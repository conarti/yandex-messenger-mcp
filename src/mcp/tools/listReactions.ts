/**
 * `list_reactions` - полный список «кто и когда» по сообщению: реакции, сгруппированные по типу
 * (`Reaction[]`, ось E1), и прочтения (`ReadState`). Тонкая обёртка над протокольным
 * `listReactions` (`reactions.ts:245-271`), который уже делает ДВА WS-вызова `list_reactions`
 * (дефолтный `Mode` -> `UserReactions`, `Mode:1` -> `UserReads`+`ReadsCount`, §17.12) - цена
 * заявлена в описании инструмента, а не спрятана.
 *
 * ОТЛИЧИЕ ОТ СИБЛИНГОВ. `get_history`/`get_message_context`/`get_thread` отдают реакции как
 * побочный продукт обогащения истории: там `actors[]` может быть усечённым сиблингом агрегата
 * (`actors_complete` вычисляется сравнением с `count`). Здесь `actors_complete` ВСЕГДА `true` -
 * это единственный протокольный путь, отдающий полный список без обрезки.
 *
 * `Limit` ОБЯЗАТЕЛЕН на проводе (`reactions.ts:119-124` бросает `RangeError` без валидного
 * значения); тут просто прокидывается вход, дефолт (`DEFAULT_LIST_REACTIONS_LIMIT`) применяет
 * сам протокольный `listReactions`, если вызывающий его не передал.
 */
import { resolveChat, type ChatCandidate } from '../../chat/resolveChat.js';
import { buildChatResolveFailure, type ChatResolveFailure } from '../../chat/resolveFailure.js';
import {
  listReactions as fetchReactionsDetail,
  type MessageReactionsDetail,
} from '../../protocol/reactions.js';
import type { ToolDeps } from './deps.js';

/** `| undefined` в полях - осознанно: под exactOptionalPropertyTypes zod отдаёт именно такой тип */
export interface ListReactionsInput {
  chat: string;
  /** Timestamp сообщения в мкс (строка) */
  message_id: string;
  /** Лимит на провод в обоих вызовах; по умолчанию `DEFAULT_LIST_REACTIONS_LIMIT` */
  limit?: number | undefined;
  /** Для чтения по join-ссылке (§17.11) */
  invite_hash?: string | undefined;
}

export type ListReactionsResult =
  | ({ status: 'ok'; chat_id: string } & MessageReactionsDetail)
  | { status: 'ambiguous_chat'; candidates: ChatCandidate[] }
  | ChatResolveFailure;

export async function listReactions(deps: ToolDeps, input: ListReactionsInput): Promise<ListReactionsResult> {
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
    return buildChatResolveFailure({ query: input.chat, reason: 'name_not_found' });
  }

  const detail = await fetchReactionsDetail(
    deps.ws,
    {
      chatId: resolved.chat_id,
      timestamp: input.message_id,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.invite_hash !== undefined ? { inviteHash: input.invite_hash } : {}),
    },
    deps.reactionMap,
  );

  deps.logger.debug('list_reactions: получено', {
    reactions: detail.reactions.length,
    reads_tracked: detail.reads.tracked,
  });

  return { status: 'ok', chat_id: resolved.chat_id, ...detail };
}
