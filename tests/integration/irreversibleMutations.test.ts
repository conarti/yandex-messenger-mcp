/**
 * Необратимые мутации (Phase 6) против ЖИВОГО сокета (mock-Xiva): delete_message, edit_message,
 * vote_in_poll (draft->confirm) + чтение опроса get_poll (read, без confirm).
 *
 * Настоящий сокет, а не мок ws.request: главные утверждения фазы - «draft НЕ мутирует» (в сокет
 * не ушёл ни один push-кадр) и «confirm мутирует одним push полным конвертом» - доказываются
 * только посчитанными сервером кадрами. draft-превью строится ЧТЕНИЕМ (message_info), поэтому в
 * draft допустим read-кадр, но не push.
 *
 * Синтетические id, живых данных нет. Форма vote ДОКО-ВЫВЕДЕНА (experimental_unverified).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAuthProvider } from '../../src/auth/FakeAuthProvider.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { loadReactionMap } from '../../src/config/reactionMap.js';
import { resetConfirmMemory } from '../../src/mcp/confirm.js';
import type { ToolDeps } from '../../src/mcp/tools/deps.js';
import {
  deleteMessage,
  type DeleteMessageDraft,
  type DeleteMessageDeleted,
} from '../../src/mcp/tools/deleteMessage.js';
import { editMessage, type EditMessageDraft, type EditMessageEdited } from '../../src/mcp/tools/editMessage.js';
import { getPoll } from '../../src/mcp/tools/getPoll.js';
import { voteInPoll, type VoteInPollDraft, type VoteInPollVoted } from '../../src/mcp/tools/voteInPoll.js';
import { getMessageInfo } from '../../src/protocol/messageInfo.js';
import { MessengerWsClient } from '../../src/transport/ws/MessengerWsClient.js';
import { createLogger } from '../../src/util/logger.js';
import { MockXiva, startMockXiva } from '../helpers/mockXiva.js';

const MY_GUID = 'aaaaaaaa-1111-2222-3333-444444444444';
const PARTNER_GUID = 'bbbbbbbb-5555-6666-7777-888888888888';
/** Приватный ChatId (§5): резолвится как literal, без похода в http */
const CHAT_ID = `${PARTNER_GUID}_${MY_GUID}`;
const MESSAGE_ID = '1784287503814009';

const config = loadConfig({ configDir: mkdtempSync(join(tmpdir(), 'ymm-irr-')) });
const logger = createLogger({ level: 'error' });
const reactionMap = loadReactionMap();

let mock: MockXiva;
let ws: MessengerWsClient;
let deps: ToolDeps;

function makeDeps(): ToolDeps {
  return {
    ws,
    http: { call: vi.fn(async () => ({})) },
    auth: new FakeAuthProvider({ context: { userGuid: MY_GUID } }),
    config,
    logger,
    reactionMap,
  } as unknown as ToolDeps;
}

/** message_info-ответ: сообщение с заданным телом/флагами (draft перечитывает им превью) */
function messageInfoResponds(fields: {
  text?: string;
  fromGuid?: string;
  deleted?: boolean;
  lastEdit?: number;
} = {}): void {
  const { text = 'исходный текст', fromGuid = MY_GUID, deleted = false, lastEdit = 0 } = fields;
  mock.responders.set('message_info', (request, connection) =>
    mock.reply(connection, request, {
      Message: {
        ClientMessage: {
          Plain: { ChatId: CHAT_ID, ...(deleted ? {} : { Text: { MessageText: text } }) },
        },
        ServerMessageInfo: {
          Timestamp: Number(MESSAGE_ID),
          SeqNo: 7,
          LastEditTimestamp: lastEdit,
          Deleted: deleted,
          From: { Guid: fromGuid, DisplayName: 'Автор' },
        },
      },
    }),
  );
}

function pollInfoResponds(payload: Record<string, unknown>): void {
  mock.responders.set('poll_info', (request, connection) => mock.reply(connection, request, payload));
}

function pushRespondsWith(payload: Record<string, unknown>): void {
  mock.responders.set('push', (request, connection) => mock.reply(connection, request, payload));
}

/** ClientMessage единственного push-кадра */
function pushClientMessage(): Record<string, unknown> {
  const frames = mock.requestsOf('push');
  expect(frames).toHaveLength(1);
  return frames[0]?.payload['ClientMessage'] as Record<string, unknown>;
}

beforeEach(async () => {
  resetConfirmMemory();
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
  messageInfoResponds();
});

afterEach(async () => {
  ws.close();
  await mock.close();
});

