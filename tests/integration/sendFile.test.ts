/**
 * send_file против ЖИВОГО сокета (mock-Xiva) + синтетический uploader-fetch и мок-поиск.
 *
 * Главные утверждения фазы доказуемы только посчитанными кадрами/вызовами:
 *  - на draft в сокет не ушёл push И uploader-fetch не вызван НИ РАЗУ (байты не льются);
 *  - на confirm проходят все 3 шага загрузки, затем ОДИН push с file_info.id;
 *  - ответ без числового Status = отказ, хотя загрузка уже состоялась.
 *
 * Синтетические id, живых данных нет. Форма исходящего вложения доко-выведена (US-009).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadAttachment } from '../../src/attachments/downloader.js';
import { FakeAuthProvider } from '../../src/auth/FakeAuthProvider.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { fingerprint, resetConfirmMemory, verifyConfirmToken } from '../../src/mcp/confirm.js';
import type { ToolDeps } from '../../src/mcp/tools/deps.js';
import { sendFile, type SendFileDraft, type SendFileSent } from '../../src/mcp/tools/sendFile.js';
import { MessengerWsClient } from '../../src/transport/ws/MessengerWsClient.js';
import { createLogger } from '../../src/util/logger.js';
import { MockXiva, startMockXiva } from '../helpers/mockXiva.js';

const MY_GUID = 'aaaaaaaa-1111-2222-3333-444444444444';
const PARTNER_GUID = 'bbbbbbbb-5555-6666-7777-888888888888';
const CHAT_ID = `${PARTNER_GUID}_${MY_GUID}`;
const OTHER_CHAT_ID = `cccccccc-9999-0000-1111-222222222222_${MY_GUID}`;

const workDir = mkdtempSync(join(tmpdir(), 'ymm-sendfile-'));
const config = loadConfig({ configDir: mkdtempSync(join(tmpdir(), 'ymm-sf-cfg-')) });
const logger = createLogger({ level: 'error' });
const IMAGE_PATH = join(workDir, 'photo.jpg');
const FILE_PATH = join(workDir, 'notes.txt');

/** Бакет chats: один точный кандидат -> резолв без неоднозначности */
function chatsHit(chatId: string, name: string) {
  return { chats: { items: [{ data: { chat_id: chatId, name } }], total: 1, limit: 50 } };
}

