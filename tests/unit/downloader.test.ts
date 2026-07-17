import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  downloadAttachment,
  parseContentDisposition,
  sanitizeFileName,
} from '../../src/attachments/downloader.js';
import { FakeAuthProvider } from '../../src/auth/FakeAuthProvider.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import type { Config } from '../../src/config/types.js';

const FILE_ID = '1234/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d';
const DAY_MS = 24 * 60 * 60 * 1000;

let workDir: string;
let config: Config;

/** Ответ-заглушка file_shortterm */
function okResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers });
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'ymm-dl-'));
  config = loadConfig({ configDir: workDir });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('sanitizeFileName', () => {
  /* Разделители схлопываются в '_', затем срезаются ведущие точки - отсюда именно такой вид */
  it('отбивает traversal: разделители пути не выживают', () => {
    expect(sanitizeFileName('../../etc/passwd', FILE_ID)).toBe('_.._etc_passwd');
    expect(sanitizeFileName('/etc/passwd', FILE_ID)).toBe('_etc_passwd');
    expect(sanitizeFileName('a\\..\\b.txt', FILE_ID)).toBe('a_.._b.txt');
  });

  it('в санитизированном имени не остаётся ни одного разделителя пути', () => {
    for (const evil of ['../../etc/passwd', '/etc/passwd', 'a\\..\\b.txt', '....//....//x']) {
      const safe = sanitizeFileName(evil, FILE_ID);

      expect(safe).not.toContain('/');
      expect(safe).not.toContain('\\');
    }
  });

  it('имя из одних точек не выживает: остаётся запасное', () => {
    expect(sanitizeFileName('..', FILE_ID)).toBe('attachment-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d');
    expect(sanitizeFileName('.', FILE_ID)).toBe('attachment-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d');
  });

  it('срезает ведущие точки: скрытый файл не создаётся', () => {
    expect(sanitizeFileName('.bashrc', FILE_ID)).toBe('bashrc');
  });

  it('вырезает управляющие символы', () => {
    expect(sanitizeFileName('от\u0000чёт\u001b.pdf', FILE_ID)).toBe('отчёт.pdf');
  });

  it('сохраняет нормальное имя, включая кириллицу', () => {
    expect(sanitizeFileName('Отчёт за июль.pdf', FILE_ID)).toBe('Отчёт за июль.pdf');
  });

  it('без имени берёт запасное от fileId', () => {
    expect(sanitizeFileName(undefined, FILE_ID)).toBe('attachment-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d');
    expect(sanitizeFileName('', FILE_ID)).toBe('attachment-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d');
  });

  it('обрезает длинное имя, сохраняя расширение', () => {
    const result = sanitizeFileName(`${'я'.repeat(400)}.pdf`, FILE_ID);

    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.endsWith('.pdf')).toBe(true);
  });
});

describe('parseContentDisposition', () => {
  it('разбирает RFC5987 filename* - живая форма ответа', () => {
    expect(parseContentDisposition("attachment; filename*=UTF-8''%D0%9E%D1%82%D1%87%D1%91%D1%82.pdf")).toBe(
      'Отчёт.pdf',
    );
  });

  it('разбирает голый filename= в кавычках и без', () => {
    expect(parseContentDisposition('attachment; filename="photo.jpg"')).toBe('photo.jpg');
    expect(parseContentDisposition('attachment; filename=photo.jpg')).toBe('photo.jpg');
  });

  it('нет заголовка либо нет имени - undefined, а не падение', () => {
    expect(parseContentDisposition(null)).toBeUndefined();
    expect(parseContentDisposition('attachment')).toBeUndefined();
    expect(parseContentDisposition("attachment; filename*=UTF-8''%E0%A4%A")).toBeUndefined();
  });
});

