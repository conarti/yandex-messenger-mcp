/**
 * Долги ЧТЕНИЯ вложений (Phase 7) на синтетических фикстурах: voice, gallery и превью `?size=`.
 *
 * Скачивание типо-агностично - voice/gallery это просто file_id, тянутся тем же generic-путём,
 * что image/file. Здесь это доказывается синтетикой; ЖИВОЙ прогон (реальное голосовое, реальная
 * галерея, картинка заведомо больше кэпа под `?size=`) - долг US-009, см. README.
 *
 * Инварианты - рантаймом, не компилятором.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadAttachment } from '../../src/attachments/downloader.js';
import { FakeAuthProvider } from '../../src/auth/FakeAuthProvider.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import type { Config } from '../../src/config/types.js';

/** Форма живого Id2: <bucket>/<uuid> */
const VOICE_ID = '5678/0a1b2c3d-voice-uuid-0001';
const GALLERY_IDS = ['9012/gallery-uuid-0001', '9012/gallery-uuid-0002', '9012/gallery-uuid-0003'];

let workDir: string;
let config: Config;

function okResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers });
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'ymm-dl-types-'));
  config = loadConfig({ configDir: workDir });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('voice: скачивается generic-путём', () => {
  it('качает голосовое по file_id тем же file_shortterm?attach=true', async () => {
    const auth = new FakeAuthProvider();
    const fetchImpl = vi.fn(async () => okResponse('opusbytes', { 'content-type': 'audio/ogg' }));

    const result = await downloadAttachment(
      { auth, config, fetchImpl: fetchImpl as unknown as typeof fetch },
      { fileId: VOICE_ID, fileName: 'voice.ogg' },
    );

    expect(existsSync(result.path)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(basename(result.path)).toBe('voice.ogg');
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      `https://files.messenger.yandex.ru/file_shortterm/${VOICE_ID}?attach=true`,
    );
  });
});

describe('gallery: каждый item скачивается отдельно', () => {
  it('качает все file_id галереи в одну папку, не затирая друг друга', async () => {
    const auth = new FakeAuthProvider();
    const fetchImpl = vi.fn(async () => okResponse('imgbytes', { 'content-type': 'image/jpeg' }));
    const deps = { auth, config, fetchImpl: fetchImpl as unknown as typeof fetch };

    const paths: string[] = [];
    for (const [index, fileId] of GALLERY_IDS.entries()) {
      const result = await downloadAttachment(deps, { fileId, fileName: `gallery-${index}.jpg` });
      paths.push(result.path);
    }

    expect(new Set(paths).size).toBe(GALLERY_IDS.length);
    for (const path of paths) {
      expect(existsSync(path)).toBe(true);
      expect(dirname(path)).toBe(config.paths.downloadsDir);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(GALLERY_IDS.length);
  });
});

describe('превью ?size=', () => {
  it('строит ?size= для превью картинки (US-009 - живая проверка на большой картинке)', async () => {
    const auth = new FakeAuthProvider();
    const fetchImpl = vi.fn(async () => okResponse('previewbytes', { 'content-type': 'image/jpeg' }));

    await downloadAttachment(
      { auth, config, fetchImpl: fetchImpl as unknown as typeof fetch },
      { fileId: GALLERY_IDS[0] as string, fileName: 'preview.jpg', size: 'SMALL48' },
    );

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      `https://files.messenger.yandex.ru/file_shortterm/${GALLERY_IDS[0]}?size=SMALL48`,
    );
  });

  it('без size тянет оригинал (?attach=true), не превью', async () => {
    const auth = new FakeAuthProvider();
    const fetchImpl = vi.fn(async () => okResponse('orig'));

    await downloadAttachment(
      { auth, config, fetchImpl: fetchImpl as unknown as typeof fetch },
      { fileId: GALLERY_IDS[0] as string, fileName: 'orig.jpg' },
    );

    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('?attach=true');
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain('?size=');
  });
});
