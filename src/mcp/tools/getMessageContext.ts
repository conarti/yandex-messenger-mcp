/**
 * `get_message_context` - окно сообщений вокруг метки: N до и N после (§14.2).
 *
 * ОКНО ИЗ ГРАНИЦ `history`. Отдельного «context»-метода нет - окно строится теми же
 * `MinTimestamp`/`MaxTimestamp`/`Limit`, что и пагинация:
 *  - сторона «до»: `MaxTimestamp = pivot+1` (ВКЛЮЧАЮЩАЯ метку, `includeUpTo`), `Limit = before+1`.
 *    Сервер отдаёт `before+1` самых свежих сообщений НЕ НОВЕЕ метки, то есть саму метку плюс
 *    `before` предыдущих. Верхняя граница исключающая, поэтому `pivot+1` нужен, чтобы захватить
 *    саму метку (инвариант v1, util/timestamps).
 *  - сторона «после»: `MinTimestamp = pivot` (нижняя граница тоже исключающая, §14.2), `Limit = after`.
 *    Возвращает `after` сообщений строго НОВЕЕ метки, ближайшие к ней.
 *
 * КУРСОРЫ - BigInt, НЕ float. Метка 16-значная, арифметика границ (`pivot+1`) правит младший
 * разряд - на float это потеря точности у 2^53 (util/timestamps).
 *
 * САМА МЕТКА выделяется из окна «до» сверкой `timestamp_mcs`: если сообщение по метке ещё живо,
 * оно уезжает в `message`, иначе `message` пуст (удалено/отфильтровано), а `before`/`after` целы.
 */
import { resolveChat, type ChatCandidate } from '../../chat/resolveChat.js';
import {
  buildChatResolveFailure,
  requestChatAddressed,
  type ChatResolveFailure,
} from '../../chat/resolveFailure.js';
import { enrichMessages, type EnrichedMessage } from '../../protocol/enrichMessage.js';
import { buildHistoryParams, findChatEntry, type HistoryResponse } from '../../protocol/history.js';
import { includeUpTo, parseMicros } from '../../util/timestamps.js';
import type { ToolDeps } from './deps.js';

/** `| undefined` в полях - осознанно: под exactOptionalPropertyTypes zod отдаёт именно такой тип */
export interface GetMessageContextInput {
  chat: string;
  /** Метка целевого сообщения в мкс строкой (то же, что message_id в get_message) */
  message_id: string;
  /** Сколько сообщений ДО метки (по умолчанию DEFAULT_CONTEXT_WINDOW) */
  before?: number | undefined;
  /** Сколько сообщений ПОСЛЕ метки (по умолчанию DEFAULT_CONTEXT_WINDOW) */
  after?: number | undefined;
}

export type GetMessageContextResult =
  | {
      status: 'ok';
      chat_id: string;
      pivot_timestamp_mcs: string;
      /** Сообщения ДО метки, от старых к новым */
      before: EnrichedMessage[];
      /** Сообщение по метке, если оно ещё живо (не удалено/не отфильтровано) */
      message?: EnrichedMessage;
      /** Сообщения ПОСЛЕ метки, от старых к новым */
      after: EnrichedMessage[];
    }
  | { status: 'ambiguous_chat'; candidates: ChatCandidate[] }
  | ChatResolveFailure;

export const DEFAULT_CONTEXT_WINDOW = 10;

function extractMessages(response: HistoryResponse, chatId: string): unknown {
  const entry = findChatEntry(response, chatId) as { Messages?: unknown } | undefined;
  return entry?.Messages;
}

export async function getMessageContext(
  deps: ToolDeps,
  input: GetMessageContextInput,
): Promise<GetMessageContextResult> {
  const before = input.before ?? DEFAULT_CONTEXT_WINDOW;
  const after = input.after ?? DEFAULT_CONTEXT_WINDOW;
  const pivot = parseMicros(input.message_id);
  const pivotMcs = pivot.toString();

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
  const chatId = resolved.chat_id;
  const enrichCtx = { myGuid: guid, reactionMap: deps.reactionMap };

  /*
   * Сторона «до» + сама метка: MaxTimestamp=pivot+1 включает метку, Limit=before+1 берёт её и before предыдущих.
   * Окно строится границами `history`, а не адресом сообщения: существование самой метки вызову не
   * требуется (несуществующий пивот даёт окно без пивота, поле `message` опционально). Значит,
   * `ENTITY_NOT_FOUND(4)` здесь может быть только про чат.
   */
  const beforeCall = await requestChatAddressed(
    { addresses: 'chat_only', query: input.chat, resolved },
    () =>
      deps.ws.request<HistoryResponse>(
        'history',
        buildHistoryParams({ chatId, limit: before + 1, maxTimestamp: includeUpTo(pivot) }),
      ),
  );
  if (!beforeCall.ok) {
    return beforeCall.failure;
  }
  const beforeAndPivot = enrichMessages(extractMessages(beforeCall.value, chatId), enrichCtx);

  let message: EnrichedMessage | undefined;
  let beforeWindow = beforeAndPivot;
  const last = beforeAndPivot.at(-1);
  if (last?.timestamp_mcs === pivotMcs) {
    message = last;
    beforeWindow = beforeAndPivot.slice(0, -1);
  }

  /* Сторона «после»: MinTimestamp=pivot (исключающая) даёт строго новее метки. Пропускаем при after=0 */
  let afterWindow: EnrichedMessage[] = [];
  if (after > 0) {
    const afterCall = await requestChatAddressed(
      { addresses: 'chat_only', query: input.chat, resolved },
      () =>
        deps.ws.request<HistoryResponse>(
          'history',
          buildHistoryParams({ chatId, limit: after, minTimestamp: pivot }),
        ),
    );
    if (!afterCall.ok) {
      return afterCall.failure;
    }
    afterWindow = enrichMessages(extractMessages(afterCall.value, chatId), enrichCtx).filter(
      (item) => item.timestamp_mcs !== pivotMcs,
    );
  }

  deps.logger.debug('get_message_context: окно собрано', {
    before: beforeWindow.length,
    after: afterWindow.length,
    pivot_present: message !== undefined,
  });

  return {
    status: 'ok',
    chat_id: chatId,
    pivot_timestamp_mcs: pivotMcs,
    before: beforeWindow,
    ...(message !== undefined ? { message } : {}),
    after: afterWindow,
  };
}
