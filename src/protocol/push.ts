/**
 * `push` - единственный канал мутаций (§14.4). В v1 из всего каталога вариантов
 * `ClientMessage` собирается ровно один: `Plain.Text` (отправка текста, §9.3/§11.1).
 *
 * Конверт (§14.4 + живой кадр §2.6):
 *   { ClientTransportId:{XivaSubscriptionId}, UserAgent,
 *     ClientMessage:{ <вариант>, LogData:{YandexUid} },
 *     Meta:{Origin:serviceId}, ClientSupportedFeatures }
 * `RequestId` сюда НЕ кладётся: его впрыскивает транспорт каждому кадру (§14.8).
 *
 * `XivaSubscriptionId` - per-connection состояние из операционного кадра `subscribed`
 * (§17.2), а не самоминт. Пустой id = соединение к отправке НЕ ГОТОВО, и здесь это
 * жёсткий отказ: собрать кадр «на удачу» значит отправить сообщение в никуда.
 *
 * ФОРМА ОТВЕТА. Подтверждена живьём (US-009, self-чат 2026-07-17): успешный `push` текста
 * вернул `{ Status:1, MessageInfo:{TimestampMcs, PrevTimestampMcs, SeqNo, Version}, DebugInfo }`.
 * То есть wire-имена контейнера `MessageInfo`/`PrevTimestampMcs`/`TimestampMcs`/`SeqNo`/`Version`
 * теперь НАБЛЮДЕНЫ, а не только восстановлены по маппингу. `DebugInfo` (адреса воркера/балансера,
 * тайминги, число попыток) сервер тоже отдаёт - он не парсится и безвреден. `RateLimit` на
 * успешной отправке НЕ приходит (единица `wait_for` так и не наблюдалась). Парсер по-прежнему
 * читает оба написания ключей - это дешёвая страховка на случай смены имени сервером.
 */
import { randomUUID } from 'node:crypto';
import { codeName, PushCommitStatus } from '../transport/ws/frameTypes.js';
import { asObject, numberOr } from '../util/json.js';
import { parseMicros } from '../util/timestamps.js';
import { mapPushCommitStatus, MessengerError } from './errors.js';

/**
 * UserAgent веб-клиента: §2.6 записан с `3.21.0`, живой захват 2026-07-17 дал `3.22.0`.
 * Верим наблюдению.
 */
const USER_AGENT = 'chats-web/3.22.0';

/**
 * `ClientSupportedFeatures` - integer-битмаска (§14.1), а не массив. Определён только
 * `EPHEMERICAL=1`. Эфемерные сообщения v1 не поддерживает, поэтому `0` тут не «пусто»,
 * а честное «не умею».
 */
const CLIENT_SUPPORTED_FEATURES = 0;

/** Commit-статусы, которые означают «сообщение принято» и повторной отправки НЕ требуют */
const COMMITTED_STATUSES: readonly number[] = [PushCommitStatus.FULLY_COMMITTED, PushCommitStatus.DUPLICATE];

export interface PlainTextInput {
  chatId: string;
  text: string;
  /** Client-side id сообщения (§11.1). Он же ключ серверной дедупликации */
  payloadId: string;
}

/**
 * `PayloadId` - client message id (§11.1). Стабилен на протяжении жизни драфта:
 * повтор push с тем же id сервер отдаёт как `DUPLICATE(8)`, а не как второе сообщение.
 */
export function createPayloadId(): string {
  return randomUUID();
}

/** Вариант `ClientMessage` для отправки текста: content-поле ровно одно - `Text` (§11.1) */
export function buildPlainTextClientMessage(input: PlainTextInput): Record<string, unknown> {
  return {
    Plain: {
      ChatId: input.chatId,
      PayloadId: input.payloadId,
      Text: { MessageText: input.text },
    },
  };
}

/** `FileInfo.Source` (§11.1): загрузка способом Disk даёт `DISK=1` */
const FILE_SOURCE_DISK = 1;

