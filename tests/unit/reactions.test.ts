/**
 * Детальная выборка реакций/прочтений двумя вызовами `list_reactions` (§17.12, спайк 4/5).
 *
 * Клиент - синтетический двойник: захватывает params и отдаёт заготовленные ответы. Проверяется
 * форма запроса (Mode-дискриминатор, обязательный Limit) и разбор ответа (кто/что/когда, время
 * строкой, «не отслеживается» != ноль). Никакой сети, фикстуры синтетические.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildListReactionsParams,
  listReactions,
  READS_MODE,
  type ReactionsClient,
} from '../../src/protocol/reactions.js';
import { createReactionMap } from '../../src/config/reactionMap.js';

const CHAT_ID = 'guid-a_guid-b';
const TS = '1784287503814009';

/** Карта с одним известным типом - чтобы отдельно проверить known и unknown-путь отрисовки */
const MAP = createReactionMap(new Map([[100102, { name: 'like-ext', emoji: '👍' }]]));

/** Двойник WS-клиента: первый вызов - реакции, второй - прочтения (порядок как в listReactions) */
function fakeClient(responses: Array<Record<string, unknown>>): {
  client: ReactionsClient;
  calls: Array<{ method: string; params: Record<string, unknown> | undefined }>;
} {
  const calls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
  let index = 0;
  const client: ReactionsClient = {
    request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      const response = responses[index] ?? {};
      index += 1;
      return response as never;
    }),
  };
  return { client, calls };
}

describe('buildListReactionsParams: Limit обязателен, Mode - дискриминатор', () => {
  it('дефолтный Mode (опущен) собирает запрос реакций с ChatId/Timestamp/Limit', () => {
    expect(buildListReactionsParams({ chatId: CHAT_ID, timestamp: TS, limit: 50 })).toEqual({
      ChatId: CHAT_ID,
      Timestamp: 1784287503814009,
      Limit: 50,
    });
  });

  it('Mode:1 добавляет режим прочтений', () => {
    const params = buildListReactionsParams({ chatId: CHAT_ID, timestamp: TS, limit: 50, mode: READS_MODE });
    expect(params['Mode']).toBe(1);
  });

  it('вызов без валидного Limit НЕ собирается - падает на входе, а не летит в BACKEND_CALL_ERROR(2)', () => {
    /* @ts-expect-error намеренно без limit: форма запроса обязана требовать его на входе */
    expect(() => buildListReactionsParams({ chatId: CHAT_ID, timestamp: TS })).toThrow(/Limit обязателен/);
    expect(() => buildListReactionsParams({ chatId: CHAT_ID, timestamp: TS, limit: 0 })).toThrow(/Limit обязателен/);
    expect(() => buildListReactionsParams({ chatId: CHAT_ID, timestamp: TS, limit: -1 })).toThrow(/Limit обязателен/);
  });

  it('inviteHash и maxTimestamp подмешиваются, когда переданы', () => {
    const params = buildListReactionsParams({
      chatId: CHAT_ID,
      timestamp: TS,
      limit: 50,
      inviteHash: 'hash-1',
      maxTimestamp: '1784287000000000',
    });
    expect(params['InviteHash']).toBe('hash-1');
    expect(params['MaxTimestamp']).toBe(1784287000000000);
  });
});

