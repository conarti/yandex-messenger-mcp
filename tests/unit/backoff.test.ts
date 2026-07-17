import { describe, expect, it } from 'vitest';
import {
  exponentialDelayMs,
  RateLimitGate,
  RATE_LIMIT_MAX_DELAY_MS,
  RATE_LIMIT_MIN_DELAY_MS,
  resolveWaitForDelayMs,
} from '../../src/transport/backoff.js';

/*
 * ЕДИНИЦА `rate_limit.wait_for` НЕИЗВЕСТНА (§14.4 её не называет, живьём поле не приходило
 * ни разу). Эти тесты фиксируют не «правильный перевод» - его знать неоткуда - а ГРАНИЦЫ
 * ущерба: при любой из трёх гипотез о единице пауза остаётся в диапазоне [1с, 60с].
 */
describe('resolveWaitForDelayMs: поведение при неизвестной единице', () => {
  it('значения рабочего диапазона проходят как есть (гипотеза «миллисекунды»)', () => {
    expect(resolveWaitForDelayMs(1_500)).toEqual({ delayMs: 1_500, clamped: 'none' });
    expect(resolveWaitForDelayMs(30_000)).toEqual({ delayMs: 30_000, clamped: 'none' });
  });

  /*
   * Если сервер имел в виду СЕКУНДЫ, `wait_for:5` без нижней границы дал бы паузу 5мс -
   * то есть ретрай-шторм в сервер, который только что попросил притормозить.
   */
  it('малые значения поднимаются до 1с: страховка от гипотезы «секунды»', () => {
    expect(resolveWaitForDelayMs(5)).toEqual({ delayMs: RATE_LIMIT_MIN_DELAY_MS, clamped: 'min' });
    expect(resolveWaitForDelayMs(60)).toEqual({ delayMs: RATE_LIMIT_MIN_DELAY_MS, clamped: 'min' });
    expect(resolveWaitForDelayMs(0)).toEqual({ delayMs: RATE_LIMIT_MIN_DELAY_MS, clamped: 'min' });
  });

  /*
   * Если сервер имел в виду МИКРОсекунды, `wait_for:60000000` (= 60с в мкс) без верхней
   * границы дал бы паузу 16.6 часов - клиент выглядел бы зависшим намертво.
   */
  it('большие значения срезаются до 60с: страховка от гипотезы «микросекунды»', () => {
    expect(resolveWaitForDelayMs(60_000_000)).toEqual({ delayMs: RATE_LIMIT_MAX_DELAY_MS, clamped: 'max' });
    expect(resolveWaitForDelayMs(Number.MAX_SAFE_INTEGER)).toEqual({
      delayMs: RATE_LIMIT_MAX_DELAY_MS,
      clamped: 'max',
    });
  });

  it('при любой гипотезе о единице пауза остаётся в [1с, 60с]', () => {
    /* 60с, записанные как секунды / миллисекунды / микросекунды */
    for (const raw of [60, 60_000, 60_000_000]) {
      const { delayMs } = resolveWaitForDelayMs(raw);
      expect(delayMs).toBeGreaterThanOrEqual(RATE_LIMIT_MIN_DELAY_MS);
      expect(delayMs).toBeLessThanOrEqual(RATE_LIMIT_MAX_DELAY_MS);
    }
  });

  /* Сервер о паузе попросил - значит пауза берётся минимальная, а не нулевая */
  it('мусорное значение не игнорируется молча, а даёт минимальную паузу', () => {
    expect(resolveWaitForDelayMs(undefined)).toEqual({ delayMs: RATE_LIMIT_MIN_DELAY_MS, clamped: 'invalid' });
    expect(resolveWaitForDelayMs('быстро')).toEqual({ delayMs: RATE_LIMIT_MIN_DELAY_MS, clamped: 'invalid' });
    expect(resolveWaitForDelayMs(Number.NaN)).toEqual({ delayMs: RATE_LIMIT_MIN_DELAY_MS, clamped: 'invalid' });
    expect(resolveWaitForDelayMs(-1)).toEqual({ delayMs: RATE_LIMIT_MIN_DELAY_MS, clamped: 'invalid' });
  });

  it('сообщает факт зажима: первое живое срабатывание должно быть видно в логах', () => {
    expect(resolveWaitForDelayMs(5).clamped).toBe('min');
    expect(resolveWaitForDelayMs(1_500).clamped).toBe('none');
    expect(resolveWaitForDelayMs(10 ** 9).clamped).toBe('max');
  });
});

describe('exponentialDelayMs', () => {
  it('удваивает паузу и упирается в потолок', () => {
    expect(exponentialDelayMs(1, { baseDelayMs: 500 })).toBe(500);
    expect(exponentialDelayMs(2, { baseDelayMs: 500 })).toBe(1_000);
    expect(exponentialDelayMs(3, { baseDelayMs: 500 })).toBe(2_000);
    expect(exponentialDelayMs(99, { baseDelayMs: 500, maxDelayMs: 8_000 })).toBe(8_000);
  });
});

describe('RateLimitGate', () => {
  function fakeClock() {
    let current = 1_000;
    const slept: number[] = [];
    const gate = new RateLimitGate(
      () => current,
      async (ms) => {
        slept.push(ms);
        current += ms;
      },
    );
    return { gate, slept, advance: (ms: number) => (current += ms) };
  }

  it('без просьбы сервера не ждёт', async () => {
    const { gate, slept } = fakeClock();

    await gate.wait();

    expect(slept).toEqual([]);
  });

  it('выдерживает окно после просьбы подождать', async () => {
    const { gate, slept } = fakeClock();

    gate.note(5_000);
    await gate.wait();

    expect(slept).toEqual([5_000]);
    /* Окно израсходовано: второй запрос уже не ждёт */
    await gate.wait();
    expect(slept).toEqual([5_000]);
  });

  it('ждёт только остаток окна', async () => {
    const { gate, slept, advance } = fakeClock();

    gate.note(5_000);
    advance(2_000);
    await gate.wait();

    expect(slept).toEqual([3_000]);
  });

  /* Более ранняя просьба не должна отменять более позднюю */
  it('окно только отодвигается, но не сокращается', async () => {
    const { gate, slept } = fakeClock();

    gate.note(10_000);
    gate.note(1_000);
    await gate.wait();

    expect(slept).toEqual([10_000]);
  });
});