export interface FileAttachmentInput {
  chatId: string;
  payloadId: string;
  /** `file_id` из `add_files` (§12.1) - кладётся в `FileInfo.Id2` */
  fileId: string;
  /** Имя файла (`FileInfo.Name`) */
  name?: string;
  /** Размер в байтах (`FileInfo.Size`) */
  size?: number;
}

export interface ImageAttachmentInput extends FileAttachmentInput {
  width?: number;
  height?: number;
}

/** `FileInfo` (§11.1): на проводе несёт `Id2` + Name/Size/Source, URL/бакета тут нет */
function buildFileInfo(input: FileAttachmentInput): Record<string, unknown> {
  return {
    Id2: input.fileId,
    ...(input.name !== undefined ? { Name: input.name } : {}),
    ...(input.size !== undefined ? { Size: input.size } : {}),
    Source: FILE_SOURCE_DISK,
  };
}

/**
 * Вариант `ClientMessage.Plain.Image` для отправки картинки (§11.1/§12.1).
 *
 * ⚠️ ФОРМА ИСХОДЯЩЕГО ПУТИ ДОКО-ВЫВЕДЕНА (US-009): входящие `Image` живьём наблюдались,
 * отправка - нет. `Width`/`Height` не проставляются намеренно: декодировать картинку ради
 * метаданных не нужно, для доставки достаточно `FileInfo`; при живой проверке добавляются
 * одной правкой. `Timestamp` не ставится - это НОВОЕ сообщение, не правка.
 */
export function buildImageClientMessage(input: ImageAttachmentInput): Record<string, unknown> {
  return {
    Plain: {
      ChatId: input.chatId,
      PayloadId: input.payloadId,
      Image: {
        ...(input.width !== undefined ? { Width: input.width } : {}),
        ...(input.height !== undefined ? { Height: input.height } : {}),
        FileInfo: buildFileInfo(input),
      },
    },
  };
}

/**
 * Вариант `ClientMessage.Plain.MiscFile` для отправки произвольного файла (§11.1/§12.1).
 * ⚠️ Форма исходящего пути доко-выведена (US-009), см. buildImageClientMessage.
 */
export function buildFileClientMessage(input: FileAttachmentInput): Record<string, unknown> {
  return {
    Plain: {
      ChatId: input.chatId,
      PayloadId: input.payloadId,
      MiscFile: {
        FileInfo: buildFileInfo(input),
      },
    },
  };
}

export interface PushParamsInput {
  clientMessage: Record<string, unknown>;
  /** Из `waitForSubscriptionId()`; пустой = кадр `subscribed` не пришёл (§17.2) */
  subscriptionId: string;
  /** Кука `yandexuid` (§14.4) */
  yandexUid: string;
  /** `Meta.Origin` = serviceId (27 по §15) */
  serviceId: number;
}

export function buildPushParams(input: PushParamsInput): Record<string, unknown> {
  const subscriptionId = input.subscriptionId.trim();
  if (subscriptionId.length === 0) {
    throw new Error(
      'push: пустой XivaSubscriptionId - соединение не получило операционный кадр subscribed (§17.2), ' +
        'отправка невозможна',
    );
  }
  return {
    ClientTransportId: { XivaSubscriptionId: subscriptionId },
    UserAgent: USER_AGENT,
    ClientMessage: { ...input.clientMessage, LogData: { YandexUid: input.yandexUid } },
    Meta: { Origin: input.serviceId },
    ClientSupportedFeatures: CLIENT_SUPPORTED_FEATURES,
  };
}

/** `messageInfo` ответа (§14.4). Метки - строки в мкс: точность важнее удобства (util/timestamps) */
export interface PushMessageInfo {
  version?: number;
  prev_timestamp_mcs?: string;
  timestamp_mcs?: string;
  seqno?: number;
}

