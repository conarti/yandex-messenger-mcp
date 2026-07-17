/**
 * Разбор join-ссылки Мессенджера в чат+сообщение (§17.11).
 *
 * ФОРМА ССЫЛКИ. Маршруты `/join/:hash/:timestamp?` и `/join/:hash/:timestamp/:threadMessageTimestamp`.
 * Отдельного message-id в протоколе НЕТ: хвост ссылки - это `Timestamp` сообщения (16 цифр, мкс),
 * тот же, что уходит в `message_info {ChatId, Timestamp}`. Каждый сегмент прогнан через
 * `encodeURIComponent`, поэтому на входе его надо `decodeURIComponent`.
 *
 * ХВОСТ - BigInt, НЕ float. Метка 16-значная: `parseInt`/`Number` потеряли бы разряд у границы
 * 2^53. Она разбирается `parseMicros` (BigInt) и отдаётся строкой; на провод её кладёт уже
 * `message_info` через `toWireTimestamp`.
 *
 * РЕЗОЛВ ЧАТА - `get_chats_info {invite_hash}` БЕЗ CSRF (§17.11). Params строго ОДИН из трёх
 * (`{chat_ids}` | `{alias}` | `{invite_hash}`); здесь всегда `invite_hash`. Идёт через
 * `RegistryHttpClient` - он и так не делает CSRF (тот живёт в слое auth только для `request_user`).
 *
 * ТРИ СЕГМЕНТА = СООБЩЕНИЕ В ТРЕДЕ. Второй сегмент задаёт родительский чат, из него и метки
 * деривируется `thread_id` (§17.10), третий - метка внутри треда. Сама деривация (`buildThreadId`)
 * приезжает в Phase 4: тут 3-сегментная ссылка ПОЛНОСТЬЮ распарсивается, родительский чат
 * резолвится, но адресация сообщения в треде помечается как ожидающая Phase 4 - без дублирующей
 * деривации `thread_id` в этом модуле.
 */
import type { RegistryHttpClient } from '../transport/RegistryHttpClient.js';
import { asObject, stringOr } from '../util/json.js';
import { parseMicros } from '../util/timestamps.js';

/** HTTP-метод резолва чата по invite_hash (§17.11), без CSRF */
const GET_CHATS_INFO_METHOD = 'get_chats_info';

/** Ссылка не разобрана как join-URL Мессенджера */
export class JoinLinkParseError extends Error {
  constructor(
    readonly input: string,
    detail: string,
  ) {
    super(`resolveLink: не разобрана join-ссылка (${detail})`);
    this.name = 'JoinLinkParseError';
  }
}

/** `get_chats_info {invite_hash}` не вернул адресуемый чат */
export class LinkChatNotFoundError extends Error {
  constructor(readonly inviteHash: string) {
    super(`resolveLink: чат по invite_hash не найден`);
    this.name = 'LinkChatNotFoundError';
  }
}

/** Результат разбора сегментов ссылки БЕЗ обращения к сети */
export interface ParsedJoinLink {
  invite_hash: string;
  /** Хвост ссылки = `Timestamp` сообщения (мкс, строка - точность BigInt, не float) */
  timestamp: string;
  /** 3-сегментная ссылка: метка сообщения ВНУТРИ треда (третий сегмент). Резолв - Phase 4 */
  thread_message_timestamp?: string;
  /** 2 или 3: сколько значимых сегментов после `/join/` */
  segments: 2 | 3;
}

/** Пометка «сообщение в треде»: `thread_id` деривируется в Phase 4 (`buildThreadId`) */
export interface LinkThreadPending {
  /** Метка сообщения внутри треда (третий сегмент ссылки) */
  message_timestamp: string;
  /** Точка расширения: деривация `thread_id` из parent_chat_id+timestamp приезжает в Phase 4 */
  pending_phase4: 'thread_id derivation (buildThreadId) arrives in Phase 4';
}

export interface ResolvedLink {
  /** Родительский чат, резолвнутый по invite_hash */
  chat_id: string;
  /** Метка адресуемого сообщения (мкс строкой) */
  timestamp: string;
  invite_hash: string;
  /**
   * Для 2-сегментной ссылки - `undefined` (сообщение адресуется напрямую в `chat_id`).
   * Для 3-сегментной - пометка треда: `chat_id`+`timestamp` дают parent, а сообщение в треде
   * ждёт `buildThreadId` (Phase 4).
   */
  thread?: LinkThreadPending;
}

