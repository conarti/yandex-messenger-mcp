/**
 * `mark_read` - отметить чат прочитанным ОДНИМ вызовом, без confirm: безобидно, сообщает
 * факт, который и так наступил (спека Round 7).
 *
 * ⚠️ ФОРМА ДОКО-ВЫВЕДЕНА (US-009/Phase 0), живьём НЕ подтверждена. Выбран маркер
 * `SeenMarker` (обоснование - в protocol/mutations.buildReadMarkerMutation). До живого
 * подтверждения помечено в README; в выдаче инструмента виден `form_status`.
 *
 * ГРАНИЦА «ДО КУДА ПРОЧИТАНО». Непрочитанное в §17.9 - это `LastSeqNo - LastSeenByMeSeqNo`.
 * Обнулить его = отметить увиденным вплоть до самого свежего сообщения. Дал вызывающий
 * message_id - берём его; иначе тянем последнюю страницу истории (один запрос) и берём
 * метку самого свежего сообщения. Это по-прежнему ОДИН вызов инструмента, без confirm.
 */
import { resolveChat, type ChatCandidate } from '../../chat/resolveChat.js';
import { enrichMessages } from '../../protocol/enrichMessage.js';
import { buildHistoryParams, findChatEntry, type HistoryResponse } from '../../protocol/history.js';
import { buildReadMarkerMutation, pushMutation } from '../../protocol/mutations.js';
import type { ToolDeps } from './deps.js';

/** `| undefined` в полях - осознанно: под exactOptionalPropertyTypes zod отдаёт именно такой тип */
export interface MarkReadInput {
  chat: string;
  /** Метка (мкс), до которой включительно отметить прочитанным. Без неё - до самого свежего */
  message_id?: string | undefined;
  /** SeqNo той же границы (§9.3 SeenMarker несёт SeqNo); необязателен */
  seqno?: number | undefined;
}

export type MarkReadResult =
  | {
      status: 'ok';
      chat_id: string;
      /** Метка (мкс), до которой отмечено прочитанным */
      up_to_message_id: string;
      commit_status: number;
      commit_status_name: string;
      /** Выбранный маркер: доко-выведен, живьём не подтверждён (US-009) */
      marker: 'SeenMarker';
      /** Форма доко-выведена: предупреждение видно в выдаче, не только в README */
      form_status: 'doc_derived_unverified';
    }
  | { status: 'empty_chat'; chat_id: string }
  | { status: 'ambiguous_chat'; candidates: ChatCandidate[] }
  | { status: 'chat_not_found'; query: string };

/** Страница истории, чтобы взять самую свежую метку, когда message_id не задан */
const NEWEST_PAGE_LIMIT = 1;

export async function markRead(deps: ToolDeps, input: MarkReadInput): Promise<MarkReadResult> {
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

  let upToTimestamp = input.message_id;
  let seqNo = input.seqno;
  if (upToTimestamp === undefined) {
    const response = await deps.ws.request<HistoryResponse>(
      'history',
      buildHistoryParams({ chatId: resolved.chat_id, limit: NEWEST_PAGE_LIMIT }),
    );
    const entry = findChatEntry(response, resolved.chat_id) as { Messages?: unknown } | undefined;
    /* Страница приходит от старых к новым - самое свежее в хвосте */
    const newest = enrichMessages(entry?.Messages, { myGuid: guid, reactionMap: deps.reactionMap }).at(-1);
    if (newest === undefined) {
      /* Нечего отмечать: чат пуст либо сервер ничего не отдал */
      return { status: 'empty_chat', chat_id: resolved.chat_id };
    }
    upToTimestamp = newest.timestamp_mcs;
    seqNo = newest.seq_no ?? seqNo;
  }

  const outcome = await pushMutation(
    { ws: deps.ws, auth: deps.auth, serviceId: deps.config.protocol.serviceId },
    buildReadMarkerMutation({
      chatId: resolved.chat_id,
      timestamp: upToTimestamp,
      ...(seqNo !== undefined ? { seqNo } : {}),
    }),
  );

  deps.logger.info('mark_read: отправлено', { commit: outcome.status_name });
  return {
    status: 'ok',
    chat_id: resolved.chat_id,
    up_to_message_id: upToTimestamp,
    commit_status: outcome.status,
    commit_status_name: outcome.status_name,
    marker: 'SeenMarker',
    form_status: 'doc_derived_unverified',
  };
}
