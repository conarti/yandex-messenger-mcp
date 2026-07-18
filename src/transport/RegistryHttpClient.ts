/**
 * HTTP registry-транспорт (§3.1): POST на apiUrl, тело - multipart FormData
 * с единственным полем `request` = JSON `{method, params}`, авторизация - заголовок `Cookie`.
 *
 * Использует глобальный fetch (Node 22 = undici в рантайме) - отдельная зависимость не нужна.
 *
 * CSRF - по признаку вызова. Read-методы (search, метаданные, файлы) идут на голой cookie.
 * Registry-МУТАЦИИ (`join_to_thread`/`leave_thread`) требуют `X-CSRF-TOKEN`, как `request_user`
 * (§17.4): без него сервер отвечает `bad_csrf_token`. Такие вызовы помечаются `{csrf:true}`,
 * токен берётся из AuthProvider.getCsrfToken(). На `bad_csrf_token` токен перефетчивается один
 * раз (он мог протухнуть) и вызов повторяется - по аналогии с рефрешем cookie.
 *
 * Ответ обёрнут в `{status, data}`; исключение - `csrf-token`, отдающий `{token}` голым
 * (§17.6), поэтому он и не ходит через этот клиент.
 */
import { AuthError, type AuthProvider } from '../auth/AuthProvider.js';
import type { Logger } from '../util/logger.js';

/** Ошибка прикладного слоя registry: `{status:"error", data:{code, text, source}}` */
export class RegistryError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly text: string | undefined,
    readonly source: string | undefined,
  ) {
    /* Текст и источник в сообщении: без них `code` вроде bad_request не диагностируется */
    const details = [text, source !== undefined ? `source=${source}` : undefined].filter(Boolean).join(', ');
    super(`registry ${method} вернул ошибку ${code}${details ? `: ${details}` : ''}`);
    this.name = 'RegistryError';
  }
}

/** Коды registry, означающие протухшую/отвергнутую cookie - повод рефрешнуть профиль */
const COOKIE_ERROR_CODES = new Set(['invalid_cookies', 'not_authorized', 'no_credentials', 'cookie_auth_failed']);

/** Код ответа registry, означающий протухший/невалидный CSRF-токен - повод перефетчить и повторить */
const BAD_CSRF_TOKEN_CODE = 'bad_csrf_token';

/** Опции вызова registry-метода */
export interface RegistryCallOptions {
  /** Приложить `X-CSRF-TOKEN`: обязателен для registry-МУТАЦИЙ (join/leave), как для request_user (§17.4) */
  csrf?: boolean;
}

export interface RegistryHttpClientDeps {
  apiUrl: string;
  auth: AuthProvider;
  logger?: Logger;
  /** Подменяется в тестах; по умолчанию глобальный fetch */
  fetchImpl?: typeof fetch;
}

interface RegistryEnvelope {
  status?: unknown;
  data?: unknown;
}

interface RegistryErrorData {
  code?: unknown;
  text?: unknown;
  source?: unknown;
}

export class RegistryHttpClient {
  private readonly doFetch: typeof fetch;

  constructor(private readonly deps: RegistryHttpClientDeps) {
    this.doFetch = deps.fetchImpl ?? fetch;
  }

  /**
   * Вызывает registry-метод и отдаёт распакованный `data`.
   * На отвергнутой cookie один раз рефрешит сессию через onAuthFailure() и повторяет.
   * На отвергнутом CSRF-токене (`{csrf:true}`-вызовы) один раз перефетчивает токен и повторяет.
   */
  async call<T>(method: string, params: Record<string, unknown> = {}, options: RegistryCallOptions = {}): Promise<T> {
    try {
      return await this.attempt<T>(method, params, options);
    } catch (error) {
      /* Протухшая cookie: рефреш профиля и один повтор */
      if (error instanceof AuthError && error.kind === 'cookie') {
        this.deps.logger?.warn('registry: cookie отвергнута, рефреш и повтор', { method });
        await this.deps.auth.onAuthFailure();
        return this.attempt<T>(method, params, options);
      }
      /* Протухший CSRF-токен на мутации: инвалидируем токен, перефетчиваем и один повтор */
      if (options.csrf === true && isBadCsrfToken(error)) {
        this.deps.logger?.warn('registry: CSRF-токен отвергнут, рефетч и повтор', { method });
        return this.attempt<T>(method, params, options, true);
      }
      throw error;
    }
  }

  private async attempt<T>(
    method: string,
    params: Record<string, unknown>,
    options: RegistryCallOptions,
    forceCsrfRefresh = false,
  ): Promise<T> {
    const context = await this.deps.auth.getAuthContext();

    const form = new FormData();
    form.append('request', JSON.stringify({ method, params }));

    const headers: Record<string, string> = {
      Cookie: context.cookieHeader,
      Accept: 'application/json',
      Referer: 'https://yandex.ru/chat',
    };
    /* Мутации (join/leave) требуют CSRF, как request_user (§17.4); read-методы идут на голой cookie */
    if (options.csrf === true) {
      headers['X-CSRF-TOKEN'] = await this.deps.auth.getCsrfToken(forceCsrfRefresh);
    }

    const response = await this.doFetch(this.deps.apiUrl, {
      method: 'POST',
      body: form,
      headers,
    });

    if (response.status === 401) {
      throw new AuthError(`registry ${method} отверг cookie (HTTP 401)`, 'cookie');
    }

    const envelope = (await response.json()) as RegistryEnvelope;

    if (envelope.status !== 'ok') {
      throw this.toError(method, envelope.data);
    }

    this.deps.logger?.debug('registry: ответ получен', { method });
    return envelope.data as T;
  }

  /** `bad_csrf_token` приходит как прикладная ошибка `{status:error, data:{code}}`, не как HTTP-статус */
  private toError(method: string, data: unknown): Error {
    const details: RegistryErrorData = (data ?? {}) as RegistryErrorData;
    const code = typeof details.code === 'string' ? details.code : 'unknown';
    if (COOKIE_ERROR_CODES.has(code)) {
      return new AuthError(`registry ${method} отверг cookie: ${code}`, 'cookie');
    }
    return new RegistryError(
      method,
      code,
      typeof details.text === 'string' ? details.text : undefined,
      typeof details.source === 'string' ? details.source : undefined,
    );
  }
}

/** Отвергнутый CSRF-токен: registry отвечает `{status:error, data:{code:"bad_csrf_token", source:"yamb"}}` */
function isBadCsrfToken(error: unknown): boolean {
  return error instanceof RegistryError && error.code === BAD_CSRF_TOKEN_CODE;
}
