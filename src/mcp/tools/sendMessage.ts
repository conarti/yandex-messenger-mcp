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
  type PushMessageInfo,
} from '../../protocol/push.js';
import type { ToolDeps } from './deps.js';

/** `| undefined` в полях - осознанно: под exactOptionalPropertyTypes zod отдаёт именно такой тип */
export interface SendMessageInput {
  chat: string;
  text: string;
  confirm?: boolean | undefined;
  confirm_token?: string | undefined;
}

export interface SendMessageDraft {
  status: 'draft';
  chat_id: string;
  /** Имя чата, если резолв его дал: подтверждать отправку по паре guid человек не может */
  chat_name?: string;
  text: string;
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
  | { status: 'chat_not_found'; query: string };

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
    /* Отпечаток send-пути = хэш текста, домен-сепарированный op='send' (см. confirm.ts) */
    const draft: DraftToken = {
      op: 'send',
      chat_id: resolved.chat_id,
      fingerprint: fingerprint('send', input.text),
      payload_id: createPayloadId(),
    };
    deps.logger.info('send_message: подготовлен draft, ничего не отправлено', { via: resolved.via });
    return {
      status: 'draft',
      chat_id: resolved.chat_id,
      ...(resolved.name !== undefined ? { chat_name: resolved.name } : {}),
      text: input.text,
      confirm_token: encodeToken(draft),
      next_step:
        'Ничего не отправлено. Чтобы отправить, повторите вызов с confirm:true, тем же confirm_token ' +
        'и НЕИЗМЕНЁННЫМИ chat и text: изменение любого из них отклонит отправку.',
    };
  }

  /* Пустая строка вместо undefined: verifyConfirmToken отвергнет её как token_missing */
  const token = input.confirm_token ?? '';
  const draft = verifyConfirmToken({
    op: 'send',
    token,
    chatId: resolved.chat_id,
    fingerprint: fingerprint('send', input.text),
    /* Историческое имя причины send-пути (v1-тесты ждут text_mismatch, не fingerprint_mismatch) */
    fingerprintMismatchReason: 'text_mismatch',
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

  const { yandexUid } = await deps.auth.getAuthContext();
  /* Готовность к отправке наступает не на open, а на кадре subscribed (§17.2) */
  const subscriptionId = await deps.ws.waitForSubscriptionId();
  const params = buildPushParams({
    clientMessage: buildPlainTextClientMessage({
      chatId: draft.chat_id,
      text: input.text,
      payloadId: draft.payload_id,
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
