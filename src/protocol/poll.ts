/**
 * Чтение опроса через WS `poll_info` (§14.3): `{ChatId, Timestamp, Limit:50, ReturnResults:true}`
 * -> `{answerVotes, myChoices, results}`.
 *
 * ЧТЕНИЕ ОТДЕЛЕНО ОТ ГОЛОСА. Чтение опроса разрешено везде (read-путь) и проверяемо против
 * ЛЮБОГО реального опроса в любом чате - поэтому оно не гейтится self-чатом и не несёт
 * confirm. Голос (`vote_in_poll`, форма `Vote` §11.4) - отдельный необратимый путь с confirm
 * и `form_status: experimental_unverified`, живьём непроверенный (см. protocol/mutations.buildVoteMutation).
 *
 * ФОРМА ОТВЕТА ДОКО-ВЫВЕДЕНА. Имена `answerVotes`/`myChoices`/`results` взяты из доки и живьём
 * не наблюдались; wire-регистр (camelCase vs PascalCase) неизвестен, поэтому читаются оба
 * написания, как в push.ts. Нормализация мягкая: неизвестная форма варианта не роняет чтение,
 * а сырой ответ доступен в `raw` - расхождение фиксируется правкой доки, а не подгонкой.
 *
 * МЕТКИ - СТРОКИ. `Timestamp` опроса несёт полную точность (§5, util/timestamps), на провод
 * уходит числом (JSON-тело), но наружу отдаётся строкой.
 */
import { asObject, numberOr, stringOr } from '../util/json.js';
import { parseMicros, toWireTimestamp } from '../util/timestamps.js';

/** WS-метод чтения опроса (§14.3) */
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
  /** Максимум вариантов; по умолчанию `DEFAULT_POLL_LIMIT` */
  limit?: number;
  /** Для чтения по join-ссылке (§17.11) */
  inviteHash?: string;
}

/** Один вариант опроса с числом голосов (`answerVotes[]`, доко-выведено) */
export interface PollAnswer {
  /** Позиция варианта: адрес для голоса (`choices`) */
  index: number;
  /** Текст варианта, если пришёл */
  title?: string;
  /** Число голосов за вариант, если пришло */
  votes?: number;
}

export interface PollInfoResult {
  /** Это опрос: `poll_info` вернул структуру опроса (признак «это опрос») */
  is_poll: true;
  /** Варианты и голоса (`answerVotes`), нормализованные мягко */
  answers: PollAnswer[];
  /** Мои выбранные варианты (`myChoices`): индексы/id */
  my_choices: number[];
  /** Агрегированные результаты (`results`), как пришли (форма доко-выведена) */
  results?: unknown;
  /** Сырой ответ на случай, если нормализация не покрыла форму (доко-выведено) */
  raw: unknown;
}

/** Ответ `poll_info` не похож на опрос: ни вариантов, ни результатов */
export class NotAPollError extends Error {
  constructor(
    readonly chatId: string,
    readonly timestampMcs: string,
  ) {
    super(`poll_info: сообщение ${chatId}@${timestampMcs} не является опросом`);
    this.name = 'NotAPollError';
  }
}

interface PollInfoResponse {
  answerVotes?: unknown;
  AnswerVotes?: unknown;
  myChoices?: unknown;
  MyChoices?: unknown;
  results?: unknown;
  Results?: unknown;
}

/** Читает первое присутствующее написание ключа: wire-регистр ответа доко-выведен */
function pick(source: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/** `answerVotes[]` -> варианты. Элемент бывает объектом `{Answer, Votes}` либо голым числом голосов */
function parseAnswers(raw: unknown): PollAnswer[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const answers: PollAnswer[] = [];
  raw.forEach((item, index) => {
    const obj = asObject(item);
    if (obj === undefined) {
      /* Голое число = голоса за вариант на этой позиции (мягкая форма) */
      const votes = numberOr(item);
      answers.push({ index, ...(votes !== undefined ? { votes } : {}) });
      return;
    }
    const title = stringOr(pick(obj, 'Answer', 'answer', 'Title', 'title', 'Text', 'text'));
    const votes = numberOr(pick(obj, 'Votes', 'votes', 'Count', 'count'));
    answers.push({
      index,
      ...(title !== undefined ? { title } : {}),
      ...(votes !== undefined ? { votes } : {}),
    });
  });
  return answers;
}

/** `myChoices` -> индексы выбранных вариантов. Нечисловой элемент отбрасывается */
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

/**
 * Читает опрос по метке через `poll_info` (один WS-вызов). `ReturnResults:true` просит вернуть
 * агрегированные результаты. Ответ без вариантов и без результатов = не опрос: бросает
 * `NotAPollError`, а не отдаёт пустую структуру за опрос.
 */
export async function readPoll(client: PollInfoClient, input: ReadPollInput): Promise<PollInfoResult> {
  const micros = parseMicros(input.timestamp);
  const params: Record<string, unknown> = {
    ChatId: input.chatId,
    Timestamp: toWireTimestamp(micros),
    Limit: input.limit ?? DEFAULT_POLL_LIMIT,
    ReturnResults: true,
  };
  if (input.inviteHash !== undefined) {
    params['InviteHash'] = input.inviteHash;
  }

  const response = await client.request<PollInfoResponse>(POLL_INFO_METHOD, params);
  const body = asObject(response) ?? {};
  const rawAnswers = pick(body, 'answerVotes', 'AnswerVotes');
  const rawResults = pick(body, 'results', 'Results');
  const answers = parseAnswers(rawAnswers);
  const myChoices = parseMyChoices(pick(body, 'myChoices', 'MyChoices'));

  /* Ни вариантов, ни результатов - сообщение не опрос (либо форма разошлась с докой) */
  if (answers.length === 0 && rawResults === undefined) {
    throw new NotAPollError(input.chatId, micros.toString());
  }

  return {
    is_poll: true,
    answers,
    my_choices: myChoices,
    ...(rawResults !== undefined ? { results: rawResults } : {}),
    raw: response,
  };
}
