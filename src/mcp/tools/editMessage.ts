/**
 * `edit_message` - необратимая правка своего сообщения, поэтому двухшаговая (draft->confirm).
 *
 * ШАГ 1 (по умолчанию): резолв чата -> ПЕРЕЧИТЫВАНИЕ правимого («было») -> confirm-токен. В сокет
 * НЕ уходит ничего: превью «было -> станет» строится чтением (`message_info`), а не правкой.
 * ШАГ 2 (`confirm:true` + токен): ре-верификация чата, цели и НОВОГО текста -> `convertMessageToPlain`
 * + `Timestamp` целевого сообщения полным конвертом (§9.3). Правка детектится при чтении как
 * непустой `LastEditTimestamp` (§9.1).
 *
 * ОТПЕЧАТОК НЕСЁТ НОВЫЙ ТЕКСТ. fingerprint = `chat:message_id:new_text`: смена текста между draft и
 * confirm инвалидирует токен (`fingerprint_mismatch`), правки «наиболее вероятного» не будет.
 *
 * ИДЕМПОТЕНТНОСТЬ - TARGET-ПУТЬ (без `payload_id`, серверный `DUPLICATE(8)` НЕ обещается, см.
 * confirm.ts): защита от повтора в пределах сессии - локальная память `recallResult`.
 *
 * ЧУЖОЕ СООБЩЕНИЕ ОТКЛОНЯЕТ СЕРВЕР: правка не своего приходит некоммитнутым commit-статусом, и
 * `pushMutation` поднимает его внятной ошибкой (§14.6). Своего ограничения тут нет.
 */
import { resolveChat, type ChatCandidate } from '../../chat/resolveChat.js';
import { buildChatResolveFailure, type ChatResolveFailure } from '../../chat/resolveFailure.js';
import { encodeToken, fingerprint, recallResult, rememberResult, verifyConfirmToken, type DraftToken } from '../confirm.js';
import { buildEditMutation, pushMutation } from '../../protocol/mutations.js';
import { getMessageInfo } from '../../protocol/messageInfo.js';
import type { ToolDeps } from './deps.js';

/** `| undefined` в полях - осознанно: под exactOptionalPropertyTypes zod отдаёт именно такой тип */
export interface EditMessageInput {
  chat: string;
  message_id: string;
  new_text: string;
  confirm?: boolean | undefined;
  confirm_token?: string | undefined;
}

export interface EditMessageDraft {
  status: 'draft';
  chat_id: string;
  message_id: string;
  /** Текущий текст сообщения (перечитан, не изменён). Отсутствует, если у сообщения нет текста */
  was_text?: string;
  /** Текст, который будет установлен на confirm */
  will_text: string;
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
  | ChatResolveFailure;

/** Отпечаток edit-пути: чат + метка цели + новый текст (смена текста инвалидирует токен) */
function editFingerprint(chatId: string, messageId: string, newText: string): string {
  return fingerprint('edit', `${chatId}:${messageId}:${newText}`);
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
    /* Превью «было -> станет» - чтением: ничего не правим */
    const info = await getMessageInfo(
      deps.ws,
      { chatId: resolved.chat_id, timestamp: input.message_id },
      { myGuid: guid, reactionMap: deps.reactionMap },
    );
    const draft: DraftToken = {
      op: 'edit',
      chat_id: resolved.chat_id,
      fingerprint: editFingerprint(resolved.chat_id, input.message_id, input.new_text),
    };
    deps.logger.info('edit_message: подготовлен draft, ничего не изменено', { via: resolved.via });
    return {
      status: 'draft',
      chat_id: resolved.chat_id,
      message_id: input.message_id,
      ...(info.message.text !== undefined ? { was_text: info.message.text } : {}),
      will_text: input.new_text,
      confirm_token: encodeToken(draft),
      next_step:
        'Ничего не изменено. Чтобы применить правку, повторите вызов с confirm:true, тем же confirm_token ' +
        'и НЕИЗМЕНЁННЫМИ chat, message_id и new_text: изменение любого из них отклонит правку.',
    };
  }

  const token = input.confirm_token ?? '';
  const draft = verifyConfirmToken({
    op: 'edit',
    token,
    chatId: resolved.chat_id,
    fingerprint: editFingerprint(resolved.chat_id, input.message_id, input.new_text),
  });

  const remembered = recallResult<EditMessageEdited>(token);
  if (remembered !== undefined) {
    deps.logger.warn('edit_message: повторный confirm тем же токеном, второй push не отправлен');
    return remembered;
  }

  /*
   * Правка пересобирает полный `Plain` заново, поэтому без `MentionedUserIds` она СТЁРЛА БЫ
   * упоминания цели (AC-7). Читаем текущие упоминания и переотправляем их. Чтение здесь, а не в
   * токене (P6: токен несёт только отпечаток), и после сверки токена - на расхождении не тратим запрос.
   */
  const info = await getMessageInfo(
    deps.ws,
    { chatId: draft.chat_id, timestamp: input.message_id },
    { myGuid: guid, reactionMap: deps.reactionMap },
  );
  const mentionedUserIds = info.message.mentions.map((mention) => mention.guid);

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
