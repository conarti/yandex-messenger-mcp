/**
 * Скачивание вложения в папку загрузок (§12.2).
 *
 * ЕДИНЫЙ ПУТЬ ДЛЯ КАРТИНОК И ПРОИЗВОЛЬНЫХ ФАЙЛОВ: и то, и другое - просто байты на диске,
 * потребитель читает их по пути. Отдельной ветки «картинка» здесь нет и быть не должно:
 * единственная разница - `?size=` в URL, и она живёт в buildAttachmentUrl.
 *
 * АВТОРИЗАЦИЯ - ТА ЖЕ СЕССИЯ, что у API: file_shortterm пускает по той же cookie (§12.2, §4).
 *
 * ЖИВЫЕ ФАКТЫ (2026-07-17), каждый противоречит наивному прочтению доки:
 *  1) `FileInfo.Id2` СОДЕРЖИТ '/': форма `<bucket>/<uuid>` (41 символ). Прогнать его целиком
 *     через encodeURIComponent - получить %2F и ГАРАНТИРОВАННЫЙ 404 (проверено). Поэтому
 *     экранирование посегментное - см. buildAttachmentUrl.
 *  2) file_shortterm отвечает 302 на хранилище, а не телом. Скачивание обязано идти за
 *     редиректом (дефолт fetch), иначе на руках останется пустой ответ.
 *  3) Content-Disposition приходит всегда и несёт RFC5987 `filename*=UTF-8''`, но его имя
 *     НЕ всегда равно `FileInfo.Name` (на живом файле имена разошлись). Авторитетное имя -
 *     `FileInfo.Name` из рефа; C-D берётся только когда рефа на руках нет.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { AuthError, type AuthProvider } from '../auth/AuthProvider.js';
import type { Config } from '../config/types.js';
import type { Logger } from '../util/logger.js';
import { sweepDownloads } from './cleanup.js';
import { buildAttachmentUrl, type AttachmentSize } from './downloadUrl.js';

/** Потолок длины имени: у ext4/APFS лимит 255 байт, оставляем запас под суффикс коллизии */
const MAX_NAME_LENGTH = 120;
/** Сколько суффиксов перебираем, прежде чем признать, что имя не подобрать */
const MAX_COLLISION_ATTEMPTS = 1000;

export interface DownloaderDeps {
  auth: AuthProvider;
  config: Config;
  logger?: Logger | undefined;
  /** Подменяется в тестах; по умолчанию глобальный fetch */
  fetchImpl?: typeof fetch | undefined;
}

export interface DownloadOptions {
  /** `FileInfo.Id2` */
  fileId: string;
  /** `FileInfo.Name` - авторитетное имя. Нет рефа -> имя возьмётся из Content-Disposition */
  fileName?: string | undefined;
  /** Задан -> тянем превью картинки нужного размера вместо оригинала */
  size?: AttachmentSize | undefined;
}

export interface DownloadedAttachment {
  /** Абсолютный путь скачанного файла */
  path: string;
  bytes: number;
  contentType?: string;
}

/**
 * Приводит имя к безопасному для файловой системы виду.
 *
 * ЗАДАЧА - НЕ КРАСОТА, А ГРАНИЦА: имя приходит с чужой стороны (из переписки либо из
 * заголовка сервера) и не имеет права выйти за пределы downloads. Поэтому разделители
 * пути схлопываются, а ведущие точки срезаются - иначе `..` осталось бы валидным именем,
 * а `.bashrc` - скрытым файлом. Пустой результат = имени нет, берём запасное от fileId.
 */
export function sanitizeFileName(rawName: string | undefined, fileId: string): string {
  const cleaned = (rawName ?? '')
    .normalize('NFC')
    /* Управляющие символы: мусор в имени и потенциальная инъекция в лог/терминал */
    .replace(/[\u0000-\u001f\u007f]/g, '')
    /* Оба разделителя, включая windows-обратный: traversal перестаёт существовать как класс */
    .replace(/[/\\]/g, '_')
    /* Ведущие точки: убивают '.', '..' и скрытые файлы разом */
    .replace(/^\.+/, '')
    .trim();

  if (cleaned.length > 0) {
    return limitLength(cleaned);
  }

  /* Запасное имя от fileId: у него форма <bucket>/<uuid>, берём хвост */
  const tail = fileId.split('/').pop() ?? '';
  const safeTail = tail.replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '');
  return `attachment-${safeTail.length > 0 ? limitLength(safeTail) : 'file'}`;
}

function limitLength(name: string): string {
  if (name.length <= MAX_NAME_LENGTH) {
    return name;
  }
  /* Расширение сохраняем: по нему потребитель понимает, что за файл */
  const ext = extname(name).slice(0, 16);
  return `${name.slice(0, MAX_NAME_LENGTH - ext.length)}${ext}`;
}

