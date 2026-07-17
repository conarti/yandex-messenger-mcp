/**
 * `list_chats` - список чатов, свежие первыми.
 *
 * ОДИН вызов `history` отдаёт всё: и метаданные, и последнее сообщение, и непрочитанное.
 *
 * `Limit:1`, А НЕ `Limit:0` - осознанное отступление от плана, продиктованное живым
 * захватом (2026-07-17): при `Limit:0` элемент чата НЕ несёт `LastMessage` вообще
 * (такого поля в ответе нет), то есть требование «показать последнее сообщение» на
 * `Limit:0` невыполнимо. При `Limit:1` каждый чат приходит с `Messages[1]`, и метка
 * этого сообщения совпала с `LastTsMcs` у 13/13 чатов - это ровно последнее сообщение,
 * без дополнительных вызовов на чат.
 *
 * Непрочитанное берётся ОТТУДА ЖЕ (`LastSeqNo - LastSeenByMeSeqNo`), поэтому
 * counters-вызов (§14.2 requestCounters) не нужен и `protocol/counters.ts` не создан.
 */
import { buildHistoryParams, extractChats, type HistoryResponse } from '../../protocol/history.js';
import { normalizeChats, type Chat } from '../../protocol/chatShape.js';
import type { ToolDeps } from './deps.js';

/** `| undefined` в полях - осознанно: под exactOptionalPropertyTypes zod отдаёт именно такой тип */
export interface ListChatsInput {
  limit?: number | undefined;
  unread_only?: boolean | undefined;
}

export interface ListChatsResult {
  chats: Chat[];
  /** Сколько чатов вернул сервер до фильтрации и среза */
  total_chats: number;
  unread_chats: number;
}

export async function listChats(deps: ToolDeps, input: ListChatsInput = {}): Promise<ListChatsResult> {
  const limit = input.limit ?? deps.config.limits.listChatsDefaultLimit;

  const response = await deps.ws.request<HistoryResponse>(
    'history',
    /* Limit - на СООБЩЕНИЯ внутри чата, не на число чатов: список приходит целиком */
    buildHistoryParams({ limit: 1, withChatData: true }),
  );

  const all = normalizeChats(extractChats(response));
  const filtered = input.unread_only === true ? all.filter((chat) => chat.unread) : all;

  deps.logger.debug('list_chats: чаты получены', {
    total: all.length,
    unread: all.filter((chat) => chat.unread).length,
    returned: Math.min(filtered.length, limit),
  });

  return {
    chats: filtered.slice(0, limit),
    total_chats: all.length,
    unread_chats: all.filter((chat) => chat.unread).length,
  };
}
