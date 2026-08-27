/**
 * `mark_read` - отметить чат прочитанным ОДНИМ вызовом, без confirm: безобидно, сообщает
 * факт, который и так наступил (спека Round 7).
 *
 * ФОРМА ПРИНЯТА ЖИВЬЁМ (US-009, self-чат 2026-07-17), выбран маркер `SeenMarker`. Перебор
 * трёх форм §9.3 на проводе: `SeenMarker`/`ReadMarker`/`UnseenMarker` - ВСЕ принимаются
 * бэкендом (никакого `BACKEND_CALL_ERROR(2)`), но ведут себя по-разному. В уже полностью
 * прочитанном self-чате `SeenMarker` отвечает `DUPLICATE(8)` (сервер сверил с текущей
 * seen-позицией и не нашёл нового), а `ReadMarker`/`UnseenMarker` коммитят `FULLY_COMMITTED(1)`
 * заново - то есть seen-позицию (от которой считается непрочитанное) двигает именно
 * `SeenMarker`.
 *
 * ЭФФЕКТ ПОДТВЕРЖДЁН ЖИВЬЁМ (2026-07-18): `SeenMarker` реально обнуляет непрочитанное.
 * Раньше обнуление НЕНУЛЕВОГО непрочитанного было долгом - в self-чате оно структурно не
 * наблюдаемо (свои же исходящие сразу «увидены мной»). Проверено в приватном чате с
 * непрочитанными сообщениями от второго аккаунта пользователя: `unread_count:2` ->
 * `mark_read` -> `commit_status:1 FULLY_COMMITTED` (не `DUPLICATE`, т.к. было что
 * коммитить) -> повторное чтение чата дало `unread_count:0`. `form_status: verified`.
 * Обоснование выбора маркера - в protocol/mutations.buildReadMarkerMutation.
 *
 * ГРАНИЦА «ДО КУДА ПРОЧИТАНО». Непрочитанное в §17.9 - это `LastSeqNo - LastSeenByMeSeqNo`.
 * Обнулить его = отметить увиденным вплоть до самого свежего сообщения. Дал вызывающий
 * message_id - берём его; иначе тянем последнюю страницу истории (один запрос) и берём
 * метку самого свежего сообщения. Это по-прежнему ОДИН вызов инструмента, без confirm.
 */
import { resolveChat, type ChatCandidate } from '../../chat/resolveChat.js';
import {
  buildChatResolveFailure,
  requestChatAddressed,
  type ChatResolveFailure,
} from '../../chat/resolveFailure.js';
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
      /** Выбранный маркер: форма принята живьём, seen-позиция двигается им (US-009) */
      marker: 'SeenMarker';
      /**
       * Форма и эффект подтверждены живьём (US-009, 2026-07-18): маркер коммитится бэкендом
       * и реально обнуляет непрочитанное - проверено на чате с непрочитанными сообщениями
       * от другого аккаунта (`unread_count` 2 -> 0).
       */
      form_status: 'verified';
    }
  | { status: 'empty_chat'; chat_id: string }
  | { status: 'ambiguous_chat'; candidates: ChatCandidate[] }
  | ChatResolveFailure;

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
    return buildChatResolveFailure({ query: input.chat, reason: 'name_not_found' });
  }

  let upToTimestamp = input.message_id;
  let seqNo = input.seqno;
  if (upToTimestamp === undefined) {
    /*
     * Границу берём страницей истории, и адресуется тут только чат: метки в параметрах нет вовсе.
     * Ветка с заданным message_id этого вызова не делает, поэтому перехват стоит именно здесь.
     */
    const newestPage = await requestChatAddressed(
      { addresses: 'chat_only', query: input.chat, resolved },
      () =>
        deps.ws.request<HistoryResponse>(
          'history',
          buildHistoryParams({ chatId: resolved.chat_id, limit: NEWEST_PAGE_LIMIT }),
        ),
    );
    if (!newestPage.ok) {
      return newestPage.failure;
    }
    const entry = findChatEntry(newestPage.value, resolved.chat_id) as { Messages?: unknown } | undefined;
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
    form_status: 'verified',
  };
}
