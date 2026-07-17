/**
 * Чтение опроса ДВУМЯ WS-вызовами (§14.3, живьём: 2026-07-17, базовый прогон + прогон с голосами).
 *
 * БАЗОВАЯ ФОРМА (первый прогон, без голосов). Вопрос, варианты и лимит выбора лежат в ТЕЛЕ
 * сообщения-опроса, а не в `poll_info`: `message_info {ChatId, Timestamp}` -> `Message.ServerMessage.
 * ClientMessage.Plain.Poll` вида `{Title, Answers:[string], MaxChoices:int, Results:{}}`. `Answers` -
 * массив СТРОК; индекс в массиве - адрес варианта для `vote_in_poll.choices`. `poll_info {ChatId,
 * Timestamp, Limit, ReturnResults:true}` пуст до первого голоса - `{Results:{}}`, ни `MyChoices`, ни
 * `AnswerVotes`. Пустой опрос - это НЕ поломка метода и НЕ признак «не опрос» (признак опроса - только
 * `Plain.Poll` в теле).
 *
 * ФОРМА С ГОЛОСАМИ (второй прогон, после первого голоса, §17.16). `poll_info` перестаёт быть пустым:
 * `Results:{Version, VotedCount, Answers:[int] (счётчики по вариантам, index-aligned), RecentVoters:
 * [UserInfo] (усечён)}`, плюс `MyChoices:[int]` (мой выбор) и `AnswerVotes:[{AnswerId?(0-based, опущен
 * при 0), TotalCount, Votes:[{Timestamp, UserInfo}]}]` - по одному элементу на вариант, У КОТОРОГО ЕСТЬ
 * ГОЛОСА (детальный разбор «кто и когда»). Та же тройка `Results/MyChoices/AnswerVotes` едет и в теле
 * сообщения (`Plain.Poll`), кроме `AnswerVotes` - его в теле нет, только в `poll_info`.
 *
 * АНОНИМНЫЙ ОПРОС - сервер СКРЫВАЕТ голосующих, не только UI. При `Plain.Poll.IsAnonymous:true`
 * (присутствует в теле, только если `true`) `poll_info` при наличии голосов отдаёт РОВНО `{Results:
 * {Version, VotedCount, Answers}, MyChoices}` - БЕЗ `AnswerVotes` и БЕЗ `Results.RecentVoters`, даже по
 * явному запросу `ReturnResults:true`. Доступны только агрегат по вариантам и свой выбор.
 *
 * ПОЭТОМУ ДВА ВЫЗОВА: `message_info` - обязательный источник вопроса/вариантов/лимита выбора и
 * признака «это опрос» (`Plain.Poll` присутствует). `poll_info` - за детальным разбором голосов
 * (`AnswerVotes`) и усечённым `RecentVoters`; если он их не отдал (аноним, либо голосов ещё нет),
 * агрегат берётся из тела. Признак «не опрос» смотрит ТОЛЬКО на `Plain.Poll`: если его нет,
 * `poll_info` не вызывается вовсе.
 *
 * ГОЛОСА ЗА ВАРИАНТ (`votes`) - `Results.Answers[i]` (счётчик по позиции) в приоритете,
 * `AnswerVotes[].TotalCount` - фоллбэк. `voters` (кто голосовал) - ТОЛЬКО из `AnswerVotes[].Votes`,
 * только не-анонимный опрос: `poll_info` для анонимного `AnswerVotes` не отдаёт вообще, и `voters`
 * не подставляется, а честно помечается `voters_hidden:true` (не выдумываем пустой список).
 *
 * МЕТКИ - СТРОКИ. И метка опроса, и метка конкретного голоса (`Votes[].Timestamp`) несут полную
 * микросекундную точность (§5, util/timestamps): на провод/с провода число, наружу - строка.
 */
import { asObject, numberOr, stringOr } from '../util/json.js';
import { parseMicros, toWireTimestamp } from '../util/timestamps.js';

/** WS-метод чтения тела сообщения-опроса (§14.3/§17.12) */
export const MESSAGE_INFO_METHOD = 'message_info';

/** WS-метод чтения агрегата опроса (§14.3) */
export const POLL_INFO_METHOD = 'poll_info';

