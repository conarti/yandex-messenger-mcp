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
import { loadReactionMap } from '../../src/config/reactionMap.js';
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
const MENTION_GUID_A = 'dddddddd-1111-2222-3333-444444444444';
const MENTION_GUID_B = 'eeeeeeee-5555-6666-7777-888888888888';
const TEXT = 'mcp selftest';

const config = loadConfig({ configDir: mkdtempSync(join(tmpdir(), 'ymm-send-')) });
const logger = createLogger({ level: 'error' });
const reactionMap = loadReactionMap();

/* 16 цифр, < 2^53: метка цели reply в том же чате */
const REPLY_TARGET_ID = '1784117592261029';

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
    reactionMap,
  } as unknown as ToolDeps;
}

/** Отвечает на push заданным commit-статусом */
function pushRespondsWith(payload: Record<string, unknown>): void {
  mock.responders.set('push', (request, connection) => mock.reply(connection, request, payload));
}

/** message_info-ответ: цель reply в CHAT_ID с заданным текстом (draft/confirm перечитывают им цитату) */
function messageInfoResponds(text: string): void {
  mock.responders.set('message_info', (request, connection) =>
    mock.reply(connection, request, {
      Message: {
        ClientMessage: { Plain: { ChatId: CHAT_ID, Text: { MessageText: text } } },
        ServerMessageInfo: {
          Timestamp: Number(REPLY_TARGET_ID),
          SeqNo: 5,
          LastEditTimestamp: 0,
          Deleted: false,
          From: { Guid: PARTNER_GUID, DisplayName: 'Коллега' },
        },
      },
    }),
  );
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
    ).rejects.toThrow(/fingerprint_mismatch/);
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

