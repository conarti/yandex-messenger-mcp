import { describe, expect, it } from 'vitest';
import {
  includeDownTo,
  includeUpTo,
  isoToMicros,
  microsToIso,
  parseMicros,
  toWireTimestamp,
} from '../../src/util/timestamps.js';

/** Живая 16-значная метка из реального профиля по форме (значение синтетическое) */
const LIVE_SHAPED = '1784117592261029';

describe('parseMicros', () => {
  it('принимает строку, number и bigint одинаково', () => {
    expect(parseMicros(LIVE_SHAPED)).toBe(1784117592261029n);
    expect(parseMicros(1784117592261029)).toBe(1784117592261029n);
    expect(parseMicros(1784117592261029n)).toBe(1784117592261029n);
  });

  it('отвергает number вне безопасного диапазона, а не молча теряет разряд', () => {
    /* 2^53 + 2: до parseMicros такое значение уже прошло через float и разряду верить нельзя */
    expect(() => parseMicros(9007199254740994)).toThrow(RangeError);
  });

  it('отвергает дробное, отрицательное и не-цифровую строку', () => {
    expect(() => parseMicros(1.5)).toThrow(TypeError);
    expect(() => parseMicros(-1n)).toThrow(RangeError);
    expect(() => parseMicros('12a4')).toThrow(TypeError);
  });
});

describe('арифметика курсоров на 16-значных мкс', () => {
  /*
   * Тот самый разряд, ради которого весь BigInt: на float `n+1` для 16-значной метки
   * ещё проходит, но запас до 2^53 конечен, и правка младшего разряда обязана быть точной.
   */
  it('includeUpTo/includeDownTo меняют РОВНО последний разряд', () => {
    const micros = parseMicros(LIVE_SHAPED);

    expect(includeUpTo(micros).toString()).toBe('1784117592261030');
    expect(includeDownTo(micros).toString()).toBe('1784117592261028');
  });

  it('точность держится там, где float её уже теряет', () => {
    /* 2^53+1 в double неотличим от 2^53: классическая точка потери разряда */
    const beyondFloat = 9007199254740993n;

    expect(includeUpTo(beyondFloat).toString()).toBe('9007199254740994');
    expect(Number(beyondFloat) + 1).not.toBe(9007199254740994);
  });

  it('includeDownTo не уходит в минус на нуле', () => {
    expect(includeDownTo(0n)).toBe(0n);
  });

  it('round-trip строка -> bigint -> строка не теряет разрядов', () => {
    for (const raw of ['1784117592261029', '1000000000000000', '9007199254740991']) {
      expect(parseMicros(raw).toString()).toBe(raw);
    }
  });
});

describe('microsToIso / isoToMicros', () => {
  it('мкс -> ISO с точностью до миллисекунд', () => {
    /* Хвост 029 мкс отбрасывается: в ISO миллисекунды - предел разрешения */
    expect(microsToIso(1784117592261029n)).toBe('2026-07-15T12:13:12.261Z');
  });

  it('ISO -> мкс даёт ровно 16 цифр и три нуля в хвосте', () => {
    const micros = isoToMicros('2026-07-15T12:13:12.261Z');

    expect(micros).toBe(1784117592261000n);
    expect(micros.toString()).toHaveLength(16);
  });

  it('отвергает неразбираемый ISO', () => {
    expect(() => isoToMicros('вчера')).toThrow(TypeError);
  });
});

describe('toWireTimestamp', () => {
  it('живая метка укладывается в number без потери', () => {
    expect(toWireTimestamp(1784117592261029n)).toBe(1784117592261029);
  });

  it('падает за 2^53 вместо молчаливой потери точности', () => {
    expect(() => toWireTimestamp(9007199254740993n)).toThrow(RangeError);
  });
});
