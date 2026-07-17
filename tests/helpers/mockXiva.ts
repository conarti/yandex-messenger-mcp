/**
 * Локальный mock-WS, отвечающий по правилам Xiva: эхо-матчинг seq в заголовке,
 * операционный текст-кадр `subscribed` на connect, server-initiated ping.
 *
 * Настоящий сокет, настоящий handshake, настоящие бинарные кадры - подменён только адрес.
 * Общий для тестов транспорта и тестов отправки: send_message обязан доказывать, что в
 * сокет НЕ ушёл push-кадр, а это проверяется только на живом сокете.
 */
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { decodeFrame, encodeDataFrame } from '../../src/transport/ws/frameCodec.js';

export interface ReceivedRequest {
  reqId: number;
  method: string;
  payload: { RequestId?: string } & Record<string, unknown>;
}

export interface MockConnection {
  socket: ServerSocket;
  url: string;
  cookie: string | undefined;
  subscriptionId: string;
  requests: ReceivedRequest[];
}

export class MockXiva {
  readonly server: WebSocketServer;
  readonly connections: MockConnection[] = [];
  /** Ответ на метод: undefined = не отвечать (для тестов таймаута) */
  responders = new Map<string, (request: ReceivedRequest, connection: MockConnection) => void>();
  private subscriptionCounter = 0;
  /** Отключается, когда тест проверяет отсутствие ping либо неготовность к push */
  sendSubscribed = true;

  constructor() {
    this.server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    this.server.on('connection', (socket, request) => {
      this.subscriptionCounter += 1;
      /* subscription-id: 40 hex, уникален на соединение (§17.2) */
      const subscriptionId = this.subscriptionCounter.toString(16).padStart(40, 'a');
      const connection: MockConnection = {
        socket,
        url: request.url ?? '',
        cookie: request.headers.cookie,
        subscriptionId,
        requests: [],
      };
      this.connections.push(connection);

      if (this.sendSubscribed) {
        socket.send(
          JSON.stringify({ operation: 'subscribed', 'subscription-id': subscriptionId, uid: 1, service: 'messenger' }),
        );
      }

      socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (!isBinary) {
          return;
        }
        const frame = decodeFrame(data);
        const received: ReceivedRequest = {
          reqId: frame.elements[1] as number,
          method: frame.elements[2] as string,
          payload: frame.payload as ReceivedRequest['payload'],
        };
        connection.requests.push(received);
        this.responders.get(received.method)?.(received, connection);
      });
    });
  }

  get url(): string {
    const { port } = this.server.address() as AddressInfo;
    return `ws://127.0.0.1:${port}/v2/subscribe/websocket`;
  }

  get latest(): MockConnection {
    const connection = this.connections.at(-1);
    if (connection === undefined) {
      throw new Error('mock: соединений не было');
    }
    return connection;
  }

  /**
   * Все кадры метода по ВСЕМ соединениям. Именно так проверяется «не отправлено»:
   * смотреть только последнее соединение недостаточно - реконнект спрятал бы отправку.
   */
  requestsOf(method: string): ReceivedRequest[] {
    return this.connections.flatMap((connection) => connection.requests.filter((item) => item.method === method));
  }

  /** Отвечает DATA-кадром с эхом seq, как это делает Xiva */
  reply(connection: MockConnection, request: ReceivedRequest, payload: Record<string, unknown>): void {
    connection.socket.send(
      encodeDataFrame({
        serviceIndex: 0,
        reqId: request.reqId,
        method: request.method,
        payload: { RequestId: request.payload.RequestId, ...payload },
      }),
    );
  }

  sendPing(connection: MockConnection, intervalSec: number): void {
    connection.socket.send(JSON.stringify({ operation: 'ping', 'server-interval-sec': intervalSec }));
  }

  async close(): Promise<void> {
    for (const connection of this.connections) {
      connection.socket.terminate();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** Поднимает mock и дожидается listening: без этого mock.url отдаст порт несуществующего сервера */
export async function startMockXiva(): Promise<MockXiva> {
  const mock = new MockXiva();
  await new Promise<void>((resolve) => mock.server.once('listening', resolve));
  return mock;
}
