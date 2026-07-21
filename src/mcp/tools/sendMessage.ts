/**
 * `send_message` - единственная необратимая операция v1, поэтому она двухшаговая.
 *
 * ШАГ 1 (по умолчанию): резолв чата -> превью -> confirm-токен. В сокет не уходит НИЧЕГО.
 * ШАГ 2 (`confirm:true` + токен): ре-верификация чата и текста -> push.
 *
 * ЗАЧЕМ РЕ-ВЕРИФИКАЦИЯ, а не просто «отправить то, что в токене». Между draft и confirm
 * может смениться всё: тот же запрос `chat` завтра резолвится в другой чат (человек
 * переименовался, появился однофамилец), а вызывающий мог подставить другой текст к
 * старому токену. Токен несёт резолвнутый ChatId и хэш текста; на confirm мы резолвим и
 * хэшируем ЗАНОВО и сверяем. Расхождение = отказ, а не отправка «наиболее вероятного».
 *
 * ИДЕМПОТЕНТНОСТЬ - двумя слоями, потому что ретрая у push нет:
 *  1) локально: израсходованный токен отдаёт запомненный результат, второй push не уходит;
 *  2) на сервере: `PayloadId` фиксируется в токене на шаге 1, поэтому даже если локальная
 *     память потерялась (рестарт, вытеснение), повтор придёт как `DUPLICATE(8)` - тоже
 *     успех, но НОВОГО сообщения не создаст.
 *
 * НЕОДНОЗНАЧНОСТЬ НЕ РАЗРЕШАЕТСЯ ГАДАНИЕМ (см. resolveChat): несколько кандидатов ->
 * наружу уходят кандидаты, и ни один push при этом не отправляется.
 */
import { resolveChat, type ChatCandidate } from '../../chat/resolveChat.js';
import { resolveMention, type MentionCandidate } from '../../chat/resolveMention.js';
import {
  ConfirmRejectedError,
  encodeToken,
  fingerprint,
  recallResult,
  rememberResult,
  resetConfirmMemory,
  verifyConfirmToken,
  type DraftToken,
} from '../confirm.js';
import {
  buildPlainTextClientMessage,
  buildPushParams,
  createPayloadId,
  parsePushResponse,
  PushNotCommittedError,
  truncateQuote,
  type ForwardedMessageRefInput,
  type PushMessageInfo,
} from '../../protocol/push.js';
import { getMessageInfo } from '../../protocol/messageInfo.js';
import type { ToolDeps } from './deps.js';

/** `| undefined` в полях - осознанно: под exactOptionalPropertyTypes zod отдаёт именно такой тип */
export interface SendMessageInput {
  chat: string;
  text: string;
  /**
   * Упоминания. На DRAFT - запросы (`@Имя`/`@<guid>`/guid), резолвятся `resolveMention`.
   * На CONFIRM - РОВНО те guid, что вернул draft, в том же порядке (порядок значим, §6.1).
   */
  mentions?: string[] | undefined;
  /**
   * Ответить на сообщение (reply): метка цели в мкс, формат `/^\d+$/` (§6.1 поле 2). Входит в
   * отпечаток. Сама цитата НЕ входит - она перечитывается с сервера на confirm (§6.2).
   */
  reply_to_message_id?: string | undefined;
  /** Переслать сообщение (forward): метка пересылаемого в мкс, формат `/^\d+$/` (§6.1 поле 3). Входит в отпечаток */
  forward_from?: string | undefined;
  confirm?: boolean | undefined;
  confirm_token?: string | undefined;
}

export { type MentionCandidate } from '../../chat/resolveMention.js';

export interface SendMessageDraft {
  status: 'draft';
  chat_id: string;
  /** Имя чата, если резолв его дал: подтверждать отправку по паре guid человек не может */
  chat_name?: string;
  text: string;
  /**
   * Резолвнутые упоминания. Предъявляются обратно на confirm; порядок значим (§6.1).
   * Присутствует ВСЕГДА (пустой массив тоже): вызывающий не должен различать «не было
   * упоминаний» и «поле забыли».
   */
  mentions: MentionCandidate[];
  /**
   * Цитата reply: текст цели, ПЕРЕЧИТАННЫЙ с сервера и обрезанный до `QUOTE_MAX_LENGTH`.
   * Информационное превью (§6.2): в отпечаток НЕ входит и обратно на confirm НЕ предъявляется -
   * цитата всегда берётся с сервера, никогда из ввода. Отсутствует у forward и когда у цели нет текста.
   */
  reply_quote?: string;
  /** true, если `reply_quote` обрезана до `QUOTE_MAX_LENGTH` (§6.2; длина ВЫВЕДЕНА - P1) */
  quote_truncated?: boolean;
  confirm_token: string;
  next_step: string;
}

