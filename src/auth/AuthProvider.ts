/**
 * ПОРТ слоя авторизации: единственный шов, через который транспорты получают
 * всё необходимое для аутентифицированного вызова.
 *
 * Сборку WS-URL порт НЕ делает - это забота MessengerWsClient (Phase 3), которому
 * достаточно AuthContext.
 */

/** Идентичность пользователя. Оба поля нужны на разных участках протокола. */
export interface Whoami {
  /**
   * Числовой uid Паспорта (10 цифр, строкой).
   * Идёт в `user=` WS-URL: клиент вычисляет `uid || guid` (см. setCredentials в chats-web),
   * и у залогиненного пользователя uid всегда есть.
   */
  uid: string;
  /** GUID Мессенджера. Нужен для конструирования приватного ChatId `<собеседник>_<я>` (§5) */
  guid: string;
}

/**
 * Подпись xiva-сессии.
 *
 * ЖИВОЙ ФАКТ (2026-07-17): у ЗАЛОГИНЕННОГО пользователя её НЕТ - `request_user`
 * не возвращает `secret_sign`, а WS-URL не несёт `sign`/`ts` и поднимается на одной cookie.
 * secretSign - это ветка гостя/заблокированной cookie/OAuth (клиент выставляет
 * `secretSignNeeded` только на close-reason COOKIE_AUTH_FAILED/NO_CREDENTIALS либо под OAuth).
 * Поэтому поле опционально: заполняется, только если сервер его прислал.
 *
 * `ts` приходит из ответа `request_user` в паре со `sign` (гостевая ветка мапится как
 * `secretSign: {sign: e.sign, ts: e.ts}`), клиентом НЕ минтится.
 */
export interface SecretSign {
  sign: string;
  ts: string;
}

/** Всё, что транспорту нужно для аутентифицированного вызова */
export interface AuthContext {
  /** Готовый заголовок `Cookie` для HTTP и WS-хендшейка */
  cookieHeader: string;
  /** Числовой uid -> `user=` в WS-URL */
  userUid: string;
  /** GUID -> приватный ChatId (§5) */
  userGuid: string;
  /** Кука `yandexuid` -> `push` LogData.YandexUid (§14.4) */
  yandexUid: string;
  /** Отсутствует на обычном cookie-пути залогиненного пользователя (см. SecretSign) */
  secretSign?: SecretSign;
}

export interface AuthProvider {
  /** Собирает контекст для транспорта. Реализация вправе кэшировать. */
  getAuthContext(): Promise<AuthContext>;
  /** Идентичность пользователя */
  getWhoami(): Promise<Whoami>;
  /**
   * Сигнал транспорта, что текущие креды отвергнуты (401 / cookie auth failed).
   * Реализация обязана инвалидировать кэш, чтобы следующий getAuthContext() переавторизовался.
   */
  onAuthFailure(): Promise<void>;
}

/** Сессия, извлечённая из persistent-профиля браузера */
export interface ProfileSession {
  cookieHeader: string;
  yandexUid: string;
}

/** Источник сессии профиля. Абстрагирован, чтобы CookieAuthProvider тестировался без браузера. */
export interface ProfileSessionSource {
  /** Отдаёт сессию (может быть из кэша/headless) */
  load(): Promise<ProfileSession>;
  /** Принудительно переавторизуется: headless-рефреш, при неудаче - headed-логин */
  refresh(): Promise<ProfileSession>;
}

/** Ошибка авторизации: сигнал вызвать onAuthFailure() и повторить */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly kind: 'cookie' | 'csrf' | 'protocol',
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
