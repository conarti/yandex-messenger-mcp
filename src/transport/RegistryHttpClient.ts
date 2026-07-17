/**
 * HTTP registry-транспорт (§3.1): POST на apiUrl, тело - multipart FormData
 * с единственным полем `request` = JSON `{method, params}`, авторизация - заголовок `Cookie`.
 *
 * Использует глобальный fetch (Node 22 = undici в рантайме) - отдельная зависимость не нужна.
 *
 * CSRF здесь НЕ делается: единственный метод v1, который его требует - `request_user`
 * (§17.4), и он живёт в слое auth, потому что нужен ДО открытия сокета.
 * Остальные read-методы (search, метаданные, файлы) идут на голой cookie.
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
   */
  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    try {
      return await this.attempt<T>(method, params);
    } catch (error) {
      if (!(error instanceof AuthError) || error.kind !== 'cookie') {
        throw error;
      }
      this.deps.logger?.warn('registry: cookie отвергнута, рефреш и повтор', { method });
      await this.deps.auth.onAuthFailure();
      return this.attempt<T>(method, params);
    }
  }

  private async attempt<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const context = await this.deps.auth.getAuthContext();

    const form = new FormData();
    form.append('request', JSON.stringify({ method, params }));

    const response = await this.doFetch(this.deps.apiUrl, {
      method: 'POST',
      body: form,
      headers: {
        Cookie: context.cookieHeader,
        Accept: 'application/json',
        Referer: 'https://yandex.ru/chat',
      },
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
