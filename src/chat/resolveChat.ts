/**
 * `ChatId | query` -> ChatId (§5).
 *
 * Порядок: готовый ChatId -> поиск среди чатов (даёт ChatId напрямую) -> поиск среди
 * пользователей (даёт guid, из которого приватный ChatId конструируется).
 *
 * НЕОДНОЗНАЧНОСТЬ НЕ РАЗРЕШАЕТСЯ ГАДАНИЕМ. Несколько совпадений -> наружу уходят
 * кандидаты, и выбор делает вызывающий. Это read-путь, но его результат кормит
 * send_message (Phase 5), где ошибка в выборе чата необратима.
 *
 * `create_private_chat` НЕ используется: это мутация, а резолв обязан быть read-only.
 */
import type { SearchEntity } from '../config/defaults.js';
import { searchWithEscalation, type SearchDeps } from '../protocol/search.js';
import { isThreadId } from '../protocol/threadId.js';
import { asObject, stringOr } from '../util/json.js';

/** Приватный чат: `<guidA>_<guidB>` (§5) */
const PRIVATE_CHAT_ID = /^[0-9a-f-]{36}_[0-9a-f-]{36}$/i;
/** Групповой чат/канал: `0/0/<guid>` (§5) */
const GROUP_CHAT_ID = /^\d+\/\d+\/[0-9a-f-]{36}$/i;

export interface ChatCandidate {
  chat_id: string;
  name?: string;
  kind: 'private' | 'group';
  /** Откуда взялся кандидат: прямой ChatId из поиска чатов либо сконструированный из guid */
  via: 'chat_search' | 'user_search';
}

export type ResolveChatResult =
  | {
      status: 'resolved';
      chat_id: string;
      via: 'literal' | 'chat_search' | 'user_search';
      /**
       * Имя разрешённого чата, если поиск его дал. Для `literal` его нет: строка ChatId
       * самодостаточна и поиска не требует. Нужно превью send_message - подтверждать
       * отправку по паре guid человек не может.
       */
      name?: string;
    }
  | { status: 'ambiguous'; candidates: ChatCandidate[] }
  | { status: 'not_found' };

export function isChatId(value: string): boolean {
  /* thread_id - тоже валидный ChatId: тред = чат (§17.10), send_message шлёт в него как в чат */
  return PRIVATE_CHAT_ID.test(value) || GROUP_CHAT_ID.test(value) || isThreadId(value);
}

/**
 * Приватный ChatId - это пара guid через `_`, ОТСОРТИРОВАННАЯ по кодовым единицам UTF-16 (§5).
 * Порядок здесь не декоративный: перестановка даёт другую строку, и чат по ней не найдётся.
 */
export function buildPrivateChatId(partnerGuid: string, myGuid: string): string {
  /*
   * Сравнение обычным `<` (кодовые единицы UTF-16), а не `localeCompare`: у guid, приходящих
   * сюда (из `getWhoami` и из бакета `users`), нет валидатора регистра, а `localeCompare`
   * детерминирован лишь относительно локали среды выполнения - на разных машинах при одном и
   * том же входе он дал бы разный порядок, тогда как итоговый chat_id обязан совпасть с
   * серверным байт в байт.
   */
  return partnerGuid < myGuid ? `${partnerGuid}_${myGuid}` : `${myGuid}_${partnerGuid}`;
}

/** Элемент бакета `chats`: `{data:{chat_id, name, ...}, ...}` (живой захват 2026-07-17) */
function toChatCandidate(item: unknown): ChatCandidate | undefined {
  const data = asObject(asObject(item)?.['data']);
  const chatId = stringOr(data?.['chat_id']);
  if (chatId === undefined) {
    return undefined;
  }
  const name = stringOr(data?.['name']);
  return {
    chat_id: chatId,
    ...(name !== undefined ? { name } : {}),
    kind: PRIVATE_CHAT_ID.test(chatId) ? 'private' : 'group',
    via: 'chat_search',
  };
}

/**
 * Self-чат («Избранное») в бакете `chats` (GAP, гейт спайка 5).
 *
 * Признак self-чата: пара одинаковых guid = мои (`ChatId === <myGuid>_<myGuid>`), либо
 * `PrivateChatInfo` + `PartnerInfo.Guid === myGuid`. Тогда наружу уходит канонический
 * ChatId `<myGuid>_<myGuid>` - даже если `data.chat_id` в выдаче поиска отсутствует.
 *
 * Не-self элемент -> `undefined`: у обычного приватного чата `PartnerInfo.Guid` = собеседник
 * (не я), а `chat_id` - пара РАЗНЫХ guid (не `<я>_<я>`). Поэтому резолв не-self чатов эта
 * ветка не меняет - на них она просто не срабатывает и управление уходит в `toChatCandidate`.
 */