export interface SendMessageSent {
  status: 'sent';
  chat_id: string;
  commit_status: number;
  commit_status_name: string;
  /** true = сервер уже принимал этот PayloadId: нового сообщения НЕ создано */
  duplicate: boolean;
  message_info?: PushMessageInfo;
  rate_limit?: { wait_for: number };
}

export type SendMessageResult =
  | SendMessageDraft
  | SendMessageSent
  | { status: 'ambiguous_chat'; candidates: ChatCandidate[] }
  | { status: 'chat_not_found'; query: string }
  /* `query` несёт КАКОЕ ИМЕННО @X не разрешилось: упоминаний может быть несколько (§6.4) */
  | { status: 'ambiguous_mention'; query: string; candidates: MentionCandidate[] }
  | { status: 'mention_not_in_chat'; query: string; guid: string; chat_id: string }
  | { status: 'mention_not_found'; query: string };

/**
 * guid упоминания: 36 символов `[0-9a-f-]` (§6.1 правило 4). Алфавит - гард инъективности отпечатка.
 * Регистр строго нижний (§5), без флага `i`: заглавный hex не должен пройти на провод.
 */
const MENTION_GUID = /^[0-9a-f-]{36}$/;

/**
 * reply_to_message_id / forward_from: только цифры (§6.1 правило 4). Гарантирует, что поля F2/F3
 * не содержат `\n`/`,`, иначе разбор payload перестал бы быть инъективным (та же природа, что у
 * коллизии guid). Гард ставится и здесь (P4), и в zod-схеме `send_message` (`server.ts`).
 */
const MESSAGE_ID_DIGITS = /^\d+$/;

export interface SendPayloadInput {
  /** guid упоминаний в порядке предъявления; порядок значим (§6.1 правило 2) */
  guids: string[];
  /** id сообщения-ответа (§6.1 поле 2); сборку `Plain` достраивает шаг 2 */
  replyToMessageId?: string;
  /** id пересылаемого (§6.1 поле 3) */
  forwardFrom?: string;
  text: string;
}

/**
 * Сериализация нагрузки send-пути (§6.1) - ДОСЛОВНО и никак иначе:
 *   payload = guids.join(',') + '\n' + reply + '\n' + forward + '\n' + text
 *
 * В отпечаток входят ТОЛЬКО guid (не `name`) и литералы reply/forward, порядок значим, пустые
 * поля дают пустую строку (разделители не схлопываются). Цитата в отпечаток НЕ входит (§6.2):
 * она приходит с сервера на confirm, не из ввода. Инъективность разбора держится на алфавите
 * первых трёх полей: каждый guid проверяется против `/^[0-9a-f-]{36}$/`, а reply/forward - против
 * `/^\d+$/` ДО сборки, иначе символ-разделитель (`\n`/`,`) в этих полях дал бы коллизию с текстом,
 * несущим те же символы (атакующая пара §6.1), на пути где push не ретраится. Проверка здесь
 * (P4) - гард, а не описание.
 */
export function buildSendPayload(input: SendPayloadInput): string {
  for (const guid of input.guids) {
    if (!MENTION_GUID.test(guid)) {
      throw new ConfirmRejectedError(
        'malformed_guid',
        `guid упоминания не в формате /^[0-9a-f-]{36}$/: ${JSON.stringify(guid)}`,
      );
    }
  }
  if (input.replyToMessageId !== undefined && !MESSAGE_ID_DIGITS.test(input.replyToMessageId)) {
    throw new ConfirmRejectedError(
      'malformed_message_id',
      `reply_to_message_id не в формате /^\\d+$/: ${JSON.stringify(input.replyToMessageId)}`,
    );
  }
  if (input.forwardFrom !== undefined && !MESSAGE_ID_DIGITS.test(input.forwardFrom)) {
    throw new ConfirmRejectedError(
      'malformed_message_id',
      `forward_from не в формате /^\\d+$/: ${JSON.stringify(input.forwardFrom)}`,
    );
  }
  return (
    input.guids.join(',') +
    '\n' +
    (input.replyToMessageId ?? '') +
    '\n' +
    (input.forwardFrom ?? '') +
    '\n' +
    input.text
  );
}

/** Отпечаток send-пути: домен-сепарация op='send' поверх нагрузки §6.1 */
export function sendFingerprint(input: SendPayloadInput): string {
  return fingerprint('send', buildSendPayload(input));
}

/** Итог резолва всех упоминаний draft: либо чистый список guid+имя, либо готовый отказ наружу */
type MentionsOutcome =
  | { status: 'ok'; candidates: MentionCandidate[] }
  | { status: 'fail'; result: SendMessageResult };

/**
 * Резолвит каждый запрос упоминания на DRAFT и схлопывает дубли по guid с сохранением
 * первого вхождения (зеркально `buildMentions`, §6.1 правило 3). Первый неразрешённый -
 * немедленный отказ наружу: неоднозначность блокирует отправку, а не угадывает (P2/AC-3).
 */
