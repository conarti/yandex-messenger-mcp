/**
 * Три слоя ошибок §14.6 против локального mock-WS: настоящий сокет, настоящие кадры,
 * синтетические только фикстуры ответов.
 *
 * Слои проверяются именно через транспорт, а не на мапперах: их легко перепутать между
 * собой (один и тот же номер значит в разных слоях разное), и цена путаницы - либо ошибка
 * вместо доставленного сообщения, либо тихий «успех» вместо отказа бэкенда.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAuthProvider } from '../../src/auth/FakeAuthProvider.js';
import { MessengerError } from '../../src/protocol/errors.js';
import { parsePushResponse } from '../../src/protocol/push.js';
import { RATE_LIMIT_MAX_DELAY_MS, RATE_LIMIT_MIN_DELAY_MS } from '../../src/transport/backoff.js';
import { MessengerWsClient } from '../../src/transport/ws/MessengerWsClient.js';
import { createLogger } from '../../src/util/logger.js';
import { MockXiva, startMockXiva } from '../helpers/mockXiva.js';

let mock: MockXiva;
let auth: FakeAuthProvider;
let client: MessengerWsClient;

/** База 1мс: тест проверяет ФАКТ повторов, а не длительность продакшн-пауз */
function createClient(backoff = { baseDelayMs: 1 }): MessengerWsClient {
  return new MessengerWsClient({
    auth,
    xivaUrl: mock.url,
    xivaServiceName: 'messenger-prod',
    requestTimeoutMs: 2_000,
    subscribedTimeoutMs: 2_000,
    backoff,
  });
}

/** Кадр PROXY_STATUS(2): msgpack fixarray[2] = [reqId, errorCode], data-секции нет (§14.9) */
function sendProxyStatus(socket: { send: (data: Buffer) => void }, reqId: number, errorCode: number): void {
  socket.send(Buffer.from([0x02, 0x92, reqId, errorCode]));
}

beforeEach(async () => {
  mock = await startMockXiva();
  auth = new FakeAuthProvider();
  client = createClient();
});

afterEach(async () => {
  client.close();
  await mock.close();
});

describe('слой 1: PROXY_STATUS (кадр 0x92)', () => {
  it('маппится в ошибку с тегом [transport] и именем кода', async () => {
    mock.responders.set('history', (request, connection) => {
      sendProxyStatus(connection.socket, request.reqId, 8);
    });

    const error = await client.request('history', { Limit: 0 }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MessengerError);
    expect(error).toMatchObject({ layer: 'transport', code: 8, codeName: 'FRAME_TOO_LARGE' });
    expect((error as Error).message).toContain('[transport]');
    expect((error as Error).message).toContain('FRAME_TOO_LARGE(8)');
    /* Дефект запроса: повтор его не исправит */
    expect(mock.requestsOf('history')).toHaveLength(1);
  });

  it('TOO_MANY_REQUESTS(7) -> backoff и повторы, затем громкий отказ', async () => {
    mock.responders.set('history', (request, connection) => {
      sendProxyStatus(connection.socket, request.reqId, 7);
    });

    const error = await client.request('history', { Limit: 0 }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ layer: 'transport', codeName: 'TOO_MANY_REQUESTS' });
    /* 3 попытки = 1 исходная + 2 повтора; исчерпав их, ошибку отдаём, а не прячем */
    expect(mock.requestsOf('history')).toHaveLength(3);
  });

  it('повтор доводит запрос до успеха, если сервер отпустил', async () => {
    let attempts = 0;
    mock.responders.set('history', (request, connection) => {
      attempts += 1;
      if (attempts === 1) {
        sendProxyStatus(connection.socket, request.reqId, 7);
        return;
      }
      mock.reply(connection, request, { Chats: [{ ChatId: 'a_b' }] });
    });

    await expect(client.request('history', { Limit: 0 })).resolves.toMatchObject({ Chats: [{ ChatId: 'a_b' }] });
    expect(mock.requestsOf('history')).toHaveLength(2);
  });

  it('неизвестный код не проглатывается - в сообщении сырое число', async () => {
    mock.responders.set('history', (request, connection) => {
      sendProxyStatus(connection.socket, request.reqId, 42);
    });

    const error = await client.request('history').catch((caught: unknown) => caught);

    expect(error).toMatchObject({ layer: 'transport', code: 42, known: false });
    expect((error as Error).message).toContain('UNKNOWN(42)');
  });
});

