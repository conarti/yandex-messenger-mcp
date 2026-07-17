/**
 * Треды (Phase 4): открытие треда как чата, пустой тред (ENTITY_NOT_FOUND = «пуст»),
 * создание из сообщения (деривация thread_id), join/leave по HTTP, и отправка в тред через
 * УЖЕ существующий send_message (thread_id как ChatId, его же draft->confirm).
 *
 * get_thread/join/leave - против мок-транспорта (vi.fn). Отправка в тред - против ЖИВОГО
 * mock-Xiva: только посчитанные сервером кадры доказывают, что push ушёл именно в thread_id.
 * Синтетические id, живых данных нет.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAuthProvider } from '../../src/auth/FakeAuthProvider.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { loadReactionMap } from '../../src/config/reactionMap.js';
import type { ToolDeps } from '../../src/mcp/tools/deps.js';
import { getThread } from '../../src/mcp/tools/getThread.js';
import { resetSentTokens, sendMessage, type SendMessageDraft, type SendMessageSent } from '../../src/mcp/tools/sendMessage.js';
import { MessengerError } from '../../src/protocol/errors.js';
import { joinThread, leaveThread } from '../../src/protocol/threads.js';
import { MessengerWsClient } from '../../src/transport/ws/MessengerWsClient.js';
import { ResponseStatus } from '../../src/transport/ws/frameTypes.js';
import { createLogger } from '../../src/util/logger.js';
import { MockXiva, startMockXiva } from '../helpers/mockXiva.js';

const MY_GUID = 'aaaaaaaa-1111-2222-3333-444444444444';
const PARTNER_GUID = 'bbbbbbbb-5555-6666-7777-888888888888';
const GROUP_PARENT = '0/0/11111111-1111-1111-1111-111111111111';
const BUSINESS_PARENT = '2/1234/11111111-1111-1111-1111-111111111111';
const PARENT_TS = '1784287503814009';
/** Дериватив группы (§17.10, radix 10): `100/0/<uuid>_<parent_ts>` */
const THREAD_ID = `100/0/11111111-1111-1111-1111-111111111111_${PARENT_TS}`;

const config = loadConfig({ configDir: mkdtempSync(join(tmpdir(), 'ymm-thread-')) });
const logger = createLogger({ level: 'error' });

/** ServerMessage-уровень (то же, что элемент history), обёрнутый как `Messages[].ServerMessage` */
function threadMessage(ts: number, text: string) {
  return {
    ServerMessage: {
      ClientMessage: { Plain: { ChatId: THREAD_ID, Text: { MessageText: text } } },
      ServerMessageInfo: {
        Timestamp: ts,
        SeqNo: 1,
        LastEditTimestamp: 0,
        Deleted: false,
        From: { Guid: PARTNER_GUID, DisplayName: 'Собеседник' },
      },
    },
  };
}

/** Корень треда (ThreadParentMessage) на уровне ServerMessage */
function parentServerMessage() {
  return {
    ClientMessage: { Plain: { ChatId: GROUP_PARENT, Text: { MessageText: 'корень треда' } } },
    ServerMessageInfo: {
      Timestamp: Number(PARENT_TS),
      SeqNo: 5,
      LastEditTimestamp: 0,
      Deleted: false,
      From: { Guid: MY_GUID, DisplayName: 'Я' },
    },
  };
}

function makeMockDeps(handlers: {
  ws?: (method: string, params: Record<string, unknown>) => unknown;
  httpCall?: (method: string, params: Record<string, unknown>) => unknown;
}): { deps: ToolDeps; wsRequest: ReturnType<typeof vi.fn>; httpCall: ReturnType<typeof vi.fn> } {
  const wsRequest = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    const result = handlers.ws?.(method, params);
    if (result instanceof Error) throw result;
    return (result ?? {}) as never;
  });
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

