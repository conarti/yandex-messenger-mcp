/**
 * `get_message` по ChatId+Timestamp через `message_info` (§14.3/§17.12).
 *
 * Проверяется: одно сообщение БЕЗ загрузки истории (ровно один вызов message_info),
 * нормализация тем же путём (normalizeMessage + enrichMessage), рендер MyReactions по карте
 * (ключ исчезает без своей реакции), внятный маппинг ErrorInfo. Фикстуры синтетические.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  getMessageInfo,
  MessageInfoError,
  type MessageInfoClient,
} from '../../src/protocol/messageInfo.js';
import { createReactionMap } from '../../src/config/reactionMap.js';

const CHAT_ID = 'guid-a_guid-b';
const MY_GUID = 'guid-me';
const TS = 1784287503814009;
const TS_STR = '1784287503814009';

const MAP = createReactionMap(new Map([[100102, { name: 'like-ext', emoji: '👍' }]]));

/** ServerMessage-уровень: та же форма, что элемент history (§11.2) */
function serverMessage(siblings: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ClientMessage: { Plain: { ChatId: CHAT_ID, Text: { MessageText: 'привет' } } },
    ServerMessageInfo: {
      Timestamp: TS,
      SeqNo: 7,
      LastEditTimestamp: 0,
      Deleted: false,
      From: { Guid: MY_GUID, DisplayName: 'Я' },
    },
    ...siblings,
  };
}

function fakeClient(response: Record<string, unknown>): {
  client: MessageInfoClient;
  calls: Array<{ method: string; params: Record<string, unknown> | undefined }>;
} {
  const calls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
  const client: MessageInfoClient = {
    request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      return response as never;
    }),
  };
  return { client, calls };
}

const ctx = { myGuid: MY_GUID, reactionMap: MAP };

describe('getMessageInfo: одно сообщение без истории', () => {
  it('делает ровно один вызов message_info с ChatId+Timestamp, без загрузки истории', async () => {
    const { client, calls } = fakeClient({ Message: serverMessage() });

    const result = await getMessageInfo(client, { chatId: CHAT_ID, timestamp: TS_STR }, ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('message_info');
    expect(calls[0]?.params).toEqual({ ChatId: CHAT_ID, Timestamp: TS });
    expect(result.message.text).toBe('привет');
    expect(result.message.timestamp_mcs).toBe(TS_STR);
    /* Нормализация тем же путём: обогащённые ключи на месте */
    expect(result.message.from_me).toBe(true);
    expect(result.message.reads.tracked).toBe(false);
  });

  it('InviteHash подмешивается для адресации по join-ссылке', async () => {
    const { client, calls } = fakeClient({ Message: serverMessage() });
    await getMessageInfo(client, { chatId: CHAT_ID, timestamp: TS_STR, inviteHash: 'h-1' }, ctx);
    expect(calls[0]?.params?.['InviteHash']).toBe('h-1');
  });

  it('поддерживает обёртку {ServerMessage:{...}} у поля Message', async () => {
    const { client } = fakeClient({ Message: { ServerMessage: serverMessage() } });
    const result = await getMessageInfo(client, { chatId: CHAT_ID, timestamp: TS_STR }, ctx);
    expect(result.message.text).toBe('привет');
  });

  it('обогащает реакции из сиблингов через карту (Phase 2 путь)', async () => {
    const { client } = fakeClient({
      Message: serverMessage({ Reactions: [{ Type: 100102, Count: 2 }] }),
    });
    const result = await getMessageInfo(client, { chatId: CHAT_ID, timestamp: TS_STR }, ctx);
    /* Единая форма (ось B1): count из Reactions[].Count, акторов в сиблингах нет -> усечён */
    expect(result.message.reactions).toEqual([
      { type: 100102, name: 'like-ext', emoji: '👍', count: 2, actors: [], actors_complete: false },
    ]);
  });
});

describe('getMessageInfo: MyReactions', () => {
  it('MyReactions рендерится по карте, когда ключ есть', async () => {
    const { client } = fakeClient({ Message: serverMessage(), MyReactions: [100102, 999999] });
    const result = await getMessageInfo(client, { chatId: CHAT_ID, timestamp: TS_STR }, ctx);
    expect(result.my_reactions).toEqual([
      { type: 100102, name: 'like-ext', emoji: '👍' },
      { type: 999999, name: null, emoji: null, unknown: true },
    ]);
  });

  it('ключ MyReactions отсутствует -> поля my_reactions нет (не пустой массив)', async () => {
    const { client } = fakeClient({ Message: serverMessage() });
    const result = await getMessageInfo(client, { chatId: CHAT_ID, timestamp: TS_STR }, ctx);
    expect(result.my_reactions).toBeUndefined();
  });
});

describe('getMessageInfo: ErrorInfo маппится внятно', () => {
  it('Message отсутствует, ErrorInfo непустой -> MessageInfoError с деталью', async () => {
    const { client } = fakeClient({ ErrorInfo: { Code: 5, Text: 'нет доступа' } });
    await expect(getMessageInfo(client, { chatId: CHAT_ID, timestamp: TS_STR }, ctx)).rejects.toThrow(
      /нет доступа/,
    );
  });

  it('Message отсутствует и ErrorInfo пуст -> MessageInfoError «не найдено»', async () => {
    const { client } = fakeClient({ ErrorInfo: {} });
    await expect(getMessageInfo(client, { chatId: CHAT_ID, timestamp: TS_STR }, ctx)).rejects.toThrow(
      MessageInfoError,
    );
  });
});