describe('delete_message: draft не удаляет, confirm удаляет (AC-12)', () => {
  it('draft: показывает удаляемое (автор/время/текст) и НЕ шлёт push', async () => {
    messageInfoResponds({ text: 'сообщение на удаление', fromGuid: MY_GUID });

    const result = (await deleteMessage(deps, { chat: CHAT_ID, message_id: MESSAGE_ID })) as DeleteMessageDraft;

    expect(result.status).toBe('draft');
    expect(result.target.text).toBe('сообщение на удаление');
    expect(result.target.from_guid).toBe(MY_GUID);
    expect(result.target.timestamp_mcs).toBe(MESSAGE_ID);
    expect(result.confirm_token).toBeTruthy();
    /* draft перечитал сообщение (read), но ничего не удалил (нет push) */
    expect(mock.requestsOf('message_info')).toHaveLength(1);
    expect(mock.requestsOf('push')).toHaveLength(0);
  });

  it('confirm: пустой Plain{ChatId, Timestamp} ВНУТРИ ClientMessage, одним push', async () => {
    const draft = (await deleteMessage(deps, { chat: CHAT_ID, message_id: MESSAGE_ID })) as DeleteMessageDraft;

    const result = (await deleteMessage(deps, {
      chat: CHAT_ID,
      message_id: MESSAGE_ID,
      confirm: true,
      confirm_token: draft.confirm_token,
    })) as DeleteMessageDeleted;

    expect(result).toMatchObject({ status: 'deleted', chat_id: CHAT_ID, message_id: MESSAGE_ID, commit_status: 1 });
    expect(mock.requestsOf('push')[0]?.payload).not.toHaveProperty('Plain');
    expect(pushClientMessage()['Plain']).toEqual({ ChatId: CHAT_ID, Timestamp: MESSAGE_ID });
    /* Удаление = пустой Plain: content-поля нет */
    expect(pushClientMessage()['Plain']).not.toHaveProperty('Text');
  });

  it('после удаления повторное чтение приходит с Deleted=true', async () => {
    messageInfoResponds({ deleted: true });

    const info = await getMessageInfo(
      ws,
      { chatId: CHAT_ID, timestamp: MESSAGE_ID },
      { myGuid: MY_GUID, reactionMap },
    );

    expect(info.message.deleted).toBe(true);
  });

  it('чужое сообщение: серверный отказ (NO_PERMISSION) смаплен внятно, не своя выдумка', async () => {
    pushRespondsWith({ Status: 15 });
    const draft = (await deleteMessage(deps, { chat: CHAT_ID, message_id: MESSAGE_ID })) as DeleteMessageDraft;

    await expect(
      deleteMessage(deps, { chat: CHAT_ID, message_id: MESSAGE_ID, confirm: true, confirm_token: draft.confirm_token }),
    ).rejects.toThrow(/NO_PERMISSION\(15\)/);
    /* Confirm попробовал отправить ровно один раз, авто-ретрая нет */
    expect(mock.requestsOf('push')).toHaveLength(1);
  });

  it('кросс-op: delete-токен, предъявленный edit, отвергается op_mismatch, push не уходит', async () => {
    const draft = (await deleteMessage(deps, { chat: CHAT_ID, message_id: MESSAGE_ID })) as DeleteMessageDraft;

    await expect(
      editMessage(deps, {
        chat: CHAT_ID,
        message_id: MESSAGE_ID,
        new_text: 'подмена',
        confirm: true,
        confirm_token: draft.confirm_token,
      }),
    ).rejects.toThrow(/op_mismatch/);
    expect(mock.requestsOf('push')).toHaveLength(0);
  });
});

describe('edit_message: draft «было -> станет» не правит, confirm правит (AC-19)', () => {
  it('draft: was_text/will_text и НИ одного push', async () => {
    messageInfoResponds({ text: 'старый текст' });

    const result = (await editMessage(deps, {
      chat: CHAT_ID,
      message_id: MESSAGE_ID,
      new_text: 'новый текст',
    })) as EditMessageDraft;

    expect(result.status).toBe('draft');
    expect(result.was_text).toBe('старый текст');
    expect(result.will_text).toBe('новый текст');
    expect(mock.requestsOf('push')).toHaveLength(0);
  });

  it('confirm: Plain{ChatId, Timestamp, Text} ВНУТРИ ClientMessage, одним push', async () => {
    const draft = (await editMessage(deps, {
      chat: CHAT_ID,
      message_id: MESSAGE_ID,
      new_text: 'новый текст',
    })) as EditMessageDraft;

    const result = (await editMessage(deps, {
      chat: CHAT_ID,
      message_id: MESSAGE_ID,
      new_text: 'новый текст',
      confirm: true,
      confirm_token: draft.confirm_token,
    })) as EditMessageEdited;

    expect(result).toMatchObject({ status: 'edited', chat_id: CHAT_ID, new_text: 'новый текст', commit_status: 1 });
    expect(mock.requestsOf('push')[0]?.payload).not.toHaveProperty('Plain');
    expect(pushClientMessage()['Plain']).toEqual({
      ChatId: CHAT_ID,
      Timestamp: MESSAGE_ID,
      Text: { MessageText: 'новый текст' },
    });
  });

  it('текст на confirm отличается от подтверждённого -> fingerprint_mismatch, push не уходит', async () => {
    const draft = (await editMessage(deps, {
      chat: CHAT_ID,
      message_id: MESSAGE_ID,
      new_text: 'новый текст',
    })) as EditMessageDraft;

    await expect(
      editMessage(deps, {
        chat: CHAT_ID,
        message_id: MESSAGE_ID,
        new_text: 'ДРУГОЙ текст',
        confirm: true,
        confirm_token: draft.confirm_token,
      }),
    ).rejects.toThrow(/fingerprint_mismatch/);
    expect(mock.requestsOf('push')).toHaveLength(0);
  });

  it('после правки чтение приходит с новым текстом и непустым LastEditTimestamp', async () => {
    messageInfoResponds({ text: 'новый текст', lastEdit: Number(MESSAGE_ID) + 1000 });

    const info = await getMessageInfo(
      ws,
      { chatId: CHAT_ID, timestamp: MESSAGE_ID },
      { myGuid: MY_GUID, reactionMap },
    );

    expect(info.message.text).toBe('новый текст');
    expect(info.message.edited).toBe(true);
    expect(info.message.edited_at).toBeTruthy();
  });
});

