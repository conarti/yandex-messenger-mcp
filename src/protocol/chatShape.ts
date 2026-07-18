/**
 * Элемент history-ответа -> метаданные чата.
 *
 * ЖИВОЙ ЗАХВАТ (2026-07-17, 13 чатов реального профиля) - ключи элемента `Chats[]`:
 * `ChatId, ChatInfo?, PartnerInfo?, PrivateChatInfo?, Counters, LastSeqNo, LastTsMcs,
 *  LastSeenByMeSeqNo, LastSeenByMeTsMcs, LastSeenSeqNo, LastSeenTsMcs, LastEditTsMcs?,
 *  Muted?, MyRole, ApprovedByMe?, ApproximateOnlineUserCount, LastModeratedRange?`.
 *
 * ДВА РАСХОЖДЕНИЯ С ДОКОЙ, факты важнее:
 *
 * 1. НЕПРОЧИТАННОЕ СЧИТАЕТСЯ ЗДЕСЬ ЖЕ: `LastSeqNo - LastSeenByMeSeqNo`. Отдельный
 *    counters-вызов (§14.2 requestCounters) НЕ НУЖЕН. Поле `Counters` в ответе на эту
 *    роль НЕ годится, хотя и называется так: живьём оно несёт
 *    `{HiddenMessageCount, TotalMessageCount}` - объём чата, а не непрочитанное.
 *
 * 2. `LastMessage` в элементе чата НЕТ (ни при `Limit:0`, ни вообще). Тело последнего
 *    сообщения даёт `Limit:1`: тогда каждый чат несёт `Messages[1]`, и его метка совпала
 *    с `LastTsMcs` у 13/13 чатов - то есть это ровно последнее сообщение, одним вызовом.
 */
import { asObject, numberOr, stringOr } from '../util/json.js';
import { microsToIso, parseMicros } from '../util/timestamps.js';
import { normalizeMessages, type Message } from './messageShape.js';

export type ChatKind = 'private' | 'group';

export interface Chat {
  chat_id: string;
  name?: string;
  kind: ChatKind;
  /** ISO метки последней активности - ключ сортировки по свежести */
  last_activity?: string;
  /** Сырые мкс последней активности строкой */
  last_activity_mcs?: string;
  /** `LastSeqNo - LastSeenByMeSeqNo`, не меньше нуля */
  unread_count: number;
  unread: boolean;
  muted: boolean;
  /**
   * Последнее сообщение чата. Есть только если history звали с `Limit >= 1`.
   * ПРИВАТНОСТЬ: по умолчанию несёт лишь метаданные (id/время/kind/автор/флаги), БЕЗ `text`,
   * цитат и вложений - list_chats тащит его в контекст модели по всем чатам сразу. Полный текст
   * отдаётся только по опт-ину (`includeLastMessageText`).
   */
  last_message?: Message;
}

/**
 * Непрочитанное = сколько последовательностей чата я не досмотрел.
 * Клампим снизу: на своих же исходящих `LastSeenByMeSeqNo` может обогнать `LastSeqNo`,
 * и отрицательное «непрочитанное» было бы бессмыслицей.
 */
export function countUnread(raw: Record<string, unknown>): number {
  const last = numberOr(raw['LastSeqNo']) ?? 0;
  const seen = numberOr(raw['LastSeenByMeSeqNo']) ?? 0;
  return Math.max(0, last - seen);
}

/** Имя: у приватного чата - собеседник, у группового - название (§11.2 UserInfo) */
function resolveName(raw: Record<string, unknown>): string | undefined {
  const partner = asObject(raw['PartnerInfo']);
  const partnerName = stringOr(partner?.['DisplayName']) ?? stringOr(partner?.['PublicName']);
  if (partnerName !== undefined) {
    return partnerName;
  }
  return stringOr(asObject(raw['ChatInfo'])?.['Name']);
}

