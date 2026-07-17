/**
 * Структурный лог в stderr.
 *
 * *** stdout НЕ ТРОГАЕТСЯ НИКОГДА. *** Он принадлежит MCP stdio-транспорту: там идёт поток
 * JSON-RPC, и любой посторонний байт - от строки лога до случайного console.log - делает поток
 * неразбираемым, то есть роняет сессию целиком. Поэтому по умолчанию вывод жёстко прибит к
 * process.stderr, а параметр `write` существует ради тестов, а не ради выбора потока.
 *
 * РЕДАКЦИЯ обязательна и покрывает две разные вещи:
 *  - секреты сессии (cookie/Session_id/sign/session/uid/guid/subscription-id) - их утечка в лог
 *    компрометирует аккаунт, а логи переживают процесс и утекают в баг-репорты;
 *  - содержимое переписки - это чужая приватная информация, и в логах диагностического
 *    инструмента ей делать нечего ни при каком уровне логирования.
 * Редактируются и ключи, и значения: секрет часто приезжает не отдельным полем, а внутри
 * строки (URL с `sign=`, заголовок с `Session_id=`), где проверка по имени ключа его не видит.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const REDACTED = '[redacted]';

/**
 * Ключи, значения которых никогда не попадают в лог: секреты сессии
 * и содержимое переписки (приватность).
 */
const REDACTED_KEYS = new Set([
  /* Секреты сессии */
  'cookie',
  'cookies',
  'cookieheader',
  'set-cookie',
  'authorization',
  'auth_token',
  'token',
  'password',
  'sign',
  'secretsign',
  'session',
  'session_id',
  'sessionid',
  'sessionid2',
  'yandexuid',
  'uid',
  'useruid',
  'guid',
  'userguid',
  'subscription-id',
  'subscriptionid',
  'xivasubscriptionid',
  /* Содержимое переписки */
  'text',
  'messagetext',
  'message',
  'messages',
  'plain',
  'body',
  'preview',
  'snippet',
  'lastmessage',
  'last_message',
]);

/**
 * Секрет внутри строки: `sign=...` в URL, `Session_id=...` в заголовке. Проверка по имени
 * ключа такое пропускает - строка могла приехать в поле `url` или в тексте ошибки.
 */
const SECRET_IN_STRING =
  /\b(session_id|sessionid2|sessionid|secret|secretsign|sign|ts|token|oauth|subscription-id|yandexuid|uid|guid)=([^;&\s"']+)/gi;

function scrubString(value: string): string {
  return value.replace(SECRET_IN_STRING, (_match, key: string) => `${key}=${REDACTED}`);
}

const MAX_DEPTH = 6;

function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return '[truncated]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }
  if (value instanceof Error) {
    /* Текст ошибки - тоже строка из внешнего мира: в неё мог попасть URL с подписью */
    return { name: value.name, message: scrubString(value.message) };
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = REDACTED_KEYS.has(key.toLowerCase()) ? REDACTED : redact(item, depth + 1);
    }
    return result;
  }
  if (typeof value === 'string') {
    return scrubString(value);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

function resolveLevel(raw: string | undefined): LogLevel {
  const candidate = raw?.toLowerCase();
  return LOG_LEVELS.includes(candidate as LogLevel) ? (candidate as LogLevel) : 'info';
}

/**
 * Поля записи. Намеренно `object`, а не `Record<string, unknown>`: у интерфейсов TS нет
 * неявной индексной сигнатуры, поэтому типизированный результат (`SweepResult`, `PushOutcome`,
 * ...) в `Record<string, unknown>` не проходит, и каждый вызывающий был бы вынужден писать
 * `logger.debug(msg, { ...result })`. Ошибка при этом всплывала бы у вызывающего, хотя
 * причина - в сигнатуре логгера. Редакция работает по значению и от типа не зависит.
 */
export type LogFields = object;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface CreateLoggerOptions {
  level?: LogLevel;
  bindings?: LogFields;
  /**
   * Подменяется ТОЛЬКО в тестах. По умолчанию - stderr; переключать вывод на stdout нельзя
   * ни при каких обстоятельствах (см. шапку модуля).
   */
  write?: (line: string) => void;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? resolveLevel(process.env['YANDEX_MESSENGER_MCP_LOG_LEVEL']);
  const bindings = options.bindings ?? {};
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));

  const log = (entry: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[entry] < LEVEL_ORDER[level]) {
      return;
    }
    const record = {
      ts: new Date().toISOString(),
      level: entry,
      msg: message,
      ...(redact(bindings) as Record<string, unknown>),
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    write(JSON.stringify(record));
  };

  return {
    debug: (message, fields) => log('debug', message, fields),
    info: (message, fields) => log('info', message, fields),
    warn: (message, fields) => log('warn', message, fields),
    error: (message, fields) => log('error', message, fields),
    child: (extra) =>
      createLogger({ level, bindings: { ...bindings, ...extra }, write }),
  };
}
