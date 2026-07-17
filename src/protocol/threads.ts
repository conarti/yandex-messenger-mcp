/**
 * Треды как чаты: открытие через `history` и подписка через HTTP (§17.10, спайк 1).
 *
 * ОТКРЫТЬ ТРЕД = `history {ChatId:<thread_id>, ChatDataFilter:{}, Limit}`. Отдельного метода
 * чтения треда нет: тред - это чат, `thread_id` - его ChatId. Родительское сообщение приезжает
 * ВНУТРИ элемента чата полем `ThreadParentMessage` (спайк 1), отдельный запрос за ним не нужен.
 *
 * ПУСТОЙ ТРЕД - НЕ ОШИБКА. Тред материализуется на сервере лишь первым `push`. Пока его нет,
 * `history` отвечает `ENTITY_NOT_FOUND(4)` - именно так веб отличает «тред пуст» от «нет доступа»
 * (`ACCESS_DENIED(2)`). Поэтому `ENTITY_NOT_FOUND` тут трактуется как `empty:true`, а не пробрасывается
 * как ошибка; любой другой код протокола проходит наверх без изменений.
 *
 * JOIN/LEAVE - ПОДПИСКА, НЕ СОЗДАНИЕ (спайк 1). `join_to_thread`/`leave_thread` идут HTTP-registry
 * (§10) и возвращают `{chat_member}` - отношение участника к треду. Создания треда среди них нет.
 */
import type { RegistryHttpClient } from '../transport/RegistryHttpClient.js';
import { ResponseStatus } from '../transport/ws/frameTypes.js';
import { asObject } from '../util/json.js';
import { MessengerError } from './errors.js';
import { enrichMessages, type EnrichedMessage } from './enrichMessage.js';
import { buildHistoryParams, findChatEntry, type HistoryResponse } from './history.js';
import { normalizeMessage, type Message } from './messageShape.js';
import { parseMicros } from '../util/timestamps.js';
import type { ReactionMap } from '../config/reactionMap.js';

/** HTTP-методы подписки на тред (§10) */
const JOIN_THREAD_METHOD = 'join_to_thread';
const LEAVE_THREAD_METHOD = 'leave_thread';

/** Минимальный контракт WS-клиента для чтения. `MessengerWsClient` ему удовлетворяет */
export interface ThreadsClient {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export interface OpenThreadInput {
  /** ChatId треда (дериватив `buildThreadId`) */
  threadId: string;
  limit: number;
  /** Курсор: метка в мкс строкой, вернуть сообщения строго старше неё */
  before?: string;
  /** Для доступа тех, кто не состоит в родительском чате (§17.11) */
  inviteHash?: string;
}

export interface OpenThreadContext {
  myGuid: string;
  reactionMap: ReactionMap;
}

export interface ThreadHistory {
  thread_id: string;
  /** `true`, когда тред ещё не материализован (`ENTITY_NOT_FOUND`) - это не ошибка, а «пуст» */
  empty: boolean;
  messages: EnrichedMessage[];
  /** Родительское сообщение треда (`ThreadParentMessage` элемента чата), если пришло */
  parent_message?: Message;
  /** Курсор следующей страницы; отсутствует, когда сообщений нет */
  next_before?: string;
  /** false, если сервер отдал меньше запрошенного - старше ничего нет */
  has_more: boolean;
}

/** Отношение участника к треду после `join_to_thread`/`leave_thread` (`{chat_member}`, §10) */
export interface ThreadMembership {
  chat_member: unknown;
}

/** `ENTITY_NOT_FOUND(4)` на `history` = тред пуст (спайк 1), а не отказ доступа */
function isThreadEmpty(error: unknown): boolean {
  return (
    error instanceof MessengerError &&
    error.layer === 'application' &&
    error.code === ResponseStatus.ENTITY_NOT_FOUND
  );
}

/** Достаёт родительское сообщение из элемента чата: голая форма и обёртка `{ServerMessage}` */
function extractParentMessage(entry: { ThreadParentMessage?: unknown } | undefined): Message | undefined {
  const raw = entry?.ThreadParentMessage;
  if (raw === undefined) {
    return undefined;
  }
  return normalizeMessage(raw) ?? normalizeMessage(asObject(raw)?.['ServerMessage']);
}

/**
 * Открывает тред как чат (`history` по `thread_id`). Пустой тред (`ENTITY_NOT_FOUND`) отдаётся
 * как `empty:true`, а не пробрасывается ошибкой. Сообщения обогащаются тем же путём, что история.
 */
export async function openThread(
  client: ThreadsClient,
  input: OpenThreadInput,
  ctx: OpenThreadContext,
): Promise<ThreadHistory> {
  const params = buildHistoryParams({
    chatId: input.threadId,
    limit: input.limit,
    withChatData: true,
    ...(input.before !== undefined ? { maxTimestamp: parseMicros(input.before) } : {}),
    ...(input.inviteHash !== undefined ? { inviteHash: input.inviteHash } : {}),
  });

  let response: HistoryResponse;
  try {
    response = await client.request<HistoryResponse>('history', params);
  } catch (error) {
    if (isThreadEmpty(error)) {
      return { thread_id: input.threadId, empty: true, messages: [], has_more: false };
    }
    throw error;
  }

  const entry = findChatEntry(response, input.threadId) as
    | { Messages?: unknown; ThreadParentMessage?: unknown }
    | undefined;
  /* has_more по СЫРОЙ длине: нормализация может отбросить битый элемент, это не конец истории */
  const rawCount = Array.isArray(entry?.Messages) ? entry.Messages.length : 0;
  const messages = enrichMessages(entry?.Messages, { myGuid: ctx.myGuid, reactionMap: ctx.reactionMap });
  const parentMessage = extractParentMessage(entry);
  /* Сервер отдаёт страницу от старых к новым, поэтому курсор - метка первого элемента */
  const oldest = messages[0];

  return {
    thread_id: input.threadId,
    empty: false,
    messages,
    ...(parentMessage !== undefined ? { parent_message: parentMessage } : {}),
    ...(oldest !== undefined ? { next_before: oldest.timestamp_mcs } : {}),
    has_more: rawCount >= input.limit,
  };
}

/** Вступает в тред (`join_to_thread {thread_id}`, HTTP §10). Подписка, не создание */
export async function joinThread(
  http: Pick<RegistryHttpClient, 'call'>,
  threadId: string,
): Promise<ThreadMembership> {
  const data = await http.call<{ chat_member?: unknown }>(JOIN_THREAD_METHOD, { thread_id: threadId });
  return { chat_member: data?.chat_member };
}

/** Выходит из треда (`leave_thread {thread_id}`, HTTP §10) */
export async function leaveThread(
  http: Pick<RegistryHttpClient, 'call'>,
  threadId: string,
): Promise<ThreadMembership> {
  const data = await http.call<{ chat_member?: unknown }>(LEAVE_THREAD_METHOD, { thread_id: threadId });
  return { chat_member: data?.chat_member };
}
