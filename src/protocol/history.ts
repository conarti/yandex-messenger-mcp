/**
 * Сборка params для WS-метода `history` и нормализация ответа (§2.4/§14.2).
 *
 * `history` - единственный метод чтения: список чатов, страница сообщений, треды и встречи
 * различаются только фильтрами (§2.4). Здесь собирается именно то подмножество, которое
 * нужно read-инструментам v1.
 *
 * Курсоры приходят BigInt и уезжают на провод number: тело кадра - JSON, а он BigInt не
 * умеет (см. util/timestamps.ts). `toWireTimestamp` падает при выходе за 2^53, поэтому
 * потеря разряда невозможна молча.
 */
import { toWireTimestamp } from '../util/timestamps.js';

export interface HistoryParamsInput {
  chatId?: string;
  chatIds?: string[];
  /** `0` = только метаданные чатов, без тел (§2.4) */
  limit: number;
  /** ИСКЛЮЧАЮЩАЯ верхняя граница (§14.2, подтверждено живьём) */
  maxTimestamp?: bigint;
  /** ИСКЛЮЧАЮЩАЯ нижняя граница (§14.2) */
  minTimestamp?: bigint;
  offset?: number;
  /** Подмешать метаданные чата; на практике всегда пустой флаг-объект (§14.2) */
  withChatData?: boolean;
  /** Не тянуть тела сообщений (§14.2 MessageDataFilter.DropPayload) */
  dropPayload?: boolean;
  inviteHash?: string;
}

/** Ответ `history`: `{Chats, RequestId}` (живой захват; §2.4) */
export interface HistoryResponse {
  Chats?: unknown;
  RequestId?: unknown;
}

export function buildHistoryParams(input: HistoryParamsInput): Record<string, unknown> {
  if (!Number.isInteger(input.limit) || input.limit < 0) {
    throw new RangeError(`history: Limit должен быть неотрицательным целым, получено ${input.limit}`);
  }
  const params: Record<string, unknown> = { Limit: input.limit };

  if (input.chatId !== undefined) {
    params['ChatId'] = input.chatId;
  }
  if (input.chatIds !== undefined) {
    params['ChatIds'] = input.chatIds;
  }
  if (input.maxTimestamp !== undefined) {
    params['MaxTimestamp'] = toWireTimestamp(input.maxTimestamp);
  }
  if (input.minTimestamp !== undefined) {
    params['MinTimestamp'] = toWireTimestamp(input.minTimestamp);
  }
  if (input.offset !== undefined) {
    if (!Number.isInteger(input.offset) || input.offset < 0) {
      throw new RangeError(`history: Offset должен быть неотрицательным целым, получено ${input.offset}`);
    }
    params['Offset'] = input.offset;
  }
  if (input.withChatData === true) {
    params['ChatDataFilter'] = {};
  }
  if (input.dropPayload === true) {
    params['MessageDataFilter'] = { DropPayload: true };
  }
  if (input.inviteHash !== undefined) {
    params['InviteHash'] = input.inviteHash;
  }
  return params;
}

/**
 * Достаёт `Chats[]` из ответа.
 * Per-chat частичные ошибки (§14.2: элемент чата может нести свой `Status`) не роняют
 * весь ответ - такие элементы просто не пройдут нормализацию в chatShape/messageShape.
 */
export function extractChats(response: HistoryResponse | undefined): unknown[] {
  const chats = response?.Chats;
  return Array.isArray(chats) ? chats : [];
}

/** Находит элемент конкретного чата в ответе */
export function findChatEntry(response: HistoryResponse | undefined, chatId: string): unknown {
  return extractChats(response).find((entry) => {
    const id = (entry as { ChatId?: unknown } | null)?.ChatId;
    return id === chatId;
  });
}
