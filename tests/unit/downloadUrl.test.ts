import { describe, expect, it } from 'vitest';
import { buildAttachmentUrl } from '../../src/attachments/downloadUrl.js';
import { DEFAULT_PROTOCOL } from '../../src/config/defaults.js';

/** Форма живого Id2: <bucket>/<uuid> (снято с реального профиля 2026-07-17) */
const FILE_ID = '1234/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d';
const HOST = DEFAULT_PROTOCOL.filePrivateHost;

describe('buildAttachmentUrl', () => {
  it('строит URL превью картинки с ?size=', () => {
    const url = buildAttachmentUrl({ filePrivateHost: HOST, fileId: FILE_ID, size: 'MIDDLE2048' });

    expect(url).toBe(`https://files.messenger.yandex.ru/file_shortterm/${FILE_ID}?size=MIDDLE2048`);
  });

  it('строит URL скачивания файла с ?attach=true, когда size не задан', () => {
    const url = buildAttachmentUrl({ filePrivateHost: HOST, fileId: FILE_ID });

    expect(url).toBe(`https://files.messenger.yandex.ru/file_shortterm/${FILE_ID}?attach=true`);
  });

  it('НЕ экранирует слэш внутри Id2: %2F даёт 404 живьём', () => {
    const url = buildAttachmentUrl({ filePrivateHost: HOST, fileId: FILE_ID });

    expect(url).not.toContain('%2F');
    expect(url).toContain('/file_shortterm/1234/0a1b2c3d');
  });

  it('берёт хост из конфига, а не из зашитой строки', () => {
    const url = buildAttachmentUrl({ filePrivateHost: 'files.example.test', fileId: FILE_ID });

    expect(url.startsWith('https://files.example.test/file_shortterm/')).toBe(true);
  });

  it.each([
    ['traversal сегментом', '1234/../../etc/passwd'],
    ['traversal в начале', '../secrets'],
    ['точечный сегмент', '1234/./x'],
    ['подмена хоста', 'evil.test/x'.replace('evil.test', 'a@evil.test')],
    ['перевод строки', '1234/abc\ndef'],
    ['пробел', '1234/a b'],
    ['query-инъекция', '1234/abc?attach=false'],
  ])('отвергает недопустимый file_id: %s', (_label, fileId) => {
    expect(() => buildAttachmentUrl({ filePrivateHost: HOST, fileId })).toThrow(/недопустимую форму/);
  });

  it('отвергает пустой file_id', () => {
    expect(() => buildAttachmentUrl({ filePrivateHost: HOST, fileId: '' })).toThrow(/пуст/);
  });
});
