import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  CONFIG_DIR_NAME,
  CONFIG_FILE_NAME,
  DEFAULT_DOWNLOADS,
  DEFAULT_LIMITS,
  DEFAULT_PROTOCOL,
  DOWNLOADS_DIR_NAME,
  PROFILE_DIR_NAME,
} from './defaults.js';
import type { Config, LoadConfigOptions, UserConfigFile } from './types.js';

/** Каталог артефактов по умолчанию: ~/.config/yandex-messenger-mcp */
export function resolveConfigDir(options: LoadConfigOptions = {}): string {
  if (options.configDir !== undefined) {
    return resolve(options.configDir);
  }
  return join(homedir(), '.config', CONFIG_DIR_NAME);
}

function resolveAgainstConfigDir(configDir: string, value: string): string {
  return isAbsolute(value) ? value : resolve(configDir, value);
}

function readUserConfigFile(configFile: string): UserConfigFile {
  let raw: string;
  try {
    raw = readFileSync(configFile, 'utf8');
  } catch (error) {
    /* Отсутствие файла - штатный случай: работаем на дефолтах */
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new Error(`Не удалось прочитать config: ${configFile}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`config содержит невалидный JSON: ${configFile}: ${(error as Error).message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`config должен быть JSON-объектом: ${configFile}`);
  }

  return parsed as UserConfigFile;
}

/**
 * Читает ~/.config/yandex-messenger-mcp/config.json, мержит с дефолтами
 * и резолвит пути артефактов. Отсутствие файла - НЕ ошибка.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const configDir = resolveConfigDir(options);
  const configFile = join(configDir, CONFIG_FILE_NAME);
  const userConfig = readUserConfigFile(configFile);

  const profileDir = resolveAgainstConfigDir(
    configDir,
    userConfig.paths?.profileDir ?? PROFILE_DIR_NAME,
  );
  const downloadsDir = resolveAgainstConfigDir(
    configDir,
    userConfig.paths?.downloadsDir ?? DOWNLOADS_DIR_NAME,
  );

  return {
    protocol: { ...DEFAULT_PROTOCOL, ...userConfig.protocol },
    paths: { configDir, configFile, profileDir, downloadsDir },
    downloads: { ...DEFAULT_DOWNLOADS, ...userConfig.downloads },
    limits: { ...DEFAULT_LIMITS, ...userConfig.limits },
  };
}