describe('get_thread: открытие треда как чата', () => {
  it('по thread_id: history {ChatId:<thread_id>, ChatDataFilter:{}}, корень отдельным полем', async () => {
    const { deps, wsRequest } = makeMockDeps({
      ws: (method) =>
        method === 'history'
          ? {
              Chats: [
                {
                  ChatId: THREAD_ID,
                  Messages: [threadMessage(Number(PARENT_TS) + 1000, 'ответ в треде')],
                  ThreadParentMessage: parentServerMessage(),
                },
              ],
            }
          : {},
    });

    const result = await getThread(deps, { thread_id: THREAD_ID });

    if (result.status !== 'ok') throw new Error(`ожидался ok, получен ${result.status}`);
    expect(result.thread_id).toBe(THREAD_ID);
    expect(result.empty).toBe(false);
    expect(result.messages.map((m) => m.text)).toEqual(['ответ в треде']);
    expect(result.parent_message?.text).toBe('корень треда');
    /* Открытие треда - обычный history по thread_id с ChatDataFilter:{} (спайк 1) */
    const historyCall = wsRequest.mock.calls.find(([m]) => m === 'history');
    expect(historyCall?.[1]).toMatchObject({ ChatId: THREAD_ID, ChatDataFilter: {} });
  });

  it('признак треда приезжает на сообщениях (thread из Phase 1 enrichMessage)', async () => {
    const { deps } = makeMockDeps({
      ws: (method) =>
        method === 'history' ? { Chats: [{ ChatId: THREAD_ID, Messages: [threadMessage(Number(PARENT_TS) + 1, 'x')] }] } : {},
    });
    const result = await getThread(deps, { thread_id: THREAD_ID });
    if (result.status !== 'ok') throw new Error('ожидался ok');
    /* enrichMessage добавил top-level ключ thread (has_thread) - контракт Phase 1 цел */
    expect(result.messages[0]?.thread).toBeDefined();
  });
});

describe('get_thread: пустой тред = ENTITY_NOT_FOUND, не ошибка', () => {
  it('ENTITY_NOT_FOUND(4) на history -> empty:true, messages:[]', async () => {
    const { deps } = makeMockDeps({
      ws: (method) => {
        if (method === 'history') {
          return new MessengerError({ layer: 'application', code: ResponseStatus.ENTITY_NOT_FOUND, retriable: false });
        }
        return {};
      },
    });

    const result = await getThread(deps, { thread_id: THREAD_ID });

    if (result.status !== 'ok') throw new Error(`ожидался ok, получен ${result.status}`);
    expect(result.empty).toBe(true);
    expect(result.messages).toEqual([]);
  });

  it('прочие ошибки протокола НЕ проглатываются как «пуст»', async () => {
    const { deps } = makeMockDeps({
      ws: (method) => {
        if (method === 'history') {
          return new MessengerError({ layer: 'application', code: ResponseStatus.ACCESS_DENIED, retriable: false });
        }
        return {};
      },
    });
    await expect(getThread(deps, { thread_id: THREAD_ID })).rejects.toThrow(/ACCESS_DENIED/);
  });
});

describe('get_thread: создание из сообщения (деривация thread_id, «Обсудить»)', () => {
  it('chat + message_id родителя -> деривирует thread_id и открывает его', async () => {
    const { deps, wsRequest } = makeMockDeps({
      ws: (method) =>
        method === 'history' ? { Chats: [{ ChatId: THREAD_ID, Messages: [threadMessage(Number(PARENT_TS) + 1, 'первое')] }] } : {},
    });

    const result = await getThread(deps, { chat: GROUP_PARENT, message_id: PARENT_TS });

    if (result.status !== 'ok') throw new Error(`ожидался ok, получен ${result.status}`);
    expect(result.thread_id).toBe(THREAD_ID);
    expect(result.parent_chat_id).toBe(GROUP_PARENT);
    /* history открыт по деривированному thread_id, а не по родительскому чату */
    const historyCall = wsRequest.mock.calls.find(([m]) => m === 'history');
    expect(historyCall?.[1]).toMatchObject({ ChatId: THREAD_ID });
  });

  it('пустой (несуществующий) тред при создании -> empty:true, куда слать - thread_id известен', async () => {
    const { deps } = makeMockDeps({
      ws: (method) => {
        if (method === 'history') {
          return new MessengerError({ layer: 'application', code: ResponseStatus.ENTITY_NOT_FOUND, retriable: false });
        }
        return {};
      },
    });

    const result = await getThread(deps, { chat: GROUP_PARENT, message_id: PARENT_TS });

    if (result.status !== 'ok') throw new Error('ожидался ok');
    expect(result.empty).toBe(true);
    expect(result.thread_id).toBe(THREAD_ID);
  });

  it('бизнес-чат (префикс 2) -> thread_unsupported, history не дёргается', async () => {
    const { deps, wsRequest } = makeMockDeps({});
    const result = await getThread(deps, { chat: BUSINESS_PARENT, message_id: PARENT_TS });
    if (result.status !== 'thread_unsupported') throw new Error(`ожидался thread_unsupported, получен ${result.status}`);
    expect(result.parent_chat_id).toBe(BUSINESS_PARENT);
    expect(wsRequest.mock.calls.some(([m]) => m === 'history')).toBe(false);
  });

  it('ни thread_id, ни пары chat+message_id -> invalid_input, сеть не трогается', async () => {
    const { deps, wsRequest } = makeMockDeps({});
    const result = await getThread(deps, {});
    expect(result.status).toBe('invalid_input');
    expect(wsRequest).not.toHaveBeenCalled();
  });

  it('невалидный thread_id -> invalid_input', async () => {
    const { deps } = makeMockDeps({});
    const result = await getThread(deps, { thread_id: 'не-тред' });
    expect(result.status).toBe('invalid_input');
  });
});

