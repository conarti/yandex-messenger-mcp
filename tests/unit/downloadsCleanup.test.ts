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

  it('файл ровно на границе TTL остаётся: удаляем строго старше', async () => {
    const edge = putFile('edge.bin', 0);
    /* now сдвинут ровно на TTL: mtime == deadline */
    const result = await sweepDownloads({ downloadsDir, ttlDays: 7, now: Date.now() + 7 * DAY_MS });

    expect(existsSync(edge)).toBe(true);
    expect(result.removed).toBe(0);
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
