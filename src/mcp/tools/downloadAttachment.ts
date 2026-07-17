/**
 * `download_attachment` - единственный инструмент, который кладёт что-то на диск.
 *
 * Скачивание НАМЕРЕННО отделено от чтения: read-инструменты отдают только рефы вложений
 * (§11.1), и материализация чужого файла на диск остаётся явным действием, а не побочным
 * эффектом просмотра истории.
 *
 * `chat_id` здесь НЕ участвует в построении URL: живой шаблон file_shortterm принимает
 * ровно `{fileId}` и ничего больше (снят из app-config 2026-07-17; таблица параметров
 * §12.2 с `{chatId, fileId, filename}` этому шаблону противоречит и не подтверждается).
 * Поле принимается как контекст вызывающего и в запрос не идёт - выдумывать ему смысл,
 * которого нет на проводе, нельзя.
 */
import { downloadAttachment as fetchAttachment } from '../../attachments/downloader.js';
import type { AttachmentSize } from '../../attachments/downloadUrl.js';
import type { ToolDeps } from './deps.js';

/** `| undefined` в полях - осознанно: под exactOptionalPropertyTypes zod отдаёт именно такой тип */
export interface DownloadAttachmentInput {
  file_id: string;
  chat_id?: string | undefined;
  size?: AttachmentSize | undefined;
}

export interface DownloadAttachmentResult {
  status: 'ok';
  /** Абсолютный путь: потребитель читает файл по нему */
  path: string;
  bytes: number;
  content_type?: string;
}

export async function downloadAttachment(
  deps: ToolDeps,
  input: DownloadAttachmentInput,
): Promise<DownloadAttachmentResult> {
  const downloaded = await fetchAttachment(
    { auth: deps.auth, config: deps.config, logger: deps.logger },
    { fileId: input.file_id, size: input.size },
  );

  return {
    status: 'ok',
    path: downloaded.path,
    bytes: downloaded.bytes,
    ...(downloaded.contentType !== undefined ? { content_type: downloaded.contentType } : {}),
  };
}
