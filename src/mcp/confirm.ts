/**
 * Общий confirm-токен необратимых мутаций (Fork B1).
 *
 * ВЫНЕСЕНО ИЗ sendMessage. v1 держал двухшаговость send прямо в инструменте; тот же
 * паттерн нужен delete/edit/send_file/vote (Phase 6-7). Здесь он обобщён БЕЗ смены
 * поведения send: «хэш текста» стал «отпечатком нагрузки» (fingerprint), а токен несёт
 * поле `op` - дискриминатор операции.
 *
 * ЗАЧЕМ `op`. Токен ходит через чужие руки: его отдают клиенту и приносят обратно. Без
 * привязки к операции токен, минченный для одной мутации, можно предъявить другой при
 * случайном совпадении полей (кросс-op replay). `op` сверяется на confirm; несовпадение =
 * `op_mismatch`, отправки нет. Дополнительно fingerprint домен-сепарирован префиксом op
 * (`hash(op + ':' + payload)`): даже одинаковая нагрузка двух операций даёт РАЗНЫЙ
 * отпечаток, поэтому подстановка отпечатка между операциями исключена и на уровне хэша.
 *
 * ИДЕМПОТЕНТНОСТЬ - ДВА РАЗНЫХ ПУТИ, НЕ ОДИН.
 *  - SEND-путь (op с `payload_id`: send, send_file) несёт client message id; повтор того
 *    же id сервер отдаёт как `DUPLICATE(8)` - серверный дедуп ДОКАЗАН (§14.4, push.ts).
 *  - TARGET-путь (delete/edit/vote, Phase 6) целится в существующее по target-Timestamp;
 *    серверный `DUPLICATE(8)` на его повторе НЕ доказан. Для него - только локальная память
 *    `recallResult` плюс естественная идемпотентность по target-Timestamp. Серверный дедуп
 *    таким операциям НЕ обещается, пока живая replay-проба (Phase 0) не покажет обратное.
 *  Локальная память общая: израсходованный токен отдаёт запомненный результат, второй push
 *  не уходит. Она ограничена сверху - защита от повтора в пределах сессии, а не журнал.
 *
 * ТОКЕН НЕ ПОДПИСАН осознанно (как в v1): подделка ничего не даёт. Чат из токена сверяется
 * с ЗАНОВО резолвнутым, нагрузка - с заново посчитанным отпечатком, отправка идёт в
 * проверенный чат. Токен - это память о драфте, а не полномочие.
 */
import { createHash } from 'node:crypto';

/** Операции, несущие confirm (необратимый путь). Реверсибельные мутации токена не имеют. */
export type ConfirmOp = 'send' | 'delete' | 'edit' | 'send_file' | 'vote';

/**
 * Начинка confirm-токена. Нагрузки тут нет - только её отпечаток: токен ходит через чужие
 * руки. `payload_id` есть только у send-пути (ключ серверной дедупликации, §11.1).
 */
export interface DraftToken {
  op: ConfirmOp;
  chat_id: string;
  fingerprint: string;
  payload_id?: string;
}

/** Confirm отвергнут. `reason` несёт машинно-читаемую причину, текст - для человека */
export class ConfirmRejectedError extends Error {
  constructor(
    readonly reason: string,
    detail: string,
  ) {
    super(`confirm отвергнут (${reason}): ${detail}`);
    this.name = 'ConfirmRejectedError';
  }
}

/** Отпечаток нагрузки, домен-сепарированный операцией: `sha256(op + ':' + payload)` */
export function fingerprint(op: ConfirmOp, payload: string): string {
  return createHash('sha256').update(`${op}:${payload}`, 'utf8').digest('hex');
}

/**
 * Токен намеренно НЕ подписан: см. шапку модуля. Это просто base64url упаковка полей,
 * а не защищённый носитель полномочий.
 */
export function encodeToken(token: DraftToken): string {
  return Buffer.from(JSON.stringify(token), 'utf8').toString('base64url');
}

