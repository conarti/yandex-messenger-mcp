/**
 * Read-инструменты против мок-транспорта: проверяется склейка
 * (params -> нормализация -> резолв чата -> курсор), а не сеть.
 */
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/loadConfig.js';
import { loadReactionMap } from '../../src/config/reactionMap.js';
import { mapResponseStatus } from '../../src/protocol/errors.js';
import { createLogger } from '../../src/util/logger.js';
import type { ToolDeps } from '../../src/mcp/tools/deps.js';
import { getHistory } from '../../src/mcp/tools/getHistory.js';
import { getMessage } from '../../src/mcp/tools/getMessage.js';
import { getMessageContext } from '../../src/mcp/tools/getMessageContext.js';
import { listChats } from '../../src/mcp/tools/listChats.js';
import { search } from '../../src/mcp/tools/search.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MY_GUID = 'aaaaaaaa-1111-2222-3333-444444444444';
const CHAT_ID = 'bbbbbbbb-5555-6666-7777-888888888888_aaaaaaaa-1111-2222-3333-444444444444';
/** Метка-пивот для get_message_context/get_message: 16 цифр (§5), значение синтетическое */
const PIVOT_TIMESTAMP = '1784287503814009';

/** Отказ бэкенда ENTITY_NOT_FOUND(4) ровно в форме, которую транспорт мапит из DATA-кадра (§14.6) */
function entityNotFound(method: string, details?: string) {
  const error = mapResponseStatus(method, {
    Status: 4,
    RequestId: 'e4e4e4e4-9999-5555-aaaa-111122223333',
    ...(details !== undefined ? { Details: details } : {}),
  });
  if (error === undefined) {
    throw new Error('фикстура не собрала ошибку');
  }
  return error;
}

const config = loadConfig({ configDir: mkdtempSync(join(tmpdir(), 'ymm-readtools-')) });
const logger = createLogger({ level: 'error' });

function message(ts: number, text: string, extra: Record<string, unknown> = {}) {
  return {
    ServerMessage: {
      ClientMessage: { Plain: { ChatId: CHAT_ID, Text: { MessageText: text }, ...extra } },
      ServerMessageInfo: {
        Timestamp: ts,
        SeqNo: 1,
        LastEditTimestamp: 0,
        Deleted: false,
        From: { Guid: 'bbbbbbbb-5555-6666-7777-888888888888', DisplayName: 'Собеседник' },
      },
    },
  };
}

function makeDeps(overrides: { wsRequest?: unknown; httpCall?: unknown } = {}): {
  deps: ToolDeps;
  wsRequest: ReturnType<typeof vi.fn>;
  httpCall: ReturnType<typeof vi.fn>;
  getWhoami: ReturnType<typeof vi.fn>;
} {
  const wsRequest = vi.fn(overrides.wsRequest as never);
  const httpCall = vi.fn(overrides.httpCall as never);
  const getWhoami = vi.fn(async () => ({ uid: '123', guid: MY_GUID }));
  const deps = {
    ws: { request: wsRequest },
    http: { call: httpCall },
    auth: { getWhoami },
    config,
    logger,
    reactionMap: loadReactionMap(),
  } as unknown as ToolDeps;
  return { deps, wsRequest, httpCall, getWhoami };
}

