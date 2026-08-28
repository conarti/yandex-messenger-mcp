/**
 * `edit_message` - необратимая правка своего сообщения, поэтому двухшаговая (draft->confirm).
 *
 * ШАГ 1 (по умолчанию): резолв чата -> резолв упоминаний (если названы) -> ПЕРЕЧИТЫВАНИЕ
 * правимого («было») -> confirm-токен. В сокет НЕ уходит ничего: превью «было -> станет»
 * строится чтением (`message_info`), а не правкой.
 * ШАГ 2 (`confirm:true` + токен): ре-верификация чата, цели, НОВОГО текста и состава упоминаний ->
 * `convertMessageToPlain` + `Timestamp` целевого сообщения полным конвертом (§9.3). Правка
 * детектится при чтении как непустой `LastEditTimestamp` (§9.1).
 *
 * ОТПЕЧАТОК НЕСЁТ НОВЫЙ ТЕКСТ И СОСТАВ УПОМИНАНИЙ (§6.1, как у send): смена любого из них между
 * draft и confirm инвалидирует токен (`fingerprint_mismatch`), правки «наиболее вероятного» не будет.
 *
 * УПОМИНАНИЯ - ДВА РЕЖИМА, и различает их НАЛИЧИЕ поля `mentions`, а не его содержимое.
 *  - поля НЕТ: состав цели не трогаем. Правка пересобирает полный `Plain` заново, поэтому без
 *    `MentionedUserIds` она СТЁРЛА БЫ упоминания цели (AC-7) - читаем текущие и переотправляем.
 *  - поле ЕСТЬ: это НОВЫЙ ПОЛНЫЙ состав, как у `send_message`. Запросы резолвятся на draft,
 *    токены `@<guid>` подставляются в текст (#15), старый состав НЕ подмешивается - вызывающий
 *    заявил его целиком. Пустой массив стирает упоминания: это заявленный состав из нуля человек.
 * Отсюда же требование к отпечатку: «поля нет» и «пустой массив» дают РАЗНЫЙ провод (сохранить
 * против стереть), поэтому обязаны давать и разный отпечаток - иначе draft одного режима
 * подтверждался бы другим.
 *
 * ИДЕМПОТЕНТНОСТЬ - TARGET-ПУТЬ (без `payload_id`, серверный `DUPLICATE(8)` НЕ обещается, см.
 * confirm.ts): защита от повтора в пределах сессии - локальная память `recallResult`.
 *
 * ЧУЖОЕ СООБЩЕНИЕ ОТКЛОНЯЕТ СЕРВЕР: правка не своего приходит некоммитнутым commit-статусом, и
 * `pushMutation` поднимает его внятной ошибкой (§14.6). Своего ограничения тут нет.
 */
import { resolveChat, type ChatCandidate } from '../../chat/resolveChat.js';
import { buildChatResolveFailure, type ChatResolveFailure } from '../../chat/resolveFailure.js';
import { type MentionCandidate } from '../../chat/resolveMention.js';
import { resolveMentions, type MentionResolveFailure } from '../../chat/resolveMentions.js';
import { renderMentionNames, substituteMentionTokens } from '../../chat/mentionTokens.js';
import {
  assertMentionGuids,
  ConfirmRejectedError,
  encodeToken,
  fingerprint,
  recallResult,
  rememberResult,
  verifyConfirmToken,
  type DraftToken,
} from '../confirm.js';
import { buildEditMutation, pushMutation } from '../../protocol/mutations.js';
import { getMessageInfo } from '../../protocol/messageInfo.js';
import type { ToolDeps } from './deps.js';

/** `| undefined` в полях - осознанно: под exactOptionalPropertyTypes zod отдаёт именно такой тип */
export interface EditMessageInput {
  chat: string;
  message_id: string;
  new_text: string;
  /**
   * НОВЫЙ ПОЛНЫЙ состав упоминаний. Отсутствие поля и пустой массив - РАЗНЫЕ вещи: без поля
   * состав цели переотправляется как есть, с пустым массивом стирается. На DRAFT - запросы
   * (`@Имя`/`@<guid>`/guid), на CONFIRM - РОВНО те guid, что вернул draft, в том же порядке.
   */
  mentions?: string[] | undefined;
  confirm?: boolean | undefined;
  confirm_token?: string | undefined;
}

