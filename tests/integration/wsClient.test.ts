/**
 * MessengerWsClient против локального mock-WS: настоящий сокет, настоящий handshake,
 * настоящие бинарные кадры - подменён только адрес (mock живёт в tests/helpers/mockXiva.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { FakeAuthProvider } from '../../src/auth/FakeAuthProvider.js';
import { MessengerWsClient } from '../../src/transport/ws/MessengerWsClient.js';
import { encodeDataFrame } from '../../src/transport/ws/frameCodec.js';
import { MockXiva, startMockXiva } from '../helpers/mockXiva.js';

const WHOAMI_RESPONSE = {
  UserInfo: { Guid: '00000000-0000-4000-8000-000000000000', Uid: 1234567890, DisplayName: 'test' },
  CurrentTime: 1784117592261029,
};

let mock: MockXiva;
let auth: FakeAuthProvider;
let client: MessengerWsClient;

/** Ждёт наступления факта, а не фиксированную паузу: закрытие сокета асинхронно */
async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

function createClient(): MessengerWsClient {
  return new MessengerWsClient({
    auth,
    xivaUrl: mock.url,
    xivaServiceName: 'messenger-prod',
    requestTimeoutMs: 2_000,
    subscribedTimeoutMs: 2_000,
  });
}

beforeEach(async () => {
  mock = await startMockXiva();
  auth = new FakeAuthProvider();
  client = createClient();

  mock.responders.set('whoami', (request, connection) => mock.reply(connection, request, WHOAMI_RESPONSE));
  mock.responders.set('history', (request, connection) =>
    mock.reply(connection, request, { Chats: [{ ChatId: 'a_b' }, { ChatId: 'c_d' }] }),
  );
});

afterEach(async () => {
  client.close();
  await mock.close();
});

describe('handshake URL (§17.1)', () => {
  it('cookie-only: несёт service/session/client/user и НЕ несёт sign/ts', async () => {
    await client.connect();

    const query = new URLSearchParams(mock.latest.url.split('?')[1]);
    expect(query.get('service')).toBe('messenger-prod:version5*common+version5*main');
    expect(query.get('client')).toBe('web_main');
    expect(query.get('user')).toBe(auth.context.userUid);
    expect(query.get('sign')).toBeNull();
    expect(query.get('ts')).toBeNull();
  });

  /*
   * Регрессия на живой отказ 4400 invalid argument "service": литеральный `+` в query
   * значит пробел. Сверяется СЫРАЯ строка - декодированный assert эту ошибку не ловит.
   */
  it('percent-кодирует service байт-в-байт как живой клиент: %3A и %2B, но литеральный *', async () => {
    await client.connect();

    const rawQuery = mock.latest.url.split('?')[1] ?? '';
    const rawService = rawQuery.split('&').find((part) => part.startsWith('service=')) ?? '';

    expect(rawService).toBe('service=messenger-prod%3Aversion5*common%2Bversion5*main');
    expect(rawService).not.toContain('+');
  });

  it('порядок параметров совпадает с живым клиентом: service, session, client, user', async () => {
    await client.connect();

    const names = (mock.latest.url.split('?')[1] ?? '').split('&').map((part) => part.split('=')[0]);

    expect(names).toEqual(['service', 'session', 'client', 'user']);
  });

  it('session - случайные 4 группы по 4 hex, новые на каждое соединение', async () => {
    await client.connect();
    const first = new URLSearchParams(mock.latest.url.split('?')[1]).get('session');
    await client.reconnect();
    const second = new URLSearchParams(mock.latest.url.split('?')[1]).get('session');

    expect(first).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    expect(second).not.toBe(first);
  });

  it('cookie уходит заголовком handshake, а не параметром URL', async () => {
    await client.connect();

    expect(mock.latest.cookie).toBe(auth.context.cookieHeader);
    expect(mock.latest.url).not.toContain('Session_id');
  });

  it('подписывает URL sign+ts, только если слой auth прислал secretSign (гостевая ветка)', async () => {
    auth = new FakeAuthProvider({ context: { secretSign: { sign: 'a'.repeat(32), ts: '1752710400' } } });
    client = createClient();

    await client.connect();

    const query = new URLSearchParams(mock.latest.url.split('?')[1]);
    expect(query.get('sign')).toBe('a'.repeat(32));
    expect(query.get('ts')).toBe('1752710400');
  });
});

