/**
 * Маппинг трёх слоёв ошибок протокола (§14.6) в одну осмысленную ошибку с ТЕГОМ СЛОЯ.
 *
 * Слои физически разные и путать их нельзя - один и тот же номер значит в них разное:
 *  1. `transport`   - кадр PROXY_STATUS `[reqId, errorCode]`, ошибка Xiva-прокси. Бэкенд запрос
 *                     мог и не увидеть.
 *  2. `application` - DATA-кадр с ненулевым `Status` в JSON: бэкенд запрос принял и отверг.
 *                     Диагностика - в `Details`/`RequestId` того же тела.
 *  3. `push`        - commit-статус ответа на `push`: принят ли сам факт мутации.
 *
 * *** ЛОВУШКА, ПОДТВЕРЖДЁННАЯ ЖИВЬЁМ: `Status` в ответе на `push` - это НЕ ResponseStatus. ***
 * Живой push вернул `Status:1` при успешной доставке (FULLY_COMMITTED) и `Status:8` на повторе
 * (DUPLICATE). В ResponseStatus `1` - это INTERNAL_ERROR, а `8` не существует вовсе. То есть
 * слепая проверка «ненулевой Status = ошибка» превратила бы успешную отправку в ошибку, а
 * вызывающий, поверив ей, отправил бы сообщение второй раз. Поэтому маппинг слоя 2 к ответам
 * `push` НЕ ПРИМЕНЯЕТСЯ - их читает mapPushCommitStatus (слой 3).
 *
 * Неизвестный код не проглатывается: codeName отдаёт `UNKNOWN(<число>)`, а сообщение прямо
 * говорит, что кода нет в справочнике §14.6 - сырое число доходит до пользователя.
 */
import { codeName, PushCommitStatus, ResponseStatus, TransportErrorCode } from '../transport/ws/frameTypes.js';

export type ErrorLayer = 'transport' | 'application' | 'push';

/** Расшифровки кодов: сам номер без смысла недиагностируем */
const TRANSPORT_HINTS: Record<number, string> = {
  [TransportErrorCode.SUCCESS]: 'успех (ошибкой не является)',
  [TransportErrorCode.PROTOCOL_ERROR]: 'прокси не разобрал кадр - запрос собран неверно',
  [TransportErrorCode.BACKEND_CALL_ERROR]: 'прокси не смог вызвать бэкенд',
  [TransportErrorCode.INTERNAL_ERROR]: 'внутренняя ошибка прокси',
  [TransportErrorCode.CORRUPTED_DATA_HEADER]: 'испорченный заголовок data-секции кадра',
  [TransportErrorCode.BACKEND_NOT_FOUND]: 'бэкенд не найден - неверный serviceIndex либо имя сервиса',
  [TransportErrorCode.SERVICE_UNAVAILABLE]: 'сервис временно недоступен',
  [TransportErrorCode.TOO_MANY_REQUESTS]: 'слишком много запросов - нужен backoff',
  [TransportErrorCode.FRAME_TOO_LARGE]: 'кадр превысил допустимый размер',
};

const APPLICATION_HINTS: Record<number, string> = {
  [ResponseStatus.INTERNAL_ERROR]: 'внутренняя ошибка бэкенда',
  [ResponseStatus.ACCESS_DENIED]: 'доступ к сущности запрещён',
  [ResponseStatus.MISCONFIGURATION]: 'ошибка конфигурации сервиса',
  [ResponseStatus.ENTITY_NOT_FOUND]: 'сущность не найдена (чат, сообщение либо пользователь)',
  [ResponseStatus.OVERLOAD]: 'бэкенд перегружен',
  [ResponseStatus.UNAUTHORIZED]: 'запрос не авторизован - сессия могла протухнуть',
};

