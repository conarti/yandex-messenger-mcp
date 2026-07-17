/**
 * Деривация thread_id (§17.10). Векторы портированы из
 * `.omc/spikes/yandex-mcp/v2/threadid-derivation.mjs` как эталон: те же входы и выходы, но
 * radix 10 (авторитетный обратный парсер бандла - тоже radix 10), а бизнес-префикс `2/…` явно
 * недоступен. Синтетические id, сети нет.
 */
import { describe, expect, it } from 'vitest';
import { buildThreadId, parseThreadId, isThreadId } from '../../src/protocol/threadId.js';

/** Метка родителя из векторов спайка (16 цифр) */
const TS = '1784287503814009';
const UUID = '1a2b3c4d-0000-0000-0000-000000000000';
/** Приватный чат из векторов: guid-образные строки (x/y, не hex - regex шире hex) */
const PRIVATE = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx_yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy';

describe('buildThreadId: три случая префикса (§17.10, radix 10)', () => {
  it('группа 0/0/<uuid> -> 100/0/<uuid>_<ts>', () => {
    expect(buildThreadId(`0/0/${UUID}`, TS)).toEqual({ status: 'ok', thread_id: `100/0/${UUID}_${TS}` });
  });

  it('канал 1/0/<uuid> -> 101/0/<uuid>_<ts>', () => {
    expect(buildThreadId(`1/0/${UUID}`, TS)).toEqual({ status: 'ok', thread_id: `101/0/${UUID}_${TS}` });
  });

  it('приватный <guid>_<guid> -> 110/0/<guid>_<guid>_<ts>', () => {
    expect(buildThreadId(PRIVATE, TS)).toEqual({ status: 'ok', thread_id: `110/0/${PRIVATE}_${TS}` });
  });

  it('бизнес 2/<ns>/<uuid> -> unsupported (radix 2 дал бы NaN; radix 10 гасим явно)', () => {
    const result = buildThreadId(`2/1234/${UUID}`, TS);
    expect(result.status).toBe('unsupported');
    if (result.status !== 'unsupported') throw new Error('unreachable');
    expect(result.reason).toMatch(/недоступен/);
  });

  it('нераспознанный ChatId -> unsupported, не роняет вызов', () => {
    expect(buildThreadId('не-чат', TS).status).toBe('unsupported');
  });

  it('метка нормализуется (число/строка/BigInt дают тот же thread_id)', () => {
    const asString = buildThreadId(`0/0/${UUID}`, TS);
    const asNumber = buildThreadId(`0/0/${UUID}`, Number(TS));
    const asBigInt = buildThreadId(`0/0/${UUID}`, BigInt(TS));
    expect(asNumber).toEqual(asString);
    expect(asBigInt).toEqual(asString);
  });

  it('битая метка -> исключение (метка обязана быть валидной)', () => {
    expect(() => buildThreadId(`0/0/${UUID}`, 'not-a-number')).toThrow();
  });
});

describe('parseThreadId: обратный разбор, round-trip J<->j', () => {
  it('группа round-trip: build -> parse даёт исходные chatId и метку', () => {
    const built = buildThreadId(`0/0/${UUID}`, TS);
    if (built.status !== 'ok') throw new Error('ожидался ok');
    expect(parseThreadId(built.thread_id)).toEqual({ chatId: `0/0/${UUID}`, timestamp: TS });
  });

  it('канал round-trip', () => {
    const built = buildThreadId(`1/0/${UUID}`, TS);
    if (built.status !== 'ok') throw new Error('ожидался ok');
    expect(parseThreadId(built.thread_id)).toEqual({ chatId: `1/0/${UUID}`, timestamp: TS });
  });

  it('приватный round-trip: родитель это <guid>_<guid> из середины (i==="10")', () => {
    const built = buildThreadId(PRIVATE, TS);
    if (built.status !== 'ok') throw new Error('ожидался ok');
    expect(parseThreadId(built.thread_id)).toEqual({ chatId: PRIVATE, timestamp: TS });
  });

  it('метка сохраняет полную точность (строкой, не через parseInt)', () => {
    /* 16-значная метка у 2^53 в float потеряла бы разряд; тут обязана дожить как есть */
    const built = buildThreadId(`0/0/${UUID}`, TS);
    if (built.status !== 'ok') throw new Error('ожидался ok');
    expect(parseThreadId(built.thread_id)?.timestamp).toBe(TS);
  });

  it('не thread_id -> undefined', () => {
    expect(parseThreadId(`0/0/${UUID}`)).toBeUndefined();
    expect(parseThreadId(PRIVATE)).toBeUndefined();
    expect(parseThreadId('мусор')).toBeUndefined();
  });
});

describe('isThreadId: распознавание валидного thread_id', () => {
  it('true для деривированного thread_id (группа/канал/приватный)', () => {
    expect(isThreadId(`100/0/${UUID}_${TS}`)).toBe(true);
    expect(isThreadId(`101/0/${UUID}_${TS}`)).toBe(true);
    expect(isThreadId(`110/0/${PRIVATE}_${TS}`)).toBe(true);
  });

  it('false для обычного ChatId и приватного чата', () => {
    expect(isThreadId(`0/0/${UUID}`)).toBe(false);
    expect(isThreadId(PRIVATE)).toBe(false);
  });
});