describe('операционный кадр subscribed (§17.2)', () => {
  it('ловится на connect и отдаётся как subscription-id', async () => {
    await client.connect();

    const id = await client.waitForSubscriptionId();

    expect(id).toBe(mock.latest.subscriptionId);
    expect(id).toHaveLength(40);
  });

  it('реконнект даёт НОВЫЙ subscription-id: старый переиспользовать нельзя', async () => {
    await client.connect();
    const before = await client.waitForSubscriptionId();

    await client.reconnect();
    const after = await client.waitForSubscriptionId();

    expect(after).not.toBe(before);
    expect(after).toBe(mock.latest.subscriptionId);
  });

  it('кадр со stale subscription-id НЕ уходит в сокет: реконнект между «взять id» и «отправить»', async () => {
    await client.connect();
    const stale = await client.waitForSubscriptionId();
    await client.reconnect();

    await expect(client.request('push', { Foo: 1 }, { requireSubscriptionId: stale })).rejects.toMatchObject({
      name: 'StaleSubscriptionIdError',
    });
    expect(mock.requestsOf('push')).toHaveLength(0);
  });

  it('кадр с subscription-id ТЕКУЩЕГО соединения проходит', async () => {
    mock.responders.set('push', (request, connection) => mock.reply(connection, request, { Status: 1 }));
    await client.connect();
    const current = await client.waitForSubscriptionId();

    const response = await client.request<{ Status: number }>('push', {}, { requireSubscriptionId: current });

    expect(response.Status).toBe(1);
    expect(mock.requestsOf('push')).toHaveLength(1);
  });
});

describe('корреляция запросов', () => {
  it('whoami end-to-end: seq стартует с 1 (§14.8)', async () => {
    const response = await client.request<typeof WHOAMI_RESPONSE>('whoami');

    expect(response.UserInfo.Uid).toBe(1234567890);
    expect(mock.latest.requests[0]?.reqId).toBe(1);
    expect(mock.latest.requests[0]?.method).toBe('whoami');
  });

  it('history(Limit:0) отдаёт список чатов', async () => {
    const response = await client.request<{ Chats: unknown[] }>('history', { Limit: 0, ChatDataFilter: {} });

    expect(response.Chats).toHaveLength(2);
    expect(mock.latest.requests[0]?.payload).toMatchObject({ Limit: 0, ChatDataFilter: {} });
  });

  it('впрыскивает RequestId в тело каждого запроса (§14.8)', async () => {
    await client.request('whoami');

    expect(mock.latest.requests[0]?.payload.RequestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{8}$/);
  });

  it('seq растёт, и параллельные ответы не путаются между собой', async () => {
    const [whoami, history] = await Promise.all([
      client.request<typeof WHOAMI_RESPONSE>('whoami'),
      client.request<{ Chats: unknown[] }>('history', { Limit: 0 }),
    ]);

    expect(whoami.UserInfo).toBeDefined();
    expect(history.Chats).toHaveLength(2);
    expect(mock.latest.requests.map((item) => item.reqId)).toEqual([1, 2]);
  });

  it('отвергает ответ, чей RequestId не совпал с запросом, даже если seq сошёлся', async () => {
    mock.responders.set('whoami', (request, connection) => {
      connection.socket.send(
        encodeDataFrame({
          serviceIndex: 0,
          reqId: request.reqId,
          method: 'whoami',
          payload: { RequestId: 'ffffffff-ffff-ffff-ffffffff', UserInfo: {} },
        }),
      );
    });

    await expect(client.request('whoami')).rejects.toThrow(/RequestId ответа не совпал/);
  });

  it('маппит PROXY_STATUS в транспортную ошибку с именем кода (§14.6)', async () => {
    mock.responders.set('history', (request, connection) => {
      /* PROXY_STATUS(2): [reqId, errorCode=7 TOO_MANY_REQUESTS], data-секции нет */
      connection.socket.send(Buffer.from([0x02, 0x92, request.reqId, 0x07]));
    });

    await expect(client.request('history', { Limit: 0 })).rejects.toThrow(/TOO_MANY_REQUESTS/);
  });
});

describe('реконнект (§14.8)', () => {
  it('восстанавливает корреляцию: seq на новом соединении снова стартует с 1', async () => {
    await client.request('whoami');
    await client.request('history', { Limit: 0 });
    expect(mock.latest.requests.map((item) => item.reqId)).toEqual([1, 2]);

    await client.reconnect();
    const response = await client.request<typeof WHOAMI_RESPONSE>('whoami');

    expect(response.UserInfo.Uid).toBe(1234567890);
    expect(mock.connections).toHaveLength(2);
    expect(mock.latest.requests.map((item) => item.reqId)).toEqual([1]);
  });

  it('поднимает новое соединение сам, если предыдущее оборвал сервер', async () => {
    await client.request('whoami');
    mock.latest.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const response = await client.request<typeof WHOAMI_RESPONSE>('whoami');

    expect(response.UserInfo.Uid).toBe(1234567890);
    expect(mock.connections).toHaveLength(2);
  });

  it('запрос в полёте на закрытом соединении падает, а не висит вечно', async () => {
    mock.responders.set('history', (_request, connection) => connection.socket.close());

    await expect(client.request('history', { Limit: 0 })).rejects.toThrow(/закрыто/);
  });
});