/**
 * Имя из Content-Disposition. Живьём сервер шлёт RFC5987-форму (`filename*=UTF-8''`),
 * поэтому она и разбирается первой; голый `filename=` оставлен как запасной вариант.
 */
export function parseContentDisposition(header: string | null): string | undefined {
  if (header === null) {
    return undefined;
  }

  const extended = /filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (extended?.[1] !== undefined) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      /* Битый percent-encoding - не повод падать: просто нет имени */
      return undefined;
    }
  }

  const plain = /filename="([^"]+)"|filename=([^;]+)/.exec(header);
  const value = plain?.[1] ?? plain?.[2];
  return value?.trim();
}

/**
 * Пишет файл, не затирая существующий: одинаковые имена у разных вложений - норма
 * (photo.jpg у всех), и молча перезаписать чужой файл нельзя. Флаг 'wx' делает
 * проверку и создание одной атомарной операцией, без гонки между exists и write.
 */
async function writeWithoutOverwrite(dir: string, name: string, data: Uint8Array): Promise<string> {
  const ext = extname(name);
  const stem = basename(name, ext);

  for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? name : `${stem}-${attempt}${ext}`;
    const path = join(dir, candidate);

    /*
     * Последний рубеж: после санитизации имя не может увести за пределы dir, но проверка
     * стоит здесь, а не в вере в санитизацию - traversal обязан быть невозможен локально.
     */
    if (dirname(path) !== dir) {
      throw new Error('имя вложения выводит за пределы папки загрузок');
    }

    try {
      await writeFile(path, data, { flag: 'wx' });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }

  throw new Error(`не удалось подобрать свободное имя для вложения после ${MAX_COLLISION_ATTEMPTS} попыток`);
}

/**
 * Качает вложение и возвращает путь на диске.
 *
 * TTL-подметание идёт ПЕРЕД каждым скачиванием, а не только на старте: сервер может жить
 * неделями без рестарта, и старт как единственная точка sweep'а копил бы чужие файлы вечно.
 */
export async function downloadAttachment(
  deps: DownloaderDeps,
  options: DownloadOptions,
): Promise<DownloadedAttachment> {
  const { auth, config, logger } = deps;
  const doFetch = deps.fetchImpl ?? fetch;
  const downloadsDir = resolve(config.paths.downloadsDir);

  await sweepDownloads({
    downloadsDir,
    ttlDays: config.downloads.ttlDays,
    logger,
  });

  const url = buildAttachmentUrl({
    filePrivateHost: config.protocol.filePrivateHost,
    fileId: options.fileId,
    size: options.size,
  });

  const response = await fetchWithAuthRetry(doFetch, url, auth, logger);

  if (!response.ok) {
    /*
     * Ошибку не приукрашиваем и не глотаем: пустой файл на диске хуже внятного отказа.
     * Маппинг в MCP-код - Phase 7, здесь обычный Error.
     */
    throw new Error(
      `не удалось скачать вложение: HTTP ${response.status} ${response.statusText}`.trim(),
    );
  }

  const data = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') ?? undefined;

  /* Имя из рефа приоритетнее: C-D живьём расходится с FileInfo.Name (см. шапку) */
  const name = sanitizeFileName(
    options.fileName ?? parseContentDisposition(response.headers.get('content-disposition')),
    options.fileId,
  );

  await mkdir(downloadsDir, { recursive: true });
  const path = await writeWithoutOverwrite(downloadsDir, name, data);

  /* Ни имени файла, ни fileId в логе: и то, и другое - часть чужой переписки */
  logger?.debug('вложение скачано', { bytes: data.byteLength, contentType });

  return { path, bytes: data.byteLength, ...(contentType !== undefined ? { contentType } : {}) };
}

/**
 * Один повтор на отвергнутой cookie - тем же приёмом, что и RegistryHttpClient:
 * протухшая сессия не должна выглядеть как «файла нет».
 */
async function fetchWithAuthRetry(
  doFetch: typeof fetch,
  url: string,
  auth: AuthProvider,
  logger: Logger | undefined,
): Promise<Response> {
  const request = async (): Promise<Response> => {
    const context = await auth.getAuthContext();
    return doFetch(url, {
      headers: { Cookie: context.cookieHeader, Referer: 'https://yandex.ru/chat' },
    });
  };

  const response = await request();
  if (response.status !== 401) {
    return response;
  }

  logger?.warn('file_shortterm: cookie отвергнута, рефреш и повтор');
  await auth.onAuthFailure();
  const retried = await request();

  if (retried.status === 401) {
    throw new AuthError('file_shortterm отверг cookie (HTTP 401) даже после рефреша', 'cookie');
  }
  return retried;
}
