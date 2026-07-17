/**
 * `get_poll` - чтение опроса по chat + message_id, БЕЗ confirm: это read-путь. Вопрос/варианты/
 * лимит выбора читаются из тела сообщения (`message_info`, живьём: §17.15), агрегированные
 * результаты - из `poll_info`. Отдаёт `title`, `answers` (с `title`/`votes`), `max_choices`, мой
 * выбор (`my_choices`) и результаты (`results`).
 *
 * ЧТЕНИЕ РАЗРЕШЕНО ВЕЗДЕ и проверяемо против ЛЮБОГО реального опроса в любом чате - в отличие от
 * голоса (`vote_in_poll`), недостижимого в self-чате. Признак «это опрос» виден и в обычной выдаче
 * сообщения (`kind:'poll'`, messageShape), и здесь полем `is_poll`.
 *
 * НЕ ОПРОС -> внятный статус. Если тело сообщения не несёт `Plain.Poll`, сообщение не опрос:
 * возвращается `not_a_poll`, а пустая структура за опрос не выдаётся.
 */
import { resolveChat, type ChatCandidate } from '../../chat/resolveChat.js';
import { NotAPollError, readPoll, type PollInfoResult } from '../../protocol/poll.js';
import type { ToolDeps } from './deps.js';

/** `| undefined` в полях - осознанно: под exactOptionalPropertyTypes zod отдаёт именно такой тип */
export interface GetPollInput {
  chat: string;
  message_id: string;
}

export type GetPollResult =
  | ({ status: 'ok'; chat_id: string; message_id: string } & PollInfoResult)
  | { status: 'not_a_poll'; chat_id: string; message_id: string }
  | { status: 'ambiguous_chat'; candidates: ChatCandidate[] }
  | { status: 'chat_not_found'; query: string };

export async function getPoll(deps: ToolDeps, input: GetPollInput): Promise<GetPollResult> {
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

  try {
    const poll = await readPoll(deps.ws, { chatId: resolved.chat_id, timestamp: input.message_id });
    deps.logger.debug('get_poll: опрос прочитан', { answers: poll.answers.length });
    return { status: 'ok', chat_id: resolved.chat_id, message_id: input.message_id, ...poll };
  } catch (error) {
    if (error instanceof NotAPollError) {
      return { status: 'not_a_poll', chat_id: resolved.chat_id, message_id: input.message_id };
    }
    throw error;
  }
}