/**
 * Приватная проекция последнего сообщения: метаданные без контента.
 * Режем `text`, цитаты (`context`) и вложения (`attachments` = имена файлов/рефы) - всё это
 * содержимое чужой переписки. Оставляем адрес, время, автора, вид и флаги: по ним модель
 * понимает «что и когда», не видя «о чём». `kind` при этом сохраняет тип контента (image/voice/...).
 */
function toLastMessageMeta(message: Message): Message {
  return {
    id: message.id,
    ...(message.chat_id !== undefined ? { chat_id: message.chat_id } : {}),
    timestamp: message.timestamp,
    timestamp_mcs: message.timestamp_mcs,
    ...(message.seq_no !== undefined ? { seq_no: message.seq_no } : {}),
    from: message.from,
    kind: message.kind,
    attachments: [],
    edited: message.edited,
    ...(message.edited_at !== undefined ? { edited_at: message.edited_at } : {}),
    deleted: message.deleted,
  };
}

/**
 * @param includeLastMessageText - опт-ин: отдать полный текст последнего сообщения.
 *   По умолчанию false - см. `Chat.last_message` (приватность).
 */
export function normalizeChat(rawChat: unknown, includeLastMessageText = false): Chat | undefined {
  const raw = asObject(rawChat);
  const chatId = stringOr(raw?.['ChatId']);
  if (raw === undefined || chatId === undefined) {
    return undefined;
  }

  let lastMicros: bigint | undefined;
  try {
    lastMicros = raw['LastTsMcs'] === undefined ? undefined : parseMicros(raw['LastTsMcs']);
  } catch {
    lastMicros = undefined;
  }

  const unreadCount = countUnread(raw);
  const name = resolveName(raw);
  const messages = normalizeMessages(raw['Messages']);
  /* Limit:1 отдаёт ровно последнее сообщение; при Limit:0 массива нет вовсе */
  const lastMessage = messages[messages.length - 1];
  /* По умолчанию отдаём проекцию без контента; полный текст - только по явному опт-ину */
  const lastMessageOut =
    lastMessage === undefined ? undefined : includeLastMessageText ? lastMessage : toLastMessageMeta(lastMessage);

  return {
    chat_id: chatId,
    ...(name !== undefined ? { name } : {}),
    /* PrivateChatInfo - признак приватного чата; у группового вместо него ChatInfo */
    kind: raw['PrivateChatInfo'] !== undefined ? 'private' : 'group',
    ...(lastMicros !== undefined
      ? { last_activity: microsToIso(lastMicros), last_activity_mcs: lastMicros.toString() }
      : {}),
    unread_count: unreadCount,
    unread: unreadCount > 0,
    muted: raw['Muted'] === true,
    ...(lastMessageOut !== undefined ? { last_message: lastMessageOut } : {}),
  };
}

/**
 * Нормализует `Chats[]` и сортирует по свежести (новые первыми).
 * @param includeLastMessageText - опт-ин на полный текст последнего сообщения (дефолт false).
 */
export function normalizeChats(rawChats: unknown, includeLastMessageText = false): Chat[] {
  if (!Array.isArray(rawChats)) {
    return [];
  }
  const chats: Chat[] = [];
  for (const raw of rawChats) {
    const chat = normalizeChat(raw, includeLastMessageText);
    if (chat !== undefined) {
      chats.push(chat);
    }
  }
  return sortByRecency(chats);
}

/** Свежие первыми. Сравнение на BigInt: метки 16-значные, float тут не имеет права участвовать */
function sortByRecency(chats: Chat[]): Chat[] {
  return [...chats].sort((a, b) => {
    const left = a.last_activity_mcs === undefined ? 0n : BigInt(a.last_activity_mcs);
    const right = b.last_activity_mcs === undefined ? 0n : BigInt(b.last_activity_mcs);
    if (left === right) {
      return 0;
    }
    return left > right ? -1 : 1;
  });
}