export interface EditMessageDraft {
  status: 'draft';
  chat_id: string;
  message_id: string;
  /** Текущий текст сообщения (перечитан, не изменён). Отсутствует, если у сообщения нет текста */
  was_text?: string;
  /**
   * КАНОНИЧЕСКИЙ текст, который будет установлен на confirm: названные в `mentions` строки уже
   * заменены на токены `@<guid>` - именно так упоминание рендерится клиентом (#15). Предмет
   * отпечатка и эха: на confirm в `new_text` возвращается ДОСЛОВНО эта строка.
   */
  will_text: string;
  /**
   * Читаемая проекция `will_text`, где guid развёрнуты обратно в имена. ТОЛЬКО ДЛЯ ЧТЕНИЯ: в
   * отпечаток не входит и обратно на confirm не предъявляется. Присутствует ровно тогда, когда
   * подстановка применилась: иначе была бы копией `will_text`. Существует потому, что по строке
   * с 37-символьными guid человек не видит, кого и в каком месте он упоминает.
   */
  will_text_preview?: string;
  /**
   * Резолвнутый НОВЫЙ состав упоминаний; предъявляется обратно на confirm, порядок значим (§6.1).
   * Поле присутствует ровно тогда, когда `mentions` были названы на входе: его отсутствие значит
   * «состав цели не трогаем», и предъявлять на confirm тогда нечего. Пустым массивом оно значит
   * «стереть упоминания» - смешивать эти два случая одной формой выдачи нельзя.
   */
  mentions?: MentionCandidate[];
  confirm_token: string;
  next_step: string;
}

export interface EditMessageEdited {
  status: 'edited';
  chat_id: string;
  message_id: string;
  new_text: string;
  commit_status: number;
  commit_status_name: string;
}

export type EditMessageResult =
  | EditMessageDraft
  | EditMessageEdited
  | { status: 'ambiguous_chat'; candidates: ChatCandidate[] }
  | ChatResolveFailure
  | MentionResolveFailure;

interface EditPayloadInput {
  chatId: string;
  messageId: string;
  /** `undefined` = поле `mentions` не предъявлено; пустой массив = предъявлен пустой состав */
  guids: readonly string[] | undefined;
  text: string;
}

/**
 * Сериализация нагрузки edit-пути: `предъявлен?` + guid + чат + метка + новый текст.
 *
 * Флаг предъявления идёт отдельным полем, а не кодируется пустой строкой: «поля нет» и «поле есть
 * и пусто» - разный провод (см. шапку модуля), и отпечаток обязан их различать. Инъективность
 * разбора держится на алфавите первых полей: каждый guid проверяется против `/^[0-9a-f-]{36}$/`
 * ДО сборки, иначе `\n`/`,` в составе дал бы коллизию с текстом, несущим те же символы, - на пути,
 * где правка необратима. Метка цели ограничена `/^\d+$/` zod-схемой инструмента.
 */
function buildEditPayload(input: EditPayloadInput): string {
  assertMentionGuids(input.guids ?? []);
  return (
    (input.guids === undefined ? '' : '1') +
    '\n' +
    (input.guids ?? []).join(',') +
    '\n' +
    input.chatId +
    '\n' +
    input.messageId +
    '\n' +
    input.text
  );
}

/** Отпечаток edit-пути: домен-сепарация op='edit' поверх нагрузки правки */
function editFingerprint(input: EditPayloadInput): string {
  return fingerprint('edit', buildEditPayload(input));
}