describe('server-ping (§14.7)', () => {
  it('не рвёт соединение: пинги сервера продлевают дедлайн', async () => {
    await client.connect();
    const connection = mock.latest;

    /* Интервал 1с -> дедлайн 1.3с; три пинга подряд держат соединение живым дольше стартовых 5с */
    for (let i = 0; i < 3; i += 1) {
      mock.sendPing(connection, 1);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const response = await client.request<typeof WHOAMI_RESPONSE>('whoami');
    expect(response.UserInfo).toBeDefined();
    expect(mock.connections).toHaveLength(1);
  });

  it('клиент НЕ шлёт ping сам: в исходящих только DATA-кадры', async () => {
    await client.connect();
    mock.sendPing(mock.latest, 60);
    await client.request('whoami');

    expect(mock.latest.requests.map((item) => item.method)).toEqual(['whoami']);
  });
});

describe('протухшая cookie', () => {
  it('close по cookie auth failed -> onAuthFailure() -> рефреш -> переконнект и повтор', async () => {
    let rejectOnce = true;
    mock.responders.set('whoami', (request, connection) => {
      if (rejectOnce) {
        rejectOnce = false;
        /* §14.5: сервер закрывает сокет с reason, сбрасывающим креды */
        connection.socket.close(4401, 'cookie auth failed');
        return;
      }
      mock.reply(connection, request, WHOAMI_RESPONSE);
    });

    const response = await client.request<typeof WHOAMI_RESPONSE>('whoami');

    expect(auth.authFailures).toBe(1);
    expect(response.UserInfo.Uid).toBe(1234567890);
    expect(mock.connections).toHaveLength(2);
  });

  it('handshake с HTTP 401 сюрфейсится как отказ авторизации', async () => {
    const rejecting = new WebSocketServer({ port: 0, host: '127.0.0.1', verifyClient: () => false });
    await new Promise<void>((resolve) => rejecting.once('listening', resolve));
    const { port } = rejecting.address() as AddressInfo;
    const failing = new MessengerWsClient({
      auth,
      xivaUrl: `ws://127.0.0.1:${port}/v2/subscribe/websocket`,
      xivaServiceName: 'messenger-prod',
      requestTimeoutMs: 2_000,
    });

    await expect(failing.connect()).rejects.toMatchObject({ name: 'AuthError', kind: 'cookie' });

    failing.close();
    await new Promise<void>((resolve) => rejecting.close(() => resolve()));
  });

  /*
   * Регрессия на УТЕЧКУ СОКЕТА: ws зовёт свой abortHandshake ТОЛЬКО когда у события
   * 'unexpected-response' нет слушателя (`else if (!websocket.emit(...))`). Наш слушатель
   * есть -> emit вернул true -> очистка библиотеки подавлена. Раньше обработчик только
   * реджектил, поэтому TCP-сокет и недренированный поток ответа висели и держали Connection.
   *
   * Сервер здесь СПЕЦИАЛЬНО обычный http, а не WebSocketServer: тот на отказе рвёт сокет
   * сам (abortHandshake на своей стороне) и утечку клиента скрыл бы. keep-alive означает,
   * что сокет закроется, только если его закроет КЛИЕНТ, - это и есть проверяемый факт.
   */
  it('handshake с HTTP 401 разрушает сокет: соединение не остаётся висеть', async () => {
    const closedSockets: Socket[] = [];
    const openedSockets: Socket[] = [];
    const rejecting = createServer((_request, response) => {
      response.writeHead(401, { 'Content-Type': 'text/plain', Connection: 'keep-alive' });
      response.end('unauthorized');
    });
    rejecting.on('connection', (socket) => {
      openedSockets.push(socket);
      socket.once('close', () => closedSockets.push(socket));
    });
    await new Promise<void>((resolve) => rejecting.listen(0, '127.0.0.1', resolve));
    const { port } = rejecting.address() as AddressInfo;
    const failing = new MessengerWsClient({
      auth,
      xivaUrl: `ws://127.0.0.1:${port}/v2/subscribe/websocket`,
      xivaServiceName: 'messenger-prod',
      requestTimeoutMs: 2_000,
    });

    await expect(failing.connect()).rejects.toMatchObject({ name: 'AuthError', kind: 'cookie' });

    expect(openedSockets).toHaveLength(1);
    /* До фикса сокет доживал до keep-alive-таймаута сервера (5с), т.е. в это окно не закрывался */
    await expect(waitFor(() => closedSockets.length === 1)).resolves.toBe(true);

    failing.close();
    await new Promise<void>((resolve) => rejecting.close(() => resolve()));
  });
});
