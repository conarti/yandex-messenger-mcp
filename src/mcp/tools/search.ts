/**
 * `search` - поиск по сообщениям/людям/чатам через HTTP registry.
 *
 * Полнота набора обеспечивается ЭСКАЛАЦИЕЙ `limit` (§17.5) - см. protocol/search.ts.
 * Усечение (упор в потолок) сюрфейсится наружу полем `truncated`, а не замалчивается.
 *
 * Элементы бакета `messages` приходят как `{data:{ClientMessage, MentionedUsers,
 * ServerMessageInfo}}` - `item.data` играет роль `ServerMessage` из истории и несёт те же
 * сиблинги (живой захват). Поэтому поисковые сообщения проходят то же ОБОГАЩЕНИЕ
 * (`enrichMessage`), что и `get_history`: без него реакции, упоминания и пересылки
 * молча терялись, хотя данные для них уже приезжали в ответе (#22).
 */
import { buildPrivateChatId } from '../../chat/resolveChat.js';
import type { SearchEntity } from '../../config/defaults.js';
import { enrichMessage, type EnrichedMessage } from '../../protocol/enrichMessage.js';
import { searchWithEscalation } from '../../protocol/search.js';
import { normalizeMessage } from '../../protocol/messageShape.js';
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
  /** Обогащённые сообщения - та же форма, что у `get_history`, а не голый v1-объект */
  messages?: EnrichedMessage[];
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

  const wantsMessages = entities.includes('messages');
  const wantsUsers = entities.includes('users');
  /*
   * Свой guid нужен обеим веткам: сообщениям для `from_me`, людям для конструирования chat_id (§5).
   * Он берётся ВНУТРИ общего блока, а не снаружи под гардом `myGuid !== undefined`: при внешнем
   * гарде запрошенный бакет мог бы молча исчезнуть из ответа, без ошибки и без лога. Здесь он
   * существует по построению, и пропасть бакету не на чем.
   */
  if (wantsMessages || wantsUsers) {
    const { guid: myGuid } = await deps.auth.getWhoami();

    if (wantsMessages) {
      result.messages = (outcome.buckets['messages'] ?? [])
        .map((item) => {
          /* `item.data` - тот же конверт, что `ServerMessage` в истории: и база, и сиблинги */
          const siblings = asObject(item)?.['data'];
          const base = normalizeMessage(siblings);
          return base === undefined
            ? undefined
            : enrichMessage(base, { myGuid, reactionMap: deps.reactionMap, siblings });
        })
        .filter((message): message is EnrichedMessage => message !== undefined);
    }
    if (wantsUsers) {
      result.users = (outcome.buckets['users'] ?? [])
        .map((item) => toUserHit(item, myGuid))
        .filter((hit): hit is UserHit => hit !== undefined);
    }
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
