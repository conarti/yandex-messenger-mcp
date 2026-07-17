/**
 * Чтение опроса (правит §14.3, живьём: 2026-07-17): `message_info {ChatId, Timestamp}` даёт
 * вопрос/варианты/лимит выбора из `Plain.Poll` (`Answers` - массив строк), `poll_info {ChatId,
 * Timestamp, Limit:50, ReturnResults:true}` даёт только агрегат `Results` (пуст до голосов).
 * Форма ответа обоих вызовов доко-выведена лишь частично - живой прогон подтвердил ровно эту
 * форму `Plain.Poll`; инварианты проверяются РАНТАЙМОМ (тулчейн тесты не типочекает). Фикстуры
 * синтетические.
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

describe('readPoll: результаты - poll_info приоритетнее тела, тело - фоллбэк', () => {
  it('пустой Results с обеих сторон (живое поведение до голосов): results:{}, votes не выставляется', async () => {
    const { client } = fakeClient(pollMessage({ Title: 'Q', Answers: ['Да', 'Нет'], Results: {} }), { Results: {} });

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(poll.results).toEqual({});
    expect(poll.answers).toEqual([{ index: 0, title: 'Да' }, { index: 1, title: 'Нет' }]);
  });

  it('poll_info.Results используется, даже если тело несёт другой Results', async () => {
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

  it('позиционный массив в results сопоставляется с votes по индексу (лучшее усилие, форма не подтверждена)', async () => {
    const { client } = fakeClient(pollMessage({ Title: 'Q', Answers: ['Да', 'Нет'], Results: {} }), {
      Results: [3, 1],
    });

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(poll.answers).toEqual([
      { index: 0, title: 'Да', votes: 3 },
      { index: 1, title: 'Нет', votes: 1 },
    ]);
  });

  it('нераспознанная форма results (объект без Votes/Count) - votes не выставляется', async () => {
    const { client } = fakeClient(pollMessage({ Title: 'Q', Answers: ['Да'], Results: {} }), {
      Results: { winner: 'Да' },
    });

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(poll.answers).toEqual([{ index: 0, title: 'Да' }]);
  });
});

describe('readPoll: мой выбор - не подтверждён живьём, best-effort', () => {
  it('poll_info без myChoices/MyChoices (живое поведение) -> my_choices: []', async () => {
    const { client } = fakeClient(pollMessage({ Title: 'Q', Answers: ['Да'], Results: {} }), { Results: {} });

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(poll.my_choices).toEqual([]);
  });

  it('читает myChoices, если когда-нибудь появится в ответе poll_info (форма не подтверждена)', async () => {
    const { client } = fakeClient(pollMessage({ Title: 'Q', Answers: ['Да', 'Нет'], Results: {} }), {
      Results: {},
      myChoices: [1],
    });

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(poll.my_choices).toEqual([1]);
  });

  it('читает PascalCase MyChoices про запас (wire-регистр не подтверждён)', async () => {
    const { client } = fakeClient(pollMessage({ Title: 'Q', Answers: ['Да'], Results: {} }), {
      Results: {},
      MyChoices: [0],
    });

    const poll = await readPoll(client, { chatId: CHAT_ID, timestamp: TS_STR });

    expect(poll.my_choices).toEqual([0]);
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
