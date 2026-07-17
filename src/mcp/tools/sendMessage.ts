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
import { createHash } from 'node:crypto';
import { resolveChat, type ChatCandidate } from '../../chat/resolveChat.js';
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

/** Confirm отвергнут. Всегда громко: тихий отказ на пути отправки неотличим от успеха */
export class ConfirmRejectedError extends Error {
  constructor(
    readonly reason: 'token_missing' | 'token_malformed' | 'chat_mismatch' | 'text_mismatch',
    detail: string,
  ) {
    super(`send_message: confirm отвергнут (${reason}): ${detail}. Сообщение НЕ отправлено`);
    this.name = 'ConfirmRejectedError';
  }
}

/** Начинка confirm-токена. Текста тут нет - только его хэш: токен ходит через чужие руки */
interface DraftToken {
  chat_id: string;
  text_hash: string;
  payload_id: string;
}

/**
 * Токен намеренно НЕ подписан: подделка ничего не даёт. Чат из токена сверяется с
 * ЗАНОВО резолвнутым, текст - с заново посчитанным хэшем, а отправка идёт в проверенный
 * чат. Токен - это память о драфте, а не полномочие.
 */
function encodeToken(draft: DraftToken): string {
  return Buffer.from(JSON.stringify(draft), 'utf8').toString('base64url');
}

function decodeToken(raw: string): DraftToken | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<DraftToken>;
    if (
      typeof parsed.chat_id !== 'string' ||
      typeof parsed.text_hash !== 'string' ||
      typeof parsed.payload_id !== 'string'
    ) {
      return undefined;
    }
    return { chat_id: parsed.chat_id, text_hash: parsed.text_hash, payload_id: parsed.payload_id };
  } catch {
    return undefined;
  }
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Израсходованные токены -> их результат. Ограничена сверху: это защита от повтора в
 * пределах сессии, а не журнал. Вытеснение старого токена не ломает идемпотентность -
 * его повтор упрётся в серверную дедупликацию по `PayloadId`.
 */
const MAX_REMEMBERED_SENDS = 100;
const sentByToken = new Map<string, SendMessageSent>();

function rememberSend(token: string, result: SendMessageSent): void {
  sentByToken.set(token, result);
  for (const oldest of sentByToken.keys()) {
    if (sentByToken.size <= MAX_REMEMBERED_SENDS) {
      break;
    }
    sentByToken.delete(oldest);
  }
}

/** Экспортируется для тестов: модульное состояние не должно течь между кейсами */
export function resetSentTokens(): void {
  sentByToken.clear();
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
    const draft: DraftToken = {
      chat_id: resolved.chat_id,
      text_hash: hashText(input.text),
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

  const token = input.confirm_token;
  if (token === undefined || token.length === 0) {
    throw new ConfirmRejectedError('token_missing', 'confirm:true требует confirm_token из шага draft');
  }
  const draft = decodeToken(token);
  if (draft === undefined) {
    throw new ConfirmRejectedError('token_malformed', 'confirm_token не разобран');
  }
  if (draft.chat_id !== resolved.chat_id) {
    /* Ни один из двух чатов не «правильнее» - расхождение значит, что подтверждали не это */
    throw new ConfirmRejectedError('chat_mismatch', 'запрос chat резолвится в другой чат, чем на шаге draft');
  }
  if (draft.text_hash !== hashText(input.text)) {
    throw new ConfirmRejectedError('text_mismatch', 'текст отличается от подтверждённого на шаге draft');
  }

  const remembered = sentByToken.get(token);
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
  rememberSend(token, result);
  deps.logger.info('send_message: отправлено', { commit: outcome.status_name, duplicate: outcome.duplicate });
  return result;
}