describe('упоминания: резолв только на draft (ось D1, §6.4)', () => {
  /** Комбинированный ответ поиска: чат-бакет для resolveChat, users-бакет для resolveMention */
  function userBucket(items: unknown[]) {
    return { users: { items, total: items.length, limit: 50 } };
  }

  it('неоднозначное @Имя -> ambiguous_mention, ни резолва «на удачу», ни push', async () => {
    deps = makeDeps({
      chats: { items: [{ data: { chat_id: CHAT_ID, name: 'Коллега' } }], total: 1, limit: 50 },
      users: {
        items: [
          { data: { guid: MENTION_GUID_A, display_name: 'Иван П.' } },
          { data: { guid: MENTION_GUID_B, display_name: 'Иван С.' } },
        ],
        total: 2,
        limit: 50,
      },
    });

    const result = await sendMessage(deps, { chat: 'Коллега', text: 'привет @Иван', mentions: ['Иван'] });

    expect(result.status).toBe('ambiguous_mention');
    if (result.status !== 'ambiguous_mention') throw new Error('ожидался ambiguous_mention');
    expect(result.query).toBe('Иван');
    expect(result.candidates.map((candidate) => candidate.guid)).toEqual([MENTION_GUID_A, MENTION_GUID_B]);
    /* Неоднозначность блокирует отправку: ни одного push-кадра сокет не видел */
    expect(mock.requestsOf('push')).toHaveLength(0);
  });

  it('draft резолвит @Имя и всегда несёт mentions [{guid, name}]', async () => {
    deps = makeDeps(userBucket([{ data: { guid: PARTNER_GUID, display_name: 'Иван' } }]));

    const result = await sendMessage(deps, { chat: CHAT_ID, text: 'привет @Иван', mentions: ['Иван'] });

    expect(result.status).toBe('draft');
    if (result.status !== 'draft') throw new Error('ожидался draft');
    expect(result.mentions).toEqual([{ guid: PARTNER_GUID, name: 'Иван' }]);
    expect(mock.requestsOf('push')).toHaveLength(0);
  });

  it('без упоминаний draft несёт пустой массив mentions (поле присутствует всегда)', async () => {
    deps = makeDeps(userBucket([]));

    const result = await sendMessage(deps, { chat: CHAT_ID, text: TEXT });

    expect(result.status).toBe('draft');
    if (result.status !== 'draft') throw new Error('ожидался draft');
    expect(result.mentions).toEqual([]);
  });

  it('confirm БЕЗ предъявленных mentions -> fingerprint_mismatch; резолв на confirm не вызывается', async () => {
    deps = makeDeps(userBucket([{ data: { guid: PARTNER_GUID, display_name: 'Иван' } }]));
    const draftResult = await sendMessage(deps, { chat: CHAT_ID, text: 'привет @Иван', mentions: ['Иван'] });
    if (draftResult.status !== 'draft') throw new Error('ожидался draft');
    /* Литеральный ChatId не ищется, поэтому единственный http-вызов - резолв упоминания на draft */
    const httpCallsAfterDraft = httpCall.mock.calls.length;

    await expect(
      sendMessage(deps, { chat: CHAT_ID, text: 'привет @Иван', confirm: true, confirm_token: draftResult.confirm_token }),
    ).rejects.toThrow(/fingerprint_mismatch/);
    /* confirm не резолвит упоминания: мок поиска не тронут ни разу сверх draft */
    expect(httpCall.mock.calls.length).toBe(httpCallsAfterDraft);
    expect(mock.requestsOf('push')).toHaveLength(0);
  });

  it('confirm с предъявленными guid отправляет MentionedUserIds, повторного резолва нет', async () => {
    await ws.connect();
    deps = makeDeps(userBucket([{ data: { guid: PARTNER_GUID, display_name: 'Иван' } }]));
    const draftResult = await sendMessage(deps, { chat: CHAT_ID, text: 'привет @Иван', mentions: ['Иван'] });
    if (draftResult.status !== 'draft') throw new Error('ожидался draft');
    const guids = draftResult.mentions.map((mention) => mention.guid);
    const httpCallsAfterDraft = httpCall.mock.calls.length;

    /* Эхом возвращается КАНОНИЧЕСКИЙ draft.text - он уже несёт токен, и отпечаток совпадает */
    const result = (await sendMessage(deps, {
      chat: CHAT_ID,
      text: draftResult.text,
      mentions: guids,
      confirm: true,
      confirm_token: draftResult.confirm_token,
    })) as SendMessageSent;

    expect(result.status).toBe('sent');
    /* confirm принимает guid литералами и не ищет: ни одного нового http-вызова */
    expect(httpCall.mock.calls.length).toBe(httpCallsAfterDraft);
    const frames = mock.requestsOf('push');
    expect(frames).toHaveLength(1);
    const plain = (frames[0]?.payload['ClientMessage'] as { Plain: Record<string, unknown> }).Plain;
    /* На провод уходит именно draft.text, а НЕ превью: ассерт явный, иначе он двусмыслен */
    expect(plain).toMatchObject({
      ChatId: CHAT_ID,
      Text: { MessageText: `привет @${PARTNER_GUID}` },
      MentionedUserIds: guids,
    });
    expect(draftResult.text).toBe(`привет @${PARTNER_GUID}`);
  });

  it('confirm с guid не в формате -> malformed_guid до отпечатка, push не уходит', async () => {
    deps = makeDeps(userBucket([{ data: { guid: PARTNER_GUID, display_name: 'Иван' } }]));
    const draftResult = await sendMessage(deps, { chat: CHAT_ID, text: 'привет @Иван', mentions: ['Иван'] });
    if (draftResult.status !== 'draft') throw new Error('ожидался draft');

    await expect(
      sendMessage(deps, {
        chat: CHAT_ID,
        text: 'привет @Иван',
        mentions: ['не-валидный-guid'],
        confirm: true,
        confirm_token: draftResult.confirm_token,
      }),
    ).rejects.toThrow(/malformed_guid/);
    expect(mock.requestsOf('push')).toHaveLength(0);
  });
});