const PUSH_HINTS: Record<number, string> = {
  [PushCommitStatus.UNCOMMMITED]: 'сервер не подтвердил запись',
  [PushCommitStatus.UNIPROXY_COMMITTED]: 'принято прокси, но запись НЕ подтверждена - успехом не считаем',
  [PushCommitStatus.FAILED]: 'сервер отклонил мутацию',
  [PushCommitStatus.NO_SUCH_CHAT]: 'чат не существует - проверьте ChatId',
  [PushCommitStatus.NOT_LEADING]: 'внутренняя маршрутизация: узел не ведущий',
  [PushCommitStatus.FOREIGN_PARTITION]: 'внутренняя маршрутизация: чужая партиция',
  [PushCommitStatus.SENDER_NOT_IN_CHAT]: 'отправитель не состоит в чате',
  [PushCommitStatus.POSTPROC_COMMITTED]: 'подтверждена только постобработка, запись - нет; успехом не считаем',
  [PushCommitStatus.KIKIMR_WRITE_FAILED]: 'запись в хранилище не удалась',
  [PushCommitStatus.MESSAGE_NOT_FOUND]: 'сообщение не найдено',
  [PushCommitStatus.DEQUEUED_AFTER_ERROR]: 'мутация снята с очереди после ошибки',
  [PushCommitStatus.BAD_REQUEST]: 'сервер счёл запрос некорректным',
  [PushCommitStatus.FILESHARE_FAILED]: 'не удалось приложить файл',
  [PushCommitStatus.NO_PERMISSION]: 'нет прав на эту операцию в этом чате',
  [PushCommitStatus.CONFLICT]: 'конфликт состояния на сервере',
  [PushCommitStatus.NO_SUCH_USER]: 'пользователь не найден',
  [PushCommitStatus.THROTTLED]: 'сервер троттлит отправку',
  [PushCommitStatus.BANNED]: 'аккаунт заблокирован для отправки',
  [PushCommitStatus.BLACKLISTED]: 'отправитель в чёрном списке получателя',
  [PushCommitStatus.NOT_FOUND]: 'сущность не найдена',
  [PushCommitStatus.SPAM_DETECTED]: 'сервер счёл сообщение спамом',
  [PushCommitStatus.RATE_LIMIT_EXCEEDED]: 'превышен лимит частоты отправки',
  [PushCommitStatus.BLOCKED_BY_PRIVACY_SETTINGS]: 'запрещено настройками приватности получателя',
  [PushCommitStatus.PUSH_UNAUTHORIZED]: 'push не авторизован - сессия либо subscription-id недействительны',
};

/**
 * Коды слоя 1, на которых повтор READ-запроса осмыслен: сервер прямо говорит «позже».
 * Остальные (PROTOCOL_ERROR, FRAME_TOO_LARGE, BACKEND_NOT_FOUND, ...) - дефект запроса,
 * от повтора он не исправится, ретрай только сожжёт лимиты.
 */
const RETRIABLE_TRANSPORT_CODES: ReadonlySet<number> = new Set([
  TransportErrorCode.SERVICE_UNAVAILABLE,
  TransportErrorCode.TOO_MANY_REQUESTS,
]);

/**
 * Коды слоя 2, на которых повтор READ-запроса осмыслен. UNAUTHORIZED сюда НЕ входит:
 * его лечит рефреш cookie, а не пауза (этим занимается ветка AuthError в транспорте).
 */
const RETRIABLE_APPLICATION_CODES: ReadonlySet<number> = new Set([ResponseStatus.OVERLOAD]);

/** Слой 3: коды, на которых сервер просит сбавить темп (§14.6) */
export const THROTTLE_PUSH_STATUSES: ReadonlySet<number> = new Set([
  PushCommitStatus.THROTTLED,
  PushCommitStatus.RATE_LIMIT_EXCEEDED,
]);

const LAYER_CODES: Record<ErrorLayer, Record<string, number>> = {
  transport: TransportErrorCode,
  application: ResponseStatus,
  push: PushCommitStatus,
};

export interface MessengerErrorInit {
  layer: ErrorLayer;
  code: number;
  /** WS-метод, на котором пришла ошибка */
  method?: string;
  /** `response.Details` (§14.6) либо расшифровка кода */
  details?: string;
  /** `response.RequestId` (§14.8) - ключ для поиска на стороне бэкенда */
  requestId?: string;
  /** Авто-ретрай READ-запроса допустим. Для мутаций всегда false: push необратим */
  retriable: boolean;
  /**
   * Сырое `rate_limit.wait_for` (§14.4). Именно СЫРОЕ: единица измерения неизвестна,
   * перевод в миллисекунды - зона ответственности transport/backoff.ts.
   */
  waitForRaw?: number;
}

/** Ошибка протокола с явным указанием слоя: без него код `4` неинтерпретируем */
export class MessengerError extends Error {
  readonly layer: ErrorLayer;
  readonly code: number;
  readonly codeName: string;
  /** Код есть в справочнике §14.6. false = сервер отдал что-то новое, наружу идёт сырое число */
  readonly known: boolean;
  readonly retriable: boolean;
  readonly method: string | undefined;
  readonly details: string | undefined;
  readonly requestId: string | undefined;
  readonly waitForRaw: number | undefined;

