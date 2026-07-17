#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { sweepDownloads } from './attachments/cleanup.js';
import { CookieAuthProvider } from './auth/CookieAuthProvider.js';
import { PlaywrightProfile } from './auth/PlaywrightProfile.js';
import { loadConfig } from './config/loadConfig.js';
import { loadReactionMap } from './config/reactionMap.js';
import { createServer } from './server.js';
import { RegistryHttpClient } from './transport/RegistryHttpClient.js';
import { MessengerWsClient } from './transport/ws/MessengerWsClient.js';
import { createLogger } from './util/logger.js';

async function main(): Promise<void> {
  const logger = createLogger({ bindings: { component: 'main' } });
  const config = loadConfig();

  logger.info('starting mcp server', {
    configFile: config.paths.configFile,
    downloadsDir: config.paths.downloadsDir,
    ttlDays: config.downloads.ttlDays,
  });

  /*
   * TTL-подметание на старте. Оно НЕ единственное (downloadAttachment метёт перед каждым
   * скачиванием): сервер живёт долго и может не рестартовать неделями. Сбой подметания не
   * должен мешать серверу подняться - скачанные файлы это кэш, а не состояние.
   */
  try {
    const swept = await sweepDownloads({
      downloadsDir: config.paths.downloadsDir,
      ttlDays: config.downloads.ttlDays,
      logger,
    });
    logger.debug('downloads sweep на старте', swept);
  } catch (error) {
    logger.warn('downloads sweep на старте не выполнен', {
      code: (error as NodeJS.ErrnoException).code ?? 'unknown',
    });
  }

  /*
   * Сборка без ввода-вывода: браузер не поднимается, сокет не открывается.
   * Авторизация случится лениво, на первом вызове инструмента, который реально
   * ходит к серверу - `tools/list` обязан отвечать и без живой сессии.
   */
  const profile = new PlaywrightProfile({ profileDir: config.paths.profileDir, logger });
  const auth = new CookieAuthProvider({
    profile,
    apiUrl: config.protocol.apiUrl,
    csrfTokenUrl: config.protocol.csrfTokenUrl,
    logger,
  });
  const ws = new MessengerWsClient({
    auth,
    xivaUrl: config.protocol.xivaUrl,
    xivaServiceName: config.protocol.xivaServiceName,
    logger,
  });
  const http = new RegistryHttpClient({ apiUrl: config.protocol.apiUrl, auth, logger });

  const server = createServer({
    config,
    logger,
    deps: { ws, http, auth, config, logger, reactionMap: loadReactionMap() },
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('mcp server connected on stdio');
}

main().catch((error: unknown) => {
  /* Логгер может быть не создан, если упал loadConfig - пишем напрямую в stderr */
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      msg: 'fatal: server failed to start',
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
