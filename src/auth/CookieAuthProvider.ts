/**
 * Адаптер cookie-режима: profile -> cookie -> request_user -> AuthContext.
 *
 * Кэширует контекст: у залогиненного пользователя в нём нет короткоживущих
 * величин (подписи `sign`/`ts` на этом пути не существует), поэтому ре-минт
 * перед каждым коннектом не нужен. Инвалидация - только через onAuthFailure().
 */
import {
  AuthError,
  type AuthContext,
  type AuthProvider,
  type ProfileSession,
  type ProfileSessionSource,
  type Whoami,
} from './AuthProvider.js';
import { fetchCsrfToken } from './csrfToken.js';
import { requestUser, resolveUserParam, type RequestUserResult } from './requestUser.js';
import type { Logger } from '../util/logger.js';

export interface CookieAuthProviderDeps {
  profile: ProfileSessionSource;
  apiUrl: string;
  csrfTokenUrl: string;
  logger?: Logger;
  /** Подменяется в тестах */
  requestUserImpl?: typeof requestUser;
  /** Подменяется в тестах; по умолчанию глобальный fetch */
  fetchImpl?: typeof fetch;
}

export class CookieAuthProvider implements AuthProvider {
  private cached: AuthContext | undefined;
  private pending: Promise<AuthContext> | undefined;
  private refreshing: Promise<ProfileSession> | undefined;
  /** CSRF-токен привязан к текущей cookie: кэшируем, чистим при инвалидации/рефреше */
  private cachedCsrfToken: string | undefined;
  /**
   * Эпоха кэша. Инкрементируется каждой инвалидацией, чтобы `build()`, стартовавший ДО неё,
   * не мог записать в кэш уже мёртвую cookie, резолвясь после.
   */
  private generation = 0;

  constructor(private readonly deps: CookieAuthProviderDeps) {}

  async getAuthContext(): Promise<AuthContext> {
    if (this.cached !== undefined) {
      return this.cached;
    }
    /* Схлопываем параллельные вызовы в один логин, чтобы не поднимать браузер дважды */
    if (this.pending === undefined) {
      const pending = this.build().finally(() => {
        /* Сверка по ссылке: инвалидация могла обнулить pending и запустить новую сборку */
        if (this.pending === pending) {
          this.pending = undefined;
        }
      });
      this.pending = pending;
    }
    return this.pending;
  }

  async getWhoami(): Promise<Whoami> {
    const context = await this.getAuthContext();
    return { uid: context.userUid, guid: context.userGuid };
  }

  /**
   * CSRF-токен на текущей cookie. Кэшируется: он живёт, пока жива cookie.
   * `forceRefresh` перефетчивает - путь восстановления после `bad_csrf_token`.
   */
  async getCsrfToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cachedCsrfToken !== undefined) {
      return this.cachedCsrfToken;
    }
    const context = await this.getAuthContext();
    const token = await fetchCsrfToken(this.deps.csrfTokenUrl, context.cookieHeader, this.deps.fetchImpl ?? fetch);
    this.cachedCsrfToken = token;
    return token;
  }

  /** Транспорт получил 401: сбрасываем кэш и рефрешим профиль */
  async onAuthFailure(): Promise<void> {
    this.deps.logger?.warn('auth: креды отвергнуты, рефреш профиля');
    this.generation += 1;
    this.cached = undefined;
    /* Новая cookie обесценивает старый CSRF-токен - чистим, чтобы следующий getCsrfToken перефетчил */
    this.cachedCsrfToken = undefined;
    /* Сборку на мёртвой cookie бросаем: её результат уже не годен новым вызывающим */
    this.pending = undefined;
    await this.refreshProfile();
  }

  /**
   * Единственная точка входа в `profile.refresh()`. Схлопывает параллельные рефреши:
   * два `launchPersistentContext` на одном profileDir упрутся в singleton-lock Chromium,
   * а одновременный отказ на WS и на скачивании - это ровно два вызова.
   */
  private async refreshProfile(): Promise<ProfileSession> {
    if (this.refreshing === undefined) {
      const refreshing = this.deps.profile.refresh().finally(() => {
        if (this.refreshing === refreshing) {
          this.refreshing = undefined;
        }
      });
      this.refreshing = refreshing;
    }
    return this.refreshing;
  }

  /** Пишет кэш, только если за время сборки не случилось инвалидации */
  private commit(context: AuthContext, generation: number): AuthContext {
    if (generation === this.generation) {
      this.cached = context;
    } else {
      this.deps.logger?.warn('auth: контекст собран на отозванной cookie, кэш не обновляем');
    }
    return context;
  }

  private async build(): Promise<AuthContext> {
    const generation = this.generation;
    const load = this.deps.requestUserImpl ?? requestUser;
    const session = await this.deps.profile.load();

    let result: RequestUserResult;
    try {
      result = await this.callRequestUser(load, session.cookieHeader);
    } catch (error) {
      /* Cookie протухла между извлечением и вызовом: рефрешим профиль и пробуем ещё раз */
      if (!(error instanceof AuthError) || error.kind !== 'cookie') {
        throw error;
      }
      this.deps.logger?.warn('auth: cookie отвергнута, рефреш профиля и повтор');
      const refreshed = await this.refreshProfile();
      const retried = await this.callRequestUser(load, refreshed.cookieHeader);
      return this.commit(this.toContext(retried, refreshed.cookieHeader, refreshed.yandexUid), generation);
    }

    return this.commit(this.toContext(result, session.cookieHeader, session.yandexUid), generation);
  }

  private async callRequestUser(load: typeof requestUser, cookieHeader: string): Promise<RequestUserResult> {
    return load({
      cookieHeader,
      apiUrl: this.deps.apiUrl,
      csrfTokenUrl: this.deps.csrfTokenUrl,
    });
  }

  private toContext(result: RequestUserResult, cookieHeader: string, yandexUid: string): AuthContext {
    this.deps.logger?.info('auth: контекст собран', { hasSecretSign: result.secretSign !== undefined });
    return {
      cookieHeader,
      userUid: resolveUserParam(result.user),
      userGuid: result.user.guid,
      yandexUid,
      ...(result.secretSign !== undefined ? { secretSign: result.secretSign } : {}),
    };
  }
}