describe('подстановка токена упоминания и поле превью (#15, П-3)', () => {
  function userBucket(items: unknown[]) {
    return { users: { items, total: items.length, limit: 50 } };
  }

  const ivanBucket = () => userBucket([{ data: { guid: PARTNER_GUID, display_name: 'Иван' } }]);

  it('каждый @<guid> из draft.text присутствует в draft.mentions[].guid', async () => {
    deps = makeDeps(ivanBucket());

    const result = await sendMessage(deps, { chat: CHAT_ID, text: 'привет @Иван и снова @Иван', mentions: ['Иван'] });

    if (result.status !== 'draft') throw new Error('ожидался draft');
    const inText = [...result.text.matchAll(/@([0-9a-f-]{36})/g)].map((match) => match[1]);
    const declared = new Set(result.mentions.map((mention) => mention.guid));
    expect(inText).toHaveLength(2);
    /* Порядки независимы по построению: сверяется принадлежность составу, а не совпадение позиций */
    expect(inText.every((guid) => guid !== undefined && declared.has(guid))).toBe(true);
  });

  it('text_preview показывает имена и присутствует, когда подстановка применилась', async () => {
    deps = makeDeps(ivanBucket());

    const result = await sendMessage(deps, { chat: CHAT_ID, text: 'привет @Иван', mentions: ['Иван'] });

    if (result.status !== 'draft') throw new Error('ожидался draft');
    expect(result.text).toBe(`привет @${PARTNER_GUID}`);
    expect(result.text_preview).toBe('привет @Иван');
    expect(result.next_step).toContain('эхом возвращайте text, а не text_preview');
  });

  it('text_preview отсутствует, когда названный запрос в тексте не встретился', async () => {
    deps = makeDeps(ivanBucket());

    const result = await sendMessage(deps, { chat: CHAT_ID, text: 'привет всем', mentions: ['Иван'] });

    if (result.status !== 'draft') throw new Error('ожидался draft');
    expect(result.text).toBe('привет всем');
    expect(result).not.toHaveProperty('text_preview');
    expect(result.next_step).not.toContain('text_preview');
  });

  it('эхо text_preview вместо text на confirm -> fingerprint_mismatch, push не уходит', async () => {
    deps = makeDeps(ivanBucket());
    const draftResult = await sendMessage(deps, { chat: CHAT_ID, text: 'привет @Иван', mentions: ['Иван'] });
    if (draftResult.status !== 'draft') throw new Error('ожидался draft');
    const preview = draftResult.text_preview;
    if (preview === undefined) throw new Error('ожидалось text_preview');

    await expect(
      sendMessage(deps, {
        chat: CHAT_ID,
        text: preview,
        mentions: draftResult.mentions.map((mention) => mention.guid),
        confirm: true,
        confirm_token: draftResult.confirm_token,
      }),
    ).rejects.toThrow(/fingerprint_mismatch/);
    expect(mock.requestsOf('push')).toHaveLength(0);
  });

  it('два разных запроса в один guid подставляются ОБА, состав упоминаний остаётся схлопнутым', async () => {
    /* Мок поиска отдаёт того же человека на любой запрос: `Ваня` и `Иван` схлопываются в один guid */
    deps = makeDeps(ivanBucket());

    const result = await sendMessage(deps, {
      chat: CHAT_ID,
      text: '@Ваня и @Иван',
      mentions: ['Ваня', 'Иван'],
    });

    if (result.status !== 'draft') throw new Error('ожидался draft');
    expect(result.text).toBe(`@${PARTNER_GUID} и @${PARTNER_GUID}`);
    expect(result.mentions).toEqual([{ guid: PARTNER_GUID, name: 'Иван' }]);
  });

  it('текст без названных упоминаний уходит байт в байт, превью не появляется', async () => {
    deps = makeDeps(userBucket([]));

    const result = await sendMessage(deps, { chat: CHAT_ID, text: 'пиши на ivan@yandex.ru, @channel' });

    if (result.status !== 'draft') throw new Error('ожидался draft');
    expect(result.text).toBe('пиши на ivan@yandex.ru, @channel');
    expect(result).not.toHaveProperty('text_preview');
  });
});