describe('list_chats', () => {
  const chats = [
    {
      ChatId: 'старый',
      LastTsMcs: 1784117000000000,
      LastSeqNo: 5,
      LastSeenByMeSeqNo: 5,
      PrivateChatInfo: {},
      PartnerInfo: { DisplayName: 'А' },
      Messages: [message(1784117000000000, 'старое')],
    },
    {
      ChatId: 'свежий',
      LastTsMcs: 1784117592261029,
      LastSeqNo: 9,
      LastSeenByMeSeqNo: 7,
      PrivateChatInfo: {},
      PartnerInfo: { DisplayName: 'Б' },
      Messages: [message(1784117592261029, 'свежее')],
    },
  ];

  it('зовёт history с Limit:1: только так приходит последнее сообщение (при Limit:0 его в ответе нет)', async () => {
    const { deps, wsRequest } = makeDeps({ wsRequest: async () => ({ Chats: chats }) });

    const result = await listChats(deps);

    expect(wsRequest).toHaveBeenCalledWith('history', { Limit: 1, ChatDataFilter: {} });
    /* Последнее сообщение есть, но по умолчанию БЕЗ текста - метаданные на месте (приватность) */
    expect(result.chats[0]?.last_message).toBeDefined();
    expect(result.chats[0]?.last_message?.text).toBeUndefined();
    expect(result.chats[0]?.last_message?.timestamp_mcs).toBe('1784117592261029');
  });

  it('include_last_message_text: полный текст последнего сообщения по опт-ину', async () => {
    const { deps } = makeDeps({ wsRequest: async () => ({ Chats: chats }) });

    const result = await listChats(deps, { include_last_message_text: true });

    expect(result.chats[0]?.last_message?.text).toBe('свежее');
  });

  it('сортирует по свежести и несёт unread из того же ответа', async () => {
    const { deps } = makeDeps({ wsRequest: async () => ({ Chats: chats }) });

    const result = await listChats(deps);

    expect(result.chats.map((c) => c.chat_id)).toEqual(['свежий', 'старый']);
    expect(result.chats[0]?.unread).toBe(true);
    expect(result.chats[0]?.unread_count).toBe(2);
    expect(result.unread_chats).toBe(1);
    expect(result.total_chats).toBe(2);
  });

  it('unread_only оставляет только непрочитанные', async () => {
    const { deps } = makeDeps({ wsRequest: async () => ({ Chats: chats }) });

    const result = await listChats(deps, { unread_only: true });

    expect(result.chats).toHaveLength(1);
    expect(result.chats[0]?.chat_id).toBe('свежий');
    /* Агрегаты считаются до фильтра - иначе непонятно, из чего отфильтровано */
    expect(result.total_chats).toBe(2);
  });

  it('limit режет выдачу', async () => {
    const { deps } = makeDeps({ wsRequest: async () => ({ Chats: chats }) });

    expect((await listChats(deps, { limit: 1 })).chats).toHaveLength(1);
  });
});