describe('downloadAttachment', () => {
  it('качает файл той же auth-сессией и возвращает путь', async () => {
    const auth = new FakeAuthProvider();
    const fetchImpl = vi.fn(async () => okResponse('содержимое', { 'content-type': 'text/plain' }));

    const result = await downloadAttachment(
      { auth, config, fetchImpl: fetchImpl as unknown as typeof fetch },
      { fileId: FILE_ID, fileName: 'note.txt' },
    );

    expect(result.path).toBe(join(config.paths.downloadsDir, 'note.txt'));
    expect(existsSync(result.path)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.contentType).toBe('text/plain');

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://files.messenger.yandex.ru/file_shortterm/${FILE_ID}?attach=true`);
    expect((init.headers as Record<string, string>)['Cookie']).toBe(auth.context.cookieHeader);
  });

  it('картинка и произвольный файл кладутся одинаково: разница только в URL', async () => {
    const auth = new FakeAuthProvider();
    const fetchImpl = vi.fn(async () => okResponse('jpegbytes', { 'content-type': 'image/jpeg' }));
    const deps = { auth, config, fetchImpl: fetchImpl as unknown as typeof fetch };

    const image = await downloadAttachment(deps, { fileId: FILE_ID, fileName: 'photo.jpg', size: 'MIDDLE2048' });
    const file = await downloadAttachment(deps, { fileId: FILE_ID, fileName: 'notes.txt' });

    expect(dirname(image.path)).toBe(dirname(file.path));
    expect(existsSync(image.path)).toBe(true);
    expect(existsSync(file.path)).toBe(true);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('?size=MIDDLE2048');
    expect(fetchImpl.mock.calls[1]?.[0]).toContain('?attach=true');
  });

  it('берёт имя из Content-Disposition, когда рефа с именем нет', async () => {
    const auth = new FakeAuthProvider();
    const fetchImpl = vi.fn(async () =>
      okResponse('x', { 'content-disposition': "attachment; filename*=UTF-8''%D0%9E%D1%82%D1%87%D1%91%D1%82.pdf" }),
    );

    const result = await downloadAttachment(
      { auth, config, fetchImpl: fetchImpl as unknown as typeof fetch },
      { fileId: FILE_ID },
    );

    expect(basename(result.path)).toBe('Отчёт.pdf');
  });

  it('имя из рефа приоритетнее Content-Disposition: живьём они расходятся', async () => {
    const auth = new FakeAuthProvider();
    const fetchImpl = vi.fn(async () => okResponse('x', { 'content-disposition': 'attachment; filename="server.bin"' }));

    const result = await downloadAttachment(
      { auth, config, fetchImpl: fetchImpl as unknown as typeof fetch },
      { fileId: FILE_ID, fileName: 'ref.txt' },
    );

    expect(basename(result.path)).toBe('ref.txt');
  });

  it('traversal в имени не выводит файл за пределы папки загрузок', async () => {
    const auth = new FakeAuthProvider();
    const fetchImpl = vi.fn(async () => okResponse('пробой'));

    const result = await downloadAttachment(
      { auth, config, fetchImpl: fetchImpl as unknown as typeof fetch },
      { fileId: FILE_ID, fileName: '../../../../tmp/pwned.txt' },
    );

    expect(dirname(result.path)).toBe(config.paths.downloadsDir);
    expect(existsSync('/tmp/pwned.txt')).toBe(false);
    expect(readdirSync(config.paths.downloadsDir)).toEqual(['_.._.._.._tmp_pwned.txt']);
  });

  it('коллизия имён не затирает чужой файл, а кладёт копию рядом', async () => {
    const auth = new FakeAuthProvider();
    const fetchImpl = vi.fn(async () => okResponse('второй'));
    const deps = { auth, config, fetchImpl: fetchImpl as unknown as typeof fetch };

    const first = await downloadAttachment(deps, { fileId: FILE_ID, fileName: 'photo.jpg' });
    writeFileSync(first.path, 'первый');
    const second = await downloadAttachment(deps, { fileId: FILE_ID, fileName: 'photo.jpg' });

    expect(basename(first.path)).toBe('photo.jpg');
    expect(basename(second.path)).toBe('photo-1.jpg');
    expect(readFileSync(first.path, 'utf8')).toBe('первый');
  });

  it('не-200 даёт внятную ошибку и не оставляет файла', async () => {
    const auth = new FakeAuthProvider();
    const fetchImpl = vi.fn(async () => new Response('', { status: 404, statusText: 'Not Found' }));

    await expect(
      downloadAttachment({ auth, config, fetchImpl: fetchImpl as unknown as typeof fetch }, { fileId: FILE_ID }),
    ).rejects.toThrow(/HTTP 404/);

    expect(existsSync(config.paths.downloadsDir)).toBe(false);
  });

  it('на 401 рефрешит сессию и повторяет один раз', async () => {
    const auth = new FakeAuthProvider();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(okResponse('ok'));

    const result = await downloadAttachment(
      { auth, config, fetchImpl: fetchImpl as unknown as typeof fetch },
      { fileId: FILE_ID, fileName: 'a.txt' },
    );

    expect(auth.authFailures).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(existsSync(result.path)).toBe(true);
  });

  it('метёт протухшее ПЕРЕД скачиванием', async () => {
    const auth = new FakeAuthProvider();
    const fetchImpl = vi.fn(async () => okResponse('свежий'));
    /* Кладём состаренный файл в downloads до вызова */
    const deps = { auth, config, fetchImpl: fetchImpl as unknown as typeof fetch };
    await downloadAttachment(deps, { fileId: FILE_ID, fileName: 'seed.txt' });
    const stale = join(config.paths.downloadsDir, 'stale.bin');
    writeFileSync(stale, 'x');
    const seconds = (Date.now() - 30 * DAY_MS) / 1000;
    utimesSync(stale, seconds, seconds);

    await downloadAttachment(deps, { fileId: FILE_ID, fileName: 'next.txt' });

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(config.paths.downloadsDir, 'next.txt'))).toBe(true);
  });

  it('невалидный file_id отвергается до сети', async () => {
    const auth = new FakeAuthProvider();
    const fetchImpl = vi.fn();

    await expect(
      downloadAttachment(
        { auth, config, fetchImpl: fetchImpl as unknown as typeof fetch },
        { fileId: '../../etc/passwd' },
      ),
    ).rejects.toThrow(/недопустимую форму/);

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
