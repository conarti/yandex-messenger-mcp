/**
 * Фильтры истории по датам: `from_date`/`to_date`/`after` (ISO -> MinTimestamp/MaxTimestamp).
 *
 * КЛЮЧЕВОЙ ИНВАРИАНТ: верхняя граница `MaxTimestamp` ИСКЛЮЧАЮЩАЯ (§14.2, проверено живьём в v1).
 * Поэтому `to_date` уходит в `MaxTimestamp` КАК ЕСТЬ (без +1): сообщение ровно на to_date НЕ
 * попадает. Мок-сервер здесь честно моделирует эту семантику (строгие границы с обеих сторон),
 * чтобы «сообщение на границе исключено» проверялось поведением, а не только значением параметра.
 * Курсоры/метки - BigInt/number, не float. Фикстуры синтетические.
 */
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/loadConfig.js';
import { loadReactionMap } from '../../src/config/reactionMap.js';
import { createLogger } from '../../src/util/logger.js';
import type { ToolDeps } from '../../src/mcp/tools/deps.js';
import { getHistory } from '../../src/mcp/tools/getHistory.js';
import { isoToMicros } from '../../src/util/timestamps.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MY_GUID = 'aaaaaaaa-1111-2222-3333-444444444444';
const PARTNER_GUID = 'bbbbbbbb-5555-6666-7777-888888888888';
const CHAT_ID = `${PARTNER_GUID}_${MY_GUID}`;

const config = loadConfig({ configDir: mkdtempSync(join(tmpdir(), 'ymm-dates-')) });
const logger = createLogger({ level: 'error' });

const TODAY_START = isoToMicros('2026-07-17T00:00:00.000Z');
const TOMORROW_START = isoToMicros('2026-07-18T00:00:00.000Z');
const TODAY_NOON = isoToMicros('2026-07-17T12:00:00.000Z');
const YESTERDAY = isoToMicros('2026-07-16T12:00:00.000Z');

function historyMessage(ts: bigint, text: string) {
  return {
    ServerMessage: {
      ClientMessage: { Plain: { ChatId: CHAT_ID, Text: { MessageText: text } } },
      ServerMessageInfo: {
        Timestamp: Number(ts),
        SeqNo: 1,
        LastEditTimestamp: 0,
        Deleted: false,
        From: { Guid: PARTNER_GUID, DisplayName: 'Собеседник' },
      },
    },
  };
}

/**
 * Мок-сервер, честно уважающий семантику границ: обе исключающие (§14.2). Возвращает те
 * сообщения фиксированного набора, что попали в окно (MinTimestamp, MaxTimestamp).
 */
function makeDeps(allMessages: Array<{ ts: bigint; text: string }>): {
  deps: ToolDeps;
  wsRequest: ReturnType<typeof vi.fn>;
} {
  const wsRequest = vi.fn(async (_method: string, params: Record<string, unknown> = {}) => {
    const max = params['MaxTimestamp'] as number | undefined;
    const min = params['MinTimestamp'] as number | undefined;
    const passed = allMessages
      .filter((m) => (max === undefined || Number(m.ts) < max) && (min === undefined || Number(m.ts) > min))
      .map((m) => historyMessage(m.ts, m.text));
    return { Chats: [{ ChatId: CHAT_ID, Messages: passed }] } as never;
  });
  const deps = {
    ws: { request: wsRequest },
    http: { call: vi.fn() },
    auth: { getWhoami: async () => ({ uid: '123', guid: MY_GUID }) },
    config,
    logger,
    reactionMap: loadReactionMap(),
  } as unknown as ToolDeps;
  return { deps, wsRequest };
}

describe('get_history: from_date/to_date -> Min/MaxTimestamp', () => {
  it('to_date уезжает в MaxTimestamp КАК ЕСТЬ (без +1) - граница исключающая', async () => {
    const { deps, wsRequest } = makeDeps([{ ts: TODAY_NOON, text: 'сегодня' }]);

    await getHistory(deps, { chat: CHAT_ID, to_date: '2026-07-18T00:00:00.000Z' });

    expect(wsRequest).toHaveBeenCalledWith('history', {
      ChatId: CHAT_ID,
      Limit: 40,
      MaxTimestamp: Number(TOMORROW_START),
    });
  });

  it('from_date включающая: MinTimestamp = дата - 1 (чтобы захватить саму метку)', async () => {
    const { deps, wsRequest } = makeDeps([{ ts: TODAY_NOON, text: 'сегодня' }]);

    await getHistory(deps, { chat: CHAT_ID, from_date: '2026-07-17T00:00:00.000Z' });

    expect(wsRequest).toHaveBeenCalledWith('history', {
      ChatId: CHAT_ID,
      Limit: 40,
      MinTimestamp: Number(TODAY_START) - 1,
    });
  });

  it('«сообщения за сегодня» одним вызовом: сегодняшнее внутри, граничное на to_date ИСКЛЮЧЕНО', async () => {
    const { deps } = makeDeps([
      { ts: YESTERDAY, text: 'вчера' },
      { ts: TODAY_START, text: 'ровно начало дня' },
      { ts: TODAY_NOON, text: 'сегодня днём' },
      /* Сообщение ровно на to_date (начало завтра = верхняя граница) - НЕ должно попасть */
      { ts: TOMORROW_START, text: 'ровно на границе to_date' },
    ]);

    const result = await getHistory(deps, {
      chat: CHAT_ID,
      from_date: '2026-07-17T00:00:00.000Z',
      to_date: '2026-07-18T00:00:00.000Z',
    });

    if (result.status !== 'ok') throw new Error('ожидался ok');
    const texts = result.messages.map((m) => m.text);
    expect(texts).toContain('ровно начало дня');
    expect(texts).toContain('сегодня днём');
    /* Верхняя граница исключающая: сообщение ровно на to_date не попало */
    expect(texts).not.toContain('ровно на границе to_date');
    /* Нижняя включающая, вчерашнее вне окна */
    expect(texts).not.toContain('вчера');
  });
});

describe('get_history: after (строго после) и приоритет курсора', () => {
  it('after уезжает в MinTimestamp КАК ЕСТЬ (строго после метки)', async () => {
    const { deps, wsRequest } = makeDeps([{ ts: TODAY_NOON, text: 'сегодня' }]);

    await getHistory(deps, { chat: CHAT_ID, after: '2026-07-17T00:00:00.000Z' });

    expect(wsRequest).toHaveBeenCalledWith('history', {
      ChatId: CHAT_ID,
      Limit: 40,
      MinTimestamp: Number(TODAY_START),
    });
  });

  it('курсор before приоритетнее to_date для верхней границы', async () => {
    const { deps, wsRequest } = makeDeps([{ ts: TODAY_NOON, text: 'сегодня' }]);

    await getHistory(deps, {
      chat: CHAT_ID,
      before: '1784117592261029',
      to_date: '2026-07-18T00:00:00.000Z',
    });

    expect(wsRequest).toHaveBeenCalledWith('history', {
      ChatId: CHAT_ID,
      Limit: 40,
      MaxTimestamp: 1784117592261029,
    });
  });
});