export interface PushOutcome {
  status: number;
  status_name: string;
  /** `FULLY_COMMITTED(1)` либо `DUPLICATE(8)`: сообщение принято, повторять нельзя */
  committed: boolean;
  /** `DUPLICATE(8)`: этот PayloadId сервер уже принял - идемпотентный успех */
  duplicate: boolean;
  message_info?: PushMessageInfo;
  /**
   * `rate_limit.wait_for` (§14.4) как есть, числом. Единица измерения нигде не
   * наблюдалась и не документирована - домысливать её тут нельзя.
   */
  rate_limit?: { wait_for: number };
}

/**
 * Отправка не подтверждена. Ретрая НЕТ: push необратим, повтор мог бы задвоить сообщение.
 *
 * Текст и расшифровка кода берутся у маппера слоя 3 (protocol/errors.ts), чтобы все три слоя
 * §14.6 объяснялись одинаково и несли тег слоя. Класс остаётся отдельным типом: вызывающему
 * важно отличать «мутация не подтверждена» от прочих ошибок протокола, не разбирая строку.
 */
export class PushNotCommittedError extends MessengerError {
  constructor(readonly outcome: PushOutcome) {
    const mapped = mapPushCommitStatus(outcome);
    super({
      layer: 'push',
      code: outcome.status,
      retriable: false,
      ...(mapped.details !== undefined ? { details: mapped.details } : {}),
      ...(outcome.rate_limit !== undefined ? { waitForRaw: outcome.rate_limit.wait_for } : {}),
    });
    this.name = 'PushNotCommittedError';
  }
}

/** Читает первое присутствующее написание ключа: wire-имена восстановлены по маппингу, не наблюдались */
function pick(source: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function microsOr(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  try {
    return parseMicros(value).toString();
  } catch {
    /* Не метка - лучше отдать outcome без поля, чем уронить подтверждённую отправку */
    return undefined;
  }
}

function parseMessageInfo(raw: unknown): PushMessageInfo | undefined {
  const info = asObject(raw);
  if (info === undefined) {
    return undefined;
  }
  const version = numberOr(pick(info, 'Version', 'version'));
  const prev = microsOr(pick(info, 'PrevTimestampMcs', 'prevTimestamp'));
  const timestamp = microsOr(pick(info, 'TimestampMcs', 'timestamp'));
  const seqno = numberOr(pick(info, 'SeqNo', 'seqno'));

  const parsed: PushMessageInfo = {
    ...(version !== undefined ? { version } : {}),
    ...(prev !== undefined ? { prev_timestamp_mcs: prev } : {}),
    ...(timestamp !== undefined ? { timestamp_mcs: timestamp } : {}),
    ...(seqno !== undefined ? { seqno } : {}),
  };
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseRateLimit(raw: unknown): { wait_for: number } | undefined {
  const limit = asObject(raw);
  const waitFor = numberOr(pick(limit, 'WaitFor', 'wait_for'));
  return waitFor !== undefined ? { wait_for: waitFor } : undefined;
}

/**
 * `deserializePushResponse` (§14.4).
 *
 * Ответ без числового `Status` - это ОТКАЗ, а не успех: подтверждения нет, а отправка
 * могла и состояться. Молча трактовать такое как успех нельзя.
 */
export function parsePushResponse(response: unknown): PushOutcome {
  const body = asObject(response);
  const status = numberOr(pick(body, 'Status', 'status'));
  if (status === undefined) {
    throw new Error('push: в ответе нет числового Status - отправка не подтверждена');
  }

  const messageInfo = parseMessageInfo(pick(body, 'MessageInfo', 'messageInfo'));
  const rateLimit = parseRateLimit(pick(body, 'RateLimit', 'rate_limit'));

  return {
    status,
    status_name: codeName(PushCommitStatus, status),
    committed: COMMITTED_STATUSES.includes(status),
    duplicate: status === PushCommitStatus.DUPLICATE,
    ...(messageInfo !== undefined ? { message_info: messageInfo } : {}),
    ...(rateLimit !== undefined ? { rate_limit: rateLimit } : {}),
  };
}
