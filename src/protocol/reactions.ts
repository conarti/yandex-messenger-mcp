/**
 * Детальная выборка реакций и прочтений: ДВА вызова `list_reactions` на сообщение (§17.12).
 *
 * ПОЧЕМУ ДВА ВЫЗОВА. `Mode` - это дискриминатор, а не фильтр набора: дефолтный `Mode` отдаёт
 * `UserReactions`, `Mode:1` отдаёт `UserReads` + `ReadsCount`. Вместе они не приходят никогда
 * (§14.3 это утверждала - опровергнуто спайком 4). Имя `ALL:2` в енуме врёт: живьём `Mode:2`
 * отдал только `UserReactions`. Цена паритета с вебом - два запроса на одно сообщение.
 *
 * `Limit` ОБЯЗАТЕЛЕН в ОБОИХ вызовах (§17.12): без него сервер отвечает `BACKEND_CALL_ERROR(2)`.
 * Поэтому `buildListReactionsParams` не собирает запрос без валидного `Limit` и падает на входе,
 * а не улетает в бэкенд-ошибку. Форма запроса защищена регресс-тестом, а не дисциплиной.
 *
 * СИБЛИНГИ `history` - НЕ ИСТОЧНИК ИСТИНЫ. Живьём `ReadsCount:10` при `RecentUserReads` длиной 3:
 * агрегаты в history обрезаны. Полный список - только отсюда.
 *
 * СЕМАНТИКА ПРОЧТЕНИЙ. Отсутствие `UserReads` = «прочтения не отслеживаются» (`tracked:false`),
 * а НЕ «никто не читал» (`count:0`). Их нельзя путать.
 *
 * ВРЕМЯ - СТРОКОЙ. Время реакции/прочтения конкретного пользователя приходит в мкс (16 цифр) и
 * отдаётся наружу строкой рядом с ISO, без float (§5, util/timestamps).
 */
import { asObject, numberOr, stringOr } from '../util/json.js';
import { microsToIso, parseMicros, toWireTimestamp } from '../util/timestamps.js';
import { loadReactionMap, type ReactionInfo, type ReactionMap } from '../config/reactionMap.js';

/** WS-метод чтения реакций/прочтений (§14.3) */
const LIST_REACTIONS_METHOD = 'list_reactions';

/** `Mode:1` -> `UserReads` + `ReadsCount`; дефолтный `Mode` (опущен) -> `UserReactions` (§17.12) */
export const READS_MODE = 1;

/** `Limit` обязателен на проводе; это его дефолт, но пустым он на провод не уходит никогда (§14.3) */
export const DEFAULT_LIST_REACTIONS_LIMIT = 50;

