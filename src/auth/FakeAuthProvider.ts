/**
 * Fake-провайдер: отдаёт валидный AuthContext без браузера и без сети.
 * Нужен тестам транспорта/протокола, чтобы не тащить Playwright и живую сессию.
 */
import type { AuthContext, AuthProvider, Whoami } from './AuthProvider.js';

/* Значения-заглушки правдоподобной формы: uid - 10 цифр, guid - GUID */
const DEFAULT_CONTEXT: AuthContext = {
  cookieHeader: 'Session_id=fake-session; yandexuid=1234567890123456789',
  userUid: '1234567890',
  userGuid: '00000000-0000-4000-8000-000000000000',
  yandexUid: '1234567890123456789',
};

export interface FakeAuthProviderOptions {
  context?: Partial<AuthContext>;
  /** Заставляет getAuthContext() падать - для тестов пути 401 */
  failWith?: Error;
  /** Синтетический CSRF-токен; по умолчанию 'fake-csrf-token' */
  csrfToken?: string;
}

export class FakeAuthProvider implements AuthProvider {
  readonly context: AuthContext;
  /** Сколько раз транспорт сообщил об отказе кред */
  authFailures = 0;
  /** История запросов CSRF-токена: значение forceRefresh каждого вызова getCsrfToken */
  readonly csrfTokenCalls: boolean[] = [];

  constructor(private readonly options: FakeAuthProviderOptions = {}) {
    this.context = { ...DEFAULT_CONTEXT, ...options.context };
  }

  async getAuthContext(): Promise<AuthContext> {
    if (this.options.failWith !== undefined) {
      throw this.options.failWith;
    }
    return this.context;
  }

  async getWhoami(): Promise<Whoami> {
    return { uid: this.context.userUid, guid: this.context.userGuid };
  }

  async getCsrfToken(forceRefresh = false): Promise<string> {
    this.csrfTokenCalls.push(forceRefresh);
    return this.options.csrfToken ?? 'fake-csrf-token';
  }

  async onAuthFailure(): Promise<void> {
    this.authFailures += 1;
  }
}
