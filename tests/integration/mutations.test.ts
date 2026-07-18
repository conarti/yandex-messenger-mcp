/**
 * Реверсибельные мутации (Phase 5) против ЖИВОГО сокета (mock-Xiva): set_reaction,
 * mark_read, pin_message. Настоящий сокет, а не мок ws.request: утверждения фазы -
 * «мусорный тип на провод НЕ уходит», «мутация уходит ОДНИМ push полным конвертом» -
 * доказываются только посчитанными сервером кадрами.
 *
 * Синтетические id, живых данных нет. Формы mark_read/pin доко-выведены (US-009).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAuthProvider } from '../../src/auth/FakeAuthProvider.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { loadReactionMap } from '../../src/config/reactionMap.js';
import type { ToolDeps } from '../../src/mcp/tools/deps.js';
import { markRead } from '../../src/mcp/tools/markRead.js';
import { pinMessage } from '../../src/mcp/tools/pinMessage.js';
import { setReaction } from '../../src/mcp/tools/setReaction.js';
import { MessengerWsClient } from '../../src/transport/ws/MessengerWsClient.js';
import { createLogger } from '../../src/util/logger.js';
import { MockXiva, startMockXiva } from '../helpers/mockXiva.js';

const MY_GUID = 'aaaaaaaa-1111-2222-3333-444444444444';
const PARTNER_GUID = 'bbbbbbbb-5555-6666-7777-888888888888';
/** Приватный ChatId (§5): резолвится как literal, без похода в http */
const CHAT_ID = `${PARTNER_GUID}_${MY_GUID}`;
const MESSAGE_ID = '1784287503814009';
/** Известный тип из reaction-map.json (like-ext / 👍) */
const KNOWN_TYPE = 100102;

const config = loadConfig({ configDir: mkdtempSync(join(tmpdir(), 'ymm-mut-')) });
const logger = createLogger({ level: 'error' });
const reactionMap = loadReactionMap();

let mock: MockXiva;
let ws: MessengerWsClient;
let httpCall: ReturnType<typeof vi.fn>;
let deps: ToolDeps;

function makeDeps(): ToolDeps {
  httpCall = vi.fn(async () => ({}));
  return {
    ws,
    http: { call: httpCall },
    auth: new FakeAuthProvider({ context: { userGuid: MY_GUID } }),
    config,
    logger,
    reactionMap,
  } as unknown as ToolDeps;
}

function pushRespondsWith(payload: Record<string, unknown>): void {
  mock.responders.set('push', (request, connection) => mock.reply(connection, request, payload));
}

/** Элемент history с одним сообщением - чтобы mark_read без message_id взял его метку */
function historyRespondsWithNewest(timestamp: number, seqNo: number): void {
  mock.responders.set('history', (request, connection) =>
    mock.reply(connection, request, {
      Chats: [
        {
          ChatId: CHAT_ID,
          Messages: [
            {
              ServerMessage: {
                ClientMessage: { Plain: { ChatId: CHAT_ID, Text: { MessageText: 'последнее' } } },
                ServerMessageInfo: {
                  Timestamp: timestamp,
                  SeqNo: seqNo,
                  LastEditTimestamp: 0,
                  Deleted: false,
                  From: { Guid: PARTNER_GUID, DisplayName: 'Собеседник' },
                },
              },
            },
          ],
        },
      ],
    }),
  );
}

/** Полезная нагрузка единственного push-кадра */
function pushClientMessage(): Record<string, unknown> {
  const frames = mock.requestsOf('push');
  expect(frames).toHaveLength(1);
  return frames[0]?.payload['ClientMessage'] as Record<string, unknown>;
}

beforeEach(async () => {
  mock = await startMockXiva();
  ws = new MessengerWsClient({
    auth: new FakeAuthProvider({ context: { userGuid: MY_GUID } }),
    xivaUrl: mock.url,
    xivaServiceName: 'messenger-prod',
    requestTimeoutMs: 2_000,
    subscribedTimeoutMs: 1_000,
  });
  deps = makeDeps();
  pushRespondsWith({ Status: 1 });
});

afterEach(async () => {
  ws.close();
  await mock.close();
});

describe('set_reaction: валидация типа ДО отправки', () => {
  it('999999 отвергается на входе: ни push, ни http на провод не уходят', async () => {
    const result = await setReaction(deps, { chat: CHAT_ID, message_id: MESSAGE_ID, type: 999999 });

    expect(result).toMatchObject({ status: 'invalid_type', type: 999999 });
    expect(mock.requestsOf('push')).toHaveLength(0);
    expect(httpCall).not.toHaveBeenCalled();
  });

  it('мусорный 1 отвергается на входе (сервер бы принял - Status:1)', async () => {
    const result = await setReaction(deps, { chat: CHAT_ID, message_id: MESSAGE_ID, type: 1 });

    expect(result).toMatchObject({ status: 'invalid_type', type: 1 });
    expect(mock.requestsOf('push')).toHaveLength(0);
  });
});

