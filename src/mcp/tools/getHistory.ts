/**
 * `get_history` - страница сообщений чата.
 *
 * КУРСОР. `before` - метка в мкс строкой, ИСКЛЮЧАЮЩАЯ: страница вернёт сообщения строго
 * старше неё. Она кладётся в `MaxTimestamp` как есть, без правки на ±1, потому что
 * `MaxTimestamp` сам по себе исключающий - проверено живьём 2026-07-17:
 * `MaxTimestamp = newest+1` возвращает сообщение с меткой newest, `MaxTimestamp = newest`
 * возвращает уже предыдущее (то же следует из §14.2, где `requestMessage` адресует
 * сообщение с меткой n через `MaxTimestamp: n+1`).
 * Поэтому `next_before` = метка САМОГО СТАРОГО сообщения страницы: следующая страница
 * продолжится ровно за ним, без пропуска и без пересечения.
 *
 * Вложения отдаются РЕФАМИ. Ничего не качается - это делает download_attachment (Phase 6).
 */
import { resolveChat, type ChatCandidate } from '../../chat/resolveChat.js';
import { enrichMessages, type EnrichedMessage } from '../../protocol/enrichMessage.js';
import { buildHistoryParams, findChatEntry, type HistoryResponse } from '../../protocol/history.js';
import { parseMicros } from '../../util/timestamps.js';
import type { ToolDeps } from './deps.js';

/** `| undefined` в полях - осознанно: под exactOptionalPropertyTypes zod отдаёт именно такой тип */
export interface GetHistoryInput {
  chat: string;
  limit?: number | undefined;
  /** Метка в мкс строкой: вернуть сообщения строго старше неё */
  before?: string | undefined;
}

export type GetHistoryResult =
  | {
      status: 'ok';
      chat_id: string;
      messages: EnrichedMessage[];
      /** Курсор следующей страницы; отсутствует, когда страница пуста */
      next_before?: string;
      /**
       * false, если сервер отдал меньше запрошенного - дальше ничего нет.
       * Считается по СЫРОЙ выдаче сервера, а не по `messages`: нормализация может
       * отбросить битый элемент, и это НЕ признак конца истории.
       */
      has_more: boolean;
    }
  | { status: 'ambiguous_chat'; candidates: ChatCandidate[] }
  | { status: 'chat_not_found'; query: string };

export const DEFAULT_HISTORY_LIMIT = 40;

export async function getHistory(deps: ToolDeps, input: GetHistoryInput): Promise<GetHistoryResult> {
  const limit = input.limit ?? DEFAULT_HISTORY_LIMIT;
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

  const response = await deps.ws.request<HistoryResponse>(
    'history',
    buildHistoryParams({
      chatId: resolved.chat_id,
      limit,
      ...(input.before !== undefined ? { maxTimestamp: parseMicros(input.before) } : {}),
    }),
  );

  const entry = findChatEntry(response, resolved.chat_id) as { Messages?: unknown } | undefined;
  /*
   * has_more считается по СЫРОЙ длине, а не по нормализованной: normalizeMessages
   * выбрасывает неадресуемые элементы (без парсящегося Timestamp), поэтому полная
   * страница с одним битым сообщением дала бы limit-1 -> has_more:false -> вызывающий
   * остановил бы пагинацию и МОЛЧА потерял бы всю историю старше этой страницы.
   */
  const rawCount = Array.isArray(entry?.Messages) ? entry.Messages.length : 0;
  /* Обогащение аддитивно поверх немутируемого v1-нормализатора (Fork D1): к каждому сообщению
   * добавляются НОВЫЕ ключи (reads/mentions/reactions_raw/thread/forwarded/from_me), v1-форма цела.
   * reactionMap отрисовывает сырые type в reactions (name/emoji), не роняя выдачу на неизвестном */
  const messages = enrichMessages(entry?.Messages, { myGuid: guid, reactionMap: deps.reactionMap });

  /* Сервер отдаёт страницу от старых к новым, поэтому курсор - метка первого элемента */
  const oldest = messages[0];

  deps.logger.debug('get_history: страница получена', {
    count: messages.length,
    attachments: messages.reduce((sum, message) => sum + message.attachments.length, 0),
    paged: input.before !== undefined,
  });

  return {
    status: 'ok',
    chat_id: resolved.chat_id,
    messages,
    ...(oldest !== undefined ? { next_before: oldest.timestamp_mcs } : {}),
    has_more: rawCount >= limit,
  };
}
