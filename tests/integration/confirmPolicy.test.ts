/**
 * Сквозная confirm-политика (Phase 8, AC-31/AC-32).
 *
 * Критерий один (спека, Principle 4): confirm - ТОЛЬКО у необратимых мутаций. Тест ловит
 * ошибку отнесения инструмента к множеству ДВУМЯ независимыми проверками:
 *
 *  1. Покрытие регистрации: каждый инструмент из server.TOOL_NAMES осознанно лежит ровно в
 *     одном ведре (read-only / не-мутация записи / мутация с confirm / мутация без confirm).
 *     Новый инструмент, забытый при классификации, ломает равенство объединения с TOOL_NAMES.
 *  2. Поведение: инструмент С confirm в режиме без confirm отдаёт draft + confirm_token и
 *     НИЧЕГО не мутирует; инструмент БЕЗ confirm исполняется одним вызовом без confirm_token.
 *     Наблюдённое разбиение сверяется с двумя перечнями РОВНО.
 *
 * Плюс кросс-op replay: токен op X, предъявленный op Y, отвергается op_mismatch
 * (через verifyConfirmToken) - это сверка поля внутри токена, а не членства в множестве.
 *
 * Против ЖИВОГО сокета (mock-Xiva): «draft не мутирует» доказывается отсутствием push-кадра.
 * Синтетические id, живых данных нет.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAuthProvider } from '../../src/auth/FakeAuthProvider.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { loadReactionMap } from '../../src/config/reactionMap.js';
import {
  ConfirmRejectedError,
  encodeToken,
  fingerprint,
  resetConfirmMemory,
  verifyConfirmToken,
  type ConfirmOp,
} from '../../src/mcp/confirm.js';
import type { ToolDeps } from '../../src/mcp/tools/deps.js';
import { deleteMessage } from '../../src/mcp/tools/deleteMessage.js';
import { editMessage } from '../../src/mcp/tools/editMessage.js';
import { markRead } from '../../src/mcp/tools/markRead.js';
import { pinMessage } from '../../src/mcp/tools/pinMessage.js';
import { sendFile } from '../../src/mcp/tools/sendFile.js';
import { sendMessage } from '../../src/mcp/tools/sendMessage.js';
import { setReaction } from '../../src/mcp/tools/setReaction.js';
import { voteInPoll } from '../../src/mcp/tools/voteInPoll.js';
import { TOOL_NAMES } from '../../src/server.js';
import { MessengerWsClient } from '../../src/transport/ws/MessengerWsClient.js';
import { createLogger } from '../../src/util/logger.js';
import { MockXiva, startMockXiva } from '../helpers/mockXiva.js';

const MY_GUID = 'aaaaaaaa-1111-2222-3333-444444444444';
const PARTNER_GUID = 'bbbbbbbb-5555-6666-7777-888888888888';
/** Приватный ChatId (§5): резолвится как literal, без похода в http */
const CHAT_ID = `${PARTNER_GUID}_${MY_GUID}`;
const MESSAGE_ID = '1784287503814009';
/** Известный тип из reaction-map.json (like-ext / 👍) - set_reaction без него отвергся бы на входе */
const KNOWN_TYPE = 100102;

/* Классификация ВСЕХ инструментов server.TOOL_NAMES по вёдрам (источник истины для проверки покрытия) */
const READ_ONLY_TOOLS = [
  'list_chats',
  'get_history',
  'get_message',
  'get_message_context',
  'get_thread',
  'search',
  'get_poll',
] as const;
/** Запись, но не мутация контента: подписка/скачивание - confirm не нужен и в перечни не входят */
const NON_MUTATION_WRITE_TOOLS = ['download_attachment', 'join_to_thread', 'leave_thread'] as const;
/** РОВНО этот набор несёт confirm (необратимые) */
const CONFIRM_MUTATION_TOOLS = ['send_message', 'delete_message', 'send_file', 'edit_message', 'vote_in_poll'] as const;
/** РОВНО этот набор - мутации без confirm (реверсибельные/безобидные) */
const NO_CONFIRM_MUTATION_TOOLS = ['set_reaction', 'pin_message', 'mark_read'] as const;

const config = loadConfig({ configDir: mkdtempSync(join(tmpdir(), 'ymm-policy-')) });
const logger = createLogger({ level: 'error' });
const reactionMap = loadReactionMap();

/** Файл для draft send_file: превью строится stat-ом, байты не читаются */
const uploadFilePath = join(mkdtempSync(join(tmpdir(), 'ymm-policy-file-')), 'note.txt');
writeFileSync(uploadFilePath, 'содержимое');

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

/** message_info-ответ: своё сообщение (draft delete/edit перечитывают им превью) */
function messageInfoRespondsOwn(): void {
  mock.responders.set('message_info', (request, connection) =>
    mock.reply(connection, request, {
      Message: {
        ClientMessage: { Plain: { ChatId: CHAT_ID, Text: { MessageText: 'исходный текст' } } },
        ServerMessageInfo: {
          Timestamp: Number(MESSAGE_ID),
          SeqNo: 7,
          LastEditTimestamp: 0,
          Deleted: false,
          From: { Guid: MY_GUID, DisplayName: 'Я' },
        },
      },
    }),
  );
}

