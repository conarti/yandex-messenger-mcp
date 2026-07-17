/**
 * send_message против ЖИВОГО сокета (mock-Xiva) и мок-поиска.
 *
 * Почему настоящий сокет, а не мок ws.request: главное утверждение фазы - «на шаге draft
 * в сокет не ушло НИЧЕГО». Мок метода это доказать не может, а посчитанные сервером кадры
 * могут.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAuthProvider } from '../../src/auth/FakeAuthProvider.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import type { ToolDeps } from '../../src/mcp/tools/deps.js';
import {
  resetSentTokens,
  sendMessage,
  type SendMessageDraft,
  type SendMessageSent,
} from '../../src/mcp/tools/sendMessage.js';
import { MessengerWsClient } from '../../src/transport/ws/MessengerWsClient.js';
import { createLogger } from '../../src/util/logger.js';
import { MockXiva, startMockXiva } from '../helpers/mockXiva.js';

const MY_GUID = 'aaaaaaaa-1111-2222-3333-444444444444';
const PARTNER_GUID = 'bbbbbbbb-5555-6666-7777-888888888888';
const CHAT_ID = `${PARTNER_GUID}_${MY_GUID}`;
const OTHER_CHAT_ID = `cccccccc-9999-0000-1111-222222222222_${MY_GUID}`;
const TEXT = 'mcp selftest';

const config = loadConfig({ configDir: mkdtempSync(join(tmpdir(), 'ymm-send-')) });
const logger = createLogger({ level: 'error' });

/** Бакет chats: один точный кандидат -> резолв без неоднозначности */
function chatsHit(chatId: string, name: string) {
  return { chats: { items: [{ data: { chat_id: chatId, name } }], total: 1, limit: 50 } };
}

let mock: MockXiva;
let ws: MessengerWsClient;
let httpCall: ReturnType<typeof vi.fn>;
let deps: ToolDeps;

function makeDeps(searchResult: unknown = chatsHit(CHAT_ID, 'Коллега')): ToolDeps {
  httpCall = vi.fn(async () => searchResult);
  return {
    ws,
    http: { call: httpCall },
    auth: new FakeAuthProvider({ context: { userGuid: MY_GUID } }),
    config,
    logger,
  } as unknown as ToolDeps;
}

/** Отвечает на push заданным commit-статусом */
function pushRespondsWith(payload: Record<string, unknown>): void {
  mock.responders.set('push', (request, connection) => mock.reply(connection, request, payload));
}

async function draft(input: { chat?: string; text?: string } = {}): Promise<SendMessageDraft> {
  const result = await sendMessage(deps, { chat: input.chat ?? 'Коллега', text: input.text ?? TEXT });
  if (result.status !== 'draft') {
    throw new Error(`ожидался draft, получен ${result.status}`);
  }
  return result;
}

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
  deps = makeDeps();
  pushRespondsWith({ Status: 1 });
});

afterEach(async () => {
  ws.close();
  await mock.close();
});

describe('шаг 1: draft', () => {
  it('НЕ отправляет ни одного push-кадра и отдаёт превью с чатом и текстом', async () => {
    await ws.connect();

    const result = await draft();

    expect(mock.requestsOf('push')).toHaveLength(0);
    expect(result).toMatchObject({ status: 'draft', chat_id: CHAT_ID, chat_name: 'Коллега', text: TEXT });
    expect(result.confirm_token).toBeTruthy();
  });

  it('неоднозначный чат -> кандидаты, ни резолва «на удачу», ни отправки', async () => {
    await ws.connect();
    deps = makeDeps({
      chats: {
        items: [{ data: { chat_id: CHAT_ID, name: 'Иван И.' } }, { data: { chat_id: OTHER_CHAT_ID, name: 'Иван П.' } }],
        total: 2,
        limit: 50,
      },
    });

    const result = await sendMessage(deps, { chat: 'Иван', text: TEXT });

    expect(result.status).toBe('ambiguous_chat');
    expect(mock.requestsOf('push')).toHaveLength(0);
  });

  it('чат не найден -> отчёт, а не отправка', async () => {
    await ws.connect();
    deps = makeDeps({ chats: { items: [], total: 0, limit: 50 }, users: { items: [], total: 0, limit: 50 } });

    const result = await sendMessage(deps, { chat: 'нет такого', text: TEXT });

    expect(result).toMatchObject({ status: 'chat_not_found' });
    expect(mock.requestsOf('push')).toHaveLength(0);
  });
});