export async function editMessage(deps: ToolDeps, input: EditMessageInput): Promise<EditMessageResult> {
  const { guid } = await deps.auth.getWhoami();

  const resolved = await resolveChat(input.chat, {
    http: deps.http,
    logger: deps.logger,
    myGuid: guid,
    searchLimit: deps.config.limits.searchDefaultLimit,
  });
  if (resolved.status === 'ambiguous') {
    return { status: 'ambiguous_chat', candidates: resolved.candidates };
  }
  if (resolved.status === 'not_found') {
    return buildChatResolveFailure({ query: input.chat, reason: 'name_not_found' });
  }

  if (input.confirm !== true) {
    /*
     * Резолв упоминаний идёт ТОЛЬКО на draft (ось D1) и ДО чтения цели: неоднозначность отклоняет
     * правку целиком, и тратить на неё ws-чтение незачем.
     */
    const mentions =
      input.mentions !== undefined
        ? await resolveMentions(input.mentions, {
            http: deps.http,
            logger: deps.logger,
            operation: 'edit_message',
            chatId: resolved.chat_id,
            searchLimit: deps.config.limits.searchDefaultLimit,
          })
        : undefined;
    if (mentions?.status === 'fail') {
      return mentions.failure;
    }
    /*
     * Подстановка идёт ДО отпечатка, и подставленный текст обязан уйти В ОБА сайта: в поле `text`
     * отпечатка ниже и в `draft.will_text`. Правка одной выдачи дала бы `fingerprint_mismatch` на
     * КАЖДОЙ правке с упоминанием - confirm считает свой отпечаток над эхом `will_text`.
     * Пустые пары возвращают текст байт в байт, поэтому режим «без mentions» проходит здесь без ветки.
     */
    const substitution = substituteMentionTokens(input.new_text, mentions?.pairs ?? []);

    /* Превью «было -> станет» - чтением: ничего не правим */
    const info = await getMessageInfo(
      deps.ws,
      { chatId: resolved.chat_id, timestamp: input.message_id },
      { myGuid: guid, reactionMap: deps.reactionMap },
    );
    const draft: DraftToken = {
      op: 'edit',
      chat_id: resolved.chat_id,
      fingerprint: editFingerprint({
        chatId: resolved.chat_id,
        messageId: input.message_id,
        guids: mentions?.candidates.map((candidate) => candidate.guid),
        text: substitution.text,
      }),
    };
    /* Источник имён превью - `candidates`, поэтому превью и `draft.mentions[]` не расходятся по построению */
    const willTextPreview =
      mentions !== undefined && substitution.substituted > 0
        ? renderMentionNames(substitution.text, mentions.candidates)
        : undefined;
    deps.logger.info('edit_message: подготовлен draft, ничего не изменено', {
      via: resolved.via,
      mentions: mentions?.candidates.length ?? null,
      substituted: substitution.substituted,
    });
    return {
      status: 'draft',
      chat_id: resolved.chat_id,
      message_id: input.message_id,
      ...(info.message.text !== undefined ? { was_text: info.message.text } : {}),
      will_text: substitution.text,
      ...(willTextPreview !== undefined ? { will_text_preview: willTextPreview } : {}),
      ...(mentions !== undefined ? { mentions: mentions.candidates } : {}),
      confirm_token: encodeToken(draft),
      next_step:
        'Ничего не изменено. Чтобы применить правку, повторите вызов с confirm:true, тем же confirm_token, ' +
        'НЕИЗМЕНЁННЫМИ chat и message_id и new_text - ДОСЛОВНО строкой will_text из этого ответа' +
        (mentions !== undefined
          ? ' и mentions - РОВНО теми guid из этого ответа, в том же порядке: изменение любого отклонит правку.'
          : ': изменение любого из них отклонит правку. Поле mentions не предъявлялось, поэтому упоминания ' +
            'правимого сообщения сохранятся как есть.') +
        (willTextPreview !== undefined
          ? ' Поле will_text_preview - ТОЛЬКО ДЛЯ ЧТЕНИЯ, оно показывает имена вместо guid: эхом возвращайте' +
            ' will_text, а не will_text_preview, иначе правка будет отклонена.'
          : ''),
    };
  }

  const token = input.confirm_token ?? '';
  /*
   * confirm НЕ ищет (ось D1): guid предъявлены вызывающим как есть, их алфавит проверяет
   * `editFingerprint` (`malformed_guid`) ДО сверки отпечатка.
   */
  const draft = verifyConfirmToken({
    op: 'edit',
    token,
    chatId: resolved.chat_id,
    fingerprint: editFingerprint({
      chatId: resolved.chat_id,
      messageId: input.message_id,
      guids: input.mentions,
      text: input.new_text,
    }),
  });

  const remembered = recallResult<EditMessageEdited>(token);
  if (remembered !== undefined) {
    deps.logger.warn('edit_message: повторный confirm тем же токеном, второй push не отправлен');
    return remembered;
  }

  /*
   * Состав упоминаний на провод. Поле предъявлено - оно и есть новый состав целиком, читать цель
   * незачем. Поля нет - прежний путь: читаем текущие упоминания цели и переотправляем их, иначе
   * пересборка полного `Plain` стёрла бы их (AC-7). Чтение здесь, а не в токене (P6: токен несёт
   * только отпечаток), и после сверки токена - на расхождении не тратим запрос.
   */
  let mentionedUserIds: string[];
  if (input.mentions !== undefined) {
    mentionedUserIds = input.mentions;
  } else {
    const info = await getMessageInfo(
      deps.ws,
      { chatId: draft.chat_id, timestamp: input.message_id },
      { myGuid: guid, reactionMap: deps.reactionMap },
    );
    mentionedUserIds = info.message.mentions.map((mention) => mention.guid);
  }

  const outcome = await pushMutation(
    { ws: deps.ws, auth: deps.auth, serviceId: deps.config.protocol.serviceId },
    buildEditMutation({
      chatId: draft.chat_id,
      timestamp: input.message_id,
      text: input.new_text,
      ...(mentionedUserIds.length > 0 ? { mentionedUserIds } : {}),
    }),
  );

  const result: EditMessageEdited = {
    status: 'edited',
    chat_id: draft.chat_id,
    message_id: input.message_id,
    new_text: input.new_text,
    commit_status: outcome.status,
    commit_status_name: outcome.status_name,
  };
  rememberResult(token, result);
  deps.logger.info('edit_message: применена правка', { commit: outcome.status_name });
  return result;
}
