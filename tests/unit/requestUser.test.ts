import { describe, expect, it } from 'vitest';
import { AuthError } from '../../src/auth/AuthProvider.js';
import { requestUser, resolveUserParam } from '../../src/auth/requestUser.js';

const API_URL = 'https://yandex.ru/messenger/api/registry/api/';
const CSRF_URL = 'https://yandex.ru/messenger/api/registry/csrf-token/';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Фейковый fetch: csrf-token -> {token}, затем ответ registry по сценарию */
function fakeFetch(registryResponse: { status?: number; payload: unknown }, csrf: unknown = { token: 'csrf-token-value' }) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers, body: init?.body });
    if (url === CSRF_URL) {
      return new Response(JSON.stringify(csrf), { status: 200 });
    }
    return new Response(JSON.stringify(registryResponse.payload), { status: registryResponse.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const LOGGED_IN_PAYLOAD = {
  status: 'ok',
  data: { user: { guid: '00000000-0000-4000-8000-000000000001', uid: 1234567890, display_name: 'x' } },
};

function options(impl: typeof fetch) {
  return { cookieHeader: 'Session_id=x; yandexuid=1', apiUrl: API_URL, csrfTokenUrl: CSRF_URL, fetchImpl: impl };
}

describe('requestUser', () => {
  it('шлёт params ровно {bind_phone_number:false} - снято с живого веб-клиента', async () => {
    const { impl, calls } = fakeFetch({ payload: LOGGED_IN_PAYLOAD });

    await requestUser(options(impl));

    const registryCall = calls.find((call) => call.url === API_URL);
    const form = registryCall?.body as FormData;
    expect(JSON.parse(String(form.get('request')))).toEqual({
      method: 'request_user',
      params: { bind_phone_number: false },
    });
  });

  it('прикладывает X-CSRF-TOKEN: без него метод отвечает bad_csrf_token', async () => {
    const { impl, calls } = fakeFetch({ payload: LOGGED_IN_PAYLOAD });

    await requestUser(options(impl));

    expect(calls[0]?.url).toBe(CSRF_URL);
    expect(calls[1]?.headers['X-CSRF-TOKEN']).toBe('csrf-token-value');
  });

  it('маппит uid (числом в JSON) и guid в строковый Whoami', async () => {
    const { impl } = fakeFetch({ payload: LOGGED_IN_PAYLOAD });

    const result = await requestUser(options(impl));

    expect(result.user).toEqual({ uid: '1234567890', guid: '00000000-0000-4000-8000-000000000001' });
  });

  it('не выставляет secretSign, когда сервер его не прислал (залогиненный пользователь)', async () => {
    const { impl } = fakeFetch({ payload: LOGGED_IN_PAYLOAD });

    const result = await requestUser(options(impl));

    expect(result.secretSign).toBeUndefined();
  });

  it('читает sign+ts из ответа на гостевой ветке: ts приходит от сервера, а не минтится клиентом', async () => {
    const { impl } = fakeFetch({
      payload: {
        status: 'ok',
        data: { guid: 'a1b2c3d4-0000-4000-8000-000000000001', sign: 'a'.repeat(32), ts: 1752710400 },
      },
    });

    const result = await requestUser(options(impl));

    expect(result.secretSign).toEqual({ sign: 'a'.repeat(32), ts: '1752710400' });
  });

  it('бросает AuthError(cookie) на отвергнутой cookie - сигнал рефрешнуть профиль', async () => {
    const { impl } = fakeFetch({ status: 403, payload: { status: 'error', data: { code: 'invalid_cookies' } } });

    await expect(requestUser(options(impl))).rejects.toMatchObject({ name: 'AuthError', kind: 'cookie' });
  });

  it('бросает AuthError(csrf) на bad_csrf_token', async () => {
    const { impl } = fakeFetch({ status: 403, payload: { status: 'error', data: { code: 'bad_csrf_token' } } });

    await expect(requestUser(options(impl))).rejects.toMatchObject({ name: 'AuthError', kind: 'csrf' });
  });

  it('бросает AuthError(csrf), если csrf-token не отдал token', async () => {
    const { impl } = fakeFetch({ payload: LOGGED_IN_PAYLOAD }, {});

    await expect(requestUser(options(impl))).rejects.toBeInstanceOf(AuthError);
  });
});

describe('resolveUserParam', () => {
  it('у залогиненного пользователя в user= идёт числовой uid', () => {
    expect(resolveUserParam({ uid: '1234567890', guid: '00000000-0000-4000-8000-000000000001' })).toBe('1234567890');
  });

  it('без uid откатывается на guid - так гостевой захват SPIKE 3 и увидел GUID', () => {
    expect(resolveUserParam({ guid: '00000000-0000-4000-8000-000000000001' })).toBe(
      '00000000-0000-4000-8000-000000000001',
    );
  });
});
