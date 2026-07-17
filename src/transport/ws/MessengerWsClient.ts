/**
 * xiva WS-транспорт: единственный путь для `history` и `push` (§1).
 *
 * Клиент САМ собирает handshake-URL из AuthContext, потому что сборка - часть транспорта,
 * а не слоя auth. URL cookie-only (§17.1, перезахват на залогиненной сессии 2026-07-17):
 *
 *   wss://push.yandex.ru/v2/subscribe/websocket
 *     ?service=<name>:version5*common+version5*main&session=<4x4hex>&client=web_main&user=<числовой uid>
 *
 * НИ `sign`, НИ `ts` в URL НЕТ - авторизует cookie в заголовке handshake. `sign`/`ts` появляются
 * только в гостевой ветке (у гостя нет числового uid, клиент откатывается на guid и подписывает
 * URL); в v1 гостевой путь не реализуется, поэтому secretSign добавляется, лишь если слой auth
 * его реально прислал.
 *
 * Per-connection состояние (сбрасывается на КАЖДОМ переподключении):
 *  - `seq` - стартует с 1 (§14.8);
 *  - `subscription-id` - приходит операционным текст-кадром `subscribed` (§17.2), на реконнекте
 *    выдаётся НОВЫЙ, поэтому старый переиспользовать нельзя.
 */
import WebSocket from 'ws';
import { randomBytes } from 'node:crypto';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { AuthError, type AuthProvider } from '../../auth/AuthProvider.js';
import {
  mapResponseStatus,
  mapTransportError,
  MessengerError,
  THROTTLE_PUSH_STATUSES,
} from '../../protocol/errors.js';
import type { Logger } from '../../util/logger.js';
import {
  DEFAULT_MAX_ATTEMPTS,
  exponentialDelayMs,
  RateLimitGate,
  resolveWaitForDelayMs,
  sleep,
  type BackoffConfig,
} from '../backoff.js';
import { decodeFrame, encodeDataFrame, type RawFrame } from './frameCodec.js';
import { createRequestId } from './requestId.js';
import { FrameType } from './frameTypes.js';

/**
 * Единственный метод-мутация протокола (§14.4). Выделен именно здесь, потому что транспорт
 * обязан относиться к нему иначе всех прочих сразу в двух местах:
 *  - НИКОГДА не ретраить: отправка необратима, а молчание сервера не значит «не записалось»;
 *  - НЕ применять маппинг слоя 2: `Status` в ответе на push - это commit-статус, а не
 *    ResponseStatus (живьём: Status:1 = успешная доставка, см. protocol/errors.ts).
 */
const PUSH_METHOD = 'push';

/** Соединение закрылось до ответа */
export class WsClosedError extends Error {
  constructor(reason: string) {
    super(`WS соединение закрыто: ${reason}`);
    this.name = 'WsClosedError';
  }
}

/**
 * Кадр несёт subscription-id ЧУЖОГО соединения (§17.2) - и не отправлен.
 *
 * Между «взять id» и «отправить» может уместиться реконнект, а на нём Xiva выдаёт новый
 * id. Сверка делается ДО send: push со stale id ушёл бы в никуда, и узнать об этом было
 * бы уже нечем - отправка необратима, повторить её вслепую нельзя.
 */
export class StaleSubscriptionIdError extends Error {
  constructor(
    readonly method: string,
    readonly expected: string,
    readonly actual: string | undefined,
  ) {
    super(
      `WS ${method}: subscription-id соединения не совпал с ожидаемым - кадр не отправлен` +
        (actual === undefined ? ' (соединение ещё не получило кадр subscribed)' : ' (произошёл реконнект)'),
    );
    this.name = 'StaleSubscriptionIdError';
  }
}

/**
 * Close-reasons, на которых клиент сбрасывает креды (§14.5): протухшая cookie-сессия.
 * `bad sign` тут же, хотя на cookie-пути подписи нет: сервер использует ту же ветку.
 */
const AUTH_CLOSE_REASONS = ['cookie auth failed', 'no credentials', 'bad sign'];