/** Вызов каждого инструмента-мутации в режиме БЕЗ confirm. Ключи = вся вселенная мутаций. */
const mutationInvokers: Record<string, () => Promise<unknown>> = {
  send_message: () => sendMessage(deps, { chat: CHAT_ID, text: 'привет' }),
  delete_message: () => deleteMessage(deps, { chat: CHAT_ID, message_id: MESSAGE_ID }),
  send_file: () => sendFile(deps, { chat: CHAT_ID, path: uploadFilePath }),
  edit_message: () => editMessage(deps, { chat: CHAT_ID, message_id: MESSAGE_ID, new_text: 'новый' }),
  vote_in_poll: () => voteInPoll(deps, { chat: CHAT_ID, message_id: MESSAGE_ID, choices: [0] }),
  set_reaction: () => setReaction(deps, { chat: CHAT_ID, message_id: MESSAGE_ID, type: KNOWN_TYPE }),
  pin_message: () => pinMessage(deps, { chat: CHAT_ID, message_id: MESSAGE_ID }),
  mark_read: () => markRead(deps, { chat: CHAT_ID, message_id: MESSAGE_ID }),
};

/** Инструмент несёт confirm, если без confirm вернул draft с confirm_token */
function producedConfirmToken(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { status?: unknown }).status === 'draft' &&
    typeof (result as { confirm_token?: unknown }).confirm_token === 'string'
  );
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
  mock.responders.set('push', (request, connection) => mock.reply(connection, request, { Status: 1 }));
  messageInfoRespondsOwn();
});

afterEach(async () => {
  ws.close();
  await mock.close();
});

describe('покрытие регистрации: каждый инструмент осознанно классифицирован', () => {
  it('объединение вёдер РОВНО = server.TOOL_NAMES, вёдра не пересекаются', () => {
    const buckets = [
      ...READ_ONLY_TOOLS,
      ...NON_MUTATION_WRITE_TOOLS,
      ...CONFIRM_MUTATION_TOOLS,
      ...NO_CONFIRM_MUTATION_TOOLS,
    ];
    /* Дизъюнктность: сумма длин = размер объединения (нет инструмента в двух вёдрах) */
    expect(buckets.length).toBe(new Set(buckets).size);
    /* Полнота: ни один зарегистрированный инструмент не забыт, ни одного лишнего */
    expect(new Set(buckets)).toEqual(new Set(TOOL_NAMES));
  });

  it('вселенная мутаций теста = confirm ∪ no-confirm перечни (без пропусков)', () => {
    expect(new Set(Object.keys(mutationInvokers))).toEqual(
      new Set([...CONFIRM_MUTATION_TOOLS, ...NO_CONFIRM_MUTATION_TOOLS]),
    );
  });
});

describe('поведение: разбиение по confirm совпадает с перечнями РОВНО (AC-31/AC-32)', () => {
  it('С confirm = {send_message, delete_message, send_file, edit_message, vote_in_poll}; без = {set_reaction, pin_message, mark_read}', async () => {
    const withConfirm: string[] = [];
    const withoutConfirm: string[] = [];

    for (const [name, invoke] of Object.entries(mutationInvokers)) {
      const result = await invoke();
      if (producedConfirmToken(result)) {
        withConfirm.push(name);
      } else {
        withoutConfirm.push(name);
      }
    }

    expect(new Set(withConfirm)).toEqual(new Set(CONFIRM_MUTATION_TOOLS));
    expect(new Set(withoutConfirm)).toEqual(new Set(NO_CONFIRM_MUTATION_TOOLS));
  });

  it('инструменты без confirm НЕ отдают confirm_token (исполняются одним вызовом)', async () => {
    for (const name of NO_CONFIRM_MUTATION_TOOLS) {
      const result = await mutationInvokers[name]!();
      expect(producedConfirmToken(result)).toBe(false);
      expect((result as { status?: unknown }).status).toBe('ok');
    }
  });
});

describe('кросс-op replay: токен op X отвергается op Y (verifyConfirmToken)', () => {
  const OPS: ConfirmOp[] = ['send', 'delete', 'edit', 'send_file', 'vote'];

  it('любая пара разных op -> op_mismatch, чат при этом совпадает', () => {
    for (const minted of OPS) {
      for (const presented of OPS) {
        if (minted === presented) {
          continue;
        }
        const token = encodeToken({ op: minted, chat_id: CHAT_ID, fingerprint: fingerprint(minted, 'x') });
        let caught: unknown;
        try {
          verifyConfirmToken({
            op: presented,
            token,
            chatId: CHAT_ID,
            fingerprint: fingerprint(presented, 'x'),
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(ConfirmRejectedError);
        expect((caught as ConfirmRejectedError).reason).toBe('op_mismatch');
      }
    }
  });

  it('та же op с той же нагрузкой проходит (контроль: отвергается именно кросс-op, а не всё подряд)', () => {
    const token = encodeToken({ op: 'delete', chat_id: CHAT_ID, fingerprint: fingerprint('delete', 'x') });
    expect(() =>
      verifyConfirmToken({ op: 'delete', token, chatId: CHAT_ID, fingerprint: fingerprint('delete', 'x') }),
    ).not.toThrow();
  });
});
