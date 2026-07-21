/**
 * ServerMessage -> MCP-сообщение (§9.1/§9.2/§11.1/§11.2).
 *
 * Нормализатор принимает `{ClientMessage, ServerMessageInfo}` НАМЕРЕННО, а не элемент
 * history: ровно в этой форме сообщение приходит и из `history`
 * (`Messages[].ServerMessage`), и из HTTP-поиска (`items[].data`) - живая проверка
 * 2026-07-17. Один нормализатор на оба источника вместо двух расходящихся.
 *
 * Правка и удаление НЕ являются отдельными типами (§9.2): это тот же Plain с
 * `LastEditTimestamp > 0` либо `Deleted = true` (у удалённого тело пустое).
 * Ответы (reply) отдельного kind тоже не имеют - они моделируются форвардом с цитатой:
 * `ForwardedMessageRefs` + `ForwardedMessageStyles.Quote` (§11.1).
 */
import { asObject, stringOr } from '../util/json.js';
import { microsToIso, parseMicros } from '../util/timestamps.js';
import { extractAttachmentRefs, type AttachmentRef } from './attachmentRefs.js';

/** Content-поля тела Plain (§11.1). Ровно одно на сообщение */
const CONTENT_KINDS = ['Text', 'Sticker', 'Image', 'MiscFile', 'Card', 'Gallery', 'Voice', 'Poll'] as const;

export type MessageKind = 'text' | 'sticker' | 'image' | 'file' | 'card' | 'gallery' | 'voice' | 'poll' | 'system' | 'unknown';

const KIND_BY_CONTENT: Record<(typeof CONTENT_KINDS)[number], MessageKind> = {
  Text: 'text',
  Sticker: 'sticker',
  Image: 'image',
  MiscFile: 'file',
  Card: 'card',
  Gallery: 'gallery',
  Voice: 'voice',
  Poll: 'poll',
};

export interface MessageSender {
  guid: string;
  name?: string;
}

/** Ссылка на процитированное/пересланное сообщение (§11.1 ForwardedMessageRefs) */
export interface MessageRef {
  chat_id?: string;
  timestamp?: string;
  timestamp_mcs?: string;
}

/** Контекст reply/forward: на проводе это одно и то же (§11.1), различает лишь наличие цитаты */
export interface MessageContext {
  /** true, если есть ForwardedMessageStyles.Quote - клиент показал бы это как reply */
  is_reply: boolean;
  refs: MessageRef[];
  quotes: string[];
}

export interface Message {
  /**
   * Метка в мкс - канонический адрес сообщения внутри чата: именно ею адресуют
   * `message_info {ChatId, Timestamp}` (§14.3) и по ней строится пагинация.
   * `PayloadId` тут не годится - это client-side id, он есть не у всех сообщений.
   */
  id: string;
  chat_id?: string;
  /** ISO с точностью до мс */
  timestamp: string;
  /** Сырые мкс строкой: полная точность, пригодна как курсор `before` */
  timestamp_mcs: string;
  seq_no?: number;
  from: MessageSender;
  kind: MessageKind;
  text?: string;
  attachments: AttachmentRef[];
  context?: MessageContext;
  edited: boolean;
  edited_at?: string;
  deleted: boolean;
}

function buildContext(body: Record<string, unknown>): MessageContext | undefined {
  const rawRefs = Array.isArray(body['ForwardedMessageRefs']) ? body['ForwardedMessageRefs'] : [];
  const rawStyles = Array.isArray(body['ForwardedMessageStyles']) ? body['ForwardedMessageStyles'] : [];

  const quotes: string[] = [];
  for (const style of rawStyles) {
    const quote = stringOr(asObject(style)?.['Quote']);
    if (quote !== undefined) {
      quotes.push(quote);
    }
  }

  if (rawRefs.length === 0 && quotes.length === 0) {
    return undefined;
  }

  const refs: MessageRef[] = [];
  for (const raw of rawRefs) {
    const ref = asObject(raw);
    if (ref === undefined) {
      continue;
    }
    const chatId = stringOr(ref['ChatId']);
    const timestamp = ref['Timestamp'];
    /* Метка форварда бывает 0/отсутствует - тогда ссылку отдаём без времени, а не роняем разбор */
    let micros: bigint | undefined;
    try {
      micros = timestamp === undefined || timestamp === 0 ? undefined : parseMicros(timestamp);
    } catch {
      micros = undefined;
    }
    refs.push({
      ...(chatId !== undefined ? { chat_id: chatId } : {}),
      ...(micros !== undefined ? { timestamp: microsToIso(micros), timestamp_mcs: micros.toString() } : {}),
    });
  }

  return { is_reply: quotes.length > 0, refs, quotes };
}