describe('слой 2: DATA-кадр с ненулевым Status', () => {
  it('маппится в ошибку с тегом [application], Details и RequestId', async () => {
    mock.responders.set('history', (request, connection) => {
      mock.reply(connection, request, { Status: 4, Details: 'no such chat' });
    });

    const error = await client.request('history', { ChatId: 'a_b' }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MessengerError);
    expect(error).toMatchObject({ layer: 'application', code: 4, codeName: 'ENTITY_NOT_FOUND' });
    expect((error as Error).message).toContain('[application]');
    expect((error as Error).message).toContain('ENTITY_NOT_FOUND(4)');
    expect((error as Error).message).toContain('no such chat');
    /* RequestId - ключ для поиска на стороне бэкенда, теряться он не должен */
    expect((error as MessengerError).requestId).toBe(mock.requestsOf('history')[0]?.payload.RequestId);
  });

  /*
   * Раньше ненулевой Status молча резолвился как успешный ответ, и парсер отдавал пустую
   * выдачу: «чат не найден» выглядел как «в чате нет сообщений».
   */
  it('не выдаёт отказ бэкенда за пустой успешный ответ', async () => {
    mock.responders.set('history', (request, connection) => {
      mock.reply(connection, request, { Status: 2, Details: 'access denied' });
    });

    await expect(client.request('history')).rejects.toThrow(/\[application\]/);
  });

  it('OVERLOAD(5) ретраится, ACCESS_DENIED(2) - нет', async () => {
    mock.responders.set('history', (request, connection) => {
      mock.reply(connection, request, { Status: 5 });
    });
    await expect(client.request('history')).rejects.toMatchObject({ codeName: 'OVERLOAD' });
    expect(mock.requestsOf('history')).toHaveLength(3);

    mock.responders.set('whoami', (request, connection) => {
      mock.reply(connection, request, { Status: 2 });
    });
    await expect(client.request('whoami')).rejects.toMatchObject({ codeName: 'ACCESS_DENIED' });
    expect(mock.requestsOf('whoami')).toHaveLength(1);
  });

  it('живая форма ответа (Status отсутствует) остаётся успехом', async () => {
    mock.responders.set('history', (request, connection) => {
      mock.reply(connection, request, { Chats: [{ ChatId: 'a_b' }] });
    });

    await expect(client.request('history')).resolves.toMatchObject({ Chats: [{ ChatId: 'a_b' }] });
  });
});

describe('слой 3: push commit-status', () => {
  /*
   * *** ЖИВОЕ НАБЛЮДЕНИЕ: Status:1 в ответе на push - это FULLY_COMMITTED, то есть УСПЕХ. ***
   * В ResponseStatus (слой 2) единица - это INTERNAL_ERROR. Применив к push маппинг слоя 2,
   * транспорт объявил бы доставленное сообщение ошибкой, а вызывающий отправил бы его второй раз.
   */
  it('Status:1 на push - успех, а НЕ application INTERNAL_ERROR(1)', async () => {
    mock.responders.set('push', (request, connection) => {
      mock.reply(connection, request, { Status: 1, MessageInfo: { SeqNo: 11 } });
    });

    const subscriptionId = await client.waitForSubscriptionId();
    const response = await client.request('push', { ClientMessage: {} }, { requireSubscriptionId: subscriptionId });

    expect(parsePushResponse(response)).toMatchObject({ status: 1, committed: true, status_name: 'FULLY_COMMITTED' });
  });

  it('Status:8 (DUPLICATE) - идемпотентный успех, а не ошибка', async () => {
    mock.responders.set('push', (request, connection) => {
      mock.reply(connection, request, { Status: 8 });
    });

    const subscriptionId = await client.waitForSubscriptionId();
    const response = await client.request('push', {}, { requireSubscriptionId: subscriptionId });

    expect(parsePushResponse(response)).toMatchObject({ status: 8, committed: true, duplicate: true });
  });

  it.each([
    [4, 'NO_SUCH_CHAT'],
    [7, 'SENDER_NOT_IN_CHAT'],
    [18, 'THROTTLED'],
    [23, 'RATE_LIMIT_EXCEEDED'],
    [24, 'BLOCKED_BY_PRIVACY_SETTINGS'],
  ])('commit-статус %i -> [push] %s, отправка не подтверждена', async (status, name) => {
    mock.responders.set('push', (request, connection) => {
      mock.reply(connection, request, { Status: status });
    });

    const subscriptionId = await client.waitForSubscriptionId();
    const outcome = parsePushResponse(
      await client.request('push', {}, { requireSubscriptionId: subscriptionId }),
    );

    expect(outcome.committed).toBe(false);
    expect(outcome.status_name).toBe(name);
  });

  /* Отправка необратима: даже троттлинг не даёт права повторить кадр */
  it('push НИКОГДА не ретраится - ни на throttle, ни на TOO_MANY_REQUESTS транспорта', async () => {
    mock.responders.set('push', (request, connection) => {
      sendProxyStatus(connection.socket, request.reqId, 7);
    });

    const subscriptionId = await client.waitForSubscriptionId();
    await expect(
      client.request('push', {}, { requireSubscriptionId: subscriptionId }),
    ).rejects.toMatchObject({ layer: 'transport', codeName: 'TOO_MANY_REQUESTS' });

    expect(mock.requestsOf('push')).toHaveLength(1);
  });
});