  constructor(init: MessengerErrorInit) {
    const name = codeName(LAYER_CODES[init.layer], init.code);
    super(buildMessage(init, name));
    this.name = 'MessengerError';
    this.layer = init.layer;
    this.code = init.code;
    this.codeName = name;
    this.known = !name.startsWith('UNKNOWN(');
    this.retriable = init.retriable;
    this.method = init.method;
    this.details = init.details;
    this.requestId = init.requestId;
    this.waitForRaw = init.waitForRaw;
  }
}

const LAYER_TITLE: Record<ErrorLayer, string> = {
  transport: 'транспорт отверг запрос',
  application: 'бэкенд вернул ошибку',
  push: 'отправка не подтверждена, commit-статус',
};

function buildMessage(init: MessengerErrorInit, name: string): string {
  const parts = [`[${init.layer}]`];
  if (init.method !== undefined) {
    parts.push(`${init.method}:`);
  }
  parts.push(`${LAYER_TITLE[init.layer]} ${name}(${init.code})`);

  const tail: string[] = [];
  if (init.details !== undefined && init.details.length > 0) {
    tail.push(init.details);
  }
  if (name.startsWith('UNKNOWN(')) {
    tail.push('кода нет в справочнике §14.6 - значение отдано как есть');
  }
  if (init.requestId !== undefined) {
    tail.push(`RequestId=${init.requestId}`);
  }
  if (init.waitForRaw !== undefined) {
    /* Единица не документирована - показываем сырое значение, а не «через N секунд» */
    tail.push(`сервер просит подождать (wait_for=${init.waitForRaw}, единица не документирована)`);
  }
  return tail.length > 0 ? `${parts.join(' ')}: ${tail.join('; ')}` : parts.join(' ');
}

/** Слой 1: кадр PROXY_STATUS `[reqId, errorCode]` (§14.6) */
export function mapTransportError(method: string, errorCode: number): MessengerError {
  return new MessengerError({
    layer: 'transport',
    code: errorCode,
    method,
    retriable: RETRIABLE_TRANSPORT_CODES.has(errorCode),
    ...(TRANSPORT_HINTS[errorCode] !== undefined ? { details: TRANSPORT_HINTS[errorCode] } : {}),
  });
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function stringOr(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Слой 2: ненулевой `Status` в теле DATA-кадра (§14.6).
 *
 * Отсутствие `Status` = успех: живой ответ `history` несёт только `{Chats, RequestId}`, поля
 * `Status` в нём нет вовсе. Требовать `Status:0` значило бы объявить ошибкой каждый штатный ответ.
 *
 * НЕ ВЫЗЫВАТЬ для ответов на `push`: там `Status` - это commit-статус (см. шапку модуля).
 */
export function mapResponseStatus(method: string, payload: unknown): MessengerError | undefined {
  const body = asObject(payload);
  const status = body?.['Status'];
  if (typeof status !== 'number' || status === ResponseStatus.SUCCESS) {
    return undefined;
  }
  const details = stringOr(body?.['Details']) ?? APPLICATION_HINTS[status];
  const requestId = stringOr(body?.['RequestId']);
  return new MessengerError({
    layer: 'application',
    code: status,
    method,
    retriable: RETRIABLE_APPLICATION_CODES.has(status),
    ...(details !== undefined ? { details } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
  });
}

/** Структурный минимум ответа push: полный тип живёт в protocol/push.ts (импорт был бы циклом) */
export interface PushCommitOutcomeLike {
  status: number;
  rate_limit?: { wait_for: number };
}

/**
 * Слой 3: commit-статус ответа на `push` (§14.6).
 *
 * `retriable` тут ВСЕГДА false, даже на THROTTLED/RATE_LIMIT_EXCEEDED. Причина не в коде, а в
 * природе операции: отправка необратима, а не подтверждённый push мог и записаться (сервер
 * ответил уже после записи, ответ потерялся). Авто-повтор задвоил бы сообщение у собеседника.
 * Пауза, о которой просит сервер, применяется к ПОСЛЕДУЮЩИМ запросам (transport/backoff.ts),
 * а решение повторить отправку остаётся за человеком.
 */
export function mapPushCommitStatus(outcome: PushCommitOutcomeLike): MessengerError {
  const hint = PUSH_HINTS[outcome.status];
  const details = [hint, 'авто-ретрай не делается: отправка необратима'].filter(Boolean).join('; ');
  return new MessengerError({
    layer: 'push',
    code: outcome.status,
    retriable: false,
    details,
    ...(outcome.rate_limit !== undefined ? { waitForRaw: outcome.rate_limit.wait_for } : {}),
  });
}
