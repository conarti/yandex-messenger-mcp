/**
 * Persistent-профиль Playwright: единственное место, где поднимается браузер.
 *
 * Браузер нужен только для логина (headed) и рефреша сессии (headless) - весь
 * протокол дальше гоняется в Node на извлечённой cookie.
 *
 * Ревизия Chromium берётся штатная, из playwright-пакета (ожидаемая ревизия
 * присутствует в кэше ms-playwright); executablePath не переопределяется, чтобы
 * не расходиться с версией, под которую собран драйвер.
 */
import { chromium, type BrowserContext, type Cookie } from 'playwright';
import type { ProfileSession, ProfileSessionSource } from './AuthProvider.js';
import type { Logger } from '../util/logger.js';

/** Страница Мессенджера: она же точка логина */
const MESSENGER_URL = 'https://yandex.ru/chat';
/** Наличие этой куки = Паспорт отдал живую сессию */
const SESSION_COOKIE = 'Session_id';
const YANDEX_UID_COOKIE = 'yandexuid';

const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_BOOT_TIMEOUT_MS = 30 * 1000;
const SESSION_POLL_INTERVAL_MS = 1000;

export interface PlaywrightProfileOptions {
  profileDir: string;
  logger?: Logger;
  /** Сколько ждать ручного входа в headed-режиме */
  loginTimeoutMs?: number;
}

/** Куки домена yandex.ru: только те, что реально уйдут на yandex.ru */
function isYandexRuCookie(cookie: Cookie): boolean {
  return cookie.domain === '.yandex.ru' || cookie.domain === 'yandex.ru';
}

export function buildCookieHeader(cookies: Cookie[]): string {
  return cookies
    .filter(isYandexRuCookie)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function findCookie(cookies: Cookie[], name: string): Cookie | undefined {
  return cookies.filter(isYandexRuCookie).find((cookie) => cookie.name === name);
}

export function hasLiveSession(cookies: Cookie[]): boolean {
  const session = findCookie(cookies, SESSION_COOKIE);
  return session !== undefined && session.value.length > 0;
}

function toSession(cookies: Cookie[]): ProfileSession {
  const yandexUid = findCookie(cookies, YANDEX_UID_COOKIE);
  if (yandexUid === undefined) {
    /* yandexuid нужен для push LogData.YandexUid (§14.4) */
    throw new Error(`Кука ${YANDEX_UID_COOKIE} отсутствует в профиле`);
  }
  return { cookieHeader: buildCookieHeader(cookies), yandexUid: yandexUid.value };
}

export class PlaywrightProfile implements ProfileSessionSource {
  private cached: ProfileSession | undefined;

  constructor(private readonly options: PlaywrightProfileOptions) {}

  /** Отдаёт сессию из кэша; иначе поднимает профиль */
  async load(): Promise<ProfileSession> {
    if (this.cached !== undefined) {
      return this.cached;
    }
    return this.refresh();
  }

  /**
   * Headless-рефреш: даём Паспорту обновить сессию и ре-экстрактим cookie.
   * Если сессии нет - эскалация в headed-логин.
   */
  async refresh(): Promise<ProfileSession> {
    this.cached = undefined;

    const headless = await this.extract({ headless: true, waitMs: DEFAULT_BOOT_TIMEOUT_MS });
    if (headless !== undefined) {
      this.options.logger?.info('auth: сессия профиля обновлена headless');
      this.cached = headless;
      return headless;
    }

    this.options.logger?.warn('auth: headless-рефреш не дал сессии, нужен ручной вход');
    const headed = await this.extract({
      headless: false,
      waitMs: this.options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
    });
    if (headed === undefined) {
      throw new Error(
        `Не удалось получить сессию Яндекса. Войдите в аккаунт в открывшемся браузере (профиль: ${this.options.profileDir})`,
      );
    }
    this.options.logger?.info('auth: сессия получена после входа');
    this.cached = headed;
    return headed;
  }

  /** Поднимает контекст, ждёт появления Session_id, извлекает cookie */
  private async extract(params: { headless: boolean; waitMs: number }): Promise<ProfileSession | undefined> {
    const context = await chromium.launchPersistentContext(this.options.profileDir, {
      headless: params.headless,
      viewport: { width: 1280, height: 900 },
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(MESSENGER_URL, { waitUntil: 'domcontentloaded' }).catch(() => {
        /* сеть могла моргнуть: сессию всё равно проверяем по cookie */
      });
      const cookies = await this.waitForSession(context, params.waitMs);
      return cookies === undefined ? undefined : toSession(cookies);
    } finally {
      await context.close();
    }
  }

  private async waitForSession(context: BrowserContext, waitMs: number): Promise<Cookie[] | undefined> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const cookies = await context.cookies();
      if (hasLiveSession(cookies)) {
        return cookies;
      }
      if (Date.now() >= deadline) {
        return undefined;
      }
      await new Promise((resolve) => setTimeout(resolve, SESSION_POLL_INTERVAL_MS));
    }
  }
}
