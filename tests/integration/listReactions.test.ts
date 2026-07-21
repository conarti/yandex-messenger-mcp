/**
 * `list_reactions` - полный список «кто и когда» по сообщению (Шаг 5, AC-16).
 *
 * Против мок-транспорта (vi.fn, диспетчеризация по методу) - проверяется склейка
 * (резолв чата -> протокольный listReactions -> сведённая форма), а не сеть. Никаких живых данных.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/loadConfig.js';
import { loadReactionMap } from '../../src/config/reactionMap.js';
import { DEFAULT_LIST_REACTIONS_LIMIT } from '../../src/protocol/reactions.js';
import { listReactions } from '../../src/mcp/tools/listReactions.js';
import type { ToolDeps } from '../../src/mcp/tools/deps.js';
import { createLogger } from '../../src/util/logger.js';

const MY_GUID = 'aaaaaaaa-1111-2222-3333-444444444444';
const PARTNER_GUID = 'bbbbbbbb-5555-6666-7777-888888888888';
const CHAT_ID = `${PARTNER_GUID}_${MY_GUID}`;
const TS = 1784287503814009;
const TS_STR = '1784287503814009';
/** Известный тип из reaction-map.json (like-ext / 👍) */
const KNOWN_TYPE = 100102;

const config = loadConfig({ configDir: mkdtempSync(join(tmpdir(), 'ymm-list-reactions-')) });
const logger = createLogger({ level: 'error' });

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

describe('list_reactions: полный список реакций и прочтений', () => {
  it('отдаёт сведённую форму Reaction[] с actors_complete:true и прочтения, двумя WS-вызовами', async () => {
    const { deps, wsRequest } = makeDeps({
      ws: (method, params) => {
        if (method !== 'list_reactions') return {};
        return params['Mode'] === 1
          ? { UserReads: [{ UserInfo: { Guid: PARTNER_GUID, DisplayName: 'Собеседник' }, Timestamp: TS }], ReadsCount: 1 }
          : {
              UserReactions: [
                { Type: KNOWN_TYPE, UserInfo: { Guid: MY_GUID, DisplayName: 'Я' }, Timestamp: TS },
                { Type: KNOWN_TYPE, UserInfo: { Guid: PARTNER_GUID, DisplayName: 'Собеседник' }, Timestamp: TS },
              ],
            };
      },
    });

    const result = await listReactions(deps, { chat: CHAT_ID, message_id: TS_STR });

    if (result.status !== 'ok') throw new Error(`ожидался ok, получен ${result.status}`);
    expect(result.chat_id).toBe(CHAT_ID);

    /* Ровно два вызова list_reactions: без Mode (реакции) и Mode:1 (прочтения) */
    const listCalls = wsRequest.mock.calls.filter(([m]) => m === 'list_reactions');
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0]?.[1]).toMatchObject({ ChatId: CHAT_ID, Timestamp: TS, Limit: DEFAULT_LIST_REACTIONS_LIMIT });
    expect(listCalls[0]?.[1]?.['Mode']).toBeUndefined();
    expect(listCalls[1]?.[1]).toMatchObject({ Mode: 1, Limit: DEFAULT_LIST_REACTIONS_LIMIT });

    /* Форма реакций - Reaction[] сгруппированный по типу, полный список актёров */
    expect(result.reactions).toHaveLength(1);
    expect(result.reactions[0]?.name).toBe('like-ext');
    expect(result.reactions[0]?.count).toBe(2);
    expect(result.reactions[0]?.actors).toHaveLength(2);
    expect(result.reactions[0]?.actors_complete).toBe(true);

    /* Прочтения - полный список, tracked:true */
    expect(result.reads.tracked).toBe(true);
    expect(result.reads.count).toBe(1);
    expect(result.reads.recent).toHaveLength(1);
    expect(result.reads.recent[0]?.actor.guid).toBe(PARTNER_GUID);
  });

  it('лимит по умолчанию уходит на провод в обоих вызовах, если не передан', async () => {
    const { deps, wsRequest } = makeDeps({
      ws: (method) => (method === 'list_reactions' ? { UserReactions: [] } : {}),
    });

    await listReactions(deps, { chat: CHAT_ID, message_id: TS_STR });

    for (const call of wsRequest.mock.calls.filter(([m]) => m === 'list_reactions')) {
      expect(call[1]).toMatchObject({ Limit: DEFAULT_LIST_REACTIONS_LIMIT });
    }
  });

  it('переданный limit уходит на провод в обоих вызовах', async () => {
    const { deps, wsRequest } = makeDeps({
      ws: (method) => (method === 'list_reactions' ? { UserReactions: [] } : {}),
    });

    await listReactions(deps, { chat: CHAT_ID, message_id: TS_STR, limit: 10 });

    for (const call of wsRequest.mock.calls.filter(([m]) => m === 'list_reactions')) {
      expect(call[1]).toMatchObject({ Limit: 10 });
    }
  });

  it('невалидный limit (<=0) отклоняется на входе, на провод не уходит', async () => {
    const { deps, wsRequest } = makeDeps({});

    await expect(listReactions(deps, { chat: CHAT_ID, message_id: TS_STR, limit: 0 })).rejects.toThrow(RangeError);
    expect(wsRequest.mock.calls.filter(([m]) => m === 'list_reactions')).toHaveLength(0);
  });

  it('invite_hash пробрасывается в оба вызова', async () => {
    const { deps, wsRequest } = makeDeps({
      ws: (method) => (method === 'list_reactions' ? { UserReactions: [] } : {}),
    });

    await listReactions(deps, { chat: CHAT_ID, message_id: TS_STR, invite_hash: 'hash-1' });

    for (const call of wsRequest.mock.calls.filter(([m]) => m === 'list_reactions')) {
      expect(call[1]).toMatchObject({ InviteHash: 'hash-1' });
    }
  });
});
