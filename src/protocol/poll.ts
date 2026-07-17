/**
 * Чтение опроса ДВУМЯ WS-вызовами (правит §14.3, живьём: 2026-07-17).
 *
 * ⚠️ ПРЕЖНЯЯ ВЕРСИЯ ЭТОГО МОДУЛЯ БЫЛА НЕВЕРНА. Она брала варианты/вопрос из `poll_info`
 * (ключи `answerVotes`/`myChoices`, доко-выведено). Живой прогон опроверг: `poll_info` вернул
 * РОВНО `{Results:{}}` - ни `answerVotes`, ни `myChoices` в ответе нет вообще.
 *
 * ЖИВАЯ ФОРМА. Вопрос, варианты и лимит выбора лежат в ТЕЛЕ сообщения-опроса, а не в `poll_info`:
 * `message_info {ChatId, Timestamp}` -> `Message.ServerMessage.ClientMessage.Plain.Poll` вида
 * `{Title, Answers:[string], MaxChoices:int, Results:{}}`. `Answers` - массив СТРОК; индекс в
 * массиве - адрес варианта для `vote_in_poll.choices`. `poll_info {ChatId, Timestamp, Limit:50,
 * ReturnResults:true}` при этом даёт только агрегат `Results` (пуст до голосов).
 *
 * ПОЭТОМУ ДВА ВЫЗОВА: `message_info` - обязательный источник вопроса/вариантов/лимита выбора и
 * признака «это опрос» (`Plain.Poll` присутствует). `poll_info` - за агрегированными `Results`;
 * если он их не отдал, используется агрегат из тела. Признак «не опрос» смотрит ТОЛЬКО на
 * `Plain.Poll`: если его нет, `poll_info` не вызывается вовсе (нет смысла).
 *
 * ГОЛОСА ЗА ВАРИАНТ (`votes`) - ЛУЧШИЙ УСИЛИЕ, ФОРМА НЕ ПОДТВЕРЖДЕНА. `Results` живьём наблюдался
 * только пустым (`{}`) - до первого голоса. Как выглядит `Results` С голосами и как он мапится на
 * конкретный вариант, живьём НЕ снято. Ниже - мягкая попытка (позиционный массив/объект с
 * Votes|Count) на случай, если форма окажется похожей на другие мутации этого протокола; если
 * `Results` пуст или не распознан - `votes` не выставляется, а не подставляется 0/выдумка.
 *
 * МОЙ ВЫБОР (`my_choices`) - ТОЖЕ НЕ ПОДТВЕРЖДЁН. Ни `message_info`, ни `poll_info` живьём не
 * показали поля «мой выбор» ДО голосования. Читаются оба написания (`myChoices`/`MyChoices`) из
 * ответа `poll_info` про запас (см. push.ts), но пока это неподтверждённая догадка: реальный ключ
 * появится или опровергнется только живым голосом (условный долг, как и form_status у vote_in_poll).
 *
 * МЕТКИ - СТРОКИ. `Timestamp` опроса несёт полную точность (§5, util/timestamps), на провод
 * уходит числом (JSON-тело), но наружу отдаётся строкой.
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

/** Один вариант опроса (`Poll.Answers[]`, живьём: массив строк) */
export interface PollAnswer {
  /** Позиция варианта в `Poll.Answers`: адрес для голоса (`vote_in_poll.choices`) */
  index: number;
  /** Текст варианта из `Poll.Answers[index]` */
  title?: string;
  /** Число голосов за вариант - лучшее усилие сопоставления с `results`, форма не подтверждена */
  votes?: number;
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
  /** Мои выбранные варианты - НЕ подтверждено живьём (см. шапку модуля) */
  my_choices: number[];
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
  myChoices?: unknown;
  MyChoices?: unknown;
  results?: unknown;
  Results?: unknown;
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
  };
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
 * Лучшее усилие сопоставить `results` с голосами по позиции варианта. Форма `results` С голосами
 * живьём НЕ снята (наблюдался только пустой `{}`) - поддерживаются позиционный массив чисел и
 * массив объектов с `Votes`/`votes`/`Count`/`count`, по аналогии с другими мягко разобранными
 * агрегатами протокола. Нераспознанная форма - пустая карта, `votes` не выставляется.
 */
function matchVotesByIndex(results: unknown): Map<number, number> {
  const votes = new Map<number, number>();
  if (!Array.isArray(results)) {
    return votes;
  }
  results.forEach((item, index) => {
    const direct = numberOr(item);
    if (direct !== undefined) {
      votes.set(index, direct);
      return;
    }
    const obj = asObject(item);
    const count = numberOr(pick(obj, 'Votes', 'votes', 'Count', 'count'));
    if (count !== undefined) {
      votes.set(index, count);
    }
  });
  return votes;
}

function buildAnswers(answerTitles: Array<string | undefined>, results: unknown): PollAnswer[] {
  const votesByIndex = matchVotesByIndex(results);
  return answerTitles.map((title, index) => {
    const votes = votesByIndex.get(index);
    return {
      index,
      ...(title !== undefined ? { title } : {}),
      ...(votes !== undefined ? { votes } : {}),
    };
  });
}

/**
 * Читает опрос по метке: `message_info` за вопросом/вариантами/лимитом выбора (обязательный
 * источник, признак «это опрос»), `poll_info` за агрегированными результатами (доп. вызов, только
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
  const results = pick(pollInfoBody, 'results', 'Results') ?? poll.results;
  const myChoices = parseMyChoices(pick(pollInfoBody, 'myChoices', 'MyChoices'));

  return {
    is_poll: true,
    ...(poll.title !== undefined ? { title: poll.title } : {}),
    answers: buildAnswers(poll.answerTitles, results),
    ...(poll.maxChoices !== undefined ? { max_choices: poll.maxChoices } : {}),
    my_choices: myChoices,
    ...(results !== undefined ? { results } : {}),
    raw: { message_info: messageInfoResponse, poll_info: pollInfoResponse },
  };
}
