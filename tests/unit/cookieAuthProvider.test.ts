import { describe, expect, it, vi } from 'vitest';
import { AuthError, type ProfileSession, type ProfileSessionSource } from '../../src/auth/AuthProvider.js';
import { CookieAuthProvider } from '../../src/auth/CookieAuthProvider.js';
import type { RequestUserResult } from '../../src/auth/requestUser.js';

const WHOAMI = { uid: '1234567890', guid: '00000000-0000-4000-8000-000000000001' };

/** Fake persistent context: отдаёт сессию без браузера */
class FakeProfile implements ProfileSessionSource {
  loadCalls = 0;
  refreshCalls = 0;

  constructor(private session: ProfileSession = { cookieHeader: 'Session_id=live', yandexUid: '555' }) {}

  async load(): Promise<ProfileSession> {
    this.loadCalls += 1;
    return this.session;
  }

  async refresh(): Promise<ProfileSession> {
    this.refreshCalls += 1;
    this.session = { cookieHeader: 'Session_id=refreshed', yandexUid: '555' };
    return this.session;
  }
}

function provider(profile: ProfileSessionSource, requestUserImpl: () => Promise<RequestUserResult>) {
  return new CookieAuthProvider({
    profile,
    apiUrl: 'https://api.test/',
    csrfTokenUrl: 'https://csrf.test/',
    requestUserImpl: requestUserImpl as never,
  });
}

describe('CookieAuthProvider', () => {
  it('собирает AuthContext из профиля и request_user', async () => {
    const profile = new FakeProfile();
    const auth = provider(profile, async () => ({ user: WHOAMI }));

    const context = await auth.getAuthContext();

    expect(context).toEqual({
      cookieHeader: 'Session_id=live',
      userUid: '1234567890',
      userGuid: '00000000-0000-4000-8000-000000000001',
      yandexUid: '555',
    });
  });

  it('отдаёт whoami с uid и guid', async () => {
    const auth = provider(new FakeProfile(), async () => ({ user: WHOAMI }));

    await expect(auth.getWhoami()).resolves.toEqual(WHOAMI);
  });

  it('кэширует контекст: повторный вызов не дёргает request_user снова', async () => {
    const load = vi.fn(async () => ({ user: WHOAMI }));
    const auth = provider(new FakeProfile(), load);

    await auth.getAuthContext();
    await auth.getAuthContext();

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('схлопывает параллельные вызовы в один логин', async () => {
    const load = vi.fn(async () => ({ user: WHOAMI }));
    const auth = provider(new FakeProfile(), load);

    await Promise.all([auth.getAuthContext(), auth.getAuthContext(), auth.getAuthContext()]);

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('на отвергнутой cookie рефрешит профиль и повторяет request_user', async () => {
    const profile = new FakeProfile();
    const load = vi
      .fn<() => Promise<RequestUserResult>>()
      .mockRejectedValueOnce(new AuthError('cookie протухла', 'cookie'))
      .mockResolvedValueOnce({ user: WHOAMI });
    const auth = provider(profile, load);

    const context = await auth.getAuthContext();

    expect(profile.refreshCalls).toBe(1);
    expect(context.cookieHeader).toBe('Session_id=refreshed');
  });

  it('не рефрешит профиль на протокольной ошибке - она не про cookie', async () => {
    const profile = new FakeProfile();
    const auth = provider(profile, async () => {
      throw new AuthError('registry сломался', 'protocol');
    });

    await expect(auth.getAuthContext()).rejects.toMatchObject({ kind: 'protocol' });
    expect(profile.refreshCalls).toBe(0);
  });

  it('onAuthFailure сбрасывает кэш и рефрешит профиль', async () => {
    const profile = new FakeProfile();
    const load = vi.fn(async () => ({ user: WHOAMI }));
    const auth = provider(profile, load);

    await auth.getAuthContext();
    await auth.onAuthFailure();
    await auth.getAuthContext();

    expect(profile.refreshCalls).toBe(1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  /*
   * Регрессия на ГОНКУ ИНВАЛИДАЦИИ: onAuthFailure() чистил кэш, но build(), стартовавший
   * до него, резолвился позже и переприсваивал cached - возвращая в кэш МЁРТВУЮ cookie,
   * ту самую, из-за которой инвалидация и случилась.
   */
  it('инвалидация побеждает гонку: build(), стартовавший до onAuthFailure, не пишет кэш', async () => {
    const profile = new FakeProfile();
    let releaseFirst!: (result: RequestUserResult) => void;
    let markFirstCallSeen!: () => void;
    const firstCallSeen = new Promise<void>((resolve) => {
      markFirstCallSeen = resolve;
    });
    const firstResult = new Promise<RequestUserResult>((resolve) => {
      releaseFirst = resolve;
    });

    let calls = 0;
    const load = vi.fn(async (): Promise<RequestUserResult> => {
      calls += 1;
      if (calls === 1) {
        markFirstCallSeen();
        return firstResult;
      }
      return { user: WHOAMI };
    });
    const auth = provider(profile, load);

    const inflight = auth.getAuthContext();
    await firstCallSeen; /* build гарантированно висит на request_user */
    await auth.onAuthFailure(); /* инвалидация посреди сборки */
    releaseFirst({ user: WHOAMI }); /* мёртвая cookie резолвится уже ПОСЛЕ инвалидации */
    await inflight;

    await auth.getAuthContext();

    /* Пересборка обязана случиться: отданный кэш означал бы возврат отозванной cookie */
    expect(load).toHaveBeenCalledTimes(2);
  });

  /*
   * Регрессия на ПАРАЛЛЕЛЬНЫЕ РЕФРЕШИ: getAuthContext() схлопывал их, а onAuthFailure() - нет.
   * Одновременный отказ на WS и на скачивании поднимал два launchPersistentContext на одном
   * profileDir -> singleton-lock Chromium.
   */
  it('onAuthFailure схлопывает параллельные рефреши в один запуск браузера', async () => {
    const profile = new FakeProfile();
    const auth = provider(profile, async () => ({ user: WHOAMI }));
    await auth.getAuthContext();

    await Promise.all([auth.onAuthFailure(), auth.onAuthFailure()]);

    expect(profile.refreshCalls).toBe(1);
  });

  it('прокидывает secretSign, если сервер его прислал (гостевая ветка)', async () => {
    const auth = provider(new FakeProfile(), async () => ({
      user: WHOAMI,
      secretSign: { sign: 'b'.repeat(32), ts: '1752710400' },
    }));

    const context = await auth.getAuthContext();

    expect(context.secretSign).toEqual({ sign: 'b'.repeat(32), ts: '1752710400' });
  });
});
