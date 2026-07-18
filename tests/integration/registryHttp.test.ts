/**
 * RegistryHttpClient против фикстур ответов: проверяется конверт запроса (§3.1)
 * и распаковка `{status, data}` / ошибок (§17.6).
 */
import { describe, expect, it } from 'vitest';
import { FakeAuthProvider } from '../../src/auth/FakeAuthProvider.js';
import { RegistryError, RegistryHttpClient } from '../../src/transport/RegistryHttpClient.js';

const API_URL = 'https://yandex.ru/messenger/api/registry/api/';

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: FormData;
}

/** Фейковый fetch: отдаёт заготовленные ответы по очереди и пишет вызовы */
function fakeFetch(responses: { status?: number; payload: unknown }[]) {
  const calls: Call[] = [];
  let index = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as FormData,
    });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(JSON.stringify(response?.payload), { status: response?.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

function createClient(impl: typeof fetch, auth = new FakeAuthProvider()) {
  return { client: new RegistryHttpClient({ apiUrl: API_URL, auth, fetchImpl: impl }), auth };
}

describe('конверт запроса (§3.1)', () => {
  it('POST с multipart FormData: единственное поле request = JSON({method, params})', async () => {
    const { impl, calls } = fakeFetch([{ payload: { status: 'ok', data: { users: [] } } }]);
    const { client } = createClient(impl);

    await client.call('search', { query: 'test', entities: ['users'], limit: 50 });

    expect(calls[0]?.url).toBe(API_URL);
    expect(calls[0]?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.body.get('request')))).toEqual({
      method: 'search',
      params: { query: 'test', entities: ['users'], limit: 50 },
    });
    expect([...(calls[0]?.body.keys() ?? [])]).toEqual(['request']);
  });

  it('авторизует вызов заголовком Cookie из AuthContext', async () => {
    const { impl, calls } = fakeFetch([{ payload: { status: 'ok', data: {} } }]);
    const { client, auth } = createClient(impl);

    await client.call('get_chat_info');

    expect(calls[0]?.headers['Cookie']).toBe(auth.context.cookieHeader);
  });

  it('read-методы идут без X-CSRF-TOKEN: CSRF нужен только request_user, и он живёт в слое auth', async () => {
    const { impl, calls } = fakeFetch([{ payload: { status: 'ok', data: {} } }]);
    const { client } = createClient(impl);

    await client.call('search', { query: 'x' });

    expect(calls[0]?.headers['X-CSRF-TOKEN']).toBeUndefined();
    expect(calls.map((call) => call.url)).toEqual([API_URL]);
  });

  it('шлёт params пустым объектом, когда их нет', async () => {
    const { impl, calls } = fakeFetch([{ payload: { status: 'ok', data: {} } }]);
    const { client } = createClient(impl);

    await client.call('get_buckets');

    expect(JSON.parse(String(calls[0]?.body.get('request')))).toEqual({ method: 'get_buckets', params: {} });
  });
});

describe('разбор ответа', () => {
  it('распаковывает data из {status, data}', async () => {
    const { impl } = fakeFetch([
      { payload: { status: 'ok', data: { users: [{ guid: 'a', display_name: 'x' }], total: 1, pages: 1 } } },
    ]);
    const { client } = createClient(impl);

    const data = await client.call<{ users: unknown[]; total: number }>('search', { query: 'x' });

    expect(data).toEqual({ users: [{ guid: 'a', display_name: 'x' }], total: 1, pages: 1 });
  });

  it('на status:"error" бросает RegistryError с code/text/source', async () => {
    const { impl } = fakeFetch([
      { payload: { status: 'error', data: { code: 'bad_request', text: 'organization_ids is required' } } },
    ]);
    const { client } = createClient(impl);

    /* Живой ответ get_organizations без organization_ids (§17.6) */
    await expect(client.call('get_organizations')).rejects.toMatchObject({
      name: 'RegistryError',
      code: 'bad_request',
      text: 'organization_ids is required',
      method: 'get_organizations',
    });
  });

  it('несёт source в сообщении: без него code вроде "No such path" не диагностируется', async () => {
    const { impl } = fakeFetch([{ payload: { status: 'error', data: { code: 'No such path', source: 'yamb' } } }]);
    const { client } = createClient(impl);

    /* Живой ответ несуществующего get_current_user_data (§17.6) */
    const error = await client.call('get_current_user_data').catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RegistryError);
    expect((error as Error).message).toContain('No such path');
    expect((error as Error).message).toContain('source=yamb');
  });
});

