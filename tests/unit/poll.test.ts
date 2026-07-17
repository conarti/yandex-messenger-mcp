/**
 * Чтение опроса (§14.3, живьём: 2026-07-17, базовый прогон + прогон с голосами): `message_info
 * {ChatId, Timestamp}` даёт вопрос/варианты/лимит выбора из `Plain.Poll` (`Answers` - массив строк),
 * `poll_info {ChatId, Timestamp, Limit:50, ReturnResults:true}` даёт агрегат `Results`, `MyChoices`
 * и, при наличии голосов у не-анонимного опроса, детальный разбор `AnswerVotes` (кто и когда).
 * У анонимного опроса `AnswerVotes`/`Results.RecentVoters` сервер скрывает даже по явному запросу.
 * Инварианты проверяются РАНТАЙМОМ (тулчейн тесты не типочекает). Фикстуры синтетические.
 */
import { describe, expect, it, vi } from 'vitest';
import { NotAPollError, readPoll, type PollInfoClient } from '../../src/protocol/poll.js';
import { normalizeMessage } from '../../src/protocol/messageShape.js';

const CHAT_ID = 'guid-a_guid-b';
const TS = 1784287503814009;
const TS_STR = '1784287503814009';

/** Ответ `message_info` в форме, снятой живьём: `{Message:{ServerMessage:{ClientMessage,...}}}` */
function pollMessage(poll: Record<string, unknown>): Record<string, unknown> {
  return {
    Message: {
      ServerMessage: {
        ClientMessage: { Plain: { ChatId: CHAT_ID, Poll: poll } },
        ServerMessageInfo: { Timestamp: TS, SeqNo: 1, LastEditTimestamp: 0, Deleted: false, From: { Guid: 'guid-a' } },
      },
    },
  };
}

/** Пара ответов: `message_info` первым вызовом, `poll_info` вторым (порядок фиксирует readPoll) */
function fakeClient(
  messageInfoResponse: Record<string, unknown>,
  pollInfoResponse: Record<string, unknown>,
): {
  client: PollInfoClient;
  calls: Array<{ method: string; params: Record<string, unknown> | undefined }>;
} {
  const calls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
  const client: PollInfoClient = {
    request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      return (method === 'message_info' ? messageInfoResponse : pollInfoResponse) as never;
    }),
  };
  return { client, calls };
}

describe('readPoll: два WS-вызова (message_info за телом, poll_info за агрегатом)', () => {
  it('message_info с ChatId+Timestamp, затем poll_info с ChatId, Timestamp, Limit:50, ReturnResults:true', async () => {
    const { client, calls } = fakeClient(
      pollMessage({ Title: 'Обед?', Answers: ['Да', 'Нет'], MaxChoices: 1, Results: {} }),
      { Results: {} },
    );

    await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe('message_info');
    expect(calls[0]?.params).toEqual({ ChatId: CHAT_ID, Timestamp: TS });
    expect(calls[1]?.method).toBe('poll_info');
    expect(calls[1]?.params).toEqual({ ChatId: CHAT_ID, Timestamp: TS, Limit: 50, ReturnResults: true });
  });

  it('InviteHash подмешивается в оба вызова для адресации по join-ссылке', async () => {
    const { client, calls } = fakeClient(pollMessage({ Title: 'Q', Answers: ['A'], MaxChoices: 1, Results: {} }), {
      Results: {},
    });
    await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR, inviteHash: 'h-1' });
    expect(calls[0]?.params?.['InviteHash']).toBe('h-1');
    expect(calls[1]?.params?.['InviteHash']).toBe('h-1');
  });

  it('кастомный limit уходит в poll_info, а не в message_info', async () => {
    const { client, calls } = fakeClient(pollMessage({ Title: 'Q', Answers: ['A'], MaxChoices: 1, Results: {} }), {
      Results: {},
    });
    await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR, limit: 10 });
    expect(calls[0]?.params?.['Limit']).toBeUndefined();
    expect(calls[1]?.params?.['Limit']).toBe(10);
  });
});

describe('readPoll: вопрос/варианты/лимит выбора из тела Plain.Poll', () => {
  it('Answers (массив строк) -> answers с index/title, Title -> title, MaxChoices -> max_choices', async () => {
    const { client } = fakeClient(
      pollMessage({ Title: 'Обед?', Answers: ['Да', 'Нет', 'Не знаю'], MaxChoices: 1, Results: {} }),
      { Results: {} },
    );

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    /* РАНТАЙМ-инвариант формы: не полагаемся на компилятор в тестах */
    expect(poll.is_poll).toBe(true);
    expect(poll.title).toBe('Обед?');
    expect(poll.max_choices).toBe(1);
    expect(poll.answers).toEqual([
      { index: 0, title: 'Да' },
      { index: 1, title: 'Нет' },
      { index: 2, title: 'Не знаю' },
    ]);
  });

  it('индекс варианта сохраняется даже если элемент Answers не строка (адрес голоса не сдвигается)', async () => {
    const { client } = fakeClient(pollMessage({ Title: 'Q', Answers: ['Да', null, 'Нет'], Results: {} }), {
      Results: {},
    });

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(poll.answers).toEqual([{ index: 0, title: 'Да' }, { index: 1 }, { index: 2, title: 'Нет' }]);
  });
});