async function resolveMentions(deps: ToolDeps, chatId: string, queries: string[]): Promise<MentionsOutcome> {
  const candidates: MentionCandidate[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    const resolved = await resolveMention(query, {
      http: deps.http,
      logger: deps.logger,
      chatId,
      searchLimit: deps.config.limits.searchDefaultLimit,
    });
    if (resolved.status === 'ambiguous') {
      deps.logger.info('send_message: упоминание неоднозначно', { candidates: resolved.candidates.length });
      return { status: 'fail', result: { status: 'ambiguous_mention', query, candidates: resolved.candidates } };
    }
    if (resolved.status === 'not_in_chat') {
      deps.logger.info('send_message: упоминание вне чата');
      return { status: 'fail', result: { status: 'mention_not_in_chat', query, guid: resolved.guid, chat_id: chatId } };
    }
    if (resolved.status === 'not_found') {
      deps.logger.info('send_message: упоминание не найдено');
      return { status: 'fail', result: { status: 'mention_not_found', query } };
    }
    if (!seen.has(resolved.guid)) {
      seen.add(resolved.guid);
      candidates.push({ guid: resolved.guid, ...(resolved.name !== undefined ? { name: resolved.name } : {}) });
    }
  }
  return { status: 'ok', candidates };
}

/**
 * Перечитывает цель reply через `message_info` и собирает цитату ИЗ ОТВЕТА СЕРВЕРА (§6.2):
 * цитата выдаёт себя за чужие слова, поэтому берётся с сервера, а не из ввода вызывающего -
 * иначе можно было бы приписать собеседнику несказанное. Один WS-read; `editMessage.ts:83-88`
 * строит превью тем же перечитыванием. Цель без текста (картинка/файл) цитаты не даёт - undefined.
 */
async function readReplyQuote(
  deps: ToolDeps,
  myGuid: string,
  chatId: string,
  messageId: string,
): Promise<{ quote: string; truncated: boolean } | undefined> {
  const info = await getMessageInfo(
    deps.ws,
    { chatId, timestamp: messageId },
    { myGuid, reactionMap: deps.reactionMap },
  );
  return info.message.text !== undefined ? truncateQuote(info.message.text) : undefined;
}

/**
 * Экспортируется для тестов: чистит общую память confirm-модуля. Имя сохранено ради v1-тестов
 * (send-путь исторически звал сброс так); под капотом - общий `resetConfirmMemory`.
 */
export function resetSentTokens(): void {
  resetConfirmMemory();
}

