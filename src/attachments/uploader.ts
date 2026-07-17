/**
 * Загрузка файла способом Disk (§12.1) - 3 шага ПЕРЕД обычным сообщением с `file_info.id`.
 *
 *  1) `upload_to_disk {files:[{name, upload_id(uuid), size, chat_id}]}` -> `{files:[{upload_url}]}`;
 *  2) HTTP PUT сырых байт на `upload_url` -> заголовок ответа `Location`;
 *  3) `add_files {chat_id, files:[{location}]}` -> `{files:[{id}]}` = `file_id`.
 * Дальше `file_id` кладётся в `FileInfo.Id2` обычного сообщения (см. push.ts) - отдельного
 * «send file» в протоколе нет.
 *
 * ⚠️ ФОРМА ИСХОДЯЩЕГО ПУТИ ДОКО-ВЫВЕДЕНА (US-009). Входящие вложения живьём наблюдались,
 * а вот отправка - нет: имена RPC, ключ `Location` и извлечение `file_id` взяты из реверса
 * веб-клиента. Живой прогон в self-чате подтверждает или правит их точечно.
 *
 * ОШИБКИ ШАГА 1 РАЗДЕЛЯЮТСЯ (§12.1), а не сваливаются в «upload failed»: 507/403 - квота
 * (места нет / отказано), 413 - размер (файл больше кэпа). Раздельный маппинг нужен, чтобы
 * вызывающий понимал, чинить квоту или уменьшать файл. Тот же маппинг применяется на PUT:
 * квота/размер могут вскрыться и там.
 *
 * СЕТЬ - НЕ ЧЕРЕЗ RegistryHttpClient. Тот прячет HTTP-статус (кроме 401), а здесь именно
 * статус несёт смысл (507/403/413). Поэтому uploader сам делает cookie-авторизованный fetch
 * с одним рефрешем на 401 - как это делает downloader.
 */
import { randomUUID } from 'node:crypto';
import type { AuthContext, AuthProvider } from '../auth/AuthProvider.js';
import { asObject, stringOr } from '../util/json.js';
import type { Logger } from '../util/logger.js';

/** Разряд ошибки загрузки: квота, размер, либо общий отказ */
export type UploadErrorKind = 'quota' | 'size' | 'upload_failed';

/** Ошибка загрузки. `kind` - машинно-читаемый разряд, `httpStatus` - код, если он был */
export class UploadError extends Error {
  constructor(
    readonly kind: UploadErrorKind,
    readonly httpStatus: number | undefined,
    detail: string,
  ) {
    super(`upload ${kind}${httpStatus !== undefined ? ` (HTTP ${httpStatus})` : ''}: ${detail}`);
    this.name = 'UploadError';
  }
}

/** 507/403 - квота, 413 - размер, всё прочее - общий отказ (§12.1) */
function classifyHttpError(status: number): UploadErrorKind {
  if (status === 507 || status === 403) {
    return 'quota';
  }
  if (status === 413) {
    return 'size';
  }
  return 'upload_failed';
}

export interface UploaderDeps {
  /** registry endpoint (`config.protocol.apiUrl`) для `upload_to_disk`/`add_files` */
  apiUrl: string;
  auth: Pick<AuthProvider, 'getAuthContext' | 'onAuthFailure'>;
  logger?: Logger | undefined;
  /** Подменяется в тестах; по умолчанию глобальный fetch */
  fetchImpl?: typeof fetch | undefined;
}

export interface UploadFileInput {
  chatId: string;
  /** Имя файла (уйдёт в `FileInfo.Name`) */
  name: string;
  /** Размер в байтах (`FileInfo.Size` и `upload_to_disk.size`) */
  size: number;
  /** Сырые байты для PUT */
  bytes: Uint8Array;
  /** MIME для заголовка PUT; без него - `application/octet-stream` */
  contentType?: string | undefined;
}

export interface UploadedFile {
  /** `file_id` из `add_files` - его кладут в `file_info.id` обычного сообщения */
  fileId: string;
}

/**
 * Проводит файл через 3 шага Disk-загрузки и возвращает `file_id`. Байты уходят на проводе
 * только здесь: draft отправки (см. sendFile.ts) сюда не заходит.
 */
export async function uploadFileToDisk(deps: UploaderDeps, input: UploadFileInput): Promise<UploadedFile> {
  const uploadUrl = await requestUploadUrl(deps, input);
  const location = await putBytes(deps, uploadUrl, input);
  const fileId = await registerFile(deps, input.chatId, location);
  deps.logger?.debug('файл загружен способом Disk (3 шага)');
  return { fileId };
}

