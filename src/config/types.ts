/**
 * Протокольные константы Яндекс.Мессенджера (§15 research).
 * Переопределяемы в config.json на случай ротации значений в новой версии chats-web.
 */
export interface ProtocolConfig {
  /** HTTP registry RPC endpoint */
  apiUrl: string;
  /** CSRF-токен endpoint. В v1 не используется: все HTTP-вызовы read/enableCSRF:false */
  csrfTokenUrl: string;
  /** xiva WS endpoint (cookie-режим), без query - query собирает MessengerWsClient */
  xivaUrl: string;
  xivaServiceName: string;
  /** X-Origin-Service-ID / Meta.Origin */
  serviceId: number;
  /** Messenger protocol version */
  apiVersion: number;
  /** HTTP config-значение client. НЕ путать с WS xiva-query client=web_main */
  client: number;
  filePrivateHost: string;
  filePublicHost: string;
  yapicFileHost: string;
  workspaceId: string;
}

/** Абсолютные пути артефактов, резолвятся относительно configDir */
export interface PathsConfig {
  configDir: string;
  configFile: string;
  profileDir: string;
  downloadsDir: string;
}

export interface DownloadsConfig {
  /** TTL авто-очистки скачанных файлов в днях */
  ttlDays: number;
}

export interface LimitsConfig {
  listChatsDefaultLimit: number;
  /** Стартовый limit для search: задаётся явно, серверный дефолт (5) не подразумевается (§17.5) */
  searchDefaultLimit: number;
}

export interface Config {
  protocol: ProtocolConfig;
  paths: PathsConfig;
  downloads: DownloadsConfig;
  limits: LimitsConfig;
}

/** Форма config.json: все секции и поля опциональны */
export interface UserConfigFile {
  protocol?: Partial<ProtocolConfig>;
  paths?: {
    /** Путь к persistent-профилю Playwright; относительный резолвится от configDir */
    profileDir?: string;
    /** Папка загрузок; относительный путь резолвится от configDir */
    downloadsDir?: string;
  };
  downloads?: Partial<DownloadsConfig>;
  limits?: Partial<LimitsConfig>;
}

export interface LoadConfigOptions {
  /** Переопределение каталога артефактов (по умолчанию ~/.config/yandex-messenger-mcp) */
  configDir?: string;
}
