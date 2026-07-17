/**
 * `get_message` по ChatId+Timestamp через WS `message_info` (§14.3/§17.12).
 *
 * ОДНО СООБЩЕНИЕ БЕЗ ИСТОРИИ. `message_info {ChatId, Timestamp, InviteHash}` адресует ровно
 * одно сообщение по его метке - страница `history` не загружается. Метка - тот же `Timestamp`
 * (16 цифр, мкс), которым сообщение адресуется везде; хранится и уходит на провод как целое,
 * без float (§5, util/timestamps).
 *
 * ФОРМА ОТВЕТА (§17.12, живьём): `{Message, ErrorInfo, MyReactions?, ChatInfo}`. В §14.3
 * `ErrorInfo`/`ChatInfo` отсутствовали - взяты из живого прогона. `MyReactions` ИСЧЕЗАЕТ как
 * ключ, когда своей реакции нет, поэтому поле опционально, а не «пустой массив».
 *
 * НОРМАЛИЗАЦИЯ - ТЕМ ЖЕ ПУТЁМ. `Message` приходит на уровне `ServerMessage`
 * (`{ClientMessage, ServerMessageInfo, ...сиблинги}`) - той же формы, что элемент `history`.
 * Поэтому нормализуется v1-логикой (`normalizeMessage`) и обогащается `enrichMessage`, а не
 * отдельным разбором: реакции/прочтения/упоминания/форварды приезжают из тех же сиблингов.
 *
 * `ErrorInfo` МАППИТСЯ ВНЯТНО. Успешный WS-ответ с непустым `ErrorInfo` - это отказ на уровне
 * сообщения (нет доступа, метка не та), а не пустая выдача: он поднимается `MessageInfoError`,
 * а не проглатывается молчаливым `undefined`.
 */
import { asObject, numberOr, stringOr } from '../util/json.js';
import { toWireTimestamp, parseMicros } from '../util/timestamps.js';
import { normalizeMessage } from './messageShape.js';
import { enrichMessage, type EnrichedMessage } from './enrichMessage.js';
import { type ReactionInfo, type ReactionMap } from '../config/reactionMap.js';

/** WS-метод чтения одного сообщения (§14.3) */
const MESSAGE_INFO_METHOD = 'message_info';

/** Минимальный контракт WS-клиента для чтения. `MessengerWsClient` ему удовлетворяет */
export interface MessageInfoClient {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export interface GetMessageInfoInput {
  chatId: string;
  /** Метка сообщения в мкс (строка/BigInt/число) */
  timestamp: string | bigint | number;
  /** Для адресации по join-ссылке (§17.11): чат за invite_hash */
  inviteHash?: string;
}

export interface GetMessageInfoContext {
  myGuid: string;
  /** Карта реакций: сырые `type` отрисовываются в name/emoji, неизвестный виден как unknown */
  reactionMap: ReactionMap;
}

export interface MessageInfoResult {
  message: EnrichedMessage;
  /** Мои реакции на это сообщение (`MyReactions`, §17.12). Ключ исчезает без своей реакции */
  my_reactions?: ReactionInfo[];
  /** Метаданные чата из ответа (`ChatInfo`), если пришли - отдаются как есть */
  chat_info?: Record<string, unknown>;
}

/** `message_info` вернул `ErrorInfo` либо не отдал адресуемого сообщения */
export class MessageInfoError extends Error {
  constructor(
    readonly chatId: string,
    readonly timestampMcs: string,
    detail: string,
  ) {
    super(`message_info: сообщение ${chatId}@${timestampMcs} недоступно: ${detail}`);
    this.name = 'MessageInfoError';
  }
}

interface MessageInfoResponse {
  Message?: unknown;
  ErrorInfo?: unknown;
  MyReactions?: unknown;
  ChatInfo?: unknown;
}

/**
 * `Message` приходит на уровне `ServerMessage`. Живьём наблюдалась и голая форма
 * (`{ClientMessage, ServerMessageInfo}`), и обёртка `{ServerMessage:{...}}` - поддерживаем обе,
 * чтобы дрейф формы не ронял чтение.
 */
function resolveServerMessage(raw: unknown): unknown {
  const obj = asObject(raw);
  if (obj === undefined) {
    return raw;
  }
  const wrapped = obj['ServerMessage'];
  return asObject(wrapped) !== undefined ? wrapped : obj;
}

/** Читаемое описание `ErrorInfo`: код/текст, если есть; иначе сырой JSON */
function describeErrorInfo(raw: unknown): string {
  const info = asObject(raw);
  if (info === undefined) {
    return JSON.stringify(raw);
  }
  const code = numberOr(info['Code']) ?? numberOr(info['Status']);
  const text = stringOr(info['Text']) ?? stringOr(info['Message']) ?? stringOr(info['Details']);
  const parts: string[] = [];
  if (code !== undefined) {
    parts.push(`code=${code}`);
  }
  if (text !== undefined) {
    parts.push(text);
  }
  return parts.length > 0 ? parts.join(', ') : JSON.stringify(raw);
}

/** Признак «ErrorInfo непустой»: пустой объект - не ошибка, это штатное «ошибки нет» */
function hasErrorInfo(raw: unknown): boolean {
  const info = asObject(raw);
  return info !== undefined && Object.keys(info).length > 0;
}

function renderMyReactions(raw: unknown, map: ReactionMap): ReactionInfo[] | undefined {
  /* Ключ отсутствует = своей реакции нет (§17.12): поле не появляется, а не «пустой массив» */
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const reactions: ReactionInfo[] = [];
  for (const item of raw) {
    /* `MyReactions` - массив int-типов (§17.12); нечисловой элемент - мусор, не тащим */
    const type = numberOr(item);
    if (type === undefined) {
      continue;
    }
    reactions.push(map.lookup(type));
  }
  return reactions;
}

/**
 * Достаёт одно сообщение по метке через `message_info` и обогащает его тем же путём, что
 * страницу истории. Без загрузки истории: один WS-вызов на одно сообщение.
 */
export async function getMessageInfo(
  client: MessageInfoClient,
  input: GetMessageInfoInput,
  ctx: GetMessageInfoContext,
): Promise<MessageInfoResult> {
  const micros = parseMicros(input.timestamp);
  const params: Record<string, unknown> = {
    ChatId: input.chatId,
    Timestamp: toWireTimestamp(micros),
  };
  if (input.inviteHash !== undefined) {
    params['InviteHash'] = input.inviteHash;
  }

  const response = await client.request<MessageInfoResponse>(MESSAGE_INFO_METHOD, params);

  const serverMessage = resolveServerMessage(response.Message);
  const base = normalizeMessage(serverMessage);
  if (base === undefined) {
    /* Нет адресуемого сообщения: если сервер сказал почему - показываем это, иначе «не найдено» */
    const detail = hasErrorInfo(response.ErrorInfo)
      ? describeErrorInfo(response.ErrorInfo)
      : 'сообщение не найдено или недоступно';
    throw new MessageInfoError(input.chatId, micros.toString(), detail);
  }

  const message = enrichMessage(base, {
    myGuid: ctx.myGuid,
    reactionMap: ctx.reactionMap,
    siblings: serverMessage,
  });
  const myReactions = renderMyReactions(response.MyReactions, ctx.reactionMap);
  const chatInfo = asObject(response.ChatInfo);

  return {
    message,
    ...(myReactions !== undefined ? { my_reactions: myReactions } : {}),
    ...(chatInfo !== undefined ? { chat_info: chatInfo } : {}),
  };
}
