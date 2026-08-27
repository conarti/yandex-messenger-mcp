/**
 * `search` - поиск по сообщениям/людям/чатам через HTTP registry.
 *
 * Полнота набора обеспечивается ЭСКАЛАЦИЕЙ `limit` (§17.5) - см. protocol/search.ts.
 * Усечение (упор в потолок) сюрфейсится наружу полем `truncated`, а не замалчивается.
 *
 * Элементы бакета `messages` приходят как `{data:{ClientMessage, ServerMessageInfo}}` -
 * это ровно та форма, которую нормализует messageShape (живой захват 2026-07-17),
 * поэтому поисковые сообщения имеют ту же схему, что и сообщения из get_history.
 */
import { buildPrivateChatId } from '../../chat/resolveChat.js';
import type { SearchEntity } from '../../config/defaults.js';
import { searchWithEscalation } from '../../protocol/search.js';
import { normalizeMessage, type Message } from '../../protocol/messageShape.js';
import { asObject, stringOr } from '../../util/json.js';
import type { ToolDeps } from './deps.js';

/** `| undefined` в полях - осознанно: под exactOptionalPropertyTypes zod отдаёт именно такой тип */
export interface SearchInput {
  query: string;
  entities?: SearchEntity[] | undefined;
  limit?: number | undefined;
}

export interface UserHit {
  guid: string;
  /** Приватный ChatId для адресации найденного человека - без него его нечем адресовать */
  chat_id: string;
  /**
   * Провенанс `chat_id`: он тут не наблюдён сервером, а СКОНСТРУИРОВАН из пары guid
   * (buildPrivateChatId, §5) - тем же способом и с той же меткой, что `ChatCandidate.via`
   * в resolveChat.ts помечает конструированный (не пришедший из поиска чатов) вариант.
   */
  chat_id_via: 'user_search';
  name?: string;
}

export interface ChatHit {
  chat_id: string;
  name?: string;
  members_count?: number;
}

export interface SearchResult {
  messages?: Message[];
  users?: UserHit[];
  chats?: ChatHit[];
  /** Как отработала эскалация: стартовый limit, финальный, сколько запросов ушло */
  escalation: { start_limit: number; final_limit: number; requests: number };
  /** true => набор может быть неполон; причина - в truncation_reason */
  truncated: boolean;
  truncation_reason?: string;
}

function toUserHit(item: unknown, myGuid: string): UserHit | undefined {
  const data = asObject(asObject(item)?.['data']);
  const guid = stringOr(data?.['guid']);
  if (guid === undefined) {
    return undefined;
  }
  const name = stringOr(data?.['display_name']) ?? stringOr(data?.['public_name']);
  return {
    guid,
    chat_id: buildPrivateChatId(guid, myGuid),
    chat_id_via: 'user_search',
    ...(name !== undefined ? { name } : {}),
  };
}

function toChatHit(item: unknown): ChatHit | undefined {
  const data = asObject(asObject(item)?.['data']);
  const chatId = stringOr(data?.['chat_id']);
  if (chatId === undefined) {
    return undefined;
  }
  const name = stringOr(data?.['name']);
  const membersCount = data?.['members_count'];
  return {
    chat_id: chatId,
    ...(name !== undefined ? { name } : {}),
    ...(typeof membersCount === 'number' ? { members_count: membersCount } : {}),
  };
}

export async function search(deps: ToolDeps, input: SearchInput): Promise<SearchResult> {
  const entities: SearchEntity[] = input.entities ?? ['messages', 'users', 'chats'];
  const startLimit = input.limit ?? deps.config.limits.searchDefaultLimit;

  const outcome = await searchWithEscalation(
    { http: deps.http, logger: deps.logger },
    { query: input.query, entities, startLimit },
  );

  const result: SearchResult = {
    escalation: { start_limit: outcome.startLimit, final_limit: outcome.finalLimit, requests: outcome.requests },
    truncated: outcome.truncated,
    ...(outcome.truncationReason !== undefined ? { truncation_reason: outcome.truncationReason } : {}),
  };

  if (entities.includes('messages')) {
    result.messages = (outcome.buckets['messages'] ?? [])
      .map((item) => normalizeMessage(asObject(item)?.['data']))
      .filter((message): message is Message => message !== undefined);
  }
  if (entities.includes('users')) {
    /* Свой guid нужен только тут - конструировать chat_id для найденного человека (§5) */
    const { guid: myGuid } = await deps.auth.getWhoami();
    result.users = (outcome.buckets['users'] ?? [])
      .map((item) => toUserHit(item, myGuid))
      .filter((hit): hit is UserHit => hit !== undefined);
  }
  if (entities.includes('chats')) {
    result.chats = (outcome.buckets['chats'] ?? [])
      .map(toChatHit)
      .filter((hit): hit is ChatHit => hit !== undefined);
  }

  deps.logger.debug('search: выдача собрана', {
    entities,
    startLimit: outcome.startLimit,
    finalLimit: outcome.finalLimit,
    requests: outcome.requests,
    truncated: outcome.truncated,
  });

  return result;
}
