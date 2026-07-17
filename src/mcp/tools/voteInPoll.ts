/**
 * `vote_in_poll` - голос в опросе. EXPERIMENTAL: форма `Vote` (§9.3/§11.4) ДОКО-ВЫВЕДЕНА и
 * живьём НЕ проверена (голос в self-чате недостижим - создание опроса Non-Goal). Поэтому
 * выдача И draft, И confirm несёт `form_status: experimental_unverified` - предупреждение стоит
 * в точке необратимого действия, а не только в README. AC-29 НЕ засчитывается, пока живой
 * `myChoices` не подтвердит голос (условный долг).
 *
 * ПОЧЕМУ CONFIRM. Механики снятия/смены голоса в протоколе не обнаружено - голос необратим,
 * поэтому он двухшаговый (draft->confirm), как send/delete/edit. Если живой прогон найдёт
 * снятие/смену - основание для confirm отпадает и он пересматривается.
 *
 * ШАГ 1 (по умолчанию): резолв чата -> confirm-токен с выбранными вариантами. В сокет НЕ уходит
 * ничего. ШАГ 2 (`confirm:true` + токен): ре-верификация чата и выбора -> `Vote{ChatId, Timestamp,
 * Choices, Results}` полным конвертом.
 *
 * ИДЕМПОТЕНТНОСТЬ - TARGET-ПУТЬ (без `payload_id`, серверный `DUPLICATE(8)` НЕ обещается): защита
 * от повтора в пределах сессии - локальная память `recallResult`.
 */
import { resolveChat, type ChatCandidate } from '../../chat/resolveChat.js';
import { encodeToken, fingerprint, recallResult, rememberResult, verifyConfirmToken, type DraftToken } from '../confirm.js';
import { buildVoteMutation, pushMutation } from '../../protocol/mutations.js';
import type { ToolDeps } from './deps.js';

/** Маркер непроверенной формы: голос строится на доко-выведенном `Vote`, живьём не наблюдался */
export const VOTE_FORM_STATUS = 'experimental_unverified';

/** `| undefined` в полях - осознанно: под exactOptionalPropertyTypes zod отдаёт именно такой тип */
export interface VoteInPollInput {
  chat: string;
  message_id: string;
  /** Выбранные варианты. Единица (индекс/id) ДОКО-ВЫВЕДЕНА (§11.4) */
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
  /** Форма голоса доко-выведена и живьём не проверена: предупреждение в точке действия */
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
  /** Форма голоса доко-выведена: AC-29 не засчитан без живого myChoices (условный долг) */
  form_status: typeof VOTE_FORM_STATUS;
}

export type VoteInPollResult =
  | VoteInPollDraft
  | VoteInPollVoted
  | { status: 'ambiguous_chat'; candidates: ChatCandidate[] }
  | { status: 'chat_not_found'; query: string };

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
    return { status: 'chat_not_found', query: input.chat };
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
        'Голос НЕ отправлен. Форма голоса доко-выведена и живьём не проверена (form_status: ' +
        'experimental_unverified). Чтобы проголосовать, повторите вызов с confirm:true, тем же ' +
        'confirm_token и НЕИЗМЕНЁННЫМИ chat, message_id и choices.',
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
  deps.logger.info('vote_in_poll: голос отправлен (форма experimental)', { commit: outcome.status_name });
  return result;
}