function toSelfChatCandidate(item: unknown, myGuid: string): ChatCandidate | undefined {
  const data = asObject(asObject(item)?.['data']);
  if (data === undefined) {
    return undefined;
  }
  const selfChatId = buildPrivateChatId(myGuid, myGuid);
  const chatId = stringOr(data['chat_id']);
  const partnerGuid = stringOr(asObject(data['PartnerInfo'])?.['Guid']);
  const bySelfId = chatId === selfChatId;
  const byGate = data['PrivateChatInfo'] !== undefined && partnerGuid === myGuid;
  if (!bySelfId && !byGate) {
    return undefined;
  }
  const name = stringOr(data['name']);
  return {
    chat_id: selfChatId,
    ...(name !== undefined ? { name } : {}),
    kind: 'private',
    via: 'chat_search',
  };
}

/** Элемент бакета `users`: `{data:{guid, display_name, ...}, ...}` (живой захват 2026-07-17) */
function toUserCandidate(item: unknown, myGuid: string): ChatCandidate | undefined {
  const data = asObject(asObject(item)?.['data']);
  const guid = stringOr(data?.['guid']);
  if (guid === undefined || guid === myGuid) {
    /* Сам себе собеседником не бываю: чат с собой этой конструкцией не адресуется */
    return undefined;
  }
  const name = stringOr(data?.['display_name']) ?? stringOr(data?.['public_name']);
  return {
    chat_id: buildPrivateChatId(guid, myGuid),
    ...(name !== undefined ? { name } : {}),
    kind: 'private',
    via: 'user_search',
  };
}

export interface ResolveChatDeps extends SearchDeps {
  /** Мой guid для конструирования приватного ChatId */
  myGuid: string;
  /** Стартовый limit поиска - тот же, что у инструмента search */
  searchLimit: number;
}

async function searchOne(deps: ResolveChatDeps, query: string, entity: SearchEntity): Promise<unknown[]> {
  const outcome = await searchWithEscalation(deps, {
    query,
    entities: [entity],
    startLimit: deps.searchLimit,
  });
  return outcome.buckets[entity] ?? [];
}

export async function resolveChat(input: string, deps: ResolveChatDeps): Promise<ResolveChatResult> {
  const query = input.trim();
  if (query.length === 0) {
    return { status: 'not_found' };
  }

  /* Уже ChatId - поиск не нужен: строка самодостаточна */
  if (isChatId(query)) {
    return { status: 'resolved', chat_id: query, via: 'literal' };
  }

  const chatItems = await searchOne(deps, query, 'chats');
  /*
   * Self-чат («Избранное») по имени (GAP): self-элемент даёт канонический `<myGuid>_<myGuid>`,
   * прочие - обычного кандидата. Резолв не-self чатов не меняется: на них toSelfChatCandidate
   * возвращает undefined, и работает прежний toChatCandidate.
   */
  const chatCandidates = chatItems
    .map((item) => toSelfChatCandidate(item, deps.myGuid) ?? toChatCandidate(item))
    .filter((c): c is ChatCandidate => c !== undefined);

  if (chatCandidates.length === 1) {
    const only = chatCandidates[0]!;
    return {
      status: 'resolved',
      chat_id: only.chat_id,
      via: 'chat_search',
      ...(only.name !== undefined ? { name: only.name } : {}),
    };
  }
  if (chatCandidates.length > 1) {
    return { status: 'ambiguous', candidates: chatCandidates };
  }

  /* Среди чатов не нашлось - значит приватный чат, возможно, ещё не в списке: ищем человека */
  const userItems = await searchOne(deps, query, 'users');
  const userCandidates = userItems
    .map((item) => toUserCandidate(item, deps.myGuid))
    .filter((c): c is ChatCandidate => c !== undefined);

  if (userCandidates.length === 1) {
    const only = userCandidates[0]!;
    return {
      status: 'resolved',
      chat_id: only.chat_id,
      via: 'user_search',
      ...(only.name !== undefined ? { name: only.name } : {}),
    };
  }
  if (userCandidates.length > 1) {
    return { status: 'ambiguous', candidates: userCandidates };
  }
  return { status: 'not_found' };
}