describe('reply: цитата с сервера, вне отпечатка (ось D, §6.2, AC-4/AC-5)', () => {
  it('draft: перечитывает цель и показывает цитату из ответа сервера, push не уходит', async () => {
    messageInfoResponds('исходное сообщение собеседника');

    const result = await sendMessage(deps, {
      chat: CHAT_ID,
      text: 'мой ответ',
      reply_to_message_id: REPLY_TARGET_ID,
    });

    expect(result.status).toBe('draft');
    if (result.status !== 'draft') throw new Error('ожидался draft');
    expect(result.reply_quote).toBe('исходное сообщение собеседника');
    expect(result.quote_truncated).toBe(false);
    /* Один WS-read цели, ни одного push */
    expect(mock.requestsOf('message_info')).toHaveLength(1);
    expect(mock.requestsOf('push')).toHaveLength(0);
  });

  it('draft: цитата длиннее 200 обрезается, quote_truncated виден', async () => {
    messageInfoResponds('я'.repeat(250));

    const result = await sendMessage(deps, { chat: CHAT_ID, text: 'ответ', reply_to_message_id: REPLY_TARGET_ID });

    if (result.status !== 'draft') throw new Error('ожидался draft');
    expect(result.quote_truncated).toBe(true);
    expect(result.reply_quote).toBe('я'.repeat(200) + '…');
  });

  it('confirm: собирает Quote из ОТВЕТА СЕРВЕРА (не из ввода), ref+quote в push-кадре', async () => {
    await ws.connect();
    messageInfoResponds('слова собеседника');
    const draftResult = await sendMessage(deps, { chat: CHAT_ID, text: 'мой ответ', reply_to_message_id: REPLY_TARGET_ID });
    if (draftResult.status !== 'draft') throw new Error('ожидался draft');

    const result = (await sendMessage(deps, {
      chat: CHAT_ID,
      text: 'мой ответ',
      reply_to_message_id: REPLY_TARGET_ID,
      confirm: true,
      confirm_token: draftResult.confirm_token,
    })) as SendMessageSent;

    expect(result.status).toBe('sent');
    const frames = mock.requestsOf('push');
    expect(frames).toHaveLength(1);
    const plain = (frames[0]?.payload['ClientMessage'] as { Plain: Record<string, unknown> }).Plain;
    expect(plain).toMatchObject({
      ChatId: CHAT_ID,
      Text: { MessageText: 'мой ответ' },
      ForwardedMessageRefs: [{ ChatId: CHAT_ID, Timestamp: Number(REPLY_TARGET_ID) }],
      ForwardedMessageStyles: [{ Quote: 'слова собеседника' }],
    });
  });

  it('правка ТЕКСТА цели между draft и confirm НЕ отвергает отправку (цитата вне отпечатка §6.2)', async () => {
    await ws.connect();
    messageInfoResponds('старый текст цели');
    const draftResult = await sendMessage(deps, { chat: CHAT_ID, text: 'мой ответ', reply_to_message_id: REPLY_TARGET_ID });
    if (draftResult.status !== 'draft') throw new Error('ожидался draft');
    expect(draftResult.reply_quote).toBe('старый текст цели');

    /* Цель отредактирована: сервер отдаёт НОВЫЙ текст. Цитата в отпечаток не входит -> отправка проходит */
    messageInfoResponds('НОВЫЙ текст цели после правки');

    const result = (await sendMessage(deps, {
      chat: CHAT_ID,
      text: 'мой ответ',
      reply_to_message_id: REPLY_TARGET_ID,
      confirm: true,
      confirm_token: draftResult.confirm_token,
    })) as SendMessageSent;

    expect(result.status).toBe('sent');
    const plain = (mock.requestsOf('push')[0]?.payload['ClientMessage'] as { Plain: Record<string, unknown> }).Plain;
    /* Quote собрана из НОВОГО ответа сервера на confirm, а не из draft */
    expect(plain).toMatchObject({ ForwardedMessageStyles: [{ Quote: 'НОВЫЙ текст цели после правки' }] });
  });

  it('смена reply_to_message_id между draft и confirm ОТВЕРГАЕТ (входит в отпечаток §6.1)', async () => {
    await ws.connect();
    messageInfoResponds('текст цели');
    const draftResult = await sendMessage(deps, { chat: CHAT_ID, text: 'мой ответ', reply_to_message_id: REPLY_TARGET_ID });
    if (draftResult.status !== 'draft') throw new Error('ожидался draft');

    await expect(
      sendMessage(deps, {
        chat: CHAT_ID,
        text: 'мой ответ',
        reply_to_message_id: '1784117592261030',
        confirm: true,
        confirm_token: draftResult.confirm_token,
      }),
    ).rejects.toThrow(/fingerprint_mismatch/);
    expect(mock.requestsOf('push')).toHaveLength(0);
  });
});