describe('listReactions: два вызова, Mode-дискриминатор, Limit в обоих', () => {
  it('делает ровно два вызова list_reactions: реакции (без Mode) и прочтения (Mode:1)', async () => {
    const { client, calls } = fakeClient([
      { UserReactions: [] },
      { UserReads: [], ReadsCount: 0 },
    ]);

    await listReactions(client, { chatId: CHAT_ID, timestamp: TS }, MAP);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe('list_reactions');
    expect(calls[1]?.method).toBe('list_reactions');
    /* Первый - реакции: Mode отсутствует (дефолт -> UserReactions) */
    expect(calls[0]?.params?.['Mode']).toBeUndefined();
    /* Второй - прочтения: Mode:1 */
    expect(calls[1]?.params?.['Mode']).toBe(1);
    /* Limit присутствует в ОБОИХ (без него сервер вернул бы BACKEND_CALL_ERROR(2)) */
    expect(calls[0]?.params?.['Limit']).toBe(50);
    expect(calls[1]?.params?.['Limit']).toBe(50);
  });

  it('UserReactions -> кто/что/когда; тип через карту, время строкой', async () => {
    const { client } = fakeClient([
      {
        UserReactions: [
          {
            Type: 100102,
            Timestamp: 1784287000000000,
            UserInfo: { Guid: 'guid-fan', DisplayName: 'Фанат' },
          },
        ],
      },
      { UserReads: [], ReadsCount: 0 },
    ]);

    const detail = await listReactions(client, { chatId: CHAT_ID, timestamp: TS }, MAP);

    /* Сгруппировано по типу (ось B1/E1): описатель типа напрямую, актор с меткой внутри */
    expect(detail.reactions).toEqual([
      {
        type: 100102,
        name: 'like-ext',
        emoji: '👍',
        count: 1,
        actors: [
          { guid: 'guid-fan', name: 'Фанат', timestamp: '2026-07-17T11:16:40.000Z', timestamp_mcs: '1784287000000000' },
        ],
        /* Детальная выборка - полный список: всегда true */
        actors_complete: true,
      },
    ]);
    /* Метка строкой, не float */
    expect(typeof detail.reactions[0]?.actors[0]?.timestamp_mcs).toBe('string');
  });

  it('неизвестный тип в UserReactions виден как unknown, выборка не падает', async () => {
    const { client } = fakeClient([
      { UserReactions: [{ Type: 999999, Timestamp: 1784287000000000, UserInfo: { Guid: 'guid-x' } }] },
      { UserReads: [], ReadsCount: 0 },
    ]);

    const detail = await listReactions(client, { chatId: CHAT_ID, timestamp: TS }, MAP);

    /* Неизвестный тип виден как unknown прямо на реакции, актор сохранён */
    expect(detail.reactions[0]).toEqual({
      type: 999999,
      name: null,
      emoji: null,
      unknown: true,
      count: 1,
      actors: [{ guid: 'guid-x', timestamp: '2026-07-17T11:16:40.000Z', timestamp_mcs: '1784287000000000' }],
      actors_complete: true,
    });
  });

  it('Mode:1 -> UserReads + ReadsCount: кто и когда прочитал, count из ReadsCount', async () => {
    const { client } = fakeClient([
      { UserReactions: [] },
      {
        ReadsCount: 10,
        UserReads: [{ Timestamp: 1784287000000000, UserInfo: { Guid: 'guid-reader', DisplayName: 'Читатель' } }],
      },
    ]);

    const detail = await listReactions(client, { chatId: CHAT_ID, timestamp: TS }, MAP);

    expect(detail.reads.tracked).toBe(true);
    expect(detail.reads.count).toBe(10);
    expect(detail.reads.recent).toEqual([
      {
        actor: { guid: 'guid-reader', name: 'Читатель' },
        timestamp: '2026-07-17T11:16:40.000Z',
        timestamp_mcs: '1784287000000000',
      },
    ]);
  });

  it('отсутствие UserReads (и ReadsCount) -> «не отслеживается», НЕ ноль', async () => {
    const { client } = fakeClient([{ UserReactions: [] }, {}]);

    const detail = await listReactions(client, { chatId: CHAT_ID, timestamp: TS }, MAP);

    expect(detail.reads).toEqual({ tracked: false, recent: [] });
    /* Именно не отслеживается, а не count:0 */
    expect(detail.reads.count).toBeUndefined();
  });

  it('ReadsCount:0 при наличии ключа -> tracked (0 прочтений), а не «не отслеживается»', async () => {
    const { client } = fakeClient([{ UserReactions: [] }, { ReadsCount: 0 }]);

    const detail = await listReactions(client, { chatId: CHAT_ID, timestamp: TS }, MAP);

    expect(detail.reads.tracked).toBe(true);
    expect(detail.reads.count).toBe(0);
  });

  it('сиблинги history не источник истины: ReadsCount:10 при recent длиной 1 - отдаём как пришло', async () => {
    const { client } = fakeClient([
      { UserReactions: [] },
      {
        ReadsCount: 10,
        UserReads: [{ Timestamp: 1784287000000000, UserInfo: { Guid: 'guid-r' } }],
      },
    ]);

    const detail = await listReactions(client, { chatId: CHAT_ID, timestamp: TS }, MAP);

    /* count честно 10, а recent - только то, что реально пришло; их расхождение штатно */
    expect(detail.reads.count).toBe(10);
    expect(detail.reads.recent).toHaveLength(1);
  });
});