describe('set_reaction: известный тип уходит одним вызовом полным конвертом', () => {
  it('ставит реакцию: Reaction ВНУТРИ ClientMessage, Type int, метка числом на проводе, Action не шлётся', async () => {
    const result = await setReaction(deps, { chat: CHAT_ID, message_id: MESSAGE_ID, type: KNOWN_TYPE });

    expect(result).toMatchObject({ status: 'ok', chat_id: CHAT_ID, type: KNOWN_TYPE, action: 'add', commit_status: 1 });
    const clientMessage = pushClientMessage();
    /* Плоская форма исключена: Reaction лежит внутри ClientMessage, не top-level кадра */
    expect(mock.requestsOf('push')[0]?.payload).not.toHaveProperty('Reaction');
    const reaction = clientMessage['Reaction'] as Record<string, unknown>;
    expect(reaction).toEqual({ ChatId: CHAT_ID, Timestamp: Number(MESSAGE_ID), Type: KNOWN_TYPE });
    /* Регресс на тип метки: Timestamp - число на проводе, не строка message_id */
    expect(typeof reaction['Timestamp']).toBe('number');
    expect(clientMessage).toHaveProperty('LogData');
  });

  it('снимает реакцию: Action:REMOVE=1', async () => {
    const result = await setReaction(deps, { chat: CHAT_ID, message_id: MESSAGE_ID, type: KNOWN_TYPE, remove: true });

    expect(result).toMatchObject({ status: 'ok', action: 'remove' });
    expect(pushClientMessage()['Reaction']).toEqual({
      ChatId: CHAT_ID,
      Timestamp: Number(MESSAGE_ID),
      Type: KNOWN_TYPE,
      Action: 1,
    });
  });

  it('некоммитнутый статус -> громкая ошибка, без авто-ретрая', async () => {
    pushRespondsWith({ Status: 4 });

    await expect(setReaction(deps, { chat: CHAT_ID, message_id: MESSAGE_ID, type: KNOWN_TYPE })).rejects.toThrow(
      /NO_SUCH_CHAT\(4\)/,
    );
    expect(mock.requestsOf('push')).toHaveLength(1);
  });
});

describe('mark_read: одним вызовом, форма и эффект подтверждены живьём (US-009)', () => {
  it('с message_id: SeenMarker внутри полного конверта, form_status verified', async () => {
    const result = await markRead(deps, { chat: CHAT_ID, message_id: MESSAGE_ID });

    expect(result).toMatchObject({
      status: 'ok',
      chat_id: CHAT_ID,
      up_to_message_id: MESSAGE_ID,
      marker: 'SeenMarker',
      form_status: 'verified',
    });
    expect(mock.requestsOf('push')[0]?.payload).not.toHaveProperty('SeenMarker');
    const seenMarker = pushClientMessage()['SeenMarker'] as Record<string, unknown>;
    expect(seenMarker).toEqual({ ChatId: CHAT_ID, Timestamp: Number(MESSAGE_ID) });
    /* Регресс на тип метки: Timestamp - число на проводе, не строка message_id */
    expect(typeof seenMarker['Timestamp']).toBe('number');
  });

  it('без message_id: берёт метку самого свежего сообщения (один history + один push)', async () => {
    historyRespondsWithNewest(1784290000000000, 77);

    const result = await markRead(deps, { chat: CHAT_ID });

    expect(result).toMatchObject({ status: 'ok', up_to_message_id: '1784290000000000' });
    expect(mock.requestsOf('history')).toHaveLength(1);
    expect(pushClientMessage()['SeenMarker']).toEqual({
      ChatId: CHAT_ID,
      Timestamp: 1784290000000000,
      SeqNo: 77,
    });
  });

  it('пустой чат: нечего отмечать, push не уходит', async () => {
    mock.responders.set('history', (request, connection) => mock.reply(connection, request, { Chats: [] }));

    const result = await markRead(deps, { chat: CHAT_ID });

    expect(result).toMatchObject({ status: 'empty_chat', chat_id: CHAT_ID });
    expect(mock.requestsOf('push')).toHaveLength(0);
  });
});

describe('pin_message: одним вызовом, семантика подтверждена живьём (US-009)', () => {
  it('закреп: Pin с Timestamp внутри полного конверта, form_status помечен', async () => {
    const result = await pinMessage(deps, { chat: CHAT_ID, message_id: MESSAGE_ID });

    expect(result).toMatchObject({
      status: 'ok',
      action: 'pin',
      message_id: MESSAGE_ID,
      form_status: 'verified',
    });
    expect(mock.requestsOf('push')[0]?.payload).not.toHaveProperty('Pin');
    const pin = pushClientMessage()['Pin'] as Record<string, unknown>;
    expect(pin).toEqual({ ChatId: CHAT_ID, Timestamp: Number(MESSAGE_ID) });
    /* Регресс на тип метки: Timestamp - число на проводе, не строка message_id */
    expect(typeof pin['Timestamp']).toBe('number');
  });

  it('открепление: Pin без Timestamp, action unpin', async () => {
    const result = await pinMessage(deps, { chat: CHAT_ID });

    expect(result).toMatchObject({ status: 'ok', action: 'unpin' });
    expect(pushClientMessage()['Pin']).toEqual({ ChatId: CHAT_ID });
  });
});
