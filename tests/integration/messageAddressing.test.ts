/**
 * Адресация сообщений: `get_message` по ChatId+Timestamp и по join-ссылке, `get_message_context`.
 *
 * Против мок-транспорта (vi.fn, диспетчеризация по методу) - проверяется склейка
 * (резолв -> message_info/history -> нормализация/обогащение -> детальные реакции), а не сеть.
 * Никаких живых данных.
 */
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/loadConfig.js';
import { loadReactionMap } from '../../src/config/reactionMap.js';
import { createLogger } from '../../src/util/logger.js';
import type { ToolDeps } from '../../src/mcp/tools/deps.js';
import { getMessage } from '../../src/mcp/tools/getMessage.js';
import { getMessageContext } from '../../src/mcp/tools/getMessageContext.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MY_GUID = 'aaaaaaaa-1111-2222-3333-444444444444';
const PARTNER_GUID = 'bbbbbbbb-5555-6666-7777-888888888888';
const CHAT_ID = `${PARTNER_GUID}_${MY_GUID}`;
const TS = 1784287503814009;
const TS_STR = '1784287503814009';

const config = loadConfig({ configDir: mkdtempSync(join(tmpdir(), 'ymm-addr-')) });
const logger = createLogger({ level: 'error' });

/** ServerMessage в обёртке, как приходит из history (`Messages[].ServerMessage`) */
function historyMessage(ts: number, text: string, siblings: Record<string, unknown> = {}) {
  return {
    ServerMessage: {
      ClientMessage: { Plain: { ChatId: CHAT_ID, Text: { MessageText: text } } },
      ServerMessageInfo: {
        Timestamp: ts,
        SeqNo: 1,
        LastEditTimestamp: 0,
        Deleted: false,
        From: { Guid: PARTNER_GUID, DisplayName: 'Собеседник' },
      },
      ...siblings,
    },
  };
}

/** ServerMessage-уровень напрямую, как приходит в message_info.Message */
function infoMessage(ts: number, text: string, siblings: Record<string, unknown> = {}) {
  return {
    ClientMessage: { Plain: { ChatId: CHAT_ID, Text: { MessageText: text } } },
    ServerMessageInfo: {
      Timestamp: ts,
      SeqNo: 1,
      LastEditTimestamp: 0,
      Deleted: false,
      From: { Guid: PARTNER_GUID, DisplayName: 'Собеседник' },
    },
    ...siblings,
  };
}

function makeDeps(handlers: {
  ws?: (method: string, params: Record<string, unknown>) => unknown;
  httpCall?: (method: string, params: Record<string, unknown>) => unknown;
}): { deps: ToolDeps; wsRequest: ReturnType<typeof vi.fn>; httpCall: ReturnType<typeof vi.fn> } {
  const wsRequest = vi.fn(async (method: string, params: Record<string, unknown> = {}) =>
    (handlers.ws?.(method, params) ?? {}) as never,
  );
  const httpCall = vi.fn(async (method: string, params: Record<string, unknown> = {}) =>
    (handlers.httpCall?.(method, params) ?? {}) as never,
  );
  const deps = {
    ws: { request: wsRequest },
    http: { call: httpCall },
    auth: { getWhoami: async () => ({ uid: '123', guid: MY_GUID }) },
    config,
    logger,
    reactionMap: loadReactionMap(),
  } as unknown as ToolDeps;
  return { deps, wsRequest, httpCall };
}

