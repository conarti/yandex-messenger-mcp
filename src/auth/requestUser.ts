/**
 * HTTP registry-метод `request_user`: идентичность пользователя (uid+guid) на cookie.
 *
 * Снято живьём с chats-web (2026-07-17), а не взято из research:
 *  - params РОВНО `{bind_phone_number: false}` (§10 числил их opaque);
 *  - метод ТРЕБУЕТ CSRF: без `X-CSRF-TOKEN` -> 403 `bad_csrf_token`
 *    (в отличие от read-методов вроде `list_contacts`, которые идут на голой cookie);
 *  - ответ `{status:"ok", data:{user:{guid, uid, display_name, ...}}}`;
 *  - `secret_sign` в ответе ОТСУТСТВУЕТ у залогиненного пользователя.
 *
 * Маппинг ответа повторяет клиентский: если в теле есть `user` - это залогиненный
 * пользователь и `secretSign = data.secret_sign` (у нас всегда undefined); иначе это
 * гостевая ветка, где `secretSign = {sign, ts}` берётся из корня ответа.
 *
 * CSRF-токен фетчится общим `fetchCsrfToken` (auth/csrfToken.ts): тот же токен нужен
 * registry-мутациям join/leave, поэтому логика вынесена и переиспользуется.
 */
import { AuthError, type SecretSign } from './AuthProvider.js';
import { fetchCsrfToken, registryHeaders } from './csrfToken.js';

export interface RequestUserOptions {
  cookieHeader: string;
  apiUrl: string;
  csrfTokenUrl: string;
  /** Подменяется в тестах; по умолчанию глобальный fetch (Node 22 = undici) */
  fetchImpl?: typeof fetch;
}

export interface RequestUserUser {
  /**
   * Числовой uid Паспорта. Есть у залогиненного пользователя; на гостевой ветке
   * ответ несёт только guid, поэтому поле опционально.
   */
  uid?: string;
  guid: string;
}

export interface RequestUserResult {
  user: RequestUserUser;
  /** Присутствует только на гостевой ветке; у залогиненного пользователя - undefined */
  secretSign?: SecretSign;
}

/**
 * Значение для `user=` в WS-URL. Повторяет правило клиента `uid || guid`:
 * у залогиненного это числовой uid, у гостя - guid (чем и объясняется GUID,
 * наблюдавшийся в гостевом захвате SPIKE 3).
 */
export function resolveUserParam(user: RequestUserUser): string {
  return user.uid ?? user.guid;
}

/** Коды ответа registry, означающие протухшую/отвергнутую cookie */
const COOKIE_ERROR_CODES = new Set(['invalid_cookies', 'not_authorized', 'no_credentials', 'cookie_auth_failed']);

interface RegistryUser {
  guid?: unknown;
  uid?: unknown;
}

interface RequestUserPayload {
  status?: unknown;
  data?: {
    user?: RegistryUser;
    secret_sign?: { sign?: unknown; ts?: unknown };
    sign?: unknown;
    ts?: unknown;
    code?: unknown;
  };
}

function parseSecretSign(data: NonNullable<RequestUserPayload['data']>): SecretSign | undefined {
  /* Ветка залогиненного пользователя: подпись лежит в secret_sign (фактически отсутствует) */
  if (data.user !== undefined) {
    const candidate = data.secret_sign;
    if (candidate && typeof candidate.sign === 'string' && candidate.ts !== undefined) {
      return { sign: candidate.sign, ts: String(candidate.ts) };
    }
    return undefined;
  }
  /* Гостевая ветка: sign и ts лежат в корне data и приходят ПАРОЙ от сервера */
  if (typeof data.sign === 'string' && data.ts !== undefined) {
    return { sign: data.sign, ts: String(data.ts) };
  }
  return undefined;
}

/**
 * Загружает идентичность пользователя на извлечённой из профиля cookie.
 * Бросает AuthError('cookie'), если cookie отвергнута - вызывающий обязан рефрешнуть профиль.
 */
export async function requestUser(options: RequestUserOptions): Promise<RequestUserResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const token = await fetchCsrfToken(options.csrfTokenUrl, options.cookieHeader, doFetch);

  const form = new FormData();
  form.append('request', JSON.stringify({ method: 'request_user', params: { bind_phone_number: false } }));

  const response = await doFetch(options.apiUrl, {
    method: 'POST',
    body: form,
    headers: { ...registryHeaders(options.cookieHeader), 'X-CSRF-TOKEN': token },
  });

  if (response.status === 401) {
    throw new AuthError('request_user отверг cookie (HTTP 401)', 'cookie');
  }

  const payload = (await response.json()) as RequestUserPayload;
  const data = payload.data;

  if (payload.status !== 'ok') {
    const code = typeof data?.code === 'string' ? data.code : 'unknown';
    if (COOKIE_ERROR_CODES.has(code)) {
      throw new AuthError(`request_user отверг cookie: ${code}`, 'cookie');
    }
    if (code === 'bad_csrf_token') {
      throw new AuthError('request_user отверг CSRF-токен', 'csrf');
    }
    throw new AuthError(`request_user вернул ошибку: ${code}`, 'protocol');
  }

  /* Залогиненный: guid+uid лежат в data.user. Гость: guid лежит прямо в data */
  const source: RegistryUser = data?.user ?? (data as RegistryUser | undefined) ?? {};
  if (typeof source.guid !== 'string') {
    throw new AuthError('request_user не вернул guid', 'protocol');
  }

  const secretSign = data !== undefined ? parseSecretSign(data) : undefined;

  return {
    user: {
      guid: source.guid,
      ...(source.uid !== undefined ? { uid: String(source.uid) } : {}),
    },
    ...(secretSign !== undefined ? { secretSign } : {}),
  };
}