/** Минимальный контракт WS-клиента, достаточный для чтения. `MessengerWsClient` ему удовлетворяет */
export interface ReactionsClient {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export interface ListReactionsInput {
  chatId: string;
  /** Метка сообщения в мкс (строка/BigInt/число) */
  timestamp: string | bigint | number;
  /** Уходит на провод всегда; по умолчанию `DEFAULT_LIST_REACTIONS_LIMIT` */
  limit?: number;
  /** Для чтения по join-ссылке (§17.11) */
  inviteHash?: string;
}

/** Кто поставил реакцию / прочитал. Guid может быть срезан - поля опциональны */
export interface ReactionActor {
  guid?: string;
  name?: string;
}

/** Реакция конкретного пользователя (`UserReactions[]`, §17.12): кто, что, когда */
export interface UserReactionEntry {
  actor: ReactionActor;
  reaction: ReactionInfo;
  /** Когда поставлена (ISO), если пришло */
  timestamp?: string;
  /** То же в мкс строкой (не float) */
  timestamp_mcs?: string;
}

/** Прочтение конкретного пользователя (`UserReads[]`, §17.12): кто и когда */
export interface UserReadEntry {
  actor: ReactionActor;
  timestamp?: string;
  timestamp_mcs?: string;
}

/**
 * Прочтения сообщения из `Mode:1`. `tracked:false` = сервер их не отслеживает для этого чата,
 * это НЕ то же самое, что `count:0`.
 */
export interface ReadState {
  tracked: boolean;
  count?: number;
  recent: UserReadEntry[];
}

/** Итог двух вызовов: детальные реакции (кто/что/когда) + прочтения (кто/когда) */
export interface MessageReactionsDetail {
  reactions: UserReactionEntry[];
  reads: ReadState;
}

interface BuildParamsInput {
  chatId: string;
  timestamp: string | bigint | number;
  limit: number;
  mode?: number;
  inviteHash?: string;
  /** Курсор пагинации (§14.3), в мкс */
  maxTimestamp?: string | bigint | number;
}

/**
 * Собирает params для `list_reactions`. `Limit` тут обязателен и валидируется: без валидного
 * `Limit` запрос НЕ собирается (иначе сервер вернёт `BACKEND_CALL_ERROR(2)`). Дефолтный `Mode`
 * не проставляется - его отсутствие и есть режим `UserReactions` (§17.12).
 */
export function buildListReactionsParams(input: BuildParamsInput): Record<string, unknown> {
  if (!Number.isInteger(input.limit) || input.limit <= 0) {
    throw new RangeError(
      `list_reactions: Limit обязателен и должен быть положительным целым, получено ${String(input.limit)}`,
    );
  }
  const params: Record<string, unknown> = {
    ChatId: input.chatId,
    Timestamp: toWireTimestamp(parseMicros(input.timestamp)),
    Limit: input.limit,
  };
  if (input.mode !== undefined) {
    params['Mode'] = input.mode;
  }
  if (input.inviteHash !== undefined) {
    params['InviteHash'] = input.inviteHash;
  }
  if (input.maxTimestamp !== undefined) {
    params['MaxTimestamp'] = toWireTimestamp(parseMicros(input.maxTimestamp));
  }
  return params;
}

/** Ответ `list_reactions`: в зависимости от `Mode` наполнен либо реакциями, либо прочтениями */
interface ListReactionsResponse {
  UserReactions?: unknown;
  UserReads?: unknown;
  ReadsCount?: unknown;
}

/** `UserInfo` (§11.2) -> актор. Пустой guid игнорируется - как идентификатор он бесполезен */
function actorOf(raw: unknown): ReactionActor {
  const info = asObject(raw);
  if (info === undefined) {
    return {};
  }
  const guid = stringOr(info['Guid']);
  const name = stringOr(info['DisplayName']);
  return {
    ...(guid !== undefined ? { guid } : {}),
    ...(name !== undefined ? { name } : {}),
  };
}

/** Метка (мкс) -> `{timestamp, timestamp_mcs}`; `0`/битую отдаёт как отсутствие, не роняет */
function markOf(raw: unknown): { timestamp: string; timestamp_mcs: string } | undefined {
  if (raw === undefined || raw === null || raw === 0) {
    return undefined;
  }
  try {
    const micros = parseMicros(raw);
    return { timestamp: microsToIso(micros), timestamp_mcs: micros.toString() };
  } catch {
    return undefined;
  }
}

function parseUserReactions(response: ListReactionsResponse, map: ReactionMap): UserReactionEntry[] {
  const raw = Array.isArray(response.UserReactions) ? response.UserReactions : [];
  const entries: UserReactionEntry[] = [];
  for (const item of raw) {
    const obj = asObject(item);
    if (obj === undefined) {
      continue;
    }
    /* Тип - int (§17.12). Без числового типа реакция неадресуема - не тащим мусор */
    const type = numberOr(obj['Type']);
    if (type === undefined) {
      continue;
    }
    const mark = markOf(obj['Timestamp']);
    entries.push({
      actor: actorOf(obj['UserInfo']),
      reaction: map.lookup(type),
      ...(mark !== undefined ? mark : {}),
    });
  }
  return entries;
}

function parseUserReads(response: ListReactionsResponse): ReadState {
  /* Ключ прочтений отсутствует целиком = не отслеживается; это НЕ `count:0` (§17.12) */
  const tracked = 'UserReads' in response || 'ReadsCount' in response;
  if (!tracked) {
    return { tracked: false, recent: [] };
  }

  const count = numberOr(response.ReadsCount);
  const raw = Array.isArray(response.UserReads) ? response.UserReads : [];
  const recent: UserReadEntry[] = [];
  for (const item of raw) {
    const obj = asObject(item);
    if (obj === undefined) {
      continue;
    }
    const actor = actorOf(obj['UserInfo']);
    const mark = markOf(obj['Timestamp']);
    if (actor.guid === undefined && actor.name === undefined && mark === undefined) {
      continue;
    }
    recent.push({ actor, ...(mark !== undefined ? mark : {}) });
  }

  return {
    tracked: true,
    ...(count !== undefined ? { count } : {}),
    recent,
  };
}

/**
 * Детальная выборка реакций и прочтений сообщения двумя вызовами `list_reactions`.
 *
 * Первый вызов (дефолтный `Mode`) даёт `UserReactions`, второй (`Mode:1`) - `UserReads`+`ReadsCount`.
 * `Limit` в обоих обязателен (проставляется `buildListReactionsParams`). `push`-семантики тут нет:
 * это чтение, поэтому идёт обычным `client.request` с ретраями READ-слоя.
 */
export async function listReactions(
  client: ReactionsClient,
  input: ListReactionsInput,
  map: ReactionMap = loadReactionMap(),
): Promise<MessageReactionsDetail> {
  const limit = input.limit ?? DEFAULT_LIST_REACTIONS_LIMIT;
  const shared = {
    chatId: input.chatId,
    timestamp: input.timestamp,
    limit,
    ...(input.inviteHash !== undefined ? { inviteHash: input.inviteHash } : {}),
  };

  const reactionsResponse = await client.request<ListReactionsResponse>(
    LIST_REACTIONS_METHOD,
    buildListReactionsParams(shared),
  );
  const readsResponse = await client.request<ListReactionsResponse>(
    LIST_REACTIONS_METHOD,
    buildListReactionsParams({ ...shared, mode: READS_MODE }),
  );

  return {
    reactions: parseUserReactions(reactionsResponse, map),
    reads: parseUserReads(readsResponse),
  };
}