describe('шаг 2: confirm', () => {
  it('FULLY_COMMITTED(1) -> успех; кадр несёт Plain.Text и subscription-id соединения', async () => {
    const { confirm_token } = await draft();

    const result = (await sendMessage(deps, {
      chat: 'Коллега',
      text: TEXT,
      confirm: true,
      confirm_token,
    })) as SendMessageSent;

    expect(result).toMatchObject({ status: 'sent', chat_id: CHAT_ID, commit_status: 1, duplicate: false });
    const frames = mock.requestsOf('push');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload).toMatchObject({
      ClientTransportId: { XivaSubscriptionId: mock.latest.subscriptionId },
      ClientMessage: { Plain: { ChatId: CHAT_ID, Text: { MessageText: TEXT } } },
      Meta: { Origin: 27 },
    });
  });

  it('DUPLICATE(8) -> идемпотентный успех, а не ошибка', async () => {
    pushRespondsWith({ Status: 8 });
    const { confirm_token } = await draft();

    const result = (await sendMessage(deps, {
      chat: 'Коллега',
      text: TEXT,
      confirm: true,
      confirm_token,
    })) as SendMessageSent;

    expect(result).toMatchObject({ status: 'sent', commit_status: 8, duplicate: true });
  });

  it('разбирает messageInfo и rate_limit.wait_for из ответа', async () => {
    pushRespondsWith({
      Status: 1,
      MessageInfo: { Version: 2, PrevTimestampMcs: 1784117000000000, TimestampMcs: 1784117592261029, SeqNo: 11 },
      RateLimit: { WaitFor: 250 },
    });
    const { confirm_token } = await draft();

    const result = (await sendMessage(deps, {
      chat: 'Коллега',
      text: TEXT,
      confirm: true,
      confirm_token,
    })) as SendMessageSent;

    expect(result.message_info).toEqual({
      version: 2,
      prev_timestamp_mcs: '1784117000000000',
      timestamp_mcs: '1784117592261029',
      seqno: 11,
    });
    expect(result.rate_limit).toEqual({ wait_for: 250 });
  });

  it('некоммитнутый статус -> громкая ошибка и НИКАКОГО авто-ретрая', async () => {
    pushRespondsWith({ Status: 4 });
    const { confirm_token } = await draft();

    await expect(sendMessage(deps, { chat: 'Коллега', text: TEXT, confirm: true, confirm_token })).rejects.toThrow(
      /NO_SUCH_CHAT\(4\)/,
    );
    expect(mock.requestsOf('push')).toHaveLength(1);
  });
});

describe('confirm: ре-верификация (отправка необратима)', () => {
  it('чат резолвится в ДРУГОЙ, чем на draft -> отказ, push не уходит', async () => {
    const { confirm_token } = await draft();
    /* Тот же запрос, но резолв сменился: однофамилец, переименование, новый чат */
    deps = makeDeps(chatsHit(OTHER_CHAT_ID, 'Коллега'));

    await expect(sendMessage(deps, { chat: 'Коллега', text: TEXT, confirm: true, confirm_token })).rejects.toThrow(
      /chat_mismatch/,
    );
    expect(mock.requestsOf('push')).toHaveLength(0);
  });

  it('текст отличается от подтверждённого -> отказ, push не уходит', async () => {
    const { confirm_token } = await draft();

    await expect(
      sendMessage(deps, { chat: 'Коллега', text: `${TEXT} и кое-что ещё`, confirm: true, confirm_token }),
    ).rejects.toThrow(/text_mismatch/);
    expect(mock.requestsOf('push')).toHaveLength(0);
  });

  it('confirm без токена -> отказ, push не уходит', async () => {
    await expect(sendMessage(deps, { chat: 'Коллега', text: TEXT, confirm: true })).rejects.toThrow(/token_missing/);
    expect(mock.requestsOf('push')).toHaveLength(0);
  });

  it('битый токен -> отказ, push не уходит', async () => {
    await expect(
      sendMessage(deps, { chat: 'Коллега', text: TEXT, confirm: true, confirm_token: 'не-токен' }),
    ).rejects.toThrow(/token_malformed/);
    expect(mock.requestsOf('push')).toHaveLength(0);
  });
});

describe('идемпотентность', () => {
  it('повторный confirm тем же токеном НЕ шлёт второй push и отдаёт тот же результат', async () => {
    const { confirm_token } = await draft();
    const first = await sendMessage(deps, { chat: 'Коллега', text: TEXT, confirm: true, confirm_token });

    const second = await sendMessage(deps, { chat: 'Коллега', text: TEXT, confirm: true, confirm_token });

    expect(mock.requestsOf('push')).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('PayloadId фиксирован в токене: повтор придёт серверу тем же id (второй слой дедупликации)', async () => {
    const first = await draft();
    const second = await draft();
    await sendMessage(deps, { chat: 'Коллега', text: TEXT, confirm: true, confirm_token: first.confirm_token });
    resetSentTokens();
    await sendMessage(deps, { chat: 'Коллега', text: TEXT, confirm: true, confirm_token: first.confirm_token });

    const payloadIds = mock
      .requestsOf('push')
      .map((frame) => ((frame.payload['ClientMessage'] as { Plain: { PayloadId: string } }).Plain.PayloadId));

    expect(payloadIds[0]).toBe(payloadIds[1]);
    /* Разные драфты - разные PayloadId: дедупликация не должна склеивать РАЗНЫЕ отправки */
    expect(second.confirm_token).not.toBe(first.confirm_token);
  });
});

describe('готовность соединения (§17.2)', () => {
  it('без кадра subscribed push НЕ уходит: отправка ждёт свежий XivaSubscriptionId', async () => {
    mock.sendSubscribed = false;
    const { confirm_token } = await draft();

    await expect(sendMessage(deps, { chat: 'Коллега', text: TEXT, confirm: true, confirm_token })).rejects.toThrow(
      /subscribed/,
    );
    expect(mock.requestsOf('push')).toHaveLength(0);
  });
});
