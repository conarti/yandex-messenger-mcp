/**
 * TTL-подметание папки загрузок.
 *
 * ЗАЧЕМ. Скачанное вложение - это копия чужой переписки на диске. Она не должна жить вечно
 * просто потому, что агент один раз её открыл. TTL (дефолт 7 дней, `downloads.ttlDays`)
 * ограничивает срок этой копии, и подметание идёт БЕЗ участия пользователя: на старте
 * сервера и перед каждым скачиванием. Второй момент важнее первого - долгоживущий сервер
 * может не рестартовать неделями, и старт как единственная точка sweep'а не сработал бы.
 *
 * ГРАНИЦА. Удаляется только то, что лежит НЕПОСРЕДСТВЕННО в downloads-каталоге и является
 * обычным файлом. Никакой рекурсии, никакого следования за симлинками: симлинк в этой папке
 * указывал бы наружу, а sweep не имеет права трогать ничего за её пределами.
 */
import { lstat, readdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Logger } from '../util/logger.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface SweepOptions {
  /** Абсолютный путь downloads-каталога (`config.paths.downloadsDir`) */
  downloadsDir: string;
  /** `downloads.ttlDays`. <= 0 отключает подметание (а НЕ удаляет всё разом) */
  ttlDays: number;
  /** Точка отсчёта, мс. Подменяется в тестах */
  now?: number;
  logger?: Logger | undefined;
}

export interface SweepResult {
  removed: number;
  kept: number;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Удаляет из downloads файлы старше TTL. Отсутствие каталога - штатный случай (ещё ничего
 * не качали), а не ошибка. Ошибка удаления одного файла не роняет проход: подметание -
 * гигиена, а не транзакция, и из-за одного залоченного файла остальные протухшие копии
 * оставаться на диске не должны.
 */
export async function sweepDownloads(options: SweepOptions): Promise<SweepResult> {
  const { downloadsDir, ttlDays, logger } = options;
  const now = options.now ?? Date.now();

  /* Отрицательный/нулевой TTL - это «выключено». Иначе конфиг с опечаткой стёр бы всю папку */
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
    logger?.debug('downloads sweep пропущен: ttlDays отключает подметание', { ttlDays });
    return { removed: 0, kept: 0 };
  }

  const dir = resolve(downloadsDir);
  const deadline = now - ttlDays * MS_PER_DAY;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isNotFound(error)) {
      return { removed: 0, kept: 0 };
    }
    throw error;
  }

  let removed = 0;
  let kept = 0;

  for (const entry of entries) {
    const path = join(dir, entry);

    /* Страховка от имени, уводящего за пределы папки: за границу sweep не выходит */
    if (dirname(path) !== dir) {
      continue;
    }

    try {
      const stats = await lstat(path);
      /* Только обычные файлы: подкаталоги и симлинки не наши, за ними может быть что угодно */
      if (!stats.isFile()) {
        continue;
      }
      if (stats.mtimeMs >= deadline) {
        kept += 1;
        continue;
      }
      await unlink(path);
      removed += 1;
    } catch (error) {
      if (isNotFound(error)) {
        continue;
      }
      /*
       * В лог идёт только errno. Ни имя файла, ни message самой ошибки: и то, и другое
       * несёт путь, а имя вложения - часть чужой переписки.
       */
      logger?.warn('downloads sweep: файл не удалён', {
        code: (error as NodeJS.ErrnoException).code ?? 'unknown',
      });
    }
  }

  logger?.debug('downloads sweep завершён', { removed, kept, ttlDays });
  return { removed, kept };
}
