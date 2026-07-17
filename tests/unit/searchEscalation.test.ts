import { describe, expect, it, vi } from 'vitest';
import type { RegistryHttpClient } from '../../src/transport/RegistryHttpClient.js';
import { SearchEntityError, searchWithEscalation } from '../../src/protocol/search.js';

/**
 * Мок сервера, воспроизводящий §17.5: `total` = число ВОЗВРАЩЁННЫХ элементов,
 * то есть min(limit, реальное). Именно поэтому клиент не может отличить «нашлось ровно
 * limit» от «нашлось больше» иначе как поднятием limit.
 */
function fakeServer(realCounts: Record<string, number>, options: { ceiling?: number } = {}) {
  const calls: number[] = [];
  const call = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    const limit = params['limit'] as number;
    const entities = params['entities'] as string[];
    calls.push(limit);
    if (options.ceiling !== undefined && limit > options.ceiling) {
      throw new Error(`bad_request: limit ${limit} слишком велик`);
    }
    const data: Record<string, unknown> = {};
    for (const entity of entities) {
      const returned = Math.min(limit, realCounts[entity] ?? 0);
      data[entity] = {
        items: Array.from({ length: returned }, (_, index) => ({ data: { id: index } })),
        total: returned,
        limit,
        /* Вестигиальны и всегда 1 - клиент обязан их игнорировать */
        page: 1,
        pages: 1,
      };
    }
    return data;
  });
  return { http: { call } as unknown as RegistryHttpClient, calls, call };
}

