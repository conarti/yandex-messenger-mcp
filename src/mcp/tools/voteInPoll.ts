/**
 * `vote_in_poll` - голос в опросе. Форма `Vote` (§9.3/§11.4) подтверждена живьём (2026-07-17):
 * `commit_status:1 FULLY_COMMITTED`, повторное чтение показало смену `my_choices` с `[0]` на
 * `[1]` после повторной отправки. Голос ПУБЛИЧЕН и МЕНЯЕМЫЙ: `choices` - это ПОЛНЫЙ набор
 * выбора, повторная отправка ЗАМЕНЯЕТ прежний (несколько вариантов - все индексы в одном
 * `Choices`).
 *
 * ПОЧЕМУ CONFIRM. Confirm сохранён, потому что сам факт голоса необратим: `voted_count` растёт,
 * а в не-анонимном опросе голосующий попадает в список голосовавших. Отменить голос до нуля
 * протоколом не подтверждено - это единственный оставшийся мелкий вопрос.
 *
 * ШАГ 1 (по умолчанию): резолв чата -> confirm-токен с выбранными вариантами. В сокет НЕ уходит
 * ничего. ШАГ 2 (`confirm:true` + токен): ре-верификация чата и выбора -> `Vote{ChatId, Timestamp,
 * Action:0, Choices}` полным конвертом (форма подтверждена живьём, §11.4, БЕЗ `Results`).
 *
 * ИДЕМПОТЕНТНОСТЬ - TARGET-ПУТЬ (без `payload_id`, серверный `DUPLICATE(8)` НЕ обещается): защита
 * от повтора в пределах сессии - локальная память `recallResult`.
 */
import { resolveChat, type ChatCandidate } from '../../chat/resolveChat.js';
import { buildChatResolveFailure, type ChatResolveFailure } from '../../chat/resolveFailure.js';
import { encodeToken, fingerprint, recallResult, rememberResult, verifyConfirmToken, type DraftToken } from '../confirm.js';
import { buildVoteMutation, pushMutation } from '../../protocol/mutations.js';
import type { ToolDeps } from './deps.js';

/** Маркер подтверждённой формы: голос `Vote` (Action:0, Choices) подтверждён живьём (2026-07-17) */
export const VOTE_FORM_STATUS = 'verified';

/** `| undefined` в полях - осознанно: под exactOptionalPropertyTypes zod отдаёт именно такой тип */
export interface VoteInPollInput {
  chat: string;
  message_id: string;
  /** Выбранные варианты: 0-based индексы в Poll.Answers[] (§11.4). ПОЛНЫЙ набор - повторная отправка заменяет */
  choices: number[];
  confirm?: boolean | undefined;
  confirm_token?: string | undefined;
}

export interface VoteInPollDraft {
  status: 'draft';
  chat_id: string;
  message_id: string;
  choices: number[];
  confirm_token: string;
  /** Форма голоса подтверждена живьём (2026-07-17): маркер в точке действия для прозрачности */
  form_status: typeof VOTE_FORM_STATUS;
  next_step: string;
}

export interface VoteInPollVoted {
  status: 'voted';
  chat_id: string;
  message_id: string;
  choices: number[];
  commit_status: number;
  commit_status_name: string;
  /** Форма голоса подтверждена живьём (2026-07-17, FULLY_COMMITTED); AC-29 закрыт */
  form_status: typeof VOTE_FORM_STATUS;
}

export type VoteInPollResult =
  | VoteInPollDraft
  | VoteInPollVoted
  | { status: 'ambiguous_chat'; candidates: ChatCandidate[] }
  | ChatResolveFailure;

/** Отпечаток vote-пути: чат + метка опроса + выбор (смена выбора инвалидирует токен) */
function voteFingerprint(chatId: string, messageId: string, choices: number[]): string {
  return fingerprint('vote', `${chatId}:${messageId}:${choices.join(',')}`);
}

export async function voteInPoll(deps: ToolDeps, input: VoteInPollInput): Promise<VoteInPollResult> {
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

  if (input.confirm !== true) {
    const draft: DraftToken = {
      op: 'vote',
      chat_id: resolved.chat_id,
      fingerprint: voteFingerprint(resolved.chat_id, input.message_id, input.choices),
    };
    deps.logger.info('vote_in_poll: подготовлен draft, голос не отправлен', { via: resolved.via });
    return {
      status: 'draft',
      chat_id: resolved.chat_id,
      message_id: input.message_id,
      choices: input.choices,
      confirm_token: encodeToken(draft),
      form_status: VOTE_FORM_STATUS,
      next_step:
        'Голос НЕ отправлен. Форма голоса подтверждена живьём (2026-07-17). Голос ПУБЛИЧЕН и ' +
        'МЕНЯЕМЫЙ: choices - это ПОЛНЫЙ набор выбора, повторная отправка ЗАМЕНЯЕТ прежний ' +
        '(несколько вариантов - все индексы в одном choices). Confirm сохранён, потому что сам ' +
        'факт голоса необратим (voted_count растёт, в не-анонимном опросе вы попадаете в список ' +
        'голосовавших); отменить голос до нуля протоколом не подтверждено. Чтобы проголосовать, ' +
        'повторите вызов с confirm:true, тем же confirm_token и НЕИЗМЕНЁННЫМИ chat, message_id и choices.',
    };
  }

  const token = input.confirm_token ?? '';
  const draft = verifyConfirmToken({
    op: 'vote',
    token,
    chatId: resolved.chat_id,
    fingerprint: voteFingerprint(resolved.chat_id, input.message_id, input.choices),
  });

  const remembered = recallResult<VoteInPollVoted>(token);
  if (remembered !== undefined) {
    deps.logger.warn('vote_in_poll: повторный confirm тем же токеном, второй push не отправлен');
    return remembered;
  }

  const outcome = await pushMutation(
    { ws: deps.ws, auth: deps.auth, serviceId: deps.config.protocol.serviceId },
    buildVoteMutation({ chatId: draft.chat_id, timestamp: input.message_id, choices: input.choices }),
  );

  const result: VoteInPollVoted = {
    status: 'voted',
    chat_id: draft.chat_id,
    message_id: input.message_id,
    choices: input.choices,
    commit_status: outcome.status,
    commit_status_name: outcome.status_name,
    form_status: VOTE_FORM_STATUS,
  };
  rememberResult(token, result);
  deps.logger.info('vote_in_poll: голос отправлен (форма подтверждена)', { commit: outcome.status_name });
  return result;
}
