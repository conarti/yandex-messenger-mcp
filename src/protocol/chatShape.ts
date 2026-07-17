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
  /** Есть только если history звали с `Limit >= 1` */
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

export function normalizeChat(rawChat: unknown): Chat | undefined {
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
    ...(lastMessage !== undefined ? { last_message: lastMessage } : {}),
  };
}

/** Нормализует `Chats[]` и сортирует по свежести (новые первыми) */
export function normalizeChats(rawChats: unknown): Chat[] {
  if (!Array.isArray(rawChats)) {
    return [];
  }
  const chats: Chat[] = [];
  for (const raw of rawChats) {
    const chat = normalizeChat(raw);
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