export function decodeToken(raw: string): DraftToken | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<DraftToken>;
    if (
      typeof parsed.op !== 'string' ||
      typeof parsed.chat_id !== 'string' ||
      typeof parsed.fingerprint !== 'string' ||
      (parsed.payload_id !== undefined && typeof parsed.payload_id !== 'string')
    ) {
      return undefined;
    }
    return {
      op: parsed.op as ConfirmOp,
      chat_id: parsed.chat_id,
      fingerprint: parsed.fingerprint,
      ...(parsed.payload_id !== undefined ? { payload_id: parsed.payload_id } : {}),
    };
  } catch {
    return undefined;
  }
}

export interface VerifyConfirmInput {
  /** Имя операции вызывающего инструмента - сверяется с `token.op` */
  op: ConfirmOp;
  /** Сырой confirm_token, как пришёл от клиента */
  token: string | undefined;
  /** ЗАНОВО резолвнутый ChatId: сверяется с чатом токена */
  chatId: string;
  /** ЗАНОВО посчитанный отпечаток нагрузки (через `fingerprint(op, ...)`) */
  fingerprint: string;
  /**
   * Причина расхождения отпечатка. По умолчанию `fingerprint_mismatch`. Механизм override
   * остаётся в API и используется send_file-путём (`file_mismatch`, отпечаток считается по
   * описанию файла). send-путь override НЕ задаёт: после расширения отпечатка на упоминания и
   * цель reply историческое имя причины стало бы ложным (расхождение состава отчиталось бы как текст).
   */
  fingerprintMismatchReason?: string;
}

/**
 * Полная ре-верификация confirm: наличие/разбор токена, сверка op, чата и отпечатка.
 * Возвращает разобранный токен (нужен его `payload_id`); при любом расхождении бросает
 * `ConfirmRejectedError` и НИЧЕГО не отправляет - решение остаётся за вызывающим до push.
 *
 * Порядок проверок значим: op раньше чата и отпечатка, чтобы кросс-op replay отсекался
 * как `op_mismatch`, а не маскировался под `chat_mismatch` при случайном совпадении.
 */
export function verifyConfirmToken(input: VerifyConfirmInput): DraftToken {
  const raw = input.token;
  if (raw === undefined || raw.length === 0) {
    throw new ConfirmRejectedError('token_missing', 'confirm:true требует confirm_token из шага draft');
  }
  const token = decodeToken(raw);
  if (token === undefined) {
    throw new ConfirmRejectedError('token_malformed', 'confirm_token не разобран');
  }
  if (token.op !== input.op) {
    throw new ConfirmRejectedError('op_mismatch', `токен операции '${token.op}' предъявлен операции '${input.op}'`);
  }
  if (token.chat_id !== input.chatId) {
    /* Ни один из чатов не «правильнее» - расхождение значит, что подтверждали не это */
    throw new ConfirmRejectedError('chat_mismatch', 'запрос chat резолвится в другой чат, чем на шаге draft');
  }
  if (token.fingerprint !== input.fingerprint) {
    throw new ConfirmRejectedError(
      input.fingerprintMismatchReason ?? 'fingerprint_mismatch',
      'нагрузка отличается от подтверждённой на шаге draft',
    );
  }
  return token;
}

/**
 * Израсходованные токены -> их результат. Ограничена сверху: защита от повтора в пределах
 * сессии, а не журнал. Вытеснение старого токена не ломает идемпотентность send-пути - его
 * повтор упрётся в серверную дедупликацию по `PayloadId`.
 */
const MAX_REMEMBERED = 100;
const resultByToken = new Map<string, unknown>();

export function rememberResult(token: string, result: unknown): void {
  resultByToken.set(token, result);
  for (const oldest of resultByToken.keys()) {
    if (resultByToken.size <= MAX_REMEMBERED) {
      break;
    }
    resultByToken.delete(oldest);
  }
}

export function recallResult<T>(token: string): T | undefined {
  return resultByToken.get(token) as T | undefined;
}

/** Экспортируется для тестов: модульное состояние не должно течь между кейсами */
export function resetConfirmMemory(): void {
  resultByToken.clear();
}