describe('get_message по chat_id + message_id', () => {
  it('отдаёт одно сообщение через message_info, БЕЗ загрузки истории', async () => {
    const { deps, wsRequest, httpCall } = makeDeps({
      ws: (method, params) => {
        if (method === 'message_info') return { Message: infoMessage(TS, 'целевое') };
        if (method === 'list_reactions') {
          return params['Mode'] === 1 ? { UserReads: [], ReadsCount: 0 } : { UserReactions: [] };
        }
        return {};
      },
    });

    const result = await getMessage(deps, { chat: CHAT_ID, message_id: TS_STR });

    if (result.status !== 'ok') throw new Error(`ожидался ok, получен ${result.status}`);
    expect(result.chat_id).toBe(CHAT_ID);
    expect(result.message.text).toBe('целевое');
    expect(result.message.timestamp_mcs).toBe(TS_STR);
    /* Литеральный ChatId не идёт в поиск */
    expect(httpCall).not.toHaveBeenCalled();
    /* history НЕ дёргается: только message_info (+ 2 list_reactions за детальными реакциями) */
    expect(wsRequest.mock.calls.some(([m]) => m === 'history')).toBe(false);
    const infoCall = wsRequest.mock.calls.find(([m]) => m === 'message_info');
    expect(infoCall?.[1]).toEqual({ ChatId: CHAT_ID, Timestamp: TS });
  });

  it('детальные реакции тянутся через list_reactions (2 вызова, Phase 2)', async () => {
    const { deps, wsRequest } = makeDeps({
      ws: (method, params) => {
        if (method === 'message_info') return { Message: infoMessage(TS, 'x') };
        if (method === 'list_reactions') {
          return params['Mode'] === 1
            ? { UserReads: [{ UserInfo: { Guid: PARTNER_GUID }, Timestamp: TS }], ReadsCount: 1 }
            : { UserReactions: [{ Type: 100102, UserInfo: { Guid: PARTNER_GUID }, Timestamp: TS }] };
        }
        return {};
      },
    });

    const result = await getMessage(deps, { chat: CHAT_ID, message_id: TS_STR });

    if (result.status !== 'ok') throw new Error('ожидался ok');
    const listCalls = wsRequest.mock.calls.filter(([m]) => m === 'list_reactions');
    expect(listCalls).toHaveLength(2);
    expect(result.reactions_detail?.reactions[0]?.reaction.name).toBe('like-ext');
    expect(result.reactions_detail?.reads.recent).toHaveLength(1);
  });

  it('with_reactions:false пропускает детальную выборку', async () => {
    const { deps, wsRequest } = makeDeps({
      ws: (method) => (method === 'message_info' ? { Message: infoMessage(TS, 'x') } : {}),
    });

    const result = await getMessage(deps, { chat: CHAT_ID, message_id: TS_STR, with_reactions: false });

    if (result.status !== 'ok') throw new Error('ожидался ok');
    expect(result.reactions_detail).toBeUndefined();
    expect(wsRequest.mock.calls.filter(([m]) => m === 'list_reactions')).toHaveLength(0);
  });

  it('без url и без пары chat+message_id -> invalid_input, сеть не трогается', async () => {
    const { deps, wsRequest } = makeDeps({});
    const result = await getMessage(deps, { chat: CHAT_ID });
    expect(result.status).toBe('invalid_input');
    expect(wsRequest).not.toHaveBeenCalled();
  });
});

describe('get_message по join-ссылке', () => {
  it('2-сегментная резолвится в чат+сообщение через get_chats_info без CSRF', async () => {
    const { deps, httpCall } = makeDeps({
      ws: (method, params) => {
        if (method === 'message_info') return { Message: infoMessage(TS, 'из ссылки') };
        if (method === 'list_reactions') {
          return params['Mode'] === 1 ? { UserReads: [], ReadsCount: 0 } : { UserReactions: [] };
        }
        return {};
      },
      httpCall: (method) => (method === 'get_chats_info' ? { chats: [{ chat_id: CHAT_ID }] } : {}),
    });

    const result = await getMessage(deps, { url: `https://yandex.ru/chat#/join/hash-1/${TS_STR}` });

    if (result.status !== 'ok') throw new Error(`ожидался ok, получен ${result.status}`);
    expect(result.chat_id).toBe(CHAT_ID);
    expect(result.message.text).toBe('из ссылки');
    expect(httpCall).toHaveBeenCalledWith('get_chats_info', { invite_hash: 'hash-1' });
  });

  it('3-сегментная (сообщение в треде) резолвится в thread_id и адресуется message_info', async () => {
    /* Родитель приватный -> thread_id = `110/0/<parent>_<parent_ts>` (§17.10) */
    const threadId = `110/0/${CHAT_ID}_${TS_STR}`;
    const threadMsgTs = 1784288000000000;
    const { deps, wsRequest } = makeDeps({
      ws: (method, params) => {
        if (method === 'message_info') return { Message: infoMessage(threadMsgTs, 'в треде') };
        if (method === 'list_reactions') {
          return params['Mode'] === 1 ? { UserReads: [], ReadsCount: 0 } : { UserReactions: [] };
        }
        return {};
      },
      httpCall: (method) => (method === 'get_chats_info' ? { chats: [{ chat_id: CHAT_ID }] } : {}),
    });

    const result = await getMessage(deps, {
      url: `https://yandex.ru/chat#/join/hash-1/${TS_STR}/${threadMsgTs}`,
    });

    if (result.status !== 'ok') throw new Error(`ожидался ok, получен ${result.status}`);
    /* Сообщение адресовано в тред (ChatId=thread_id, Timestamp=метка внутри треда) */
    expect(result.chat_id).toBe(threadId);
    expect(result.message.text).toBe('в треде');
    const infoCall = wsRequest.mock.calls.find(([m]) => m === 'message_info');
    expect(infoCall?.[1]).toMatchObject({ ChatId: threadId, Timestamp: threadMsgTs, InviteHash: 'hash-1' });
  });

  it('3-сегментная на бизнес-чат (префикс 2) -> thread_unsupported, message_info не дёргается', async () => {
    const businessChat = '2/1234/11111111-1111-1111-1111-111111111111';
    const { deps, wsRequest } = makeDeps({
      httpCall: (method) => (method === 'get_chats_info' ? { chats: [{ chat_id: businessChat }] } : {}),
    });

    const result = await getMessage(deps, {
      url: `https://yandex.ru/chat#/join/hash-1/${TS_STR}/1784288000000000`,
    });

    if (result.status !== 'thread_unsupported') {
      throw new Error(`ожидался thread_unsupported, получен ${result.status}`);
    }
    expect(result.parent_chat_id).toBe(businessChat);
    expect(result.thread_message_timestamp).toBe('1784288000000000');
    expect(result.reason).toMatch(/недоступен/);
    expect(wsRequest.mock.calls.some(([m]) => m === 'message_info')).toBe(false);
  });
});