describe('get_history', () => {
  it('литеральный ChatId не идёт в поиск; страница нормализована', async () => {
    const { deps, wsRequest, httpCall } = makeDeps({
      wsRequest: async () => ({ Chats: [{ ChatId: CHAT_ID, Messages: [message(1784117592261029, 'привет')] }] }),
    });

    const result = await getHistory(deps, { chat: CHAT_ID, limit: 40 });

    expect(httpCall).not.toHaveBeenCalled();
    expect(wsRequest).toHaveBeenCalledWith('history', { ChatId: CHAT_ID, Limit: 40 });
    if (result.status !== 'ok') throw new Error('ожидался ok');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toBe('привет');
  });

  it('курсор before уезжает в MaxTimestamp КАК ЕСТЬ: граница исключающая', async () => {
    const { deps, wsRequest } = makeDeps({
      wsRequest: async () => ({ Chats: [{ ChatId: CHAT_ID, Messages: [message(1784117000000000, 'старое')] }] }),
    });

    await getHistory(deps, { chat: CHAT_ID, limit: 40, before: '1784117592261029' });

    expect(wsRequest).toHaveBeenCalledWith('history', {
      ChatId: CHAT_ID,
      Limit: 40,
      MaxTimestamp: 1784117592261029,
    });
  });

  it('next_before = метка самого старого сообщения страницы', async () => {
    const { deps } = makeDeps({
      wsRequest: async () => ({
        Chats: [
          {
            ChatId: CHAT_ID,
            /* Сервер отдаёт страницу от старых к новым */
            Messages: [message(1784117000000000, 'старое'), message(1784117592261029, 'новое')],
          },
        ],
      }),
    });

    const result = await getHistory(deps, { chat: CHAT_ID, limit: 40 });

    if (result.status !== 'ok') throw new Error('ожидался ok');
    expect(result.next_before).toBe('1784117000000000');
    expect(result.has_more).toBe(false);
  });

  it('has_more true, когда сервер отдал ровно limit', async () => {
    const { deps } = makeDeps({
      wsRequest: async () => ({ Chats: [{ ChatId: CHAT_ID, Messages: [message(1784117000000000, 'x')] }] }),
    });

    const result = await getHistory(deps, { chat: CHAT_ID, limit: 1 });

    if (result.status !== 'ok') throw new Error('ожидался ok');
    expect(result.has_more).toBe(true);
  });

  /*
   * Регрессия на ТИХУЮ ПОТЕРЮ ИСТОРИИ: has_more считался по нормализованному массиву,
   * а normalizeMessages выбрасывает элементы без парсящейся метки. Полная страница с одним
   * битым сообщением давала limit-1 -> has_more:false -> вызывающий останавливал пагинацию
   * и терял ВСЮ историю старше этой страницы, ничего об этом не узнав.
   */
  it('has_more остаётся true, когда сервер отдал полную страницу, но элемент не нормализовался', async () => {
    const brokenMessage = {
      ServerMessage: {
        ClientMessage: { Plain: { ChatId: CHAT_ID, Text: { MessageText: 'без метки' } } },
        /* Метки нет -> сообщение неадресуемо -> normalizeMessages его выбросит */
        ServerMessageInfo: { SeqNo: 2, Deleted: false, From: { Guid: 'bbbbbbbb-5555-6666-7777-888888888888' } },
      },
    };
    const { deps } = makeDeps({
      wsRequest: async () => ({
        Chats: [
          {
            ChatId: CHAT_ID,
            Messages: [message(1784117000000000, 'целое'), brokenMessage, message(1784117592261029, 'целое')],
          },
        ],
      }),
    });

    const result = await getHistory(deps, { chat: CHAT_ID, limit: 3 });

    if (result.status !== 'ok') throw new Error('ожидался ok');
    /* Битое до вызывающего не доезжает - это правильно */
    expect(result.messages).toHaveLength(2);
    /* ...но страница БЫЛА полной, значит история продолжается */
    expect(result.has_more).toBe(true);
  });

  it('рефы вложений доезжают до выдачи, но ничего не качается', async () => {
    const { deps } = makeDeps({
      wsRequest: async () => ({
        Chats: [
          {
            ChatId: CHAT_ID,
            Messages: [
              message(1784117592261029, '', {
                Text: undefined,
                Image: { Width: 1, Height: 2, FileInfo: { Id2: 'doc-1', Name: 'p.jpg', Size: 10, Source: 0 } },
              }),
            ],
          },
        ],
      }),
    });

    const result = await getHistory(deps, { chat: CHAT_ID });

    if (result.status !== 'ok') throw new Error('ожидался ok');
    expect(result.messages[0]?.attachments).toEqual([
      { kind: 'image', file_id: 'doc-1', name: 'p.jpg', size: 10, source: 'mds', width: 1, height: 2 },
    ]);
  });

  it('реакции из сиблингов отрисованы через карту; 999999 виден как unknown, выдача не падает, Count сходится', async () => {
    const withReactions = {
      ServerMessage: {
        ClientMessage: { Plain: { ChatId: CHAT_ID, Text: { MessageText: 'с реакциями' } } },
        ServerMessageInfo: {
          Timestamp: 1784287503814009,
          SeqNo: 1,
          LastEditTimestamp: 0,
          Deleted: false,
          From: { Guid: 'bbbbbbbb-5555-6666-7777-888888888888', DisplayName: 'Собеседник' },
        },
        /* Reactions - сиблинг уровня ServerMessage (§11.2), включая неизвестный серверу тип */
        Reactions: [
          { Type: 100102, Count: 3 },
          { Type: 999999, Count: 1 },
        ],
      },
    };
    const { deps } = makeDeps({
      wsRequest: async () => ({ Chats: [{ ChatId: CHAT_ID, Messages: [withReactions] }] }),
    });

    const result = await getHistory(deps, { chat: CHAT_ID, limit: 40 });

    if (result.status !== 'ok') throw new Error('ожидался ok');
    /* Единая форма (ось B1): известный тип - с name/emoji; неизвестный - unknown, но не потерян.
     * Акторов в сиблингах нет -> actors:[], а count>0 -> actors_complete:false */
    expect(result.messages[0]?.reactions).toEqual([
      { type: 100102, name: 'like-ext', emoji: '👍', count: 3, actors: [], actors_complete: false },
      { type: 999999, name: null, emoji: null, unknown: true, count: 1, actors: [], actors_complete: false },
    ]);
    /* Count сходится: сумма показанного = сумме сырого Reactions[].Count */
    const shown = (result.messages[0]?.reactions ?? []).reduce((sum, r) => sum + (r.count ?? 0), 0);
    expect(shown).toBe(4);
  });

  it('query с несколькими совпадениями -> кандидаты, история НЕ запрашивается', async () => {
    const { deps, wsRequest } = makeDeps({
      httpCall: async () => ({
        chats: {
          items: [
            { data: { chat_id: '0/0/11111111-1111-1111-1111-111111111111', name: 'Команда А' } },
            { data: { chat_id: '0/0/22222222-2222-2222-2222-222222222222', name: 'Команда Б' } },
          ],
          total: 2,
          limit: 50,
        },
      }),
    });

    const result = await getHistory(deps, { chat: 'Команда' });

    expect(result.status).toBe('ambiguous_chat');
    if (result.status !== 'ambiguous_chat') throw new Error('ожидались кандидаты');
    expect(result.candidates).toHaveLength(2);
    expect(wsRequest).not.toHaveBeenCalled();
  });

  it('чат не найден -> chat_not_found', async () => {
    const { deps } = makeDeps({ httpCall: async () => ({ chats: { items: [], total: 0 }, users: { items: [], total: 0 } }) });

    const result = await getHistory(deps, { chat: 'кого-нет' });

    expect(result.status).toBe('chat_not_found');
  });
});