describe('vote_in_poll: draft->confirm, форма experimental (AC-29 условный, AC-31)', () => {
  it('draft: form_status experimental_unverified присутствует, голос НЕ отправлен', async () => {
    const result = (await voteInPoll(deps, {
      chat: CHAT_ID,
      message_id: MESSAGE_ID,
      choices: [0, 2],
    })) as VoteInPollDraft;

    expect(result.status).toBe('draft');
    /* Предупреждение о непроверенной форме стоит в точке необратимого действия, не только в README */
    expect(result.form_status).toBe('experimental_unverified');
    expect(result.choices).toEqual([0, 2]);
    expect(mock.requestsOf('push')).toHaveLength(0);
  });

  it('confirm: form_status experimental_unverified присутствует И В ВЫВОДЕ confirm; Vote одним push', async () => {
    const draft = (await voteInPoll(deps, {
      chat: CHAT_ID,
      message_id: MESSAGE_ID,
      choices: [0, 2],
    })) as VoteInPollDraft;

    const result = (await voteInPoll(deps, {
      chat: CHAT_ID,
      message_id: MESSAGE_ID,
      choices: [0, 2],
      confirm: true,
      confirm_token: draft.confirm_token,
    })) as VoteInPollVoted;

    expect(result).toMatchObject({ status: 'voted', chat_id: CHAT_ID, commit_status: 1 });
    /* form_status в ВЫВОДЕ confirm - главное требование AC-29 (условный долг помечен в точке действия) */
    expect(result.form_status).toBe('experimental_unverified');
    expect(mock.requestsOf('push')[0]?.payload).not.toHaveProperty('Vote');
    expect(pushClientMessage()['Vote']).toEqual({
      ChatId: CHAT_ID,
      Timestamp: MESSAGE_ID,
      Choices: [0, 2],
      Results: true,
    });
  });

  it('AC-29 условный: без живого myChoices голос НЕ объявляется проверенным (form_status держит долг)', async () => {
    const draft = (await voteInPoll(deps, { chat: CHAT_ID, message_id: MESSAGE_ID, choices: [1] })) as VoteInPollDraft;
    const voted = (await voteInPoll(deps, {
      chat: CHAT_ID,
      message_id: MESSAGE_ID,
      choices: [1],
      confirm: true,
      confirm_token: draft.confirm_token,
    })) as VoteInPollVoted;

    /* Оба вывода несут маркер experimental: AC-29 засчитывается только против живого myChoices */
    expect(draft.form_status).toBe('experimental_unverified');
    expect(voted.form_status).toBe('experimental_unverified');
  });
});

describe('get_poll: чтение опроса без confirm (AC-28, безусловно)', () => {
  it('варианты, мой выбор и результаты; признак is_poll; poll_info одним вызовом', async () => {
    pollInfoResponds({
      answerVotes: [
        { Answer: 'Да', Votes: 5 },
        { Answer: 'Нет', Votes: 2 },
      ],
      myChoices: [0],
      results: { total: 7 },
    });

    const result = await getPoll(deps, { chat: CHAT_ID, message_id: MESSAGE_ID });

    if (result.status !== 'ok') {
      throw new Error(`ожидался ok, получен ${result.status}`);
    }
    expect(result.is_poll).toBe(true);
    expect(result.answers).toEqual([
      { index: 0, title: 'Да', votes: 5 },
      { index: 1, title: 'Нет', votes: 2 },
    ]);
    expect(result.my_choices).toEqual([0]);
    expect(result.results).toEqual({ total: 7 });
    expect(mock.requestsOf('poll_info')).toHaveLength(1);
    /* Чтение опроса - read-путь: ни одного push */
    expect(mock.requestsOf('push')).toHaveLength(0);
  });

  it('не опрос -> статус not_a_poll, пустая структура за опрос не выдаётся', async () => {
    pollInfoResponds({});

    const result = await getPoll(deps, { chat: CHAT_ID, message_id: MESSAGE_ID });

    expect(result.status).toBe('not_a_poll');
  });
});
