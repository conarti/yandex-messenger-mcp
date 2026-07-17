/**
 * Сборка push-кадра (§14.4/§11.1) и разбор ответа (`deserializePushResponse`, §14.4).
 */
import { describe, expect, it } from 'vitest';
import {
  buildPlainTextClientMessage,
  buildPushParams,
  createPayloadId,
  parsePushResponse,
  PushNotCommittedError,
} from '../../src/protocol/push.js';

const SUBSCRIPTION_ID = 'a'.repeat(40);
const YANDEX_UID = '1234567890123456789';
const SERVICE_ID = 27;

function params(overrides: { subscriptionId?: string; text?: string } = {}) {
  return buildPushParams({
    clientMessage: buildPlainTextClientMessage({
      chatId: 'aaaa_bbbb',
      text: overrides.text ?? 'привет',
      payloadId: 'payload-1',
    }),
    subscriptionId: overrides.subscriptionId ?? SUBSCRIPTION_ID,
    yandexUid: YANDEX_UID,
    serviceId: SERVICE_ID,
  });
}

describe('buildPushParams (§14.4)', () => {
  it('собирает конверт живого кадра: транспорт, ClientMessage, Meta.Origin, features', () => {
    expect(params()).toEqual({
      ClientTransportId: { XivaSubscriptionId: SUBSCRIPTION_ID },
      UserAgent: 'chats-web/3.22.0',
      ClientMessage: {
        Plain: { ChatId: 'aaaa_bbbb', PayloadId: 'payload-1', Text: { MessageText: 'привет' } },
        LogData: { YandexUid: YANDEX_UID },
      },
      Meta: { Origin: SERVICE_ID },
      ClientSupportedFeatures: 0,
    });
  });

  it('НЕ кладёт RequestId: его впрыскивает транспорт каждому кадру (§14.8)', () => {
    expect(params()).not.toHaveProperty('RequestId');
  });

  it('LogData.YandexUid берётся из куки yandexuid, а не из uid/guid (§14.4)', () => {
    const message = params()['ClientMessage'] as { LogData: { YandexUid: string } };

    expect(message.LogData.YandexUid).toBe(YANDEX_UID);
  });

  /* Пустой id = кадр subscribed не пришёл: соединение к отправке не готово (§17.2) */
  it('отказывает на пустом XivaSubscriptionId, а не собирает кадр «на удачу»', () => {
    expect(() => params({ subscriptionId: '' })).toThrow(/subscribed/);
    expect(() => params({ subscriptionId: '   ' })).toThrow(/subscribed/);
  });

  it('PayloadId уникален на драфт: он же ключ серверной дедупликации (§11.1)', () => {
    expect(createPayloadId()).not.toBe(createPayloadId());
  });
});

describe('parsePushResponse (§14.4/§14.6)', () => {
  it('FULLY_COMMITTED(1) - успех (живой heartbeat-push, §17.2)', () => {
    const outcome = parsePushResponse({ Status: 1 });

    expect(outcome).toMatchObject({ status: 1, status_name: 'FULLY_COMMITTED', committed: true, duplicate: false });
  });

  it('DUPLICATE(8) - идемпотентный успех: сообщение уже принято, повторять нельзя', () => {
    const outcome = parsePushResponse({ Status: 8 });

    expect(outcome).toMatchObject({ status: 8, status_name: 'DUPLICATE', committed: true, duplicate: true });
  });

  it.each([
    [4, 'NO_SUCH_CHAT'],
    [7, 'SENDER_NOT_IN_CHAT'],
    [18, 'THROTTLED'],
    [23, 'RATE_LIMIT_EXCEEDED'],
    [0, 'UNCOMMMITED'],
  ])('commit-статус %i (%s) успехом НЕ считается', (status, name) => {
    const outcome = parsePushResponse({ Status: status });

    expect(outcome.committed).toBe(false);
    expect(outcome.status_name).toBe(name);
  });

  it('неизвестный commit-статус не выдаётся за успех и отдаётся числом', () => {
    const outcome = parsePushResponse({ Status: 99 });

    expect(outcome).toMatchObject({ committed: false, status_name: 'UNKNOWN(99)' });
  });

  it('разбирает messageInfo, метки - строками в мкс (точность BigInt)', () => {
    const outcome = parsePushResponse({
      Status: 1,
      MessageInfo: { Version: 3, PrevTimestampMcs: 1784117000000000, TimestampMcs: 1784117592261029, SeqNo: 42 },
    });

    expect(outcome.message_info).toEqual({
      version: 3,
      prev_timestamp_mcs: '1784117000000000',
      timestamp_mcs: '1784117592261029',
      seqno: 42,
    });
  });

  /*
   * Живьём наблюдался только `Status`; остальные имена §14.4 приводит так, как их отдаёт
   * дезериализатор НА ВЫХОДЕ. Парсер читает оба написания - реконструкция wire-имён гипотеза.
   */
  it('читает и lowercase-написание ответа', () => {
    const outcome = parsePushResponse({
      status: 8,
      messageInfo: { version: 1, prevTimestamp: '1784117000000000', timestamp: '1784117592261029', seqno: 7 },
      rate_limit: { wait_for: 1500 },
    });

    expect(outcome).toMatchObject({ status: 8, committed: true, duplicate: true, rate_limit: { wait_for: 1500 } });
    expect(outcome.message_info?.seqno).toBe(7);
  });

  it('разбирает rate_limit.wait_for при троттлинге', () => {
    const outcome = parsePushResponse({ Status: 18, RateLimit: { WaitFor: 60000000 } });

    expect(outcome.rate_limit).toEqual({ wait_for: 60000000 });
    expect(outcome.committed).toBe(false);
  });

  it('ответ без Status - отказ, а не тихий успех', () => {
    expect(() => parsePushResponse({ MessageInfo: {} })).toThrow(/Status/);
    expect(() => parsePushResponse(undefined)).toThrow(/Status/);
  });

  it('PushNotCommittedError несёт имя статуса и wait_for в тексте', () => {
    const error = new PushNotCommittedError(parsePushResponse({ Status: 18, RateLimit: { WaitFor: 500 } }));

    expect(error.message).toMatch(/THROTTLED\(18\)/);
    expect(error.message).toMatch(/wait_for=500/);
  });
});