describe('join_to_thread / leave_thread: подписка через HTTP', () => {
  it('join_to_thread {thread_id} -> {chat_member}', async () => {
    const { deps, httpCall } = makeMockDeps({
      httpCall: (method) => (method === 'join_to_thread' ? { chat_member: { role: 'member' } } : {}),
    });

    const membership = await joinThread(deps.http, THREAD_ID);

    expect(membership).toEqual({ chat_member: { role: 'member' } });
    expect(httpCall).toHaveBeenCalledWith('join_to_thread', { thread_id: THREAD_ID });
  });

  it('leave_thread {thread_id} -> {chat_member}', async () => {
    const { deps, httpCall } = makeMockDeps({
      httpCall: (method) => (method === 'leave_thread' ? { chat_member: { role: 'left' } } : {}),
    });

    const membership = await leaveThread(deps.http, THREAD_ID);

    expect(membership).toEqual({ chat_member: { role: 'left' } });
    expect(httpCall).toHaveBeenCalledWith('leave_thread', { thread_id: THREAD_ID });
  });
});

describe('отправка в тред: через существующий send_message (thread_id как ChatId)', () => {
  let mock: MockXiva;
  let ws: MessengerWsClient;
  let httpCall: ReturnType<typeof vi.fn>;
  let deps: ToolDeps;

  beforeEach(async () => {
    resetSentTokens();
    mock = await startMockXiva();
    ws = new MessengerWsClient({
      auth: new FakeAuthProvider({ context: { userGuid: MY_GUID } }),
      xivaUrl: mock.url,
      xivaServiceName: 'messenger-prod',
      requestTimeoutMs: 2_000,
      subscribedTimeoutMs: 1_000,
    });
    /* Поиск НЕ должен вызываться: thread_id - литеральный ChatId (§17.10) */
    httpCall = vi.fn(async () => ({ chats: { items: [], total: 0, limit: 50 } }));
    deps = {
      ws,
      http: { call: httpCall },
      auth: new FakeAuthProvider({ context: { userGuid: MY_GUID } }),
      config,
      logger,
      reactionMap: loadReactionMap(),
    } as unknown as ToolDeps;
    mock.responders.set('push', (request, connection) => mock.reply(connection, request, { Status: 1 }));
  });

  afterEach(async () => {
    ws.close();
    await mock.close();
  });

  it('thread_id принимается как ChatId: draft->confirm материализует тред первым push', async () => {
    const draftResult = await sendMessage(deps, { chat: THREAD_ID, text: 'первое в треде' });
    if (draftResult.status !== 'draft') throw new Error(`ожидался draft, получен ${draftResult.status}`);
    const draft = draftResult as SendMessageDraft;
    /* thread_id распознан как литеральный ChatId - поиск не вызывался */
    expect(httpCall).not.toHaveBeenCalled();
    expect(draft.chat_id).toBe(THREAD_ID);
    /* На шаге draft в сокет не ушло ничего (поведение send_message не изменилось) */
    expect(mock.requestsOf('push')).toHaveLength(0);

    const sent = (await sendMessage(deps, {
      chat: THREAD_ID,
      text: 'первое в треде',
      confirm: true,
      confirm_token: draft.confirm_token,
    })) as SendMessageSent;

    expect(sent).toMatchObject({ status: 'sent', chat_id: THREAD_ID, commit_status: 1 });
    const frames = mock.requestsOf('push');
    expect(frames).toHaveLength(1);
    /* Первый push несёт thread_id как ChatId - именно он материализует тред (спайк 1) */
    expect(frames[0]?.payload).toMatchObject({
      ClientMessage: { Plain: { ChatId: THREAD_ID, Text: { MessageText: 'первое в треде' } } },
    });
  });
});
