import { describe, expect, it } from 'vitest';
import {
  mapPushCommitStatus,
  mapResponseStatus,
  mapTransportError,
  MessengerError,
} from '../../src/protocol/errors.js';

describe('слой 1: transport (кадр PROXY_STATUS, §14.6)', () => {
  it('несёт тег слоя, имя кода и расшифровку', () => {
    const error = mapTransportError('history', 7);

    expect(error).toBeInstanceOf(MessengerError);
    expect(error.layer).toBe('transport');
    expect(error.code).toBe(7);
    expect(error.codeName).toBe('TOO_MANY_REQUESTS');
    expect(error.message).toContain('[transport]');
    expect(error.message).toContain('TOO_MANY_REQUESTS(7)');
    expect(error.message).toContain('history');
    /* Без расшифровки номер кода недиагностируем */
    expect(error.message).toMatch(/слишком много запросов/i);
  });

  it('retriable только там, где сервер прямо говорит «позже»', () => {
    expect(mapTransportError('history', 7).retriable).toBe(true);
    expect(mapTransportError('history', 6).retriable).toBe(true);
    /* Дефект запроса повтором не лечится - ретрай лишь сожжёт лимиты */
    expect(mapTransportError('history', 1).retriable).toBe(false);
    expect(mapTransportError('history', 8).retriable).toBe(false);
    expect(mapTransportError('history', 5).retriable).toBe(false);
  });

  it('покрывает весь enum §14.6 расшифровками', () => {
    for (let code = 0; code <= 8; code += 1) {
      const error = mapTransportError('history', code);
      expect(error.known).toBe(true);
      expect(error.details).toBeDefined();
    }
  });

  it('неизвестный код не проглатывается: сырое число доходит до пользователя', () => {
    const error = mapTransportError('history', 42);

    expect(error.known).toBe(false);
    expect(error.codeName).toBe('UNKNOWN(42)');
    expect(error.message).toContain('UNKNOWN(42)');
    expect(error.message).toContain('справочнике');
    expect(error.retriable).toBe(false);
  });
});

describe('слой 2: application (Status в DATA-кадре, §14.6)', () => {
  it('ненулевой Status -> ошибка с тегом слоя, Details и RequestId', () => {
    const error = mapResponseStatus('history', {
      Status: 4,
      Details: 'chat not found',
      RequestId: 'aaaaaaaa-bbbb-cccc-dddddddd',
    });

    expect(error?.layer).toBe('application');
    expect(error?.code).toBe(4);
    expect(error?.codeName).toBe('ENTITY_NOT_FOUND');
    expect(error?.message).toContain('[application]');
    expect(error?.message).toContain('ENTITY_NOT_FOUND(4)');
    /* Details бэкенда важнее нашей расшифровки: он про конкретный случай */
    expect(error?.message).toContain('chat not found');
    expect(error?.requestId).toBe('aaaaaaaa-bbbb-cccc-dddddddd');
  });

  it('без Details подставляет расшифровку кода', () => {
    expect(mapResponseStatus('history', { Status: 2 })?.message).toMatch(/доступ.*запрещ/i);
  });

  /*
   * ЖИВОЕ НАБЛЮДЕНИЕ: ответ history несёт только {Chats, RequestId} - поля Status в нём нет.
   * Требовать Status:0 значило бы объявить ошибкой каждый штатный ответ.
   */
  it('отсутствующий и нулевой Status - успех', () => {
    expect(mapResponseStatus('history', { Chats: [], RequestId: 'x' })).toBeUndefined();
    expect(mapResponseStatus('history', { Status: 0 })).toBeUndefined();
    expect(mapResponseStatus('history', undefined)).toBeUndefined();
  });

  it('retriable только на OVERLOAD; UNAUTHORIZED лечится рефрешем, а не паузой', () => {
    expect(mapResponseStatus('history', { Status: 5 })?.retriable).toBe(true);
    expect(mapResponseStatus('history', { Status: 6 })?.retriable).toBe(false);
    expect(mapResponseStatus('history', { Status: 4 })?.retriable).toBe(false);
  });

  it('неизвестный Status отдаётся сырым числом', () => {
    const error = mapResponseStatus('history', { Status: 99 });

    expect(error?.known).toBe(false);
    expect(error?.message).toContain('UNKNOWN(99)');
  });
});

describe('слой 3: push commit-status (§14.6)', () => {
  it.each([
    [4, 'NO_SUCH_CHAT', /чат не существует/i],
    [7, 'SENDER_NOT_IN_CHAT', /не состоит в чате/i],
    [18, 'THROTTLED', /троттлит/i],
    [19, 'BANNED', /заблокирован/i],
    [22, 'SPAM_DETECTED', /спам/i],
    [23, 'RATE_LIMIT_EXCEEDED', /лимит частоты/i],
    [24, 'BLOCKED_BY_PRIVACY_SETTINGS', /приватности/i],
    [25, 'PUSH_UNAUTHORIZED', /не авторизован/i],
  ])('код %i -> %s с осмысленной расшифровкой', (status, name, hint) => {
    const error = mapPushCommitStatus({ status });

    expect(error.layer).toBe('push');
    expect(error.codeName).toBe(name);
    expect(error.message).toContain('[push]');
    expect(error.message).toContain(`${name}(${status})`);
    expect(error.message).toMatch(hint);
  });

  it('покрывает весь enum §14.6 (0..25) расшифровками', () => {
    for (let status = 0; status <= 25; status += 1) {
      /* 1 и 8 - успех, ошибкой не маппятся, но имя кода обязано быть известно */
      const error = mapPushCommitStatus({ status });
      expect(error.known).toBe(true);
    }
  });

  /*
   * Отправка необратима, а не подтверждённый push мог и записаться: сервер ответил уже после
   * записи, а ответ потерялся. Авто-повтор задвоил бы сообщение у собеседника.
   */
  it('НИКОГДА не retriable, даже на троттлинге', () => {
    expect(mapPushCommitStatus({ status: 18 }).retriable).toBe(false);
    expect(mapPushCommitStatus({ status: 23, rate_limit: { wait_for: 500 } }).retriable).toBe(false);
    expect(mapPushCommitStatus({ status: 18 }).message).toMatch(/авто-ретрай не делается/i);
  });

  it('несёт сырое wait_for и честно говорит, что единица неизвестна', () => {
    const error = mapPushCommitStatus({ status: 23, rate_limit: { wait_for: 500 } });

    expect(error.waitForRaw).toBe(500);
    expect(error.message).toContain('wait_for=500');
    /* Не «через 500 мс»: единица не документирована и живьём не наблюдалась */
    expect(error.message).toContain('единица не документирована');
    expect(error.message).not.toMatch(/500\s*(мс|ms|секунд)/);
  });

  it('неизвестный commit-статус отдаётся сырым числом', () => {
    const error = mapPushCommitStatus({ status: 77 });

    expect(error.known).toBe(false);
    expect(error.message).toContain('UNKNOWN(77)');
  });
});
