import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepDownloads } from '../../src/attachments/cleanup.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let workDir: string;
let downloadsDir: string;

/** Кладёт файл с искусственно состаренным mtime */
function putFile(name: string, ageDays: number): string {
  const path = join(downloadsDir, name);
  writeFileSync(path, 'x');
  const seconds = (Date.now() - ageDays * DAY_MS) / 1000;
  utimesSync(path, seconds, seconds);
  return path;
}

/**
 * Кладёт файл с ТОЧНЫМ mtime. Нужен там, где проверяется граница TTL.
 *
 * Секунды берутся целыми осознанно: `utimesSync` принимает секунды, и деление
 * произвольной мс-метки на 1000 не отыгрывается обратно точно - mtimeMs выходит
 * вроде `...401.999`, то есть на доли миллисекунды НИЖЕ задуманного. На границе
 * это решает исход, поэтому метка должна быть представима в секундах без остатка.
 */
function putFileAtExactly(name: string, mtimeMs: number): string {
  const path = join(downloadsDir, name);
  writeFileSync(path, 'x');
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  return path;
}

/** Целая секунда: единственная метка, которую utimesSync отдаёт обратно без потерь */
function wholeSecondAnchor(): number {
  return Math.floor(Date.now() / 1000) * 1000;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'ymm-sweep-'));
  downloadsDir = join(workDir, 'downloads');
  mkdirSync(downloadsDir);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('sweepDownloads', () => {
  it('удаляет файл старше TTL и сохраняет свежий', async () => {
    const stale = putFile('stale.bin', 10);
    const fresh = putFile('fresh.bin', 1);

    const result = await sweepDownloads({ downloadsDir, ttlDays: 7 });

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(result).toEqual({ removed: 1, kept: 1 });
  });

  /*
   * Граница строится от ОДНОГО якоря, а не от двух чтений часов. Прежняя версия брала
   * mtime из `Date.now()` в putFile, а `now` - из второго `Date.now()` мгновением позже:
   * deadline оказывался на миллисекунду впереди mtime, файл проходил как «строго старше»
   * и удалялся. Тест зеленел, только когда оба чтения попадали в одну миллисекунду, то
   * есть был гонкой (живьём падал в ~5 прогонах из 8). Здесь mtime == deadline по
   * построению, и проверяется ровно заявленное: ровно на границе - НЕ удаляем.
   */
  it('файл ровно на границе TTL остаётся: удаляем строго старше', async () => {
    const anchor = wholeSecondAnchor();
    const edge = putFileAtExactly('edge.bin', anchor);

    /* now = anchor + TTL => deadline = anchor = mtime файла */
    const result = await sweepDownloads({ downloadsDir, ttlDays: 7, now: anchor + 7 * DAY_MS });

    expect(existsSync(edge)).toBe(true);
    expect(result.removed).toBe(0);
  });

  it('файл на миллисекунду старше границы удаляется: граница именно строгая', async () => {
    const anchor = wholeSecondAnchor();
    const justOver = putFileAtExactly('just-over.bin', anchor - 1);

    const result = await sweepDownloads({ downloadsDir, ttlDays: 7, now: anchor + 7 * DAY_MS });

    expect(existsSync(justOver)).toBe(false);
    expect(result.removed).toBe(1);
  });

  it('ttlDays <= 0 отключает подметание, а не стирает всё', async () => {
    const ancient = putFile('ancient.bin', 900);

    const result = await sweepDownloads({ downloadsDir, ttlDays: 0 });

    expect(existsSync(ancient)).toBe(true);
    expect(result).toEqual({ removed: 0, kept: 0 });
  });

  it('отсутствие папки загрузок - не ошибка', async () => {
    const result = await sweepDownloads({ downloadsDir: join(workDir, 'нет-такой'), ttlDays: 7 });

    expect(result).toEqual({ removed: 0, kept: 0 });
  });

  it('не трогает подкаталоги и их содержимое', async () => {
    const nested = join(downloadsDir, 'sub');
    mkdirSync(nested);
    const inner = join(nested, 'old.bin');
    writeFileSync(inner, 'x');
    const seconds = (Date.now() - 900 * DAY_MS) / 1000;
    utimesSync(inner, seconds, seconds);

    const result = await sweepDownloads({ downloadsDir, ttlDays: 7 });

    expect(existsSync(inner)).toBe(true);
    expect(result.removed).toBe(0);
  });

  it('не идёт по симлинку наружу: цель за пределами downloads остаётся жива', async () => {
    const outside = join(workDir, 'важный-файл-снаружи.bin');
    writeFileSync(outside, 'x');
    const seconds = (Date.now() - 900 * DAY_MS) / 1000;
    utimesSync(outside, seconds, seconds);
    symlinkSync(outside, join(downloadsDir, 'link.bin'));

    await sweepDownloads({ downloadsDir, ttlDays: 7 });

    expect(existsSync(outside)).toBe(true);
  });
});
