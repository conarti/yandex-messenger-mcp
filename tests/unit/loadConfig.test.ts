import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DOWNLOADS,
  DEFAULT_LIMITS,
  DEFAULT_PROTOCOL,
} from '../../src/config/defaults.js';
import { loadConfig, resolveConfigDir } from '../../src/config/loadConfig.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'ymm-config-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('loadConfig без файла', () => {
  it('не бросает и отдаёт дефолты', () => {
    const config = loadConfig({ configDir: workDir });

    expect(config.protocol).toEqual(DEFAULT_PROTOCOL);
    expect(config.downloads).toEqual(DEFAULT_DOWNLOADS);
    expect(config.downloads.ttlDays).toBe(7);
    expect(config.limits).toEqual(DEFAULT_LIMITS);
  });

  it('резолвит profile/ и downloads/ относительно configDir', () => {
    const config = loadConfig({ configDir: workDir });

    expect(config.paths.configDir).toBe(workDir);
    expect(config.paths.configFile).toBe(join(workDir, 'config.json'));
    expect(config.paths.profileDir).toBe(join(workDir, 'profile'));
    expect(config.paths.downloadsDir).toBe(join(workDir, 'downloads'));
  });
});

describe('resolveConfigDir', () => {
  it('по умолчанию указывает в ~/.config/yandex-messenger-mcp', () => {
    expect(resolveConfigDir()).toBe(join(homedir(), '.config', 'yandex-messenger-mcp'));
  });

  it('дефолтный loadConfig резолвит все пути внутрь ~/.config/yandex-messenger-mcp', () => {
    const expectedDir = join(homedir(), '.config', 'yandex-messenger-mcp');
    const config = loadConfig();

    expect(config.paths.configDir).toBe(expectedDir);
    expect(config.paths.configFile).toBe(join(expectedDir, 'config.json'));
    expect(config.paths.profileDir).toBe(join(expectedDir, 'profile'));
    expect(config.paths.downloadsDir).toBe(join(expectedDir, 'downloads'));
  });
});

describe('loadConfig с файлом', () => {
  it('мержит частичный конфиг поверх дефолтов, не затирая соседние поля', () => {
    writeFileSync(
      join(workDir, 'config.json'),
      JSON.stringify({
        downloads: { ttlDays: 30 },
        protocol: { apiVersion: 6 },
      }),
    );

    const config = loadConfig({ configDir: workDir });

    expect(config.downloads.ttlDays).toBe(30);
    expect(config.protocol.apiVersion).toBe(6);
    expect(config.protocol.apiUrl).toBe(DEFAULT_PROTOCOL.apiUrl);
    expect(config.limits).toEqual(DEFAULT_LIMITS);
  });

  it('уважает абсолютный downloadsDir и относительный резолвит от configDir', () => {
    const absolute = join(tmpdir(), 'ymm-downloads-abs');
    writeFileSync(
      join(workDir, 'config.json'),
      JSON.stringify({ paths: { downloadsDir: absolute, profileDir: 'chrome-profile' } }),
    );

    const config = loadConfig({ configDir: workDir });

    expect(config.paths.downloadsDir).toBe(absolute);
    expect(config.paths.profileDir).toBe(join(workDir, 'chrome-profile'));
  });

  it('бросает понятную ошибку на битом JSON', () => {
    writeFileSync(join(workDir, 'config.json'), '{ not json');

    expect(() => loadConfig({ configDir: workDir })).toThrow(/невалидный JSON/);
  });
});

describe('defaults', () => {
  it('не содержат OAuth-скаффолдинга websocketUrl/uniproxyApiKey', () => {
    expect(DEFAULT_PROTOCOL).not.toHaveProperty('websocketUrl');
    expect(DEFAULT_PROTOCOL).not.toHaveProperty('uniproxyApiKey');
  });
});
