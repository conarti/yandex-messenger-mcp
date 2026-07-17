/**
 * `send_file` - отправка картинки или файла, поэтому необратимая и двухшаговая (draft->confirm).
 *
 * ШАГ 1 (по умолчанию): резолв чата -> метаданные файла (имя/размер/тип) БЕЗ чтения байтов ->
 * confirm-токен. В сеть НЕ уходит ничего: ни один из 3 шагов загрузки (§12.1) на draft не
 * выполняется. Превью строится `stat`, а не заливкой.
 * ШАГ 2 (`confirm:true` + токен): ре-верификация чата и файла -> 3-шаговая Disk-загрузка
 * (uploader.ts) -> обычное сообщение с `file_info.id` через send-путь (§12.1).
 *
 * ЭТО SEND-ПУТЬ. Финальный шаг - обычное сообщение с `PayloadId`, поэтому идемпотентность
 * держится ДВУМЯ слоями, как у send_message: локальная память токена + серверный `DUPLICATE(8)`
 * по `PayloadId` (доказанный дедуп send-пути, §14.4). `PayloadId` фиксируется в токене на draft
 * и переживает рестарт. Ответ без числового `Status` = отказ (инвариант push.ts): вложение уже
 * залито, но пока commit не подтверждён, сообщение считать отправленным нельзя.
 *
 * ПЕРЕЗАЛИВКА ПРИ ПОВТОРНОМ CONFIRM. Если процесс рестартовал (локальная память токена
 * потеряна), повторный confirm пройдёт все 3 шага заново - байты уйдут повторно. Дубля
 * СООБЩЕНИЯ при этом нет (`PayloadId` из токена -> `DUPLICATE(8)`), но байты расходуют квоту.
 * Поведение ограничено квота-ошибкой, не блокер (см. README).
 *
 * VOICE/GALLERY В ОТПРАВКУ НЕ ВХОДЯТ (только чтение, §Non-Goals) - тут ровно image и file.
 */
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { resolveChat, type ChatCandidate } from '../../chat/resolveChat.js';
import {
  ConfirmRejectedError,
  encodeToken,
  fingerprint,
  recallResult,
  rememberResult,
  verifyConfirmToken,
  type DraftToken,
} from '../confirm.js';
import {
  buildFileClientMessage,
  buildImageClientMessage,
  buildPushParams,
  createPayloadId,
  parsePushResponse,
  PushNotCommittedError,
  type PushMessageInfo,
} from '../../protocol/push.js';
import { uploadFileToDisk } from '../../attachments/uploader.js';
import type { ToolDeps } from './deps.js';

/** В отправку входят только image и file (voice/gallery - чтение, §Non-Goals) */
export type SendFileKind = 'image' | 'file';

/** Расширения, которые уходят как картинка (`Plain.Image`); всё прочее - `Plain.MiscFile` */
const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
  '.heic',
  '.heif',
  '.tif',
  '.tiff',
]);

/** Минимальный MIME по расширению для заголовка PUT и превью draft; нет в карте - undefined */
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.pdf': 'application/pdf',
};

/** `| undefined` в полях - осознанно: под exactOptionalPropertyTypes zod отдаёт именно такой тип */
export interface SendFileInput {
  chat: string;
  path: string;
  confirm?: boolean | undefined;
  confirm_token?: string | undefined;
}

export interface SendFileOptions {
  /** Инъекция fetch для загрузчика (тесты); в проде - глобальный fetch */
  fetchImpl?: typeof fetch | undefined;
}

/** Что отправляется - показывается в draft, чтобы человек подтверждал файл, а не путь */
export interface SendFilePreview {
  name: string;
  size: number;
  kind: SendFileKind;
  content_type?: string;
}

export interface SendFileDraft {
  status: 'draft';
  chat_id: string;
  /** Имя чата, если резолв его дал: подтверждать по паре guid человек не может */
  chat_name?: string;
  file: SendFilePreview;
  confirm_token: string;
  next_step: string;
}

export interface SendFileSent {
  status: 'sent';
  chat_id: string;
  /** `file_id` вложения: по нему сообщение читается обратно и вложение скачивается */
  file_id: string;
  kind: SendFileKind;
  commit_status: number;
  commit_status_name: string;
  /** true = сервер уже принимал этот PayloadId: нового сообщения НЕ создано */
  duplicate: boolean;
  message_info?: PushMessageInfo;
  rate_limit?: { wait_for: number };
}

export type SendFileResult =
  | SendFileDraft
  | SendFileSent
  | { status: 'ambiguous_chat'; candidates: ChatCandidate[] }
  | { status: 'chat_not_found'; query: string }
  | { status: 'file_not_found'; path: string };

interface FileDescription {
  name: string;
  size: number;
  kind: SendFileKind;
  contentType?: string;
}

/** Метаданные файла БЕЗ чтения байтов (`stat`); не файл или нет файла -> undefined */
async function describeFile(path: string): Promise<FileDescription | undefined> {
  let stats;
  try {
    stats = await stat(path);
  } catch {
    return undefined;
  }
  if (!stats.isFile()) {
    return undefined;
  }
  const name = basename(path);
  const ext = extname(name).toLowerCase();
  const kind: SendFileKind = IMAGE_EXTENSIONS.has(ext) ? 'image' : 'file';
  const contentType = CONTENT_TYPE_BY_EXT[ext];
  return { name, size: stats.size, kind, ...(contentType !== undefined ? { contentType } : {}) };
}