/** Шаг 1: `upload_to_disk` -> `upload_url`. Ошибки квоты/размера маппятся раздельно */
async function requestUploadUrl(deps: UploaderDeps, input: UploadFileInput): Promise<string> {
  const response = await registryPost(deps, 'upload_to_disk', {
    files: [{ name: input.name, upload_id: randomUUID(), size: input.size, chat_id: input.chatId }],
  });
  if (!response.ok) {
    throw new UploadError(classifyHttpError(response.status), response.status, 'upload_to_disk отклонён');
  }
  const data = await parseRegistryData('upload_to_disk', response);
  const uploadUrl = stringOr(firstFile(data)?.['upload_url']);
  if (uploadUrl === undefined) {
    throw new UploadError('upload_failed', undefined, 'upload_to_disk без upload_url в ответе');
  }
  return uploadUrl;
}

/** Шаг 2: PUT сырых байт на `upload_url` -> заголовок `Location` (адрес файла в хранилище) */
async function putBytes(deps: UploaderDeps, uploadUrl: string, input: UploadFileInput): Promise<string> {
  const response = await authedFetch(deps, (context, doFetch) =>
    doFetch(uploadUrl, {
      method: 'PUT',
      body: input.bytes,
      headers: {
        Cookie: context.cookieHeader,
        'Content-Type': input.contentType ?? 'application/octet-stream',
      },
    }),
  );
  if (!response.ok) {
    throw new UploadError(classifyHttpError(response.status), response.status, 'PUT сырых байт отклонён');
  }
  /* Headers.get регистронезависим (Fetch spec): 'Location' покрывает и 'location' */
  const location = response.headers.get('Location');
  if (location === null || location.length === 0) {
    throw new UploadError('upload_failed', undefined, 'PUT не вернул заголовок Location');
  }
  return location;
}

/** Шаг 3: `add_files` по `location` -> `file_id` */
async function registerFile(deps: UploaderDeps, chatId: string, location: string): Promise<string> {
  const response = await registryPost(deps, 'add_files', { chat_id: chatId, files: [{ location }] });
  if (!response.ok) {
    throw new UploadError(classifyHttpError(response.status), response.status, 'add_files отклонён');
  }
  const data = await parseRegistryData('add_files', response);
  const fileId = stringOr(firstFile(data)?.['id']);
  if (fileId === undefined) {
    throw new UploadError('upload_failed', undefined, 'add_files без file_id в ответе');
  }
  return fileId;
}

/** `data.files[0]` как объект, либо undefined - формы ответа доко-выведены, разбор мягкий */
function firstFile(data: unknown): Record<string, unknown> | undefined {
  const files = asObject(data)?.['files'];
  const first = Array.isArray(files) ? files[0] : undefined;
  return asObject(first);
}

/** registry-POST (multipart form с полем `request`), как RegistryHttpClient, но статус виден */
function registryPost(deps: UploaderDeps, method: string, params: Record<string, unknown>): Promise<Response> {
  return authedFetch(deps, (context, doFetch) => {
    const form = new FormData();
    form.append('request', JSON.stringify({ method, params }));
    return doFetch(deps.apiUrl, {
      method: 'POST',
      body: form,
      headers: {
        Cookie: context.cookieHeader,
        Accept: 'application/json',
        Referer: 'https://yandex.ru/chat',
      },
    });
  });
}

/** Распаковка `{status, data}`. Не `ok` = общий отказ: содержательный код тут не наблюдался */
async function parseRegistryData(method: string, response: Response): Promise<unknown> {
  const envelope = asObject(await response.json());
  if (envelope?.['status'] !== 'ok') {
    throw new UploadError('upload_failed', undefined, `registry ${method} вернул не ok`);
  }
  return envelope['data'];
}

/**
 * Cookie-авторизованный fetch с одним рефрешем на 401 - как downloader/RegistryHttpClient:
 * протухшая сессия не должна маскироваться под ошибку загрузки.
 */
async function authedFetch(
  deps: UploaderDeps,
  request: (context: AuthContext, doFetch: typeof fetch) => Promise<Response>,
): Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch;
  const once = async (): Promise<Response> => request(await deps.auth.getAuthContext(), doFetch);

  const first = await once();
  if (first.status !== 401) {
    return first;
  }
  deps.logger?.warn('uploader: cookie отвергнута, рефреш и повтор');
  await deps.auth.onAuthFailure();
  return once();
}
