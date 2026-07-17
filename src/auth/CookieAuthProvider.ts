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
  type ProfileSessionSource,
  type Whoami,
} from './AuthProvider.js';
import { requestUser, resolveUserParam, type RequestUserResult } from './requestUser.js';
import type { Logger } from '../util/logger.js';

export interface CookieAuthProviderDeps {
  profile: ProfileSessionSource;
  apiUrl: string;
  csrfTokenUrl: string;
  logger?: Logger;
  /** Подменяется в тестах */
  requestUserImpl?: typeof requestUser;
}

export class CookieAuthProvider implements AuthProvider {
  private cached: AuthContext | undefined;
  private pending: Promise<AuthContext> | undefined;

  constructor(private readonly deps: CookieAuthProviderDeps) {}

  async getAuthContext(): Promise<AuthContext> {
    if (this.cached !== undefined) {
      return this.cached;
    }
    /* Схлопываем параллельные вызовы в один логин, чтобы не поднимать браузер дважды */
    this.pending ??= this.build().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  async getWhoami(): Promise<Whoami> {
    const context = await this.getAuthContext();
    return { uid: context.userUid, guid: context.userGuid };
  }

  /** Транспорт получил 401: сбрасываем кэш и рефрешим профиль */
  async onAuthFailure(): Promise<void> {
    this.deps.logger?.warn('auth: креды отвергнуты, рефреш профиля');
    this.cached = undefined;
    await this.deps.profile.refresh();
  }

  private async build(): Promise<AuthContext> {
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
      const refreshed = await this.deps.profile.refresh();
      const retried = await this.callRequestUser(load, refreshed.cookieHeader);
      const context = this.toContext(retried, refreshed.cookieHeader, refreshed.yandexUid);
      this.cached = context;
      return context;
    }

    const context = this.toContext(result, session.cookieHeader, session.yandexUid);
    this.cached = context;
    return context;
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