describe('rate_limit.wait_for соблюдается (§14.4)', () => {
  /*
   * push не ретраится, поэтому уважить просьбу сервера можно единственным честным способом:
   * притормозить СЛЕДУЮЩИЕ запросы. Иначе wait_for был бы полем, которое мы разбираем и
   * выбрасываем.
   */
  it('после throttle с wait_for следующий запрос откладывается', async () => {
    mock.responders.set('push', (request, connection) => {
      /* 2000 в рабочем диапазоне: зажим не сработает, пауза = сырое значение */
      mock.reply(connection, request, { Status: 18, RateLimit: { WaitFor: 2_000 } });
    });
    mock.responders.set('history', (request, connection) => mock.reply(connection, request, { Chats: [] }));

    const subscriptionId = await client.waitForSubscriptionId();
    await client.request('push', {}, { requireSubscriptionId: subscriptionId });

    const startedAt = Date.now();
    await client.request('history');

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_500);
  }, 10_000);

  /*
   * Единица wait_for неизвестна. `60000000` - это 60с, если сервер считает в микросекундах,
   * и 16.6 ЧАСОВ, если принять число за миллисекунды. Верхний зажим держит паузу в пределах
   * минуты при любой гипотезе - иначе клиент выглядел бы зависшим намертво.
   *
   * Проверяется через лог, а не секундомером: ждать реальную паузу тест не может, а факт
   * «взвели 60с, а не 16.6 часов» виден именно в записи о зажиме.
   */
  it('огромный wait_for зажимается: клиент не виснет на часы', async () => {
    const entries: Record<string, unknown>[] = [];
    const logger = createLogger({ level: 'debug', write: (line) => entries.push(JSON.parse(line)) });
    client.close();
    client = new MessengerWsClient({
      auth,
      xivaUrl: mock.url,
      xivaServiceName: 'messenger-prod',
      requestTimeoutMs: 2_000,
      subscribedTimeoutMs: 2_000,
      logger,
    });

    mock.responders.set('push', (request, connection) => {
      mock.reply(connection, request, { Status: 23, RateLimit: { WaitFor: 60_000_000 } });
    });

    const subscriptionId = await client.waitForSubscriptionId();
    await client.request('push', {}, { requireSubscriptionId: subscriptionId });

    const noted = entries.find((entry) => entry.clamped !== undefined);
    /* Окно взведено ровно на потолок (60с), а не на 60000000мс = 16.6 часов */
    expect(noted).toMatchObject({ delayMs: RATE_LIMIT_MAX_DELAY_MS, clamped: 'max', waitForRaw: 60_000_000 });
    /* Сырое значение обязано остаться в логе: по нему и определится единица при первом живом случае */
    expect(noted?.note).toMatch(/единица wait_for не документирована/);
  });

  /*
   * Обратный промах: если сервер считает в СЕКУНДАХ, `wait_for:5` без нижней границы дал бы
   * паузу 5мс - ретрай-шторм в сервер, который только что попросил притормозить.
   */
  it('крошечный wait_for поднимается до 1с: паузa не схлопывается', async () => {
    const entries: Record<string, unknown>[] = [];
    const logger = createLogger({ level: 'debug', write: (line) => entries.push(JSON.parse(line)) });
    client.close();
    client = new MessengerWsClient({
      auth,
      xivaUrl: mock.url,
      xivaServiceName: 'messenger-prod',
      requestTimeoutMs: 2_000,
      subscribedTimeoutMs: 2_000,
      logger,
    });

    mock.responders.set('push', (request, connection) => {
      mock.reply(connection, request, { Status: 18, RateLimit: { WaitFor: 5 } });
    });

    const subscriptionId = await client.waitForSubscriptionId();
    await client.request('push', {}, { requireSubscriptionId: subscriptionId });

    expect(entries.find((entry) => entry.clamped !== undefined)).toMatchObject({
      delayMs: RATE_LIMIT_MIN_DELAY_MS,
      clamped: 'min',
      waitForRaw: 5,
    });
  });

  /* Сервер сказал «частишь», но срок не назвал - пауза всё равно нужна */
  it('throttle без rate_limit тоже взводит окно', async () => {
    mock.responders.set('push', (request, connection) => mock.reply(connection, request, { Status: 18 }));
    mock.responders.set('history', (request, connection) => mock.reply(connection, request, { Chats: [] }));

    const subscriptionId = await client.waitForSubscriptionId();
    await client.request('push', {}, { requireSubscriptionId: subscriptionId });

    const startedAt = Date.now();
    await client.request('history');

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
  }, 10_000);

  it('без просьбы сервера следующий запрос не ждёт', async () => {
    mock.responders.set('push', (request, connection) => mock.reply(connection, request, { Status: 1 }));
    mock.responders.set('history', (request, connection) => mock.reply(connection, request, { Chats: [] }));

    const subscriptionId = await client.waitForSubscriptionId();
    await client.request('push', {}, { requireSubscriptionId: subscriptionId });

    const startedAt = Date.now();
    await client.request('history');

    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});