describe('searchWithEscalation', () => {
  it('ГЛАВНОЕ: при стартовом limit < N возвращает все N, а не первые limit', () => {
    /* Терм с известным N=7 - ровно тот случай, что снят живьём на bucket users */
    const { http, calls } = fakeServer({ users: 7 });

    return searchWithEscalation({ http }, { query: 'терм', entities: ['users'], startLimit: 5 }).then((outcome) => {
      expect(outcome.buckets['users']).toHaveLength(7);
      expect(outcome.truncated).toBe(false);
      /* Стартовали с 5 (насыщение), подняли до 20 - там плато */
      expect(calls).toEqual([5, 20]);
      expect(outcome.startLimit).toBe(5);
      expect(outcome.finalLimit).toBe(20);
      expect(outcome.requests).toBe(2);
    });
  });

  it('не эскалирует, когда выдача сразу вышла на плато', async () => {
    const { http, calls } = fakeServer({ users: 3 });

    const outcome = await searchWithEscalation({ http }, { query: 'терм', entities: ['users'], startLimit: 50 });

    expect(outcome.buckets['users']).toHaveLength(3);
    expect(calls).toEqual([50]);
    expect(outcome.requests).toBe(1);
  });

  it('эскалирует многократно, пока не упрётся в плато', async () => {
    const { http, calls } = fakeServer({ messages: 300 });

    const outcome = await searchWithEscalation({ http }, { query: 'терм', entities: ['messages'], startLimit: 5 });

    expect(outcome.buckets['messages']).toHaveLength(300);
    expect(calls).toEqual([5, 20, 80, 320]);
    expect(outcome.truncated).toBe(false);
  });

  it('поднимает limit, если насыщен ХОТЬ ОДИН бакет', async () => {
    const { http, calls } = fakeServer({ users: 2, messages: 40 });

    const outcome = await searchWithEscalation(
      { http },
      { query: 'терм', entities: ['users', 'messages'], startLimit: 10 },
    );

    expect(outcome.buckets['users']).toHaveLength(2);
    expect(outcome.buckets['messages']).toHaveLength(40);
    expect(calls).toEqual([10, 40, 160]);
  });

  it('на потолке эскалации помечает усечение ЯВНО, а не режет молча', async () => {
    /* Совпадений больше клиентского потолка 1000 */
    const { http } = fakeServer({ messages: 5000 });

    const outcome = await searchWithEscalation({ http }, { query: 'терм', entities: ['messages'], startLimit: 1000 });

    expect(outcome.truncated).toBe(true);
    expect(outcome.truncationReason).toContain('1000');
    /* Найденное всё равно отдаётся - деградация явная, но не пустая */
    expect(outcome.buckets['messages']).toHaveLength(1000);
  });

  it('на серверном отказе после успешной страницы отдаёт последнюю удачную выдачу с пометкой', async () => {
    /* Сервер начинает ругаться на limit > 100 */
    const { http } = fakeServer({ messages: 500 }, { ceiling: 100 });

    const outcome = await searchWithEscalation({ http }, { query: 'терм', entities: ['messages'], startLimit: 25 });

    expect(outcome.truncated).toBe(true);
    expect(outcome.truncationReason).toContain('отверг');
    expect(outcome.buckets['messages']).toHaveLength(100);
  });

  /*
   * Регрессия на ВРУЩИЙ finalLimit: он считался как limit/FACTOR от ОТВЕРГНУТОГО limit,
   * но эскалация клампится о клиентский потолок (320 -> min(1280, 1000) = 1000).
   * Обратное деление давало 250 - limit, на котором не было ни одного запроса.
   */
  it('finalLimit при отказе = последний УДАЧНЫЙ limit, даже если эскалация клампилась о потолок', async () => {
    /* Сервер отвечает на 320, но валит поднятый до потолка 1000 */
    const { http, calls } = fakeServer({ messages: 5000 }, { ceiling: 500 });

    const outcome = await searchWithEscalation({ http }, { query: 'терм', entities: ['messages'], startLimit: 320 });

    /* 320*4 = 1280 -> склампилось в 1000 -> отказ; 1000/4 = 250 никогда не запрашивался */
    expect(calls).toEqual([320, 1000]);
    expect(outcome.finalLimit).toBe(320);
    expect(outcome.buckets['messages']).toHaveLength(320);
    expect(outcome.truncated).toBe(true);
    expect(outcome.truncationReason).toContain('limit=320');
    expect(outcome.truncationReason).not.toContain('limit=250');
  });

  it('первый же серверный отказ пробрасывается, а не выдаётся за усечённый успех', async () => {
    const { http } = fakeServer({ messages: 500 }, { ceiling: 10 });

    await expect(
      searchWithEscalation({ http }, { query: 'терм', entities: ['messages'], startLimit: 25 }),
    ).rejects.toThrow('слишком велик');
  });

  it('игнорирует page/pages: на них решение не строится', async () => {
    const call = vi.fn(async () => ({
      users: { items: [{ data: {} }], total: 1, limit: 50, page: 1, pages: 99 },
    }));
    const http = { call } as unknown as RegistryHttpClient;

    const outcome = await searchWithEscalation({ http }, { query: 'терм', entities: ['users'], startLimit: 50 });

    /* pages=99 не спровоцировал ни одного лишнего запроса */
    expect(call).toHaveBeenCalledTimes(1);
    expect(outcome.buckets['users']).toHaveLength(1);
  });
});

describe('валидация entities (§17.6)', () => {
  it('contacts отвергается НА ВХОДЕ, до сети', async () => {
    const { http, call } = fakeServer({ contacts: 5 });

    await expect(
      searchWithEscalation({ http }, { query: 'терм', entities: ['contacts' as never], startLimit: 5 }),
    ).rejects.toThrow(SearchEntityError);
    expect(call).not.toHaveBeenCalled();
  });

  it('сообщение об ошибке называет валидные entities', async () => {
    const { http } = fakeServer({});

    await expect(
      searchWithEscalation({ http }, { query: 'терм', entities: ['contacts' as never], startLimit: 5 }),
    ).rejects.toThrow(/messages, users, chats/);
  });

  it('пустой список entities отвергается', async () => {
    const { http } = fakeServer({});

    await expect(searchWithEscalation({ http }, { query: 'терм', entities: [], startLimit: 5 })).rejects.toThrow(
      SearchEntityError,
    );
  });

  it('стартовый limit меньше единицы отвергается', async () => {
    const { http } = fakeServer({ users: 1 });

    await expect(
      searchWithEscalation({ http }, { query: 'терм', entities: ['users'], startLimit: 0 }),
    ).rejects.toThrow(RangeError);
  });
});
