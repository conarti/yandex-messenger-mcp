/**
 * Извлечение рефов вложений из тела сообщения (§11.1/§12.4).
 *
 * ТОЛЬКО РЕФЫ. Ничего не качается: скачивание - отдельный инструмент (Phase 6),
 * и оно должно оставаться явным действием пользователя, а не побочным эффектом чтения.
 *
 * На проводе у файла есть лишь `{Id2, Name, Size, Source}` - ни URL, ни бакета (§11.1).
 * `Id2` (mds doc id) и есть то, что Phase 6 превратит в download-URL.
 * ЖИВАЯ ПРОВЕРКА (2026-07-17): по 372 сообщениям реального профиля набор ключей FileInfo
 * ровно {Id2, Name, Size, Source} - лишних полей нет.
 */

/** `Source` enum FileInfo (§11.1) */
const SOURCE_NAMES: Record<number, AttachmentSource> = { 0: 'mds', 1: 'disk' };

export type AttachmentSource = 'mds' | 'disk' | 'unknown';

/** Тип вложения = имя content-поля Plain, из которого его достали (§11.1) */
export type AttachmentKind = 'image' | 'file' | 'voice' | 'gallery_image';

export interface AttachmentRef {
  kind: AttachmentKind;
  /** `FileInfo.Id2` - doc id для download_attachment (Phase 6) */
  file_id: string;
  name?: string;
  size?: number;
  source: AttachmentSource;
  /** Только для image/gallery_image */
  width?: number;
  height?: number;
  animated?: boolean;
  /** Только для voice, секунды */
  duration?: number;
}

interface RawFileInfo {
  Id2?: unknown;
  Name?: unknown;
  Size?: unknown;
  Source?: unknown;
}

function toRef(kind: AttachmentKind, fileInfo: unknown, extra: Partial<AttachmentRef> = {}): AttachmentRef | undefined {
  if (fileInfo === null || typeof fileInfo !== 'object') {
    return undefined;
  }
  const info = fileInfo as RawFileInfo;
  /* Без Id2 реф бесполезен: скачать по нему будет нечего */
  if (typeof info.Id2 !== 'string' || info.Id2.length === 0) {
    return undefined;
  }
  const source = typeof info.Source === 'number' ? (SOURCE_NAMES[info.Source] ?? 'unknown') : 'unknown';
  return {
    kind,
    file_id: info.Id2,
    ...(typeof info.Name === 'string' ? { name: info.Name } : {}),
    ...(typeof info.Size === 'number' ? { size: info.Size } : {}),
    source,
    ...extra,
  };
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function imageExtras(image: Record<string, unknown>): Partial<AttachmentRef> {
  const width = numberOr(image['Width']);
  const height = numberOr(image['Height']);
  return {
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(typeof image['Animated'] === 'boolean' ? { animated: image['Animated'] } : {}),
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/**
 * Достаёт все рефы вложений из тела `Plain`/`Ephemeral`.
 * Content-поле в теле ровно одно (§11.1), но Gallery несёт пачку - отсюда массив.
 */
export function extractAttachmentRefs(body: unknown): AttachmentRef[] {
  const plain = asObject(body);
  if (plain === undefined) {
    return [];
  }
  const refs: AttachmentRef[] = [];

  const image = asObject(plain['Image']);
  if (image !== undefined) {
    const ref = toRef('image', image['FileInfo'], imageExtras(image));
    if (ref !== undefined) {
      refs.push(ref);
    }
  }

  const miscFile = asObject(plain['MiscFile']);
  if (miscFile !== undefined) {
    const ref = toRef('file', miscFile['FileInfo']);
    if (ref !== undefined) {
      refs.push(ref);
    }
  }

  const voice = asObject(plain['Voice']);
  if (voice !== undefined) {
    const duration = numberOr(voice['Duration']);
    const ref = toRef('voice', voice['FileInfo'], duration !== undefined ? { duration } : {});
    if (ref !== undefined) {
      refs.push(ref);
    }
  }

  const gallery = asObject(plain['Gallery']);
  if (gallery !== undefined) {
    const items = Array.isArray(gallery['Items']) ? gallery['Items'] : [];
    for (const item of items) {
      const itemImage = asObject(asObject(item)?.['Image']);
      if (itemImage === undefined) {
        continue;
      }
      const ref = toRef('gallery_image', itemImage['FileInfo'], imageExtras(itemImage));
      if (ref !== undefined) {
        refs.push(ref);
      }
    }
  }

  return refs;
}