/** Достаёт тело и его вид: Plain и Ephemeral устроены одинаково (§11.1) */
function resolveBody(clientMessage: Record<string, unknown>): {
  body: Record<string, unknown> | undefined;
  kind: MessageKind;
} {
  const plain = asObject(clientMessage['Plain']) ?? asObject(clientMessage['Ephemeral']);
  if (plain !== undefined) {
    for (const content of CONTENT_KINDS) {
      if (plain[content] !== undefined) {
        return { body: plain, kind: KIND_BY_CONTENT[content] };
      }
    }
    /* Тело есть, но content-поля нет - штатный вид удалённого сообщения (§9.2) */
    return { body: plain, kind: 'unknown' };
  }
  if (clientMessage['SystemMessage'] !== undefined) {
    return { body: asObject(clientMessage['SystemMessage']), kind: 'system' };
  }
  return { body: undefined, kind: 'unknown' };
}

/**
 * Нормализует `{ClientMessage, ServerMessageInfo}` в MCP-сообщение.
 * Возвращает undefined, если метки нет: без неё сообщение неадресуемо.
 */
export function normalizeMessage(serverMessage: unknown): Message | undefined {
  const source = asObject(serverMessage);
  if (source === undefined) {
    return undefined;
  }
  const info = asObject(source['ServerMessageInfo']);
  const clientMessage = asObject(source['ClientMessage']);
  if (info === undefined || clientMessage === undefined) {
    return undefined;
  }

  let micros: bigint;
  try {
    micros = parseMicros(info['Timestamp']);
  } catch {
    return undefined;
  }

  const { body, kind } = resolveBody(clientMessage);
  const from = asObject(info['From']);
  const fromGuid = stringOr(from?.['Guid']);
  const fromName = stringOr(from?.['DisplayName']);

  const lastEdit = info['LastEditTimestamp'];
  const edited = typeof lastEdit === 'number' && lastEdit > 0;
  const deleted = info['Deleted'] === true;

  /**
   * Текст собирается из content-полей, которые его реально несут - ревизия всех восьми
   * `CONTENT_KINDS` (AC-10):
   * - `Text.MessageText` - обычный текст;
   * - `Voice.Text` - распознанная речь;
   * - `Gallery.Text` - подпись к галерее (AC-9), тот же ключ, что и у обычного текста;
   * - `Sticker`, `Image`, `MiscFile` текстового поля на проводе не несут вовсе - на них лежит
   *   только `FileInfo` (§11.1, `attachmentRefs.ts`) - терять здесь нечего;
   * - `Card`, вероятно, содержательно несёт текст, но его форма ни разу не наблюдалась
   *   живьём, и он СОЗНАТЕЛЬНО не поддерживается (AC-11): читать из невалидированной формы
   *   значит рисковать вернуть не то поле под видом текста;
   * - `Poll.Title` намеренно НЕ подставляется (AC-12) - заголовок уже отдаётся отдельно,
   *   через `get_poll` (`poll.ts:185`), дублирование развело бы источники правды.
   */
  const text =
    stringOr(asObject(body?.['Text'])?.['MessageText']) ??
    stringOr(asObject(body?.['Voice'])?.['Text']) ??
    stringOr(asObject(body?.['Gallery'])?.['Text']);
  const context = body !== undefined ? buildContext(body) : undefined;
  const chatId = stringOr(body?.['ChatId']);

  return {
    id: micros.toString(),
    ...(chatId !== undefined ? { chat_id: chatId } : {}),
    timestamp: microsToIso(micros),
    timestamp_mcs: micros.toString(),
    ...(typeof info['SeqNo'] === 'number' ? { seq_no: info['SeqNo'] } : {}),
    from: { guid: fromGuid ?? '', ...(fromName !== undefined ? { name: fromName } : {}) },
    /* У удалённого тело пустое, поэтому вид берём из флага, а не из отсутствующего content-поля */
    kind: deleted ? 'unknown' : kind,
    ...(text !== undefined ? { text } : {}),
    attachments: deleted ? [] : extractAttachmentRefs(body),
    ...(context !== undefined ? { context } : {}),
    edited,
    ...(edited ? { edited_at: microsToIso(parseMicros(lastEdit)) } : {}),
    deleted,
  };
}

/** Нормализует пачку `Messages[]` из history-ответа, отбрасывая неадресуемые элементы */
export function normalizeMessages(rawMessages: unknown): Message[] {
  if (!Array.isArray(rawMessages)) {
    return [];
  }
  const messages: Message[] = [];
  for (const raw of rawMessages) {
    const message = normalizeMessage(asObject(raw)?.['ServerMessage']);
    if (message !== undefined) {
      messages.push(message);
    }
  }
  return messages;
}
