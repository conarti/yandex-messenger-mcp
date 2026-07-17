/**
 * Сборка URL скачивания вложения (§12.2).
 *
 * URL СТРОИТ КЛИЕНТ. На проводе у рефа вложения нет ни url, ни бакета - только
 * `FileInfo.Id2` (§11.1), и это подтверждено живьём: 12 рефов на 372 сообщениях реального
 * профиля, url нет ни у одного. Поэтому download-URL - целиком наша конструкция из
 * `file_shortterm/{fileId}` и хоста, а не что-то, полученное от сервера.
 *
 * ХОСТ БЕРЁТСЯ ИЗ КОНФИГА (`protocol.filePrivateHost`), а не зашит строкой: в chats-web
 * реальные хосты инжектятся в рантайме из app-config и в бандле их нет (§12.2), значит они
 * ротируемы. Захардкодить хост - значит сделать ротацию правкой кода вместо правки config.json.
 *
 * ПРИВАТНЫЙ хост, не публичный: file_shortterm требует той же auth-сессии, что и API (§12.2, §4).
 */

/**
 * `size` enum §12.2. По доке - превью картинок разного размера.
 *
 * ⚠️ ЖИВЬЁМ `?size=` ИГНОРИРУЕТСЯ этим download-путём (US-009, 2026-07-17): на реальной
 * картинке 4080px (заведомо больше кэпа `MIDDLE2048`) запросы `?size=ORIGINAL`,
 * `?size=MIDDLE2048` и `?size=SMALL` вернули байт-в-байт одно и то же (211331 байт). То есть
 * шаблон `file_shortterm` ресайз не делает - сервер отдаёт оригинал независимо от токена
 * размера. Параметр сохранён (он безвреден и входит в публичный интерфейс инструмента), но
 * рассчитывать на уменьшение размера через него нельзя.
 */
export const ATTACHMENT_SIZES = ['SMALL', 'SMALL48', 'MIDDLE2048', 'ORIGINAL'] as const;
export type AttachmentSize = (typeof ATTACHMENT_SIZES)[number];

export interface AttachmentUrlOptions {
  /** `protocol.filePrivateHost` из конфига */
  filePrivateHost: string;
  /** `FileInfo.Id2` рефа вложения */
  fileId: string;
  /**
   * Задан -> превью картинки (`?size=`); не задан -> скачивание файла (`?attach=true`).
   * Для не-картинок size бессмыслен: у сервера нечего ресайзить.
   */
  size?: AttachmentSize | undefined;
}

/**
 * `Id2` живьём имеет форму `<bucket>/<uuid>` (41 символ) - СО СЛЭШЕМ ВНУТРИ.
 * Это и есть причина, по которой id нельзя прогнать через encodeURIComponent целиком:
 * '/' превратится в %2F и сервер ответит 404 (проверено живьём 2026-07-17).
 * Слэш здесь - структура пути, а не символ значения.
 *
 * Но и «просто подставить» его нельзя: id приходит снаружи, и подставленный в path
 * `../..` увёл бы URL на чужой ресурс. Поэтому вместо экранирования - валидация формы:
 * разрешены только сегменты из [A-Za-z0-9._-], и ни один сегмент не может быть '.'/'..'.
 * Всё, что прошло, URL-безопасно по построению и в экранировании не нуждается.
 */
const FILE_ID_SEGMENT = /^[A-Za-z0-9._-]+$/;

function assertSafeFileId(fileId: string): void {
  if (fileId.length === 0) {
    throw new Error('file_id пуст: скачивать нечего');
  }

  const segments = fileId.split('/');
  for (const segment of segments) {
    if (!FILE_ID_SEGMENT.test(segment) || segment === '.' || segment === '..') {
      throw new Error('file_id имеет недопустимую форму: ожидается <bucket>/<uuid>');
    }
  }
}

export function buildAttachmentUrl(options: AttachmentUrlOptions): string {
  const { filePrivateHost, fileId, size } = options;

  assertSafeFileId(fileId);

  const base = `https://${filePrivateHost}/file_shortterm/${fileId}`;

  return size !== undefined ? `${base}?size=${size}` : `${base}?attach=true`;
}