describe('search', () => {
  it('сообщения нормализуются той же схемой, что и в get_history', async () => {
    const { deps } = makeDeps({
      httpCall: async () => ({
        messages: {
          /* Живая форма: item.data = {ClientMessage, ServerMessageInfo} без обёртки ServerMessage */
          items: [{ data: message(1784117592261029, 'найденное').ServerMessage }],
          total: 1,
          limit: 50,
        },
      }),
    });

    const result = await search(deps, { query: 'найденное', entities: ['messages'] });

    expect(result.messages).toHaveLength(1);
    expect(result.messages?.[0]?.text).toBe('найденное');
    expect(result.messages?.[0]?.timestamp_mcs).toBe('1784117592261029');
    expect(result.truncated).toBe(false);
  });

  it('users и chats сводятся к плоским хитам', async () => {
    const { deps } = makeDeps({
      httpCall: async () => ({
        users: { items: [{ data: { guid: 'g1', display_name: 'Иван' } }], total: 1, limit: 50 },
        chats: { items: [{ data: { chat_id: '0/0/x', name: 'Команда', members_count: 3 } }], total: 1, limit: 50 },
      }),
    });

    const result = await search(deps, { query: 'x', entities: ['users', 'chats'] });

    /* chat_id для человека сконструирован из пары guid (§5): партнёр 'g1' < MY_GUID нет,
     * значит порядок пары - мой guid первым */
    expect(result.users).toEqual([
      { guid: 'g1', chat_id: `${MY_GUID}_g1`, chat_id_via: 'user_search', name: 'Иван' },
    ]);
    expect(result.chats).toEqual([{ chat_id: '0/0/x', name: 'Команда', members_count: 3 }]);
  });

  it('entities без users не тянет getWhoami: своего guid для сообщений не нужно', async () => {
    const { deps, getWhoami } = makeDeps({
      httpCall: async () => ({ messages: { items: [], total: 0, limit: 50 } }),
    });

    await search(deps, { query: 'x', entities: ['messages'] });

    expect(getWhoami).not.toHaveBeenCalled();
  });

  it('entities с users тянет getWhoami: без него chat_id для человека не собрать', async () => {
    const { deps, getWhoami } = makeDeps({
      httpCall: async () => ({ users: { items: [{ data: { guid: 'g1' } }], total: 1, limit: 50 } }),
    });

    await search(deps, { query: 'x', entities: ['users'] });

    expect(getWhoami).toHaveBeenCalledTimes(1);
  });

  it('эскалация сюрфейсится наружу', async () => {
    let call = 0;
    const { deps } = makeDeps({
      httpCall: async (_m: string, params: Record<string, unknown>) => {
        call += 1;
        const limit = params['limit'] as number;
        const returned = Math.min(limit, 7);
        return { users: { items: Array.from({ length: returned }, () => ({ data: { guid: `g${call}` } })), total: returned, limit } };
      },
    });

    const result = await search(deps, { query: 'терм', entities: ['users'], limit: 5 });

    expect(result.users).toHaveLength(7);
    expect(result.escalation).toEqual({ start_limit: 5, final_limit: 20, requests: 2 });
  });

  it('contacts отвергается до сети', async () => {
    const { deps, httpCall } = makeDeps({});

    await expect(search(deps, { query: 'x', entities: ['contacts' as never] })).rejects.toThrow(/contacts/);
    expect(httpCall).not.toHaveBeenCalled();
  });
});