/** Синтетический uploader-fetch: отвечает на 3 шага и отдаёт заданный file_id из add_files */
function uploaderFetch(fileId = 'up1234/uuid-file'): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: string | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'PUT') {
      return new Response(null, { status: 200, headers: { Location: 'disk:loc' } });
    }
    const form = init?.body as FormData;
    const method = (JSON.parse(String(form.get('request'))) as { method: string }).method;
    if (method === 'upload_to_disk') {
      return new Response(JSON.stringify({ status: 'ok', data: { files: [{ upload_url: 'https://disk.example/put/1' }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (method === 'add_files') {
      return new Response(JSON.stringify({ status: 'ok', data: { files: [{ id: fileId }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`неожиданный RPC ${method}`);
  });
}

function asFetch(fn: ReturnType<typeof vi.fn>): typeof fetch {
  return fn as unknown as typeof fetch;
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

function pushRespondsWith(payload: Record<string, unknown>): void {
  mock.responders.set('push', (request, connection) => mock.reply(connection, request, payload));
}

async function draftFor(path = IMAGE_PATH): Promise<SendFileDraft> {
  const result = await sendFile(deps, { chat: 'Коллега', path });
  if (result.status !== 'draft') {
    throw new Error(`ожидался draft, получен ${result.status}`);
  }
  return result;
}

beforeEach(async () => {
  resetConfirmMemory();
  /* Свежие файлы каждый тест: тест ре-верификации меняет размер, соседние не должны страдать */
  writeFileSync(IMAGE_PATH, 'jpegbytes-1234567890');
  writeFileSync(FILE_PATH, 'file content bytes here');
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
  it('НЕ льёт байты и НЕ шлёт push, отдаёт превью файла с именем/размером/типом/чатом', async () => {
    const upFetch = uploaderFetch();

    const result = await sendFile(deps, { chat: 'Коллега', path: IMAGE_PATH }, { fetchImpl: asFetch(upFetch) });

    expect(result.status).toBe('draft');
    expect(upFetch).not.toHaveBeenCalled();
    expect(mock.requestsOf('push')).toHaveLength(0);
    const draft = result as SendFileDraft;
    expect(draft).toMatchObject({ chat_id: CHAT_ID, chat_name: 'Коллега', file: { name: 'photo.jpg', kind: 'image' } });
    expect(draft.file.size).toBeGreaterThan(0);
    expect(draft.confirm_token).toBeTruthy();
  });

  it('файл без картиночного расширения -> kind:file', async () => {
    const draft = await draftFor(FILE_PATH);

    expect(draft.file).toMatchObject({ name: 'notes.txt', kind: 'file' });
  });

  it('нет файла -> file_not_found, без резолва «на удачу» и без сети', async () => {
    const upFetch = uploaderFetch();

    const result = await sendFile(
      deps,
      { chat: 'Коллега', path: join(workDir, 'нет-такого.png') },
      { fetchImpl: asFetch(upFetch) },
    );

    expect(result).toMatchObject({ status: 'file_not_found' });
    expect(upFetch).not.toHaveBeenCalled();
    expect(mock.requestsOf('push')).toHaveLength(0);
  });

  it('неоднозначный чат -> кандидаты, ни заливки, ни отправки', async () => {
    deps = makeDeps({
      chats: {
        items: [{ data: { chat_id: CHAT_ID, name: 'Иван И.' } }, { data: { chat_id: OTHER_CHAT_ID, name: 'Иван П.' } }],
        total: 2,
        limit: 50,
      },
    });
    const upFetch = uploaderFetch();

    const result = await sendFile(deps, { chat: 'Иван', path: IMAGE_PATH }, { fetchImpl: asFetch(upFetch) });

    expect(result.status).toBe('ambiguous_chat');
    expect(upFetch).not.toHaveBeenCalled();
    expect(mock.requestsOf('push')).toHaveLength(0);
  });
});

describe('шаг 2: confirm', () => {
  it('картинка: 3 шага загрузки, затем один push с Plain.Image.FileInfo.Id2', async () => {
    const draft = await draftFor(IMAGE_PATH);
    const upFetch = uploaderFetch('up1234/uuid-file');

    const result = (await sendFile(
      deps,
      { chat: 'Коллега', path: IMAGE_PATH, confirm: true, confirm_token: draft.confirm_token },
      { fetchImpl: asFetch(upFetch) },
    )) as SendFileSent;

    expect(upFetch).toHaveBeenCalledTimes(3);
    const frames = mock.requestsOf('push');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload).toMatchObject({
      ClientTransportId: { XivaSubscriptionId: mock.latest.subscriptionId },
      ClientMessage: { Plain: { ChatId: CHAT_ID, Image: { FileInfo: { Id2: 'up1234/uuid-file', Source: 1 } } } },
      Meta: { Origin: 27 },
    });
    expect(result).toMatchObject({
      status: 'sent',
      chat_id: CHAT_ID,
      file_id: 'up1234/uuid-file',
      kind: 'image',
      commit_status: 1,
      duplicate: false,
    });
  });

  it('файл: push несёт Plain.MiscFile.FileInfo.Id2, kind:file', async () => {
    const draft = await draftFor(FILE_PATH);
    const upFetch = uploaderFetch('file9999/uuid-doc');

    const result = (await sendFile(
      deps,
      { chat: 'Коллега', path: FILE_PATH, confirm: true, confirm_token: draft.confirm_token },
      { fetchImpl: asFetch(upFetch) },
    )) as SendFileSent;

    const frames = mock.requestsOf('push');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload).toMatchObject({
      ClientMessage: { Plain: { ChatId: CHAT_ID, MiscFile: { FileInfo: { Id2: 'file9999/uuid-doc' } } } },
    });
    expect(result).toMatchObject({ status: 'sent', file_id: 'file9999/uuid-doc', kind: 'file' });
  });

  it('ответ без числового Status -> отказ, ХОТЯ загрузка уже прошла', async () => {
    pushRespondsWith({});
    const draft = await draftFor(IMAGE_PATH);
    const upFetch = uploaderFetch();

    await expect(
      sendFile(
        deps,
        { chat: 'Коллега', path: IMAGE_PATH, confirm: true, confirm_token: draft.confirm_token },
        { fetchImpl: asFetch(upFetch) },
      ),
    ).rejects.toThrow(/Status/);

    /* Байты залиты (3 шага), но commit не подтверждён - тихим успехом это не считается */
    expect(upFetch).toHaveBeenCalledTimes(3);
    expect(mock.requestsOf('push')).toHaveLength(1);
  });

  it('DUPLICATE(8) -> идемпотентный успех, а не ошибка', async () => {
    pushRespondsWith({ Status: 8 });
    const draft = await draftFor(IMAGE_PATH);
    const upFetch = uploaderFetch();

    const result = (await sendFile(
      deps,
      { chat: 'Коллега', path: IMAGE_PATH, confirm: true, confirm_token: draft.confirm_token },
      { fetchImpl: asFetch(upFetch) },
    )) as SendFileSent;

    expect(result).toMatchObject({ status: 'sent', commit_status: 8, duplicate: true });
  });

  it('некоммитнутый статус -> громкая ошибка, без авто-ретрая push', async () => {
    pushRespondsWith({ Status: 4 });
    const draft = await draftFor(IMAGE_PATH);
    const upFetch = uploaderFetch();

    await expect(
      sendFile(
        deps,
        { chat: 'Коллега', path: IMAGE_PATH, confirm: true, confirm_token: draft.confirm_token },
        { fetchImpl: asFetch(upFetch) },
      ),
    ).rejects.toThrow(/NO_SUCH_CHAT\(4\)/);
    expect(mock.requestsOf('push')).toHaveLength(1);
  });
});

describe('идемпотентность и ре-верификация', () => {
  it('повторный confirm тем же токеном НЕ льёт заново и НЕ шлёт второй push', async () => {
    const draft = await draftFor(IMAGE_PATH);
    const upFetch = uploaderFetch();

    const first = await sendFile(
      deps,
      { chat: 'Коллега', path: IMAGE_PATH, confirm: true, confirm_token: draft.confirm_token },
      { fetchImpl: asFetch(upFetch) },
    );
    const second = await sendFile(
      deps,
      { chat: 'Коллега', path: IMAGE_PATH, confirm: true, confirm_token: draft.confirm_token },
      { fetchImpl: asFetch(upFetch) },
    );

    expect(upFetch).toHaveBeenCalledTimes(3);
    expect(mock.requestsOf('push')).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('файл подменён между draft и confirm -> file_mismatch, без заливки и push', async () => {
    const draft = await draftFor(FILE_PATH);
    /* Меняем размер файла: отпечаток draft перестаёт сходиться */
    writeFileSync(FILE_PATH, 'совсем другой и заметно более длинный текст файла');
    const upFetch = uploaderFetch();

    await expect(
      sendFile(
        deps,
        { chat: 'Коллега', path: FILE_PATH, confirm: true, confirm_token: draft.confirm_token },
        { fetchImpl: asFetch(upFetch) },
      ),
    ).rejects.toThrow(/file_mismatch/);
    expect(upFetch).not.toHaveBeenCalled();
    expect(mock.requestsOf('push')).toHaveLength(0);
  });

  it('чат резолвится в ДРУГОЙ -> chat_mismatch, без заливки и push', async () => {
    const draft = await draftFor(IMAGE_PATH);
    deps = makeDeps(chatsHit(OTHER_CHAT_ID, 'Коллега'));
    const upFetch = uploaderFetch();

    await expect(
      sendFile(
        deps,
        { chat: 'Коллега', path: IMAGE_PATH, confirm: true, confirm_token: draft.confirm_token },
        { fetchImpl: asFetch(upFetch) },
      ),
    ).rejects.toThrow(/chat_mismatch/);
    expect(upFetch).not.toHaveBeenCalled();
    expect(mock.requestsOf('push')).toHaveLength(0);
  });

  it('confirm без токена -> отказ, без заливки и push', async () => {
    const upFetch = uploaderFetch();

    await expect(
      sendFile(deps, { chat: 'Коллега', path: IMAGE_PATH, confirm: true }, { fetchImpl: asFetch(upFetch) }),
    ).rejects.toThrow(/token_missing/);
    expect(upFetch).not.toHaveBeenCalled();
    expect(mock.requestsOf('push')).toHaveLength(0);
  });
});

describe('кросс-op', () => {
  it('токен send_file, предъявленный операции delete, отвергается op_mismatch', async () => {
    const draft = await draftFor(IMAGE_PATH);

    expect(() =>
      verifyConfirmToken({
        op: 'delete',
        token: draft.confirm_token,
        chatId: CHAT_ID,
        fingerprint: fingerprint('delete', `${CHAT_ID}:100`),
      }),
    ).toThrow(/op_mismatch/);
  });
});

describe('read-back', () => {
  it('отправленное скачивается обратно по file_id', async () => {
    const draft = await draftFor(IMAGE_PATH);
    const upFetch = uploaderFetch('1234/uuid-sent');
    const sent = (await sendFile(
      deps,
      { chat: 'Коллега', path: IMAGE_PATH, confirm: true, confirm_token: draft.confirm_token },
      { fetchImpl: asFetch(upFetch) },
    )) as SendFileSent;

    const dlFetch = vi.fn(async () => new Response('image-bytes', { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    const downloaded = await downloadAttachment(
      { auth: new FakeAuthProvider(), config, fetchImpl: asFetch(dlFetch) },
      { fileId: sent.file_id },
    );

    expect(String(dlFetch.mock.calls[0]?.[0])).toContain(`/file_shortterm/${sent.file_id}`);
    expect(downloaded.bytes).toBeGreaterThan(0);
  });
});
