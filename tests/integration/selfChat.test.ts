/**
 * Self-чат («Избранное») адресуем по имени через get_history (Phase 8, AC-30).
 *
 * Раньше резолв отбрасывал самого пользователя как собеседника, и «Избранное» было достижимо
 * только литеральным ChatId. Теперь `get_history` по имени «Избранное» резолвит self-чат
 * `<myGuid>_<myGuid>` (гейт спайка 5: PrivateChatInfo + PartnerInfo.Guid === myGuid) и отдаёт
 * его историю. Фикстуры синтетические.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/loadConfig.js';
import { loadReactionMap } from '../../src/config/reactionMap.js';
import { createLogger } from '../../src/util/logger.js';
import type { ToolDeps } from '../../src/mcp/tools/deps.js';
import { getHistory } from '../../src/mcp/tools/getHistory.js';

const MY_GUID = 'aaaaaaaa-1111-2222-3333-444444444444';
const SELF_CHAT_ID = `${MY_GUID}_${MY_GUID}`;
const MESSAGE_TS = 1784287503814009;

const config = loadConfig({ configDir: mkdtempSync(join(tmpdir(), 'ymm-self-')) });
const logger = createLogger({ level: 'error' });

/** Элемент бакета chats: self-чат по гейту спайка 5 (без chat_id в выдаче поиска) */
const selfChatSearchItem = { data: { name: 'Избранное', PrivateChatInfo: {}, PartnerInfo: { Guid: MY_GUID } } };

function makeDeps(): { deps: ToolDeps; httpCall: ReturnType<typeof vi.fn>; wsRequest: ReturnType<typeof vi.fn> } {
  const httpCall = vi.fn(async (_method: string, params: Record<string, unknown> = {}) => {
    const entity = (params['entities'] as string[] | undefined)?.[0];
    const items = entity === 'chats' ? [selfChatSearchItem] : [];
    return { [entity ?? 'chats']: { items, total: items.length, limit: params['limit'], page: 1, pages: 1 } };
  });
  const wsRequest = vi.fn(async (_method: string, _params: Record<string, unknown> = {}) => {
    return {
      Chats: [
        {
          ChatId: SELF_CHAT_ID,
          Messages: [
            {
              ServerMessage: {
                ClientMessage: { Plain: { ChatId: SELF_CHAT_ID, Text: { MessageText: 'заметка себе' } } },
                ServerMessageInfo: {
                  Timestamp: MESSAGE_TS,
                  SeqNo: 1,
                  LastEditTimestamp: 0,
                  Deleted: false,
                  From: { Guid: MY_GUID, DisplayName: 'Я' },
                },
              },
            },
          ],
        },
      ],
    } as never;
  });
  const deps = {
    ws: { request: wsRequest },
    http: { call: httpCall },
    auth: { getWhoami: async () => ({ uid: '123', guid: MY_GUID }) },
    config,
    logger,
    reactionMap: loadReactionMap(),
  } as unknown as ToolDeps;
  return { deps, httpCall, wsRequest };
}

describe('get_history по имени «Избранное» отдаёт self-чат (AC-30)', () => {
  it('резолвит self-ChatId <myGuid>_<myGuid> и возвращает его историю', async () => {
    const { deps, wsRequest } = makeDeps();

    const result = await getHistory(deps, { chat: 'Избранное' });

    if (result.status !== 'ok') {
      throw new Error(`ожидался ok, получен ${result.status}`);
    }
    expect(result.chat_id).toBe(SELF_CHAT_ID);
    expect(result.messages.map((m) => m.text)).toContain('заметка себе');
    /* История запрошена именно по self-ChatId, а не по строке «Избранное» */
    expect(wsRequest).toHaveBeenCalledWith('history', expect.objectContaining({ ChatId: SELF_CHAT_ID }));
  });
});
