/**
 * Единая форма отказа резолва чата (#18, AC-19…AC-23).
 *
 * Проверяются все три достижимые причины и распределение нагрузки между `candidates` и
 * `next_step`: у `name_not_found` кандидатов не бывает СТРУКТУРНО (всё, где их два и больше,
 * уходит в `ambiguous`, а один - в `resolved`), поэтому тест на неё ассертит содержимое
 * подсказки, а не непустоту списка.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildChatResolveFailure,
  requestChatAddressed,
  type ResolvedChatAddress,
} from '../../src/chat/resolveFailure.js';
import { mapResponseStatus, MessengerError } from '../../src/protocol/errors.js';

const MY_GUID = 'aaaaaaaa-1111-2222-3333-444444444444';
const PARTNER_GUID = 'bbbbbbbb-5555-6666-7777-888888888888';
const PRIVATE_CHAT_ID = `${PARTNER_GUID}_${MY_GUID}`;
const QUERY = 'Александр';

const VIA_USER_SEARCH: ResolvedChatAddress = {
  chat_id: PRIVATE_CHAT_ID,
  via: 'user_search',
  name: 'Александр Б.',
};
const VIA_LITERAL: ResolvedChatAddress = { chat_id: PRIVATE_CHAT_ID, via: 'literal' };

/** Отказ бэкенда ровно в той форме, в которой его собирает транспорт из DATA-кадра */
function entityNotFound(details?: string): MessengerError {
  const error = mapResponseStatus('history', {
    Status: 4,
    RequestId: '286c97ff-f942-552c-999aaf01',
    ...(details !== undefined ? { Details: details } : {}),
  });
  if (error === undefined) {
    throw new Error('фикстура не собрала ошибку');
  }
  return error;
}

describe('name_not_found', () => {
  const failure = buildChatResolveFailure({ query: QUERY, reason: 'name_not_found' });

  it('сохраняет литерал chat_not_found и несёт запрос вызывающего', () => {
    expect(failure.status).toBe('chat_not_found');
    expect(failure.query).toBe(QUERY);
    expect(failure.reason).toBe('name_not_found');
  });

  it('кандидатов не несёт: их тут не бывает структурно', () => {
    expect(failure.candidates).toEqual([]);
  });

  it('нагрузку несёт next_step: он называет обе доступные адресации', () => {
    expect(failure.next_step).toContain('ChatId');
    expect(failure.next_step).toContain('list_chats');
    expect(failure.next_step).toContain('search');
  });
});

describe('chat_absent_for_user', () => {
  it('несёт ровно одного кандидата в формате пути неоднозначности', async () => {
    const outcome = await requestChatAddressed(
      { addresses: 'chat_only', query: QUERY, resolved: VIA_USER_SEARCH },
      () => Promise.reject(entityNotFound()),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('ожидался отказ');
    expect(outcome.failure).toMatchObject({ status: 'chat_not_found', reason: 'chat_absent_for_user' });
    expect(outcome.failure.candidates).toEqual([
      { chat_id: PRIVATE_CHAT_ID, name: 'Александр Б.', kind: 'private', via: 'user_search' },
    ]);
    expect(outcome.failure.next_step).toContain('send_message');
  });

  it('пустой Details не считается серверным текстом: stringOr отбрасывает пустую строку', async () => {
    const outcome = await requestChatAddressed(
      { addresses: 'chat_only', query: QUERY, resolved: VIA_USER_SEARCH },
      () => Promise.reject(entityNotFound('')),
    );

    if (outcome.ok) throw new Error('ожидался отказ');
    expect(outcome.failure.reason).toBe('chat_absent_for_user');
  });
});

describe('backend_entity_not_found', () => {
  it('чат адресован литералом - человека за ним нет, кандидатов тоже', async () => {
    const outcome = await requestChatAddressed(
      { addresses: 'chat_only', query: PRIVATE_CHAT_ID, resolved: VIA_LITERAL },
      () => Promise.reject(entityNotFound()),
    );

    if (outcome.ok) throw new Error('ожидался отказ');
    expect(outcome.failure).toMatchObject({
      status: 'chat_not_found',
      reason: 'backend_entity_not_found',
      candidates: [],
    });
    expect(outcome.failure.next_step).toContain('list_chats');
  });

  /* Сервер сказал своё - верим ему, а не собственному выводу «переписки ещё нет» */
  it('серверный текст в Details перебивает via:user_search', async () => {
    const outcome = await requestChatAddressed(
      { addresses: 'chat_only', query: QUERY, resolved: VIA_USER_SEARCH },
      () => Promise.reject(entityNotFound('chat is gone')),
    );

    if (outcome.ok) throw new Error('ожидался отказ');
    expect(outcome.failure.reason).toBe('backend_entity_not_found');
    expect(outcome.failure.candidates).toEqual([]);
  });
});

describe('границы перехвата', () => {
  it('успешный вызов проходит насквозь', async () => {
    const outcome = await requestChatAddressed(
      { addresses: 'chat_only', query: QUERY, resolved: VIA_USER_SEARCH },
      () => Promise.resolve({ Chats: [] }),
    );

    expect(outcome).toEqual({ ok: true, value: { Chats: [] } });
  });

  it('чужие ошибки не подменяются отказом резолва', async () => {
    const accessDenied = entityNotFound();
    const other = new MessengerError({ layer: 'application', code: 2, retriable: false });
    expect(accessDenied.code).not.toBe(other.code);

    await expect(
      requestChatAddressed({ addresses: 'chat_only', query: QUERY, resolved: VIA_USER_SEARCH }, () =>
        Promise.reject(other),
      ),
    ).rejects.toBe(other);
  });

  it('код 4 других слоёв не перехватывается: номер в них значит другое', async () => {
    const pushNoSuchChat = new MessengerError({ layer: 'push', code: 4, retriable: false });

    await expect(
      requestChatAddressed({ addresses: 'chat_only', query: QUERY, resolved: VIA_USER_SEARCH }, () =>
        Promise.reject(pushNoSuchChat),
      ),
    ).rejects.toBe(pushNoSuchChat);
  });

  it('запрос вызывается ровно один раз: перехват не ретраит', async () => {
    const request = vi.fn(() => Promise.reject(entityNotFound()));

    await requestChatAddressed(
      { addresses: 'chat_only', query: QUERY, resolved: VIA_LITERAL },
      request,
    );

    expect(request).toHaveBeenCalledTimes(1);
  });
});
