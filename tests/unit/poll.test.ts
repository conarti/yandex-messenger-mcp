/**
 * Чтение опроса (Phase 6): `poll_info {ChatId, Timestamp, Limit:50, ReturnResults:true}` ->
 * `{answerVotes, myChoices, results}`. Плюс признак «это опрос» в нормализованной выдаче
 * сообщения (kind:'poll', messageShape). Форма ответа доко-выведена - парсинг мягкий,
 * инварианты проверяются РАНТАЙМОМ (тулчейн тесты не типочекает).
 */
import { describe, expect, it, vi } from 'vitest';
import { NotAPollError, readPoll, type PollInfoClient } from '../../src/protocol/poll.js';
import { normalizeMessage } from '../../src/protocol/messageShape.js';

const CHAT_ID = 'guid-a_guid-b';
const TS = 1784287503814009;
const TS_STR = '1784287503814009';

function fakeClient(response: Record<string, unknown>): {
  client: PollInfoClient;
  calls: Array<{ method: string; params: Record<string, unknown> | undefined }>;
} {
  const calls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
  const client: PollInfoClient = {
    request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      return response as never;
    }),
  };
  return { client, calls };
}

describe('readPoll: запрос poll_info', () => {
  it('один вызов poll_info с ChatId, Timestamp (число), Limit:50, ReturnResults:true', async () => {
    const { client, calls } = fakeClient({
      answerVotes: [{ Answer: 'Да', Votes: 3 }],
      myChoices: [],
    });

    await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('poll_info');
    expect(calls[0]?.params).toEqual({ ChatId: CHAT_ID, Timestamp: TS, Limit: 50, ReturnResults: true });
  });

  it('InviteHash подмешивается для адресации по join-ссылке', async () => {
    const { client, calls } = fakeClient({ answerVotes: [{ Answer: 'A' }] });
    await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR, inviteHash: 'h-1' });
    expect(calls[0]?.params?.['InviteHash']).toBe('h-1');
  });
});

describe('readPoll: варианты, мой выбор, результаты', () => {
  it('нормализует answerVotes в answers с index/title/votes и читает myChoices/results', async () => {
    const results = { total: 4, winner: 0 };
    const { client } = fakeClient({
      answerVotes: [
        { Answer: 'Да', Votes: 3 },
        { Answer: 'Нет', Votes: 1 },
      ],
      myChoices: [0],
      results,
    });

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    /* РАНТАЙМ-инвариант формы: не полагаемся на компилятор в тестах */
    expect(poll.is_poll).toBe(true);
    expect(poll.answers).toEqual([
      { index: 0, title: 'Да', votes: 3 },
      { index: 1, title: 'Нет', votes: 1 },
    ]);
    expect(poll.my_choices).toEqual([0]);
    expect(poll.results).toEqual(results);
    /* Сырой ответ доступен: расхождение доко-формы фиксируется правкой доки, а не подгонкой */
    expect(poll.raw).toMatchObject({ myChoices: [0] });
  });

  it('голый числовой элемент answerVotes читается как голоса за позицию', async () => {
    const { client } = fakeClient({ answerVotes: [5, 2], myChoices: [1] });

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(poll.answers).toEqual([
      { index: 0, votes: 5 },
      { index: 1, votes: 2 },
    ]);
    expect(poll.my_choices).toEqual([1]);
  });

  it('читает PascalCase-написание ключей (wire-регистр доко-выведен)', async () => {
    const { client } = fakeClient({ AnswerVotes: [{ Title: 'X', Count: 7 }], MyChoices: [0], Results: { n: 1 } });

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(poll.answers).toEqual([{ index: 0, title: 'X', votes: 7 }]);
    expect(poll.my_choices).toEqual([0]);
    expect(poll.results).toEqual({ n: 1 });
  });

  it('пустой myChoices - это не голос (голос проверяется живьём, AC-29 условный)', async () => {
    const { client } = fakeClient({ answerVotes: [{ Answer: 'A', Votes: 0 }], myChoices: [] });

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(poll.my_choices).toEqual([]);
  });
});

describe('readPoll: не опрос', () => {
  it('ни вариантов, ни результатов -> NotAPollError, пустая структура за опрос не выдаётся', async () => {
    const { client } = fakeClient({});
    await expect(readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR })).rejects.toThrow(NotAPollError);
  });
});

describe('признак «это опрос» в выдаче сообщения (kind:poll, messageShape)', () => {
  it('сообщение с content-полем Poll нормализуется в kind:poll', () => {
    const message = normalizeMessage({
      ClientMessage: {
        Plain: {
          ChatId: CHAT_ID,
          Poll: { Answers: [{ Answer: 'Да' }, { Answer: 'Нет' }], Title: 'Обед?' },
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