describe('readPoll: пустой опрос (без голосов) - метод рабочий, не роняется (живьём, §17.15/17.16)', () => {
  it('poll_info отдаёт ровно {Results:{}}: votes/voters не выставляются, my_choices пуст', async () => {
    const { client } = fakeClient(pollMessage({ Title: 'Обед?', Answers: ['Да', 'Нет'], Results: {} }), {
      Results: {},
    });

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(poll.is_poll).toBe(true);
    expect(poll.answers).toEqual([
      { index: 0, title: 'Да' },
      { index: 1, title: 'Нет' },
    ]);
    expect(poll.my_choices).toEqual([]);
    expect(poll.is_anonymous).toBe(false);
    expect(poll.voted_count).toBeUndefined();
    expect(poll.voters_hidden).toBeUndefined();
    expect(poll.recent_voters).toBeUndefined();
    expect(poll.results).toEqual({});
  });
});

describe('readPoll: результаты - poll_info приоритетнее тела, тело - фоллбэк', () => {
  it('pollInfo.Results используется, даже если тело несёт другой Results', async () => {
    const { client } = fakeClient(pollMessage({ Title: 'Q', Answers: ['Да'], Results: { stale: true } }), {
      Results: { fresh: true },
    });

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(poll.results).toEqual({ fresh: true });
  });

  it('poll_info без Results -> фоллбэк на Results из тела', async () => {
    const { client } = fakeClient(pollMessage({ Title: 'Q', Answers: ['Да'], Results: { total: 4 } }), {});

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(poll.results).toEqual({ total: 4 });
  });

  it('Results.Answers[] сопоставляется с votes по индексу (живьём, §14.3)', async () => {
    const { client } = fakeClient(pollMessage({ Title: 'Q', Answers: ['Да', 'Нет'], Results: {} }), {
      Results: { Answers: [3, 1] },
    });

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(poll.answers).toEqual([
      { index: 0, title: 'Да', votes: 3 },
      { index: 1, title: 'Нет', votes: 1 },
    ]);
  });

  it('Results без ключа Answers (нераспознанная форма) - votes не выставляется', async () => {
    const { client } = fakeClient(pollMessage({ Title: 'Q', Answers: ['Да'], Results: {} }), {
      Results: { winner: 'Да' },
    });

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(poll.answers).toEqual([{ index: 0, title: 'Да' }]);
  });
});

describe('readPoll: мой выбор - MyChoices из poll_info либо из тела (живьём, §14.3)', () => {
  it('poll_info без MyChoices и тело без MyChoices -> my_choices: []', async () => {
    const { client } = fakeClient(pollMessage({ Title: 'Q', Answers: ['Да'], Results: {} }), { Results: {} });

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(poll.my_choices).toEqual([]);
  });

  it('читает MyChoices из poll_info (приоритет над телом)', async () => {
    const { client } = fakeClient(pollMessage({ Title: 'Q', Answers: ['Да', 'Нет'], Results: {} }), {
      Results: {},
      MyChoices: [1],
    });

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(poll.my_choices).toEqual([1]);
  });

  it('фоллбэк на MyChoices из тела, если poll_info их не отдал', async () => {
    const { client } = fakeClient(pollMessage({ Title: 'Q', Answers: ['Да'], Results: {}, MyChoices: [0] }), {
      Results: {},
    });

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(poll.my_choices).toEqual([0]);
  });
});

