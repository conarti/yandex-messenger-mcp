import { describe, expect, it } from 'vitest';
import { FakeAuthProvider } from '../../src/auth/FakeAuthProvider.js';

describe('FakeAuthProvider', () => {
  it('отдаёт полный AuthContext без браузера и без сети', async () => {
    const provider = new FakeAuthProvider();

    const context = await provider.getAuthContext();

    expect(context.cookieHeader).toContain('Session_id=');
    expect(context.userUid).toMatch(/^\d{10}$/);
    expect(context.userGuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(context.yandexUid).toMatch(/^\d+$/);
  });

  it('не выдумывает secretSign: на cookie-пути залогиненного пользователя его нет', async () => {
    const provider = new FakeAuthProvider();

    const context = await provider.getAuthContext();

    expect(context.secretSign).toBeUndefined();
  });

  it('позволяет подменить поля контекста', async () => {
    const provider = new FakeAuthProvider({ context: { userUid: '9999999999' } });

    await expect(provider.getWhoami()).resolves.toEqual({
      uid: '9999999999',
      guid: '00000000-0000-4000-8000-000000000000',
    });
  });

  it('считает сигналы onAuthFailure от транспорта', async () => {
    const provider = new FakeAuthProvider();

    await provider.onAuthFailure();
    await provider.onAuthFailure();

    expect(provider.authFailures).toBe(2);
  });

  it('отдаёт синтетический CSRF-токен и пишет forceRefresh каждого вызова', async () => {
    const provider = new FakeAuthProvider();

    await expect(provider.getCsrfToken()).resolves.toBe('fake-csrf-token');
    await provider.getCsrfToken(true);

    expect(provider.csrfTokenCalls).toEqual([false, true]);
  });
});
