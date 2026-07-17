/**
 * Backoff и rate-limit gate.
 *
 * ===================================================================================
 *  ЕДИНИЦА ИЗМЕРЕНИЯ `rate_limit.wait_for` НЕИЗВЕСТНА. ЗДЕСЬ ОНА НЕ УГАДЫВАЕТСЯ.
 * ===================================================================================
 * Что известно фактически:
 *  - §14.4 описывает `rate_limit:{wait_for: RateLimit.WaitFor}` и ни слова про единицу;
 *  - живьём `rate_limit` не приходил НИ РАЗУ (ни на успешной отправке, ни на дубликате),
 *    то есть наблюдения нет вообще - есть только имя поля;
 *  - само имя `WaitFor` не несёт суффикса (сравните: метки времени в этом протоколе везде
 *    подписаны - `TimestampMcs`, `LastTsMcs`, `PrevTimestampMcs`). Вывести единицу из
 *    соглашения об именовании нельзя: суффикса просто нет.
 *
 * Цена ошибки НЕсимметрична, но плоха в обе стороны:
 *  - принять секунды за миллисекунды -> `wait_for:5` даст паузу 5мс -> ретрай-шторм в тот
 *    самый сервер, который только что попросил притормозить (и это путь к бану);
 *  - принять микросекунды за миллисекунды -> `wait_for:60000000` (= 60с в мкс) даст паузу
 *    16.6 ЧАСОВ -> клиент выглядит зависшим намертво.
 *
 * РЕШЕНИЕ: не интерпретировать единицу, а ОГРАНИЧИТЬ результат с обеих сторон.
 * Сырое число трактуется как миллисекунды (единственная единица, которую понимает setTimeout)
 * и зажимается в [MIN, MAX]. Зажим - это не косметика, а именно то, что делает промах по
 * единице переживаемым, каким бы он ни был:
 *  - если сервер имел в виду СЕКУНДЫ, малые значения (1..60) провалились бы в единицы
 *    миллисекунд - MIN=1с не даёт паузе схлопнуться и ретрай-шторма не возникает;
 *  - если сервер имел в виду МИКРОсекунды, большие значения улетели бы в часы - MAX=60с
 *    ограничивает зависание минутой;
 *  - если сервер имел в виду МИЛЛИсекунды, значения рабочего диапазона проходят как есть.
 * То есть при ЛЮБОЙ из трёх гипотез поведение остаётся в диапазоне «пауза от 1с до 60с» -
 * безопасно и для сервера, и для вызывающего. Точность приносится в жертву осознанно: без
 * живого наблюдения точной паузы всё равно не получить.
 *
 * Каждое применение `wait_for` логируется предупреждением с СЫРЫМ значением и фактом зажима -
 * первое же живое срабатывание в логах даст возможность определить единицу и убрать эту оговорку.
 */
import type { Logger } from '../util/logger.js';

/** Нижняя граница паузы по `wait_for`: страховка от гипотезы «сервер прислал секунды» */
export const RATE_LIMIT_MIN_DELAY_MS = 1_000;
/** Верхняя граница паузы по `wait_for`: страховка от гипотезы «сервер прислал микросекунды» */
export const RATE_LIMIT_MAX_DELAY_MS = 60_000;

/** База экспоненциального backoff, когда сервер паузу не назвал */
export const DEFAULT_BASE_DELAY_MS = 500;
/** Потолок экспоненциального backoff */
export const DEFAULT_MAX_DELAY_MS = 8_000;
/** Всего попыток READ-запроса (1 исходная + 2 повтора) */
export const DEFAULT_MAX_ATTEMPTS = 3;

export type WaitForClamp = 'none' | 'min' | 'max' | 'invalid';

export interface WaitForDelay {
  delayMs: number;
  /** Как сырое значение легло в допустимый диапазон - идёт в лог, чтобы промах был видим */
  clamped: WaitForClamp;
}

/**
 * Переводит сырое `wait_for` в паузу. См. шапку модуля: единица не угадывается, результат
 * зажимается в [1с, 60с].
 *
 * Мусорное значение (не число, NaN, отрицательное) не игнорируется молча: сервер о паузе
 * попросил, и раз он это сделал, пауза берётся минимальная, а не нулевая.
 */
export function resolveWaitForDelayMs(raw: unknown): WaitForDelay {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    return { delayMs: RATE_LIMIT_MIN_DELAY_MS, clamped: 'invalid' };
  }
  if (raw < RATE_LIMIT_MIN_DELAY_MS) {
    return { delayMs: RATE_LIMIT_MIN_DELAY_MS, clamped: 'min' };
  }
  if (raw > RATE_LIMIT_MAX_DELAY_MS) {
    return { delayMs: RATE_LIMIT_MAX_DELAY_MS, clamped: 'max' };
  }
  return { delayMs: raw, clamped: 'none' };
}

export interface BackoffConfig {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Экспоненциальная пауза перед попыткой `attempt` (1 = первый повтор).
 * Джиттера нет сознательно: клиент в процессе один, стада, которое надо разводить, не существует,
 * а детерминированная задержка проверяема тестом.
 */
export function exponentialDelayMs(attempt: number, config: BackoffConfig = {}): number {
  const base = config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const max = config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  return Math.min(base * 2 ** Math.max(0, attempt - 1), max);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Общий на соединение «не раньше чем» - так соблюдается `wait_for` от `push`.
 *
 * Зачем отдельный механизм, а не просто повтор с паузой: push не ретраится (отправка
 * необратима), поэтому уважить просьбу сервера подождать можно единственным честным способом -
 * притормозив СЛЕДУЮЩИЕ запросы. Иначе `wait_for` был бы полем, которое мы разбираем и
 * выбрасываем.
 */
export class RateLimitGate {
  private notBefore = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly sleepImpl: (ms: number) => Promise<void> = sleep,
  ) {}

  /** Отодвигает окно; более ранняя просьба не отменяет более позднюю */
  note(delayMs: number): void {
    this.notBefore = Math.max(this.notBefore, this.now() + delayMs);
  }

  remainingMs(): number {
    return Math.max(0, this.notBefore - this.now());
  }

  async wait(logger?: Logger): Promise<void> {
    const remaining = this.remainingMs();
    if (remaining <= 0) {
      return;
    }
    logger?.debug('ws: ожидание окна rate-limit', { remainingMs: remaining });
    await this.sleepImpl(remaining);
  }
}
