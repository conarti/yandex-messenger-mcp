/**
 * Фетч CSRF-токена для registry-мутаций (§17.6).
 *
 * POST csrf-token/ отдаёт `{token}` голым, без обёртки {status,data}. Тот же токен требуют
 * и `request_user` (слой auth), и registry-мутации join/leave (§10), поэтому логика вынесена
 * сюда и переиспользуется, а не дублируется по месту.
 */
import { AuthError } from './AuthProvider.js';

/** Общие заголовки registry-вызова на голой cookie */
export function registryHeaders(cookieHeader: string): Record<string, string> {
  return {
    Cookie: cookieHeader,
    Accept: 'application/json',
    Referer: 'https://yandex.ru/chat',
  };
}

/**
 * POST csrf-token/ -> `{token}` голым, без обёртки {status,data} (§17.6).
 * Бросает AuthError('cookie'), если cookie отвергнута - вызывающий обязан рефрешнуть профиль.
 */
export async function fetchCsrfToken(
  csrfTokenUrl: string,
  cookieHeader: string,
  doFetch: typeof fetch,
): Promise<string> {
  const response = await doFetch(csrfTokenUrl, {
    method: 'POST',
    headers: registryHeaders(cookieHeader),
  });

  if (response.status === 401 || response.status === 403) {
    throw new AuthError(`csrf-token отверг cookie (HTTP ${response.status})`, 'cookie');
  }
  if (!response.ok) {
    throw new AuthError(`csrf-token вернул HTTP ${response.status}`, 'protocol');
  }

  const payload = (await response.json()) as { token?: unknown };
  if (typeof payload.token !== 'string' || payload.token.length === 0) {
    throw new AuthError('csrf-token не вернул поле token', 'csrf');
  }
  return payload.token;
}