export async function sendMessage(deps: ToolDeps, input: SendMessageInput): Promise<SendMessageResult> {
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
    return { status: 'chat_not_found', query: input.chat };
  }

  if (input.confirm !== true) {
    /* Резолв упоминаний идёт ТОЛЬКО на draft (ось D1): неоднозначность блокирует отправку */
    const mentions = await resolveMentions(deps, resolved.chat_id, input.mentions ?? []);
    if (mentions.status === 'fail') {
      return mentions.result;
    }
    const guids = mentions.candidates.map((candidate) => candidate.guid);
    /* Отпечаток покрывает ровно четыре вещи §6.1: guid, reply, forward, text. Цитата в него НЕ входит (§6.2) */
    const draft: DraftToken = {
      op: 'send',
      chat_id: resolved.chat_id,
      fingerprint: sendFingerprint({
        guids,
        ...(input.reply_to_message_id !== undefined ? { replyToMessageId: input.reply_to_message_id } : {}),
        ...(input.forward_from !== undefined ? { forwardFrom: input.forward_from } : {}),
        text: input.text,
      }),
      payload_id: createPayloadId(),
    };
    /*
     * Превью цитаты reply - перечитыванием цели с сервера (§6.2, образец editMessage.ts:83-88).
     * Цитата информационна: в отпечаток не входит и обратно на confirm не предъявляется, поэтому
     * легальная правка цели между draft и confirm отправку НЕ отвергает. Forward цитаты не несёт.
     */
    const replyQuote =
      input.reply_to_message_id !== undefined
        ? await readReplyQuote(deps, guid, resolved.chat_id, input.reply_to_message_id)
        : undefined;
    deps.logger.info('send_message: подготовлен draft, ничего не отправлено', {
      via: resolved.via,
      mentions: mentions.candidates.length,
      reply: input.reply_to_message_id !== undefined,
      forward: input.forward_from !== undefined,
    });
    return {
      status: 'draft',
      chat_id: resolved.chat_id,
      ...(resolved.name !== undefined ? { chat_name: resolved.name } : {}),
      text: input.text,
      mentions: mentions.candidates,
      ...(replyQuote !== undefined ? { reply_quote: replyQuote.quote, quote_truncated: replyQuote.truncated } : {}),
      confirm_token: encodeToken(draft),
      next_step:
        'Ничего не отправлено. Чтобы отправить, повторите вызов с confirm:true, тем же confirm_token, ' +
        'НЕИЗМЕНЁННЫМИ chat и text' +
        (guids.length > 0
          ? ' и mentions - РОВНО теми guid из этого ответа, в том же порядке: изменение любого отклонит отправку.'
          : ': изменение любого из них отклонит отправку.'),
    };
  }

  /* Пустая строка вместо undefined: verifyConfirmToken отвергнет её как token_missing */
  const token = input.confirm_token ?? '';
  /*
   * confirm НЕ ищет (ось D1): guid и метки reply/forward предъявлены вызывающим как есть.
   * sendFingerprint валидирует их алфавит и бросает malformed_guid/malformed_message_id ДО сверки
   * отпечатка. Причину override НЕ задаём - она падает на дефолт fingerprint_mismatch (§6.3):
   * историческое имя причины стало бы ложным после расширения отпечатка на упоминания и цель reply.
   */
  const presentedMentions = input.mentions ?? [];
  const draft = verifyConfirmToken({
    op: 'send',
    token,
    chatId: resolved.chat_id,
    fingerprint: sendFingerprint({
      guids: presentedMentions,
      ...(input.reply_to_message_id !== undefined ? { replyToMessageId: input.reply_to_message_id } : {}),
      ...(input.forward_from !== undefined ? { forwardFrom: input.forward_from } : {}),
      text: input.text,
    }),
  });
  if (draft.payload_id === undefined) {
    /* send-токен обязан нести payload_id (ключ серверной дедупликации); его отсутствие = битый токен */
    throw new ConfirmRejectedError('token_malformed', 'send-токен без payload_id');
  }

  const remembered = recallResult<SendMessageSent>(token);
  if (remembered !== undefined) {
    deps.logger.warn('send_message: повторный confirm тем же токеном, второй push не отправлен');
    return remembered;
  }

  /*
   * Reply/forward - одна форма Plain, различает наличие Quote (messageShape.ts:46-52). Reply
   * перечитывает цель и берёт Quote ИЗ ОТВЕТА СЕРВЕРА (§6.2), не из ввода: цитата в отпечаток не
   * входит, поэтому правка цели между draft и confirm отправку НЕ отвергает. Один WS-read на reply.
   * Forward цитаты не несёт - только ссылку. Метка reply указывает в тот же чат (draft.chat_id).
   */
  const forwardedRefs: ForwardedMessageRefInput[] = [];
  let quote: string | undefined;
  if (input.reply_to_message_id !== undefined) {
    forwardedRefs.push({ chatId: draft.chat_id, timestamp: input.reply_to_message_id });
    const replyQuote = await readReplyQuote(deps, guid, draft.chat_id, input.reply_to_message_id);
    quote = replyQuote?.quote;
    deps.logger.debug('send_message: reply, цель перечитана', {
      method: 'message_info',
      quote_length: quote?.length ?? 0,
    });
  }
  if (input.forward_from !== undefined) {
    forwardedRefs.push({ chatId: draft.chat_id, timestamp: input.forward_from });
  }

  const { yandexUid } = await deps.auth.getAuthContext();
  /* Готовность к отправке наступает не на open, а на кадре subscribed (§17.2) */
  const subscriptionId = await deps.ws.waitForSubscriptionId();
  const params = buildPushParams({
    clientMessage: buildPlainTextClientMessage({
      chatId: draft.chat_id,
      text: input.text,
      payloadId: draft.payload_id,
      ...(presentedMentions.length > 0 ? { mentionedUserIds: presentedMentions } : {}),
      ...(forwardedRefs.length > 0 ? { forwardedRefs } : {}),
      ...(quote !== undefined ? { quote } : {}),
    }),
    subscriptionId,
    yandexUid,
    serviceId: deps.config.protocol.serviceId,
  });

  const outcome = parsePushResponse(await deps.ws.request('push', params, { requireSubscriptionId: subscriptionId }));
  if (!outcome.committed) {
    throw new PushNotCommittedError(outcome);
  }

  const result: SendMessageSent = {
    status: 'sent',
    chat_id: draft.chat_id,
    commit_status: outcome.status,
    commit_status_name: outcome.status_name,
    duplicate: outcome.duplicate,
    ...(outcome.message_info !== undefined ? { message_info: outcome.message_info } : {}),
    ...(outcome.rate_limit !== undefined ? { rate_limit: outcome.rate_limit } : {}),
  };
  rememberResult(token, result);
  deps.logger.info('send_message: отправлено', { commit: outcome.status_name, duplicate: outcome.duplicate });
  return result;
}
