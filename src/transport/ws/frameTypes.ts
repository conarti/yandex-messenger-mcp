/**
 * Константы WS-протокола: типы кадров (§2.2/§14.9) и три слоя error-кодов (§14.6).
 *
 * Держатся отдельным модулем сознательно: смена версии chats-web правит значения
 * здесь, а не растекается по кодеку и клиенту.
 */

/**
 * Байт 0 кадра. Определяет арность msgpack-заголовка:
 * Data -> 0x93 [serviceIndex, reqId, method], ProxyStatus -> 0x92 [reqId, errorCode],
 * Push -> 0x94 [uid, service, event, transitId].
 */
export const FrameType = {
  Data: 1,
  ProxyStatus: 2,
  Push: 3,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

/** Слой 1: транспортная ошибка из кадра PROXY_STATUS (§14.6) */
export const TransportErrorCode = {
  SUCCESS: 0,
  PROTOCOL_ERROR: 1,
  BACKEND_CALL_ERROR: 2,
  INTERNAL_ERROR: 3,
  CORRUPTED_DATA_HEADER: 4,
  BACKEND_NOT_FOUND: 5,
  SERVICE_UNAVAILABLE: 6,
  TOO_MANY_REQUESTS: 7,
  FRAME_TOO_LARGE: 8,
} as const;
export type TransportErrorCode = (typeof TransportErrorCode)[keyof typeof TransportErrorCode];

/** Слой 2: `Status` в JSON DATA-кадра (§14.6). Поля `Retriable` в протоколе нет */
export const ResponseStatus = {
  SUCCESS: 0,
  INTERNAL_ERROR: 1,
  ACCESS_DENIED: 2,
  MISCONFIGURATION: 3,
  ENTITY_NOT_FOUND: 4,
  OVERLOAD: 5,
  UNAUTHORIZED: 6,
} as const;
export type ResponseStatus = (typeof ResponseStatus)[keyof typeof ResponseStatus];

/**
 * Слой 3: commit-статус ответа на `push` (§14.6).
 * `DUPLICATE` - идемпотентный успех: сообщение уже принято, повторно слать нельзя.
 */
export const PushCommitStatus = {
  UNCOMMMITED: 0,
  FULLY_COMMITTED: 1,
  UNIPROXY_COMMITTED: 2,
  FAILED: 3,
  NO_SUCH_CHAT: 4,
  NOT_LEADING: 5,
  FOREIGN_PARTITION: 6,
  SENDER_NOT_IN_CHAT: 7,
  DUPLICATE: 8,
  POSTPROC_COMMITTED: 9,
  KIKIMR_WRITE_FAILED: 10,
  MESSAGE_NOT_FOUND: 11,
  DEQUEUED_AFTER_ERROR: 12,
  BAD_REQUEST: 13,
  FILESHARE_FAILED: 14,
  NO_PERMISSION: 15,
  CONFLICT: 16,
  NO_SUCH_USER: 17,
  THROTTLED: 18,
  BANNED: 19,
  BLACKLISTED: 20,
  NOT_FOUND: 21,
  SPAM_DETECTED: 22,
  RATE_LIMIT_EXCEEDED: 23,
  BLOCKED_BY_PRIVACY_SETTINGS: 24,
  PUSH_UNAUTHORIZED: 25,
} as const;
export type PushCommitStatus = (typeof PushCommitStatus)[keyof typeof PushCommitStatus];

/** Имя кода для сообщений об ошибке; неизвестный код не скрывается, а отдаётся числом */
export function codeName(codes: Record<string, number>, value: number): string {
  return Object.keys(codes).find((key) => codes[key] === value) ?? `UNKNOWN(${value})`;
}