/** `Limit` вариантов опроса (§14.3). Дефолт из доки */
export const DEFAULT_POLL_LIMIT = 50;

/** Минимальный контракт WS-клиента для чтения. `MessengerWsClient` ему удовлетворяет */
export interface PollInfoClient {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export interface ReadPollInput {
  chatId: string;
  /** Метка сообщения-опроса в мкс (строка/BigInt/число) */
  timestamp: string | bigint | number;
  /** Максимум вариантов агрегата `poll_info`; по умолчанию `DEFAULT_POLL_LIMIT` */
  limit?: number;
  /** Для чтения по join-ссылке (§17.11) */
  inviteHash?: string;
}

/** Проголосовавший за вариант (`AnswerVotes[].Votes[]`, живьём: только не-анонимный опрос) */
export interface PollVoter {
  /** `UserInfo.DisplayName`; отсутствует, если сервер имя не отдал */
  name?: string;
  /** Метка голоса в мкс (строка, полная точность) */
  timestamp: string;
}

/** Один вариант опроса (`Poll.Answers[]`, живьём: массив строк) */
export interface PollAnswer {
  /** Позиция варианта в `Poll.Answers`: адрес для голоса (`vote_in_poll.choices`) */
  index: number;
  /** Текст варианта из `Poll.Answers[index]` */
  title?: string;
  /** Число голосов за вариант: `Results.Answers[index]`, фоллбэк `AnswerVotes[].TotalCount` */
  votes?: number;
  /** Кто голосовал (имя+время): только не-анонимный опрос, из `AnswerVotes[].Votes` */
  voters?: PollVoter[];
}

export interface PollInfoResult {
  /** Это опрос: у сообщения есть `Plain.Poll` (признак «это опрос») */
  is_poll: true;
  /** Вопрос опроса (`Poll.Title`) */
  title?: string;
  /** Варианты, построенные из `Poll.Answers[]` */
  answers: PollAnswer[];
  /** Максимум выбираемых вариантов (`Poll.MaxChoices`) */
  max_choices?: number;
  /** Мои выбранные варианты (`MyChoices`, тело или `poll_info`) */
  my_choices: number[];
  /** Опрос анонимный (`Poll.IsAnonymous`, в теле присутствует только если `true`) */
  is_anonymous: boolean;
  /** Число уникальных проголосовавших (`Results.VotedCount`) - не сумма голосов по вариантам */
  voted_count?: number;
  /** Усечённый список недавних голосующих (`Results.RecentVoters`), только не-анонимный опрос */
  recent_voters?: Array<{ name?: string }>;
  /**
   * `true`, если опрос анонимный: сервер скрывает `AnswerVotes`/`RecentVoters` даже по явному
   * запросу - список голосующих по вариантам недоступен принципиально, не просто «ещё не пришёл»
   */
  voters_hidden?: true;
  /** Агрегированные результаты: `poll_info.Results`, либо `Poll.Results` из тела, если пусто */
  results?: unknown;
  /** Сырые ответы обоих вызовов на случай, если нормализация не покрыла форму */
  raw: { message_info: unknown; poll_info: unknown };
}

/** Ответ `message_info` не несёт `Plain.Poll`: сообщение не является опросом */
export class NotAPollError extends Error {
  constructor(
    readonly chatId: string,
    readonly timestampMcs: string,
  ) {
    super(`message_info: сообщение ${chatId}@${timestampMcs} не является опросом`);
    this.name = 'NotAPollError';
  }
}

interface MessageInfoResponse {
  Message?: unknown;
}

interface PollInfoResponse {
  MyChoices?: unknown;
  Results?: unknown;
  /** По одному элементу на вариант с голосами; отсутствует у анонимного опроса (живьём) */
  AnswerVotes?: unknown;
}

/** Читает первое присутствующее написание ключа: wire-регистр доко-выведен (как в push.ts) */
function pick(source: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/**
 * `Message` приходит на уровне `ServerMessage`. Живьём наблюдалась и голая форма
 * (`{ClientMessage, ServerMessageInfo}`), и обёртка `{ServerMessage:{...}}` (см. messageInfo.ts) -
 * поддерживаем обе, чтобы дрейф формы не ронял чтение.
 */
function resolveServerMessage(raw: unknown): unknown {
  const obj = asObject(raw);
  if (obj === undefined) {
    return raw;
  }
  const wrapped = obj['ServerMessage'];
  return asObject(wrapped) !== undefined ? wrapped : obj;
}

interface RawPoll {
  title?: string;
  /** `Poll.Answers[]` как есть: индекс элемента - адрес варианта, даже если элемент не строка */
  answerTitles: Array<string | undefined>;
  maxChoices?: number;
  /** Агрегат из тела (`Poll.Results`), может быть `{}` до голосов */
  results?: unknown;
  /** `Poll.MyChoices` из тела, фоллбэк, если `poll_info` их не отдал */
  myChoices?: unknown;
  /** `Poll.IsAnonymous`: в теле присутствует только если `true` (живьём) */
  isAnonymous: boolean;
}

/** Достаёт `ClientMessage.Plain.Poll` из ответа `message_info`. `undefined` = сообщение не опрос */
function extractPoll(response: MessageInfoResponse): RawPoll | undefined {
  const serverMessage = asObject(resolveServerMessage(response.Message));
  const clientMessage = asObject(serverMessage?.['ClientMessage']);
  const plain = asObject(clientMessage?.['Plain']) ?? asObject(clientMessage?.['Ephemeral']);
  const poll = asObject(plain?.['Poll']);
  if (poll === undefined) {
    return undefined;
  }

  const rawAnswers = poll['Answers'];
  const answerTitles = Array.isArray(rawAnswers) ? rawAnswers.map((item) => stringOr(item)) : [];
  const title = stringOr(poll['Title']);
  const maxChoices = numberOr(poll['MaxChoices']);

  return {
    ...(title !== undefined ? { title } : {}),
    answerTitles,
    ...(maxChoices !== undefined ? { maxChoices } : {}),
    results: poll['Results'],
    myChoices: poll['MyChoices'],
    isAnonymous: poll['IsAnonymous'] === true,
  };
}

/** `MyChoices` -> индексы выбранных вариантов. Нечисловой элемент отбрасывается */
function parseMyChoices(raw: unknown): number[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const choices: number[] = [];
  for (const item of raw) {
    const value = numberOr(item);
    if (value !== undefined) {
      choices.push(value);
    }
  }
  return choices;
}

/** Метка конкретного голоса (`Votes[].Timestamp`): строка/BigInt/число - наружу всегда строка мкс */
function voteTimestamp(value: unknown): string | undefined {
  try {
    return parseMicros(value).toString();
  } catch {
    return undefined;
  }
}

/** `AnswerVotes[].Votes[]` -> `{name?, timestamp}[]`. Элемент без валидной метки отбрасывается */
function parseVoters(rawVotes: unknown): PollVoter[] {
  if (!Array.isArray(rawVotes)) {
    return [];
  }
  const voters: PollVoter[] = [];
  for (const item of rawVotes) {
    const obj = asObject(item);
    const timestamp = voteTimestamp(obj?.['Timestamp']);
    if (timestamp === undefined) {
      continue;
    }
    const userInfo = asObject(obj?.['UserInfo']);
    const name = stringOr(userInfo?.['DisplayName']);
    voters.push({ ...(name !== undefined ? { name } : {}), timestamp });
  }
  return voters;
}

/**
 * `AnswerVotes[]` -> карта `AnswerId -> {totalCount, voters}`. `AnswerId` опущен, когда индекс
 * варианта = 0 (живьём, §14.3) - отсутствующий ключ трактуется как `0`, а не как «неизвестно».
 */
function parseAnswerVotes(raw: unknown): Map<number, { totalCount?: number; voters: PollVoter[] }> {
  const map = new Map<number, { totalCount?: number; voters: PollVoter[] }>();
  if (!Array.isArray(raw)) {
    return map;
  }
  for (const item of raw) {
    const obj = asObject(item);
    if (obj === undefined) {
      continue;
    }
    const answerId = numberOr(obj['AnswerId']) ?? 0;
    const totalCount = numberOr(obj['TotalCount']);
    map.set(answerId, {
      ...(totalCount !== undefined ? { totalCount } : {}),
      voters: parseVoters(obj['Votes']),
    });
  }
  return map;
}

/** `Results.Answers[]` -> счётчики по позиции варианта (index-aligned, живьём). Нечисло -> 0 */
function resultsAnswerCounts(results: Record<string, unknown>): number[] | undefined {
  const answers = results['Answers'];
  if (!Array.isArray(answers)) {
    return undefined;
  }
  return answers.map((item) => numberOr(item) ?? 0);
}

/** `Results.RecentVoters[]`/`UserInfo[]` -> `{name?}[]` (усечённый список, только не-анонимный) */
function parseUserNames(raw: unknown): Array<{ name?: string }> {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((item) => {
    const obj = asObject(item);
    const name = stringOr(obj?.['DisplayName']);
    return name !== undefined ? { name } : {};
  });
}

function buildAnswers(
  answerTitles: Array<string | undefined>,
  resultsCounts: number[] | undefined,
  answerVotes: Map<number, { totalCount?: number; voters: PollVoter[] }>,
): PollAnswer[] {
  return answerTitles.map((title, index) => {
    const perAnswer = answerVotes.get(index);
    const votes = resultsCounts?.[index] ?? perAnswer?.totalCount;
    const voters = perAnswer?.voters;
    return {
      index,
      ...(title !== undefined ? { title } : {}),
      ...(votes !== undefined ? { votes } : {}),
      ...(voters !== undefined && voters.length > 0 ? { voters } : {}),
    };
  });
}

/**
 * Читает опрос по метке: `message_info` за вопросом/вариантами/лимитом выбора (обязательный
 * источник, признак «это опрос»), `poll_info` за детальным разбором голосов (доп. вызов, только
 * если сообщение - опрос). Не опрос (нет `Plain.Poll`) - `NotAPollError`, `poll_info` не дёргается.
 */
export async function readPoll(client: PollInfoClient, input: ReadPollInput): Promise<PollInfoResult> {
  const micros = parseMicros(input.timestamp);
  const wireTimestamp = toWireTimestamp(micros);

  const messageInfoParams: Record<string, unknown> = { ChatId: input.chatId, Timestamp: wireTimestamp };
  if (input.inviteHash !== undefined) {
    messageInfoParams['InviteHash'] = input.inviteHash;
  }
  const messageInfoResponse = await client.request<MessageInfoResponse>(MESSAGE_INFO_METHOD, messageInfoParams);

  const poll = extractPoll(messageInfoResponse);
  if (poll === undefined) {
    throw new NotAPollError(input.chatId, micros.toString());
  }

  const pollInfoParams: Record<string, unknown> = {
    ChatId: input.chatId,
    Timestamp: wireTimestamp,
    Limit: input.limit ?? DEFAULT_POLL_LIMIT,
    ReturnResults: true,
  };
  if (input.inviteHash !== undefined) {
    pollInfoParams['InviteHash'] = input.inviteHash;
  }
  const pollInfoResponse = await client.request<PollInfoResponse>(POLL_INFO_METHOD, pollInfoParams);
  const pollInfoBody = asObject(pollInfoResponse) ?? {};

  /* poll_info - основной источник агрегата; тело - фоллбэк, если poll_info его не отдал */
  const resultsObj = asObject(pick(pollInfoBody, 'Results')) ?? asObject(poll.results) ?? {};
  const myChoices = parseMyChoices(pick(pollInfoBody, 'MyChoices') ?? poll.myChoices);
  const answerVotes = parseAnswerVotes(pollInfoBody['AnswerVotes']);
  const resultsCounts = resultsAnswerCounts(resultsObj);
  const votedCount = numberOr(resultsObj['VotedCount']);
  const recentVoters = parseUserNames(resultsObj['RecentVoters']);

  return {
    is_poll: true,
    ...(poll.title !== undefined ? { title: poll.title } : {}),
    answers: buildAnswers(poll.answerTitles, resultsCounts, answerVotes),
    ...(poll.maxChoices !== undefined ? { max_choices: poll.maxChoices } : {}),
    my_choices: myChoices,
    is_anonymous: poll.isAnonymous,
    ...(votedCount !== undefined ? { voted_count: votedCount } : {}),
    ...(recentVoters.length > 0 ? { recent_voters: recentVoters } : {}),
    ...(poll.isAnonymous ? { voters_hidden: true } : {}),
    results: resultsObj,
    raw: { message_info: messageInfoResponse, poll_info: pollInfoResponse },
  };
}