describe('readPoll: кто проголосовал (AnswerVotes, только не-анонимный опрос, живьём §14.3)', () => {
  it('answers[i].voters из AnswerVotes[].Votes (имя+время), voted_count из Results.VotedCount, recent_voters', async () => {
    const { client } = fakeClient(
      pollMessage({ Title: 'Обед?', Answers: ['Да', 'Нет'], MaxChoices: 2, Results: {} }),
      {
        Results: {
          Version: 1700000000000000,
          VotedCount: 1,
          Answers: [1, 1],
          RecentVoters: [{ Guid: 'guid-a', DisplayName: 'Автор' }],
        },
        MyChoices: [0, 1],
        AnswerVotes: [
          /* AnswerId для индекса 0 опущен (живьём, §14.3) */
          { TotalCount: 1, Votes: [{ Timestamp: '1700000000000000', UserInfo: { DisplayName: 'Автор' } }] },
          { AnswerId: 1, TotalCount: 1, Votes: [{ Timestamp: '1700000000000000', UserInfo: { DisplayName: 'Автор' } }] },
        ],
      },
    );

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(poll.is_anonymous).toBe(false);
    expect(poll.voters_hidden).toBeUndefined();
    expect(poll.voted_count).toBe(1);
    expect(poll.my_choices).toEqual([0, 1]);
    expect(poll.recent_voters).toEqual([{ name: 'Автор' }]);
    expect(poll.answers).toEqual([
      { index: 0, title: 'Да', votes: 1, voters: [{ name: 'Автор', timestamp: '1700000000000000' }] },
      { index: 1, title: 'Нет', votes: 1, voters: [{ name: 'Автор', timestamp: '1700000000000000' }] },
    ]);
  });

  it('votes фоллбэком берётся из AnswerVotes[].TotalCount, если Results.Answers[] нет', async () => {
    const { client } = fakeClient(pollMessage({ Title: 'Q', Answers: ['Да', 'Нет'], Results: {} }), {
      Results: { VotedCount: 1 },
      AnswerVotes: [{ AnswerId: 1, TotalCount: 2, Votes: [] }],
    });

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(poll.answers).toEqual([{ index: 0, title: 'Да' }, { index: 1, title: 'Нет', votes: 2 }]);
  });

  it('голосующий без валидной метки времени отбрасывается (не выдумывается timestamp)', async () => {
    const { client } = fakeClient(pollMessage({ Title: 'Q', Answers: ['Да'], Results: {} }), {
      Results: {},
      AnswerVotes: [{ TotalCount: 1, Votes: [{ UserInfo: { DisplayName: 'Автор' } }] }],
    });

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(poll.answers[0]?.voters).toBeUndefined();
  });
});

describe('readPoll: анонимный опрос - голосующие скрыты сервером (живьём §14.3, не только UI)', () => {
  it('IsAnonymous:true в теле -> voters_hidden:true, AnswerVotes/RecentVoters недоступны, агрегат+my_choices видны', async () => {
    const { client } = fakeClient(
      pollMessage({ Title: 'Секрет?', Answers: ['Да', 'Нет'], IsAnonymous: true, Results: {} }),
      {
        /* Аноним: сервер НЕ отдаёт AnswerVotes и Results.RecentVoters даже по ReturnResults:true */
        Results: { Version: 1700000000000000, VotedCount: 1, Answers: [1, 0] },
        MyChoices: [0],
      },
    );

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(poll.is_anonymous).toBe(true);
    expect(poll.voters_hidden).toBe(true);
    expect(poll.voted_count).toBe(1);
    expect(poll.my_choices).toEqual([0]);
    expect(poll.recent_voters).toBeUndefined();
    expect(poll.answers).toEqual([
      { index: 0, title: 'Да', votes: 1 },
      { index: 1, title: 'Нет', votes: 0 },
    ]);
    /* Ни одного варианта не несёт voters - список голосующих принципиально недоступен */
    expect(poll.answers.every((answer) => answer.voters === undefined)).toBe(true);
  });

  it('IsAnonymous отсутствует в теле -> is_anonymous:false (живьём: ключ есть только при true)', async () => {
    const { client } = fakeClient(pollMessage({ Title: 'Q', Answers: ['Да'], Results: {} }), { Results: {} });

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(poll.is_anonymous).toBe(false);
    expect(poll.voters_hidden).toBeUndefined();
  });
});

describe('readPoll: raw несёт оба сырых ответа', () => {
  it('raw.message_info и raw.poll_info доступны для расхождений формы', async () => {
    const messageInfoResponse = pollMessage({ Title: 'Q', Answers: ['Да'], Results: {} });
    const pollInfoResponse = { Results: {} };
    const { client } = fakeClient(messageInfoResponse, pollInfoResponse);

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(poll.raw).toEqual({ message_info: messageInfoResponse, poll_info: pollInfoResponse });
  });
});

describe('readPoll: не опрос', () => {
  it('нет Plain.Poll в message_info -> NotAPollError, poll_info НЕ вызывается', async () => {
    const { client, calls } = fakeClient(
      {
        Message: {
          ServerMessage: {
            ClientMessage: { Plain: { ChatId: CHAT_ID, Text: { MessageText: 'привет' } } },
            ServerMessageInfo: {
              Timestamp: TS,
              SeqNo: 1,
              LastEditTimestamp: 0,
              Deleted: false,
              From: { Guid: 'guid-a' },
            },
          },
        },
      },
      { Results: {} },
    );

    await expect(readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR })).rejects.toThrow(NotAPollError);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('message_info');
  });
});

describe('признак «это опрос» в выдаче сообщения (kind:poll, messageShape)', () => {
  it('сообщение с content-полем Poll нормализуется в kind:poll', () => {
    const message = normalizeMessage({
      ClientMessage: {
        Plain: {
          ChatId: CHAT_ID,
          Poll: { Answers: ['Да', 'Нет'], Title: 'Обед?' },
        },
      },
      ServerMessageInfo: {
        Timestamp: TS,
        SeqNo: 1,
        LastEditTimestamp: 0,
        Deleted: false,
        From: { Guid: 'guid-a', DisplayName: 'Автор' },
      },
    });

    expect(message?.kind).toBe('poll');
  });
});