describe('get_message_context: N до и N после метки', () => {
  const older1 = TS - 2000;
  const older2 = TS - 1000;
  const newer1 = TS + 1000;
  const newer2 = TS + 2000;

  it('возвращает before/after вокруг метки и саму метку', async () => {
    const { deps, wsRequest } = makeDeps({
      ws: (method, params) => {
        if (method !== 'history') return {};
        /* Сторона «до» несёт MaxTimestamp (метку включает), сторона «после» - MinTimestamp */
        if (params['MaxTimestamp'] !== undefined) {
          return {
            Chats: [
              {
                ChatId: CHAT_ID,
                Messages: [
                  historyMessage(older1, 'до-1'),
                  historyMessage(older2, 'до-2'),
                  historyMessage(TS, 'метка'),
                ],
              },
            ],
          };
        }
        return {
          Chats: [{ ChatId: CHAT_ID, Messages: [historyMessage(newer1, 'после-1'), historyMessage(newer2, 'после-2')] }],
        };
      },
    });

    const result = await getMessageContext(deps, { chat: CHAT_ID, message_id: TS_STR, before: 2, after: 2 });

    if (result.status !== 'ok') throw new Error('ожидался ok');
    expect(result.before.map((m) => m.text)).toEqual(['до-1', 'до-2']);
    expect(result.message?.text).toBe('метка');
    expect(result.after.map((m) => m.text)).toEqual(['после-1', 'после-2']);
    expect(result.pivot_timestamp_mcs).toBe(TS_STR);

    /* Сторона «до»: MaxTimestamp = метка+1 (включающая), Limit = before+1 */
    const beforeCall = wsRequest.mock.calls.find(([m, p]) => m === 'history' && (p as Record<string, unknown>)['MaxTimestamp'] !== undefined);
    expect(beforeCall?.[1]).toMatchObject({ MaxTimestamp: TS + 1, Limit: 3 });
    /* Сторона «после»: MinTimestamp = метка (исключающая), Limit = after */
    const afterCall = wsRequest.mock.calls.find(([m, p]) => m === 'history' && (p as Record<string, unknown>)['MinTimestamp'] !== undefined);
    expect(afterCall?.[1]).toMatchObject({ MinTimestamp: TS, Limit: 2 });
  });

  it('after:0 не делает второй вызов history', async () => {
    const { deps, wsRequest } = makeDeps({
      ws: (method, params) => {
        if (method === 'history' && params['MaxTimestamp'] !== undefined) {
          return { Chats: [{ ChatId: CHAT_ID, Messages: [historyMessage(TS, 'метка')] }] };
        }
        return {};
      },
    });

    const result = await getMessageContext(deps, { chat: CHAT_ID, message_id: TS_STR, before: 5, after: 0 });

    if (result.status !== 'ok') throw new Error('ожидался ok');
    expect(result.after).toEqual([]);
    expect(wsRequest.mock.calls.filter(([m]) => m === 'history')).toHaveLength(1);
  });
});