/** Первый server-ping ожидается ≤5с после open (§14.7) */
const FIRST_PING_TIMEOUT_MS = 5_000;
/** Множитель таймаута между пингами (§14.7): 60с интервал -> 78с дедлайн */
const PING_TIMEOUT_FACTOR = 1.3;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SUBSCRIBED_TIMEOUT_MS = 15_000;

interface PendingRequest {
  method: string;
  /** Второй ключ корреляции: сверяется с `RequestId` из тела ответа (§14.8) */
  requestId: string;
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Waiter {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Connection {
  socket: WebSocket;
  /** §14.8: per-connection счётчик, старт 1 */
  seq: number;
  pending: Map<number, PendingRequest>;
  /** §17.2: приходит асинхронно после connect, на реконнекте - новый */
  subscriptionId: string | undefined;
  subscribedWaiters: Waiter[];
  pingTimer: NodeJS.Timeout | undefined;
  closed: boolean;
  /** Взводится, если соединение упало из-за отвергнутой cookie */
  authFailed: boolean;
}

export interface MessengerWsClientDeps {
  auth: AuthProvider;
  /** База без query: query собирает клиент */
  xivaUrl: string;
  xivaServiceName: string;
  logger?: Logger;
  requestTimeoutMs?: number;
  subscribedTimeoutMs?: number;
  /** Параметры backoff для READ-запросов; push не ретраится ни при каких настройках */
  backoff?: BackoffConfig;
}

export interface WsRequestOptions {
  /**
   * Отправить кадр, ТОЛЬКО если у соединения ровно этот subscription-id.
   * Нужно push: он несёт id внутри тела, и на другом соединении этот id недействителен (§17.2).
   */
  requireSubscriptionId?: string;
}

/** `session` в URL: 4 группы по 4 hex, напр. 74d0-3c17-7924-9497 (§2.1) */
function createSessionId(): string {
  const hex = randomBytes(8).toString('hex');
  return [0, 4, 8, 12].map((start) => hex.slice(start, start + 4)).join('-');
}

/** Топики xiva, на которые подписывается веб-клиент; `+` - их разделитель в синтаксисе Xiva */
const XIVA_TOPICS = 'version5*common+version5*main';

/**
 * Собирает query через URLSearchParams - ровно так же, как живой веб-клиент.
 *
 * ЖИВОЕ НАБЛЮДЕНИЕ (2026-07-17): сырой URL клиента несёт `service` percent-encoded:
 * `service=messenger-prod%3Aversion5*common%2Bversion5*main` (`:`->`%3A`, `+`->`%2B`,
 * `*` остаётся литералом - это ровно правила x-www-form-urlencoded).
 * Research §2.1/§17.1 приводят URL в ДЕКОДИРОВАННОМ виде (их снимали через
 * `searchParams`, а он `%2B` показывает как `+`). Слать литеральный `+` НЕЛЬЗЯ:
 * в query он значит пробел, и Xiva закрывает сокет с `4400 invalid argument "service"`.
 */
function buildXivaUrl(options: {
  xivaUrl: string;
  serviceName: string;
  session: string;
  user: string;
  secretSign?: { sign: string; ts: string };
}): string {
  const query = new URLSearchParams({
    service: `${options.serviceName}:${XIVA_TOPICS}`,
    session: options.session,
    client: 'web_main',
    /* Гостевая ветка: подпись есть только если слой auth её получил (§17.1) */
    ...(options.secretSign !== undefined ? { sign: options.secretSign.sign, ts: options.secretSign.ts } : {}),
    user: options.user,
  });
  return `${options.xivaUrl}?${query.toString()}`;
}

function isAuthCloseReason(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return AUTH_CLOSE_REASONS.some((known) => normalized.includes(known));
}

export class MessengerWsClient {
  private connection: Connection | undefined;
  private connecting: Promise<Connection> | undefined;
  private disposed = false;
  /** Окно «не раньше чем» из `rate_limit.wait_for`: единственный способ уважить его без ретрая push */
  private readonly rateLimitGate = new RateLimitGate();

  constructor(private readonly deps: MessengerWsClientDeps) {}

  /** Открывает соединение, если его нет. Резолвится на WS open, не дожидаясь `subscribed` */
  async connect(): Promise<void> {
    await this.ensureConnection();
  }

  /**
   * Отправляет DATA-кадр и ждёт ответ.
   *
   * Три разных реакции на неудачу, и смешивать их нельзя:
   *  - отвергнутая cookie: один рефреш профиля через onAuthFailure() и повтор (паузы не нужны);
   *  - retriable-ошибка READ-запроса (§14.6): повтор с экспоненциальной паузой;
   *  - `push`: без повторов вообще - отправка необратима (§14.4).
   */
  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
    options: WsRequestOptions = {},
  ): Promise<T> {
    let retries = 0;
    let authRefreshed = false;

    for (;;) {
      /* Сервер уже просил подождать - выдерживаем окно до расхода seq */
      await this.rateLimitGate.wait(this.deps.logger);
      try {
        return await this.attempt<T>(method, params, options);
      } catch (error) {
        /* Рефреш cookie бюджет повторов не тратит: это не «сервер занят», а «сессия протухла» */
        if (error instanceof AuthError && error.kind === 'cookie' && !authRefreshed) {
          authRefreshed = true;
          this.deps.logger?.warn('ws: cookie отвергнута, рефреш профиля и переподключение', { method });
          await this.deps.auth.onAuthFailure();
          continue;
        }

        const delayMs = this.retryDelayFor(method, error, retries);
        if (delayMs === undefined) {
          throw error;
        }
        retries += 1;
        this.deps.logger?.warn('ws: повтор запроса после backoff', {
          method,
          attempt: retries,
          delayMs,
          code: error instanceof MessengerError ? `${error.layer}/${error.codeName}` : 'unknown',
        });
        await sleep(delayMs);
      }
    }
  }

  /**
   * Пауза перед повтором либо undefined, если повторять нельзя.
   *
   * `push` отсекается ПЕРВЫМ и безусловно: даже TOO_MANY_REQUESTS на отправке не даёт права
   * повторить кадр - сообщение могло уйти, и повтор задвоил бы его у собеседника. Вместо
   * повтора взводится окно ожидания, а решение остаётся за вызывающим.
   */
  private retryDelayFor(method: string, error: unknown, retries: number): number | undefined {
    if (method === PUSH_METHOD) {
      return undefined;
    }
    if (!(error instanceof MessengerError) || !error.retriable) {
      return undefined;
    }
    const maxAttempts = this.deps.backoff?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (retries + 1 >= maxAttempts) {
      return undefined;
    }
    return exponentialDelayMs(retries + 1, this.deps.backoff ?? {});
  }

  /**
   * Отдаёт `subscription-id` текущего соединения, дожидаясь операционного кадра `subscribed`.
   * Нужен отправке (§17.2): push со старым id после реконнекта не пройдёт.
   */
  async waitForSubscriptionId(): Promise<string> {
    const connection = await this.ensureConnection();
    if (connection.subscriptionId !== undefined) {
      return connection.subscriptionId;
    }
    return new Promise<string>((resolve, reject) => {
      const timeout = this.deps.subscribedTimeoutMs ?? DEFAULT_SUBSCRIBED_TIMEOUT_MS;
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          connection.subscribedWaiters = connection.subscribedWaiters.filter((item) => item !== waiter);
          reject(new Error(`ws: операционный кадр subscribed не пришёл за ${timeout}мс`));
        }, timeout),
      };
      connection.subscribedWaiters.push(waiter);
    });
  }

  /** Принудительный реконнект: новое соединение, seq с 1, новый subscription-id */
  async reconnect(): Promise<void> {
    this.dropConnection('reconnect');
    await this.ensureConnection();
  }

  close(): void {
    this.disposed = true;
    this.dropConnection('client close');
  }

  private async attempt<T>(method: string, params: Record<string, unknown>, options: WsRequestOptions): Promise<T> {
    const connection = await this.ensureConnection();

    /* Сверка ДО расхода seq и до send: stale-кадр не должен уйти в сокет ни при каких условиях */
    const required = options.requireSubscriptionId;
    if (required !== undefined && connection.subscriptionId !== required) {
      throw new StaleSubscriptionIdError(method, required, connection.subscriptionId);
    }

    const reqId = connection.seq;
    connection.seq += 1;

    const requestId = createRequestId();
    const frame = encodeDataFrame({
      serviceIndex: 0,
      reqId,
      method,
      payload: { RequestId: requestId, ...params },
    });

    return new Promise<T>((resolve, reject) => {
      const timeout = this.deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const pending: PendingRequest = {
        method,
        requestId,
        resolve: resolve as (payload: unknown) => void,
        reject,
        timer: setTimeout(() => {
          connection.pending.delete(reqId);
          reject(new Error(`WS ${method}: ответ не пришёл за ${timeout}мс`));
        }, timeout),
      };
      connection.pending.set(reqId, pending);
      this.deps.logger?.debug('ws: запрос отправлен', { method, reqId });
      /* ws зовёт колбэк с null при успехе, поэтому проверка именно на наличие ошибки */
      connection.socket.send(frame, (error) => {
        if (error) {
          this.settle(connection, reqId, (item) => item.reject(error));
        }
      });
    });
  }

  private async ensureConnection(): Promise<Connection> {
    if (this.disposed) {
      throw new Error('ws: клиент закрыт');
    }
    if (this.connection !== undefined && !this.connection.closed) {
      return this.connection;
    }
    /* Схлопываем параллельные вызовы в один handshake */
    this.connecting ??= this.openConnection().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async openConnection(): Promise<Connection> {
    const context = await this.deps.auth.getAuthContext();
    const url = buildXivaUrl({
      xivaUrl: this.deps.xivaUrl,
      serviceName: this.deps.xivaServiceName,
      session: createSessionId(),
      user: context.userUid,
      ...(context.secretSign !== undefined ? { secretSign: context.secretSign } : {}),
    });

    const socket = new WebSocket(url, {
      headers: { Cookie: context.cookieHeader, Origin: 'https://yandex.ru' },
    });

    const connection: Connection = {
      socket,
      seq: 1,
      pending: new Map(),
      subscriptionId: undefined,
      subscribedWaiters: [],
      pingTimer: undefined,
      closed: false,
      authFailed: false,
    };

    /*
     * Слушатели вешаются ДО ожидания open: Xiva шлёт операционный `subscribed` сразу
     * после апгрейда, и подписка после await его теряет.
     */
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      this.onMessage(connection, data, isBinary);
    });
    socket.on('close', (code: number, reason: Buffer) => {
      this.onClose(connection, code, reason.toString());
    });
    socket.on('error', (error) => {
      this.deps.logger?.error('ws: ошибка сокета', { error });
    });

    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      /*
       * ws вызывает abortHandshake ТОЛЬКО если у события нет слушателя
       * (`else if (!websocket.emit('unexpected-response', req, res))`): наличие этого
       * обработчика подавляет собственную очистку библиотеки, поэтому TCP-сокет и
       * недренированный поток ответа закрываем сами - иначе они висят и держат весь
       * граф Connection до таймаута keep-alive.
       */
      const onUnexpectedResponse = (request: ClientRequest, response: IncomingMessage): void => {
        cleanup();
        const status = response.statusCode ?? 0;
        response.destroy();
        request.destroy();
        reject(
          status === 401 || status === 403
            ? new AuthError(`ws: handshake отверг cookie (HTTP ${status})`, 'cookie')
            : new Error(`ws: handshake вернул HTTP ${status}`),
        );
      };
      const cleanup = (): void => {
        socket.off('open', onOpen);
        socket.off('error', onError);
        socket.off('unexpected-response', onUnexpectedResponse);
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
      socket.once('unexpected-response', onUnexpectedResponse);
    });

    /* §14.7: первый ping ожидается быстро; молчание = мёртвое соединение */
    this.armPingTimer(connection, FIRST_PING_TIMEOUT_MS);

    this.connection = connection;
    this.deps.logger?.info('ws: соединение открыто');
    return connection;
  }

  private onMessage(connection: Connection, data: Buffer, isBinary: boolean): void {
    if (!isBinary) {
      this.onOperationFrame(connection, data.toString('utf8'));
      return;
    }

    let frame: RawFrame;
    try {
      frame = decodeFrame(data);
    } catch (error) {
      this.deps.logger?.error('ws: кадр не разобран', { error });
      return;
    }

    if (frame.frameType === FrameType.Data) {
      this.onDataFrame(connection, frame);
      return;
    }
    if (frame.frameType === FrameType.ProxyStatus) {
      this.onProxyStatusFrame(connection, frame);
      return;
    }
    if (frame.frameType === FrameType.Push) {
      /* Server-initiated событие: LIVE-подписки - non-goal v1, кадр не должен ронять транспорт */
      this.deps.logger?.debug('ws: server push пропущен', { event: frame.elements[2] });
      return;
    }
    this.deps.logger?.warn('ws: неизвестный тип кадра', { frameType: frame.frameType });
  }

  /** Текстовые операционные кадры Xiva (§14.7) */
  private onOperationFrame(connection: Connection, raw: string): void {
    let message: { operation?: string; 'subscription-id'?: string; 'server-interval-sec'?: number };
    try {
      message = JSON.parse(raw);
    } catch {
      this.deps.logger?.warn('ws: операционный кадр не разобран');
      return;
    }

    switch (message.operation) {
      case 'ping': {
        const interval = message['server-interval-sec'] ?? 60;
        this.armPingTimer(connection, interval * 1000 * PING_TIMEOUT_FACTOR);
        this.deps.logger?.debug('ws: server ping', { intervalSec: interval });
        return;
      }
      case 'subscribed': {
        const id = message['subscription-id'];
        if (typeof id !== 'string' || id.length === 0) {
          this.deps.logger?.warn('ws: кадр subscribed без subscription-id');
          return;
        }
        connection.subscriptionId = id;
        for (const waiter of connection.subscribedWaiters) {
          clearTimeout(waiter.timer);
          waiter.resolve(id);
        }
        connection.subscribedWaiters = [];
        this.deps.logger?.info('ws: subscription-id получен', { length: id.length });
        return;
      }
      case 'unsubscribe': {
        /* §14.7: сервер отзывает подписку и чистит креды - трактуем как отказ авторизации */
        connection.authFailed = true;
        connection.socket.close();
        return;
      }
      default: {
        this.deps.logger?.warn('ws: операционный кадр', { operation: message.operation ?? 'unknown' });
      }
    }
  }

  private onDataFrame(connection: Connection, frame: RawFrame): void {
    const reqId = frame.elements[1];
    if (typeof reqId !== 'number') {
      this.deps.logger?.warn('ws: DATA-кадр без числового reqId');
      return;
    }
    const payload = frame.payload as { RequestId?: unknown } | undefined;

    this.settle(connection, reqId, (pending) => {
      /* Корреляция по ОБОИМ ключам: reqId транспорта и RequestId бэкенда (§14.8) */
      const responseRequestId = payload?.RequestId;
      if (typeof responseRequestId === 'string' && responseRequestId !== pending.requestId) {
        pending.reject(new Error(`WS ${pending.method}: RequestId ответа не совпал с запросом (reqId=${reqId})`));
        return;
      }

      if (pending.method === PUSH_METHOD) {
        /* Слой 3 разбирает protocol/push.ts; транспорт лишь снимает просьбу подождать */
        this.notePushRateLimit(frame.payload);
        pending.resolve(frame.payload);
        return;
      }

      /* Слой 2 (§14.6): ненулевой Status - это отказ бэкенда, а не пустая выдача */
      const applicationError = mapResponseStatus(pending.method, frame.payload);
      if (applicationError !== undefined) {
        pending.reject(applicationError);
        return;
      }
      pending.resolve(frame.payload);
    });
  }

  /**
   * Снимает `rate_limit.wait_for` с ответа на push и взводит окно ожидания (§14.4).
   *
   * Читается и просьба на throttle-статусах без `rate_limit`: сервер сказал «частишь»,
   * и пауза нужна, даже если срок он не назвал. Разбирать здесь commit-статус целиком -
   * не задача транспорта, поэтому берутся ровно два throttle-кода.
   */
  private notePushRateLimit(payload: unknown): void {
    const body = payload as { Status?: unknown; RateLimit?: unknown; rate_limit?: unknown } | undefined;
    if (body === null || typeof body !== 'object') {
      return;
    }
    const limit = (body.RateLimit ?? body.rate_limit) as { WaitFor?: unknown; wait_for?: unknown } | undefined;
    const rawWaitFor = limit !== null && typeof limit === 'object' ? (limit.WaitFor ?? limit.wait_for) : undefined;
    const throttled = typeof body.Status === 'number' && THROTTLE_PUSH_STATUSES.has(body.Status);

    if (rawWaitFor === undefined && !throttled) {
      return;
    }

    const { delayMs, clamped } = resolveWaitForDelayMs(rawWaitFor);
    this.rateLimitGate.note(delayMs);
    /* Сырое значение в логе намеренно: первое живое срабатывание позволит определить единицу */
    this.deps.logger?.warn('ws: сервер просит сбавить темп, следующие запросы отложены', {
      waitForRaw: rawWaitFor ?? null,
      delayMs,
      clamped,
      note: 'единица wait_for не документирована; значение зажато в [1с, 60с]',
    });
  }

  private onProxyStatusFrame(connection: Connection, frame: RawFrame): void {
    const reqId = frame.elements[0];
    const errorCode = frame.elements[1];
    if (typeof reqId !== 'number' || typeof errorCode !== 'number') {
      this.deps.logger?.warn('ws: PROXY_STATUS с нечисловым заголовком');
      return;
    }
    this.settle(connection, reqId, (pending) => {
      pending.reject(mapTransportError(pending.method, errorCode));
    });
  }

  private settle(connection: Connection, reqId: number, apply: (pending: PendingRequest) => void): void {
    const pending = connection.pending.get(reqId);
    if (pending === undefined) {
      this.deps.logger?.warn('ws: ответ без ожидающего запроса', { reqId });
      return;
    }
    connection.pending.delete(reqId);
    clearTimeout(pending.timer);
    apply(pending);
  }

  private armPingTimer(connection: Connection, timeoutMs: number): void {
    if (connection.pingTimer !== undefined) {
      clearTimeout(connection.pingTimer);
    }
    connection.pingTimer = setTimeout(() => {
      this.deps.logger?.warn('ws: server-ping не пришёл в срок, закрываем соединение');
      connection.socket.close();
    }, timeoutMs);
  }

  private onClose(connection: Connection, code: number, reason: string): void {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    if (connection.pingTimer !== undefined) {
      clearTimeout(connection.pingTimer);
    }
    if (this.connection === connection) {
      this.connection = undefined;
    }

    const authFailed = connection.authFailed || isAuthCloseReason(reason);
    this.deps.logger?.warn('ws: соединение закрыто', { code, reason, authFailed });

    /* Протухшая cookie сюрфейсится как AuthError: вызывающий рефрешит профиль и повторяет */
    const error = authFailed
      ? new AuthError(`ws: соединение закрыто из-за авторизации: ${reason || code}`, 'cookie')
      : new WsClosedError(reason || String(code));

    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    connection.pending.clear();

    for (const waiter of connection.subscribedWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    connection.subscribedWaiters = [];
  }

  private dropConnection(reason: string): void {
    const connection = this.connection;
    if (connection === undefined) {
      return;
    }
    /* Закрываем сокет; per-connection состояние умрёт вместе с объектом Connection */
    connection.socket.close(1000, reason);
    this.onClose(connection, 1000, reason);
  }
}