/**
 * Отпечаток send_file-пути: имя + размер + тип. Байтов на draft нет, поэтому отпечаток берётся
 * из того, что даёт `stat`; на confirm файл перечитывается `stat` заново и отпечаток сверяется -
 * подмена файла между draft и confirm отклоняется.
 */
function sendFileFingerprint(description: FileDescription): string {
  return fingerprint('send_file', `${description.name}:${description.size}:${description.kind}`);
}

export async function sendFile(
  deps: ToolDeps,
  input: SendFileInput,
  options: SendFileOptions = {},
): Promise<SendFileResult> {
  const { guid } = await deps.auth.getWhoami();

  const resolved = await resolveChat(input.chat, {
    http: deps.http,
    logger: deps.logger,
    myGuid: guid,
    searchLimit: deps.config.limits.searchDefaultLimit,
  });
  if (resolved.status === 'ambiguous') {
    return { status: 'ambiguous_chat', candidates: resolved.candidates };
  }
  if (resolved.status === 'not_found') {
    return { status: 'chat_not_found', query: input.chat };
  }

  const description = await describeFile(input.path);
  if (description === undefined) {
    return { status: 'file_not_found', path: input.path };
  }

  if (input.confirm !== true) {
    const draft: DraftToken = {
      op: 'send_file',
      chat_id: resolved.chat_id,
      fingerprint: sendFileFingerprint(description),
      payload_id: createPayloadId(),
    };
    deps.logger.info('send_file: подготовлен draft, ничего не залито и не отправлено', {
      via: resolved.via,
      kind: description.kind,
    });
    return {
      status: 'draft',
      chat_id: resolved.chat_id,
      ...(resolved.name !== undefined ? { chat_name: resolved.name } : {}),
      file: {
        name: description.name,
        size: description.size,
        kind: description.kind,
        ...(description.contentType !== undefined ? { content_type: description.contentType } : {}),
      },
      confirm_token: encodeToken(draft),
      next_step:
        'Ничего не залито и не отправлено. Чтобы отправить, повторите вызов с confirm:true, тем же confirm_token ' +
        'и НЕИЗМЕНЁННЫМИ chat и path: изменение любого из них или самого файла отклонит отправку.',
    };
  }

  /* Пустая строка вместо undefined: verifyConfirmToken отвергнет её как token_missing */
  const token = input.confirm_token ?? '';
  const draft = verifyConfirmToken({
    op: 'send_file',
    token,
    chatId: resolved.chat_id,
    fingerprint: sendFileFingerprint(description),
    fingerprintMismatchReason: 'file_mismatch',
  });
  if (draft.payload_id === undefined) {
    /* send_file-токен обязан нести payload_id (ключ серверной дедупликации); его отсутствие = битый токен */
    throw new ConfirmRejectedError('token_malformed', 'send_file-токен без payload_id');
  }

  const remembered = recallResult<SendFileSent>(token);
  if (remembered !== undefined) {
    deps.logger.warn('send_file: повторный confirm тем же токеном, повторной заливки и push нет');
    return remembered;
  }

  /* Байты читаются ТОЛЬКО здесь, после того как токен и файл сверены - draft байтов не касается */
  const bytes = new Uint8Array(await readFile(input.path));
  const { fileId } = await uploadFileToDisk(
    {
      apiUrl: deps.config.protocol.apiUrl,
      auth: deps.auth,
      logger: deps.logger,
      fetchImpl: options.fetchImpl,
    },
    {
      chatId: draft.chat_id,
      name: description.name,
      size: description.size,
      bytes,
      ...(description.contentType !== undefined ? { contentType: description.contentType } : {}),
    },
  );

  const { yandexUid } = await deps.auth.getAuthContext();
  /* Готовность к отправке наступает не на open, а на кадре subscribed (§17.2) */
  const subscriptionId = await deps.ws.waitForSubscriptionId();
  const clientMessage =
    description.kind === 'image'
      ? buildImageClientMessage({ chatId: draft.chat_id, payloadId: draft.payload_id, fileId, name: description.name, size: description.size })
      : buildFileClientMessage({ chatId: draft.chat_id, payloadId: draft.payload_id, fileId, name: description.name, size: description.size });

  const params = buildPushParams({
    clientMessage,
    subscriptionId,
    yandexUid,
    serviceId: deps.config.protocol.serviceId,
  });

  const outcome = parsePushResponse(await deps.ws.request('push', params, { requireSubscriptionId: subscriptionId }));
  if (!outcome.committed) {
    throw new PushNotCommittedError(outcome);
  }

  const result: SendFileSent = {
    status: 'sent',
    chat_id: draft.chat_id,
    file_id: fileId,
    kind: description.kind,
    commit_status: outcome.status,
    commit_status_name: outcome.status_name,
    duplicate: outcome.duplicate,
    ...(outcome.message_info !== undefined ? { message_info: outcome.message_info } : {}),
    ...(outcome.rate_limit !== undefined ? { rate_limit: outcome.rate_limit } : {}),
  };
  rememberResult(token, result);
  deps.logger.info('send_file: отправлено', {
    commit: outcome.status_name,
    duplicate: outcome.duplicate,
    kind: description.kind,
  });
  return result;
}