describe('CSRF для мутаций (join/leave)', () => {
  it('{csrf:true} прикладывает X-CSRF-TOKEN из AuthProvider.getCsrfToken', async () => {
    const { impl, calls } = fakeFetch([{ payload: { status: 'ok', data: { chat_member: {} } } }]);
    const { client } = createClient(impl);

    await client.call('join_to_thread', { thread_id: 't' }, { csrf: true });

    expect(calls[0]?.headers['X-CSRF-TOKEN']).toBe('fake-csrf-token');
  });

  it('bad_csrf_token -> перефетч токена (forceRefresh) и один повтор', async () => {
    const { impl, calls } = fakeFetch([
      { payload: { status: 'error', data: { code: 'bad_csrf_token', source: 'yamb' } } },
      { payload: { status: 'ok', data: { chat_member: { role: 'left' } } } },
    ]);
    const { client, auth } = createClient(impl);

    const data = await client.call<{ chat_member: unknown }>('leave_thread', { thread_id: 't' }, { csrf: true });

    expect(data).toEqual({ chat_member: { role: 'left' } });
    /* Первый вызов без force, повтор - с force: токен мог протухнуть, его инвалидируют и перефетчивают */
    expect(auth.csrfTokenCalls).toEqual([false, true]);
    expect(calls).toHaveLength(2);
  });

  it('не зацикливается: повторный bad_csrf_token после перефетча сюрфейсится наверх', async () => {
    const { impl, calls } = fakeFetch([
      { payload: { status: 'error', data: { code: 'bad_csrf_token', source: 'yamb' } } },
    ]);
    const { client } = createClient(impl);

    await expect(client.call('join_to_thread', { thread_id: 't' }, { csrf: true })).rejects.toMatchObject({
      name: 'RegistryError',
      code: 'bad_csrf_token',
    });
    expect(calls).toHaveLength(2);
  });

  it('read-метод с bad_csrf_token НЕ ретраится: CSRF-путь только для помеченных вызовов', async () => {
    const { impl, calls } = fakeFetch([
      { payload: { status: 'error', data: { code: 'bad_csrf_token', source: 'yamb' } } },
    ]);
    const { client } = createClient(impl);

    await expect(client.call('search', { query: 'x' })).rejects.toMatchObject({ name: 'RegistryError' });
    /* Без {csrf:true} повтора нет - ровно один вызов */
    expect(calls).toHaveLength(1);
  });
});

describe('протухшая cookie', () => {
  it('HTTP 401 -> onAuthFailure() -> рефреш -> повтор', async () => {
    const { impl, calls } = fakeFetch([
      { status: 401, payload: {} },
      { payload: { status: 'ok', data: { ok: true } } },
    ]);
    const { client, auth } = createClient(impl);

    const data = await client.call<{ ok: boolean }>('search', { query: 'x' });

    expect(auth.authFailures).toBe(1);
    expect(data).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('код invalid_cookies трактуется как отказ авторизации, а не прикладная ошибка', async () => {
    const { impl } = fakeFetch([
      { payload: { status: 'error', data: { code: 'invalid_cookies' } } },
      { payload: { status: 'ok', data: { ok: true } } },
    ]);
    const { client, auth } = createClient(impl);

    await client.call('search', { query: 'x' });

    expect(auth.authFailures).toBe(1);
  });

  it('не зацикливается: повторный отказ после рефреша сюрфейсится наверх', async () => {
    const { impl, calls } = fakeFetch([{ status: 401, payload: {} }]);
    const { client, auth } = createClient(impl);

    await expect(client.call('search', { query: 'x' })).rejects.toMatchObject({ name: 'AuthError', kind: 'cookie' });

    expect(auth.authFailures).toBe(1);
    expect(calls).toHaveLength(2);
  });
});
