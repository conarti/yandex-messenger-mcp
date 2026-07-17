/**
 * uploader: 3-шаговая Disk-загрузка (§12.1) на синтетических фикстурах.
 *
 * Живого upload-эндпоинта нет (US-009), поэтому fetch подменён. Проверяется порядок шагов,
 * извлечение `file_id` и РАЗДЕЛЬНЫЙ маппинг ошибок: 507/403 - квота, 413 - размер.
 *
 * Инварианты - рантаймом (assert), не компилятором: tsgo тайпчекает только src/.
 */
import { describe, expect, it, vi } from 'vitest';
import { UploadError, uploadFileToDisk, type UploadErrorKind } from '../../src/attachments/uploader.js';
import { FakeAuthProvider } from '../../src/auth/FakeAuthProvider.js';

const API_URL = 'https://yandex.ru/messenger/api/registry/api/';
const CHAT_ID = 'chat-1';
const BYTES = new Uint8Array([1, 2, 3, 4]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Метод RPC из multipart-поля `request` (registry-POST собирает FormData) */
async function rpcMethod(init: RequestInit | undefined): Promise<string> {
  const form = init?.body as FormData;
  const parsed = JSON.parse(String(form.get('request'))) as { method: string };
  return parsed.method;
}

function isPut(init: RequestInit | undefined): boolean {
  return (init?.method ?? 'GET') === 'PUT';
}

function makeDeps(fetchImpl: ReturnType<typeof vi.fn>) {
  return { apiUrl: API_URL, auth: new FakeAuthProvider(), fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe('uploadFileToDisk: 3 шага', () => {
  it('проходит upload_to_disk -> PUT байтов -> add_files по порядку и отдаёт file_id', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (isPut(init)) {
        seen.push(`PUT ${String(url)}`);
        expect(init?.body).toBe(BYTES);
        return new Response(null, { status: 200, headers: { Location: 'disk:file-loc' } });
      }
      const method = await rpcMethod(init);
      seen.push(`POST ${method}`);
      if (method === 'upload_to_disk') {
        return jsonResponse({ status: 'ok', data: { files: [{ upload_url: 'https://disk.example/put/1' }] } });
      }
      if (method === 'add_files') {
        return jsonResponse({ status: 'ok', data: { files: [{ id: '1234/uuid-file' }] } });
      }
      throw new Error(`неожиданный RPC ${method}`);
    });

    const result = await uploadFileToDisk(makeDeps(fetchImpl), {
      chatId: CHAT_ID,
      name: 'photo.jpg',
      size: BYTES.length,
      bytes: BYTES,
    });

    expect(result.fileId).toBe('1234/uuid-file');
    expect(seen).toEqual(['POST upload_to_disk', 'PUT https://disk.example/put/1', 'POST add_files']);
  });

  it('add_files шлёт location из заголовка Location шага PUT', async () => {
    let addFilesParams: unknown;
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (isPut(init)) {
        return new Response(null, { status: 200, headers: { Location: 'disk:the-location' } });
      }
      const form = init?.body as FormData;
      const parsed = JSON.parse(String(form.get('request'))) as { method: string; params: unknown };
      if (parsed.method === 'upload_to_disk') {
        return jsonResponse({ status: 'ok', data: { files: [{ upload_url: 'https://disk.example/put/1' }] } });
      }
      addFilesParams = parsed.params;
      return jsonResponse({ status: 'ok', data: { files: [{ id: 'file-id' }] } });
    });

    await uploadFileToDisk(makeDeps(fetchImpl), { chatId: CHAT_ID, name: 'a.bin', size: 4, bytes: BYTES });

    expect(addFilesParams).toEqual({ chat_id: CHAT_ID, files: [{ location: 'disk:the-location' }] });
  });
});

describe('uploadFileToDisk: раздельные ошибки шага 1', () => {
  function failingUpload(status: number): ReturnType<typeof vi.fn> {
    return vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (isPut(init)) {
        return new Response(null, { status: 200, headers: { Location: 'x' } });
      }
      const method = await rpcMethod(init);
      if (method === 'upload_to_disk') {
        return new Response('quota or size error', { status });
      }
      return jsonResponse({ status: 'ok', data: { files: [{ id: 'x' }] } });
    });
  }

  it.each<[number, UploadErrorKind]>([
    [507, 'quota'],
    [403, 'quota'],
    [413, 'size'],
  ])('HTTP %i на upload_to_disk -> %s, PUT не выполняется', async (status, kind) => {
    const fetchImpl = failingUpload(status);

    let error: unknown;
    try {
      await uploadFileToDisk(makeDeps(fetchImpl), { chatId: CHAT_ID, name: 'big.bin', size: 1, bytes: BYTES });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).kind).toBe(kind);
    expect((error as UploadError).httpStatus).toBe(status);
    /* Байты НЕ ушли: раз URL не выделен, PUT не должен состояться */
    expect(fetchImpl.mock.calls.some((call) => isPut(call[1] as RequestInit))).toBe(false);
  });
});

describe('uploadFileToDisk: неполные ответы -> upload_failed', () => {
  it('PUT без заголовка Location', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (isPut(init)) {
        return new Response(null, { status: 200 });
      }
      const method = await rpcMethod(init);
      if (method === 'upload_to_disk') {
        return jsonResponse({ status: 'ok', data: { files: [{ upload_url: 'https://disk.example/put/1' }] } });
      }
      return jsonResponse({ status: 'ok', data: { files: [{ id: 'x' }] } });
    });

    let error: unknown;
    try {
      await uploadFileToDisk(makeDeps(fetchImpl), { chatId: CHAT_ID, name: 'a.bin', size: 4, bytes: BYTES });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).kind).toBe('upload_failed');
  });

  it('add_files без file_id', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (isPut(init)) {
        return new Response(null, { status: 200, headers: { Location: 'loc' } });
      }
      const method = await rpcMethod(init);
      if (method === 'upload_to_disk') {
        return jsonResponse({ status: 'ok', data: { files: [{ upload_url: 'https://disk.example/put/1' }] } });
      }
      return jsonResponse({ status: 'ok', data: { files: [{}] } });
    });

    let error: unknown;
    try {
      await uploadFileToDisk(makeDeps(fetchImpl), { chatId: CHAT_ID, name: 'a.bin', size: 4, bytes: BYTES });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).kind).toBe('upload_failed');
  });
});

describe('uploadFileToDisk: 401', () => {
  it('рефрешит сессию один раз и повторяет шаг', async () => {
    const auth = new FakeAuthProvider();
    let uploadCalls = 0;
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (isPut(init)) {
        return new Response(null, { status: 200, headers: { Location: 'loc' } });
      }
      const method = await rpcMethod(init);
      if (method === 'upload_to_disk') {
        uploadCalls += 1;
        if (uploadCalls === 1) {
          return new Response('', { status: 401 });
        }
        return jsonResponse({ status: 'ok', data: { files: [{ upload_url: 'https://disk.example/put/1' }] } });
      }
      return jsonResponse({ status: 'ok', data: { files: [{ id: 'ok-id' }] } });
    });

    const result = await uploadFileToDisk(
      { apiUrl: API_URL, auth, fetchImpl: fetchImpl as unknown as typeof fetch },
      { chatId: CHAT_ID, name: 'a.bin', size: 4, bytes: BYTES },
    );

    expect(result.fileId).toBe('ok-id');
    expect(auth.authFailures).toBe(1);
    expect(uploadCalls).toBe(2);
  });
});
