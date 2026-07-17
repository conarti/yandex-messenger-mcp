import type { DownloadsConfig, LimitsConfig, ProtocolConfig } from './types.js';

/** Имя каталога артефактов внутри ~/.config */
export const CONFIG_DIR_NAME = 'yandex-messenger-mcp';
export const CONFIG_FILE_NAME = 'config.json';
export const PROFILE_DIR_NAME = 'profile';
export const DOWNLOADS_DIR_NAME = 'downloads';

/**
 * Константы §15 research-дока.
 *
 * Сознательно БЕЗ `websocketUrl` (uniproxy) и `uniproxyApiKey`: они нужны только
 * OAuth-транспорту uniproxy, который в v1 не реализуется и потребует отдельного
 * WS-клиента (ADR: OAuth-скаффолдинг снят как YAGNI).
 */
export const DEFAULT_PROTOCOL: ProtocolConfig = {
  apiUrl: 'https://yandex.ru/messenger/api/registry/api/',
  csrfTokenUrl: 'https://yandex.ru/messenger/api/registry/csrf-token/',
  xivaUrl: 'wss://push.yandex.ru/v2/subscribe/websocket',
  xivaServiceName: 'messenger-prod',
  serviceId: 27,
  apiVersion: 5,
  client: 1000,
  filePrivateHost: 'files.messenger.yandex.ru',
  filePublicHost: 'files.messenger.yandex.net',
  yapicFileHost: 'avatars.mds.yandex.net',
  workspaceId: 'main',
};

export const DEFAULT_DOWNLOADS: DownloadsConfig = {
  ttlDays: 7,
};

export const DEFAULT_LIMITS: LimitsConfig = {
  listChatsDefaultLimit: 50,
  searchDefaultLimit: 50,
};

/** Валидные entities для search (§17.6): `contacts` невалиден и отвергается на входе */
export const SEARCH_ENTITIES = ['messages', 'users', 'chats'] as const;
export type SearchEntity = (typeof SEARCH_ENTITIES)[number];

/** Во сколько раз поднимается `limit`, когда выдача насыщена (§17.5) */
export const SEARCH_LIMIT_FACTOR = 4;

/**
 * Клиентский потолок эскалации `limit`.
 *
 * Серверного потолка НЕ обнаружено: живьём `limit=500` и `limit=1000` отвечают штатно
 * (2026-07-17). Это чисто наша страховка от бесконечной эскалации; при насыщении на
 * этом значении результат помечается `truncated`, а не обрезается молча.
 */
export const SEARCH_LIMIT_CEILING = 1000;
