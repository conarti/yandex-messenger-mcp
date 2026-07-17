/**
 * Микросекундные метки Мессенджера (§5: 16 цифр) и арифметика курсоров.
 *
 * ПОЧЕМУ BigInt: границы диапазона строятся арифметикой `MaxTimestamp = n+1`,
 * `MinTimestamp = i-1` (§14.2). На float такая правка последнего разряда 16-значного
 * числа не имеет права на существование: как только значение перевалит 2^53, `n+1`
 * молча даст `n`, и страница либо продублирует, либо потеряет сообщение. Поэтому
 * внутри всё считается BigInt, а наружу метка отдаётся строкой.
 *
 * ГРАНИЦА С ПРОВОДОМ: тело кадра - обычный JSON (§2.2), а `JSON.stringify` не умеет
 * BigInt. Значит в params метка обязана стать number. Сегодня это безопасно (живые
 * метки ~1.78e15 < 2^53 ≈ 9.007e15), но запас конечен - `toWireTimestamp` проверяет
 * его явно и падает, вместо того чтобы потерять точность молча.
 */

const MICROS_PER_MILLI = 1000n;

/** Метка укладывается в 16 цифр (§5); шире - симптом того, что пришло не то поле */
const MAX_REASONABLE_MICROS = 10n ** 17n;

/** Принимает метку в любом виде, в котором её отдаёт провод или MCP-клиент */
export function parseMicros(value: unknown): bigint {
  if (typeof value === 'bigint') {
    return assertMicros(value);
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new TypeError(`timestamp: ожидалось целое в мкс, получено ${value}`);
    }
    if (!Number.isSafeInteger(value)) {
      /* Значение уже прошло через float и могло потерять младшие разряды */
      throw new RangeError(`timestamp: ${value} вне безопасного диапазона number, точность не гарантируется`);
    }
    return assertMicros(BigInt(value));
  }
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) {
      throw new TypeError(`timestamp: строка должна быть десятичными цифрами, получено "${value}"`);
    }
    return assertMicros(BigInt(value));
  }
  throw new TypeError(`timestamp: неподдерживаемый тип ${typeof value}`);
}

function assertMicros(value: bigint): bigint {
  if (value < 0n) {
    throw new RangeError(`timestamp: отрицательная метка ${value}`);
  }
  if (value >= MAX_REASONABLE_MICROS) {
    throw new RangeError(`timestamp: метка ${value} шире 17 цифр - это не микросекунды`);
  }
  return value;
}

/** Метка -> ISO-8601. Точность ISO - миллисекунды, поэтому сырые мкс отдаются рядом */
export function microsToIso(value: unknown): string {
  const micros = parseMicros(value);
  const millis = micros / MICROS_PER_MILLI;
  return new Date(Number(millis)).toISOString();
}

/** ISO-8601 -> мкс. Обратная операция для фильтров по времени */
export function isoToMicros(iso: string): bigint {
  const millis = Date.parse(iso);
  if (Number.isNaN(millis)) {
    throw new TypeError(`timestamp: не разобран ISO-8601 "${iso}"`);
  }
  return BigInt(millis) * MICROS_PER_MILLI;
}

/**
 * Готовит метку к укладке в JSON-тело кадра.
 * Падает на выходе за 2^53 - молчаливая потеря разряда тут дороже отказа.
 */
export function toWireTimestamp(micros: bigint): number {
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `timestamp: ${micros} больше 2^53 - JSON-тело кадра не может нести такую метку без потери точности`,
    );
  }
  return Number(micros);
}

/**
 * Верхняя граница `MaxTimestamp` ИСКЛЮЧАЮЩАЯ (проверено живьём 2026-07-17:
 * `MaxTimestamp = newest+1` возвращает сообщение с меткой newest, `MaxTimestamp = newest`
 * возвращает уже предыдущее). Совпадает с §14.2, где `requestMessage` берёт сообщение
 * с меткой n через `MaxTimestamp: n+1`.
 */
export function includeUpTo(micros: bigint): bigint {
  return micros + 1n;
}

/** Нижняя граница `MinTimestamp` тоже исключающая: чтобы захватить метку i, передаётся i-1 (§14.2) */
export function includeDownTo(micros: bigint): bigint {
  return micros === 0n ? 0n : micros - 1n;
}