export interface ResolveLinkDeps {
  http: Pick<RegistryHttpClient, 'call'>;
}

/**
 * Разбирает join-ссылку в сегменты БЕЗ сети. Возвращает `undefined`, если это не join-URL -
 * вызывающий отличает «не ссылка» от «ссылка битая» (последнее - `JoinLinkParseError`).
 */
export function parseJoinLink(input: string): ParsedJoinLink | undefined {
  const marker = '/join/';
  const at = input.indexOf(marker);
  if (at === -1) {
    return undefined;
  }
  /* Хвост после `/join/`; отсекаем возможные query/fragment, чтобы не утащить их в сегмент */
  const tail = input.slice(at + marker.length).split(/[?#]/, 1)[0] ?? '';
  const rawSegments = tail.split('/').filter((segment) => segment.length > 0);
  if (rawSegments.length < 2 || rawSegments.length > 3) {
    throw new JoinLinkParseError(input, `ожидалось 2 или 3 сегмента после /join/, получено ${rawSegments.length}`);
  }

  const decoded = rawSegments.map((segment) => decodeURIComponent(segment));
  const inviteHash = stringOr(decoded[0]);
  if (inviteHash === undefined) {
    throw new JoinLinkParseError(input, 'пустой invite_hash');
  }

  /* Хвост - Timestamp: разбираем BigInt-ом, наружу строкой (16 цифр, не float) */
  const timestamp = parseTimestampSegment(input, decoded[1]);

  if (decoded.length === 2) {
    return { invite_hash: inviteHash, timestamp, segments: 2 };
  }
  const threadMessageTimestamp = parseTimestampSegment(input, decoded[2]);
  return {
    invite_hash: inviteHash,
    timestamp,
    thread_message_timestamp: threadMessageTimestamp,
    segments: 3,
  };
}

function parseTimestampSegment(input: string, raw: string | undefined): string {
  if (raw === undefined) {
    throw new JoinLinkParseError(input, 'отсутствует сегмент Timestamp');
  }
  try {
    return parseMicros(raw).toString();
  } catch {
    throw new JoinLinkParseError(input, `сегмент Timestamp не разобран: "${raw}"`);
  }
}

/** Ответ `get_chats_info`: `data.chats[0]` + опциональный `errors[]` (§17.11, group-ветка) */
interface GetChatsInfoResponse {
  chats?: unknown;
  errors?: unknown;
}

/** Достаёт chat_id из `data.chats[0]`. HTTP-registry отдаёт snake_case, но подстрахуемся PascalCase */
function extractChatId(response: GetChatsInfoResponse): string | undefined {
  const chats = Array.isArray(response.chats) ? response.chats : [];
  const first = asObject(chats[0]);
  if (first === undefined) {
    return undefined;
  }
  return stringOr(first['chat_id']) ?? stringOr(first['ChatId']);
}

/**
 * Разбирает join-ссылку и резолвит родительский чат через `get_chats_info {invite_hash}`.
 *
 * 2-сегментная ссылка резолвится ПОЛНОСТЬЮ в `{chat_id, timestamp}`. 3-сегментная резолвит
 * родительский чат и возвращает пометку `thread` - деривация `thread_id` для сообщения в треде
 * достраивается в Phase 4 (`buildThreadId`), здесь дубля деривации нет.
 */
export async function resolveLink(deps: ResolveLinkDeps, input: string): Promise<ResolvedLink> {
  const parsed = parseJoinLink(input);
  if (parsed === undefined) {
    throw new JoinLinkParseError(input, 'ссылка не содержит /join/');
  }

  const response = await deps.http.call<GetChatsInfoResponse>(GET_CHATS_INFO_METHOD, {
    invite_hash: parsed.invite_hash,
  });
  const chatId = extractChatId(response);
  if (chatId === undefined) {
    throw new LinkChatNotFoundError(parsed.invite_hash);
  }

  if (parsed.segments === 2) {
    return { chat_id: chatId, timestamp: parsed.timestamp, invite_hash: parsed.invite_hash };
  }
  return {
    chat_id: chatId,
    timestamp: parsed.timestamp,
    invite_hash: parsed.invite_hash,
    thread: {
      message_timestamp: parsed.thread_message_timestamp!,
      pending_phase4: 'thread_id derivation (buildThreadId) arrives in Phase 4',
    },
  };
}
