/**
 * E2E live smoke: read-путь на РЕАЛЬНОМ аккаунте.
 *
 * ЗАПУСК: `YMCP_E2E=1 npm test` (или `YMCP_E2E=1 npx vitest run tests/e2e`).
 * Без флага весь файл скипается - обычный `npm test` не должен ходить в сеть, поднимать
 * браузер и зависеть от чужого аккаунта. Это единственный тест в репозитории, которому
 * нужны живая сессия и настоящий профиль.
 *
 * *** ГРАНИЦА SMOKE: ТОЛЬКО ЧТЕНИЕ. ***
 * Ни одного `send_message`, ни одного `download_attachment`. Причина не в лени, а в
 * необратимости и следах: отправка уходит живому собеседнику и её нельзя отменить, а
 * скачивание кладёт копию чужой переписки на диск. Smoke обязан быть безопасен для
 * повторного запуска в любой момент кем угодно - поэтому он не пишет ни в мессенджер,
 * ни на диск. Отправка и скачивание проверены живьём отдельными разовыми прогонами
 * (фазы 5 и 6), их место - не в наборе, который гоняют повторно.
 *
 * *** ПРИВАТНОСТЬ АССЕРТОВ. ***
 * Ассерты идут ТОЛЬКО по числам и булям. Это не стилистика: vitest печатает в диагностику
 * сравниваемое значение, поэтому `expect(uid).toMatch(/^\d+$/)` при падении вывалил бы в
 * лог живой uid, а `expect(chat.name).toBeDefined()` - имя собеседника. Свойство проверяем,
 * значение наружу не выпускаем: `expect(/^\d+$/.test(uid)).toBe(true)`.
 * По той же причине итоговая сводка несёт только агрегаты.
 */
import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CookieAuthProvider } from '../../src/auth/CookieAuthProvider.js';
import { PlaywrightProfile } from '../../src/auth/PlaywrightProfile.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { loadReactionMap } from '../../src/config/reactionMap.js';
import type { ToolDeps } from '../../src/mcp/tools/deps.js';
import { getHistory } from '../../src/mcp/tools/getHistory.js';
import { listChats } from '../../src/mcp/tools/listChats.js';
import { RegistryHttpClient } from '../../src/transport/RegistryHttpClient.js';
import { MessengerWsClient } from '../../src/transport/ws/MessengerWsClient.js';
import { createLogger } from '../../src/util/logger.js';

/** Флаг живого прогона. Любое другое значение (в т.ч. отсутствие) = скип */
const LIVE = process.env['YMCP_E2E'] === '1';

/** Живой прогон = браузер + сеть + чужой сервер. Дефолтные 5с тут бессмысленны */
const LIVE_TIMEOUT_MS = 180_000;

/** Сводка: только агрегаты. Ни ChatId, ни uid/guid, ни текста - см. шапку */
interface Aggregates {
  whoami_uid_numeric: boolean;
  whoami_guid_present: boolean;
  chats: number;
  chats_unread: number;
  chats_with_last_message: number;
  recency_sorted: boolean;
  history_messages: number;
  history_attachment_refs: number;
  history_downloaded_files: number;
}

/** Сколько файлов лежит в downloads. Отсутствие папки - штатный ноль, а не ошибка */
async function countDownloads(downloadsDir: string): Promise<number> {
  try {
    return (await readdir(downloadsDir)).length;
  } catch {
    return 0;
  }
}

describe.skipIf(!LIVE)('e2e live smoke (YMCP_E2E=1, реальный аккаунт)', () => {
  let deps: ToolDeps;
  let ws: MessengerWsClient;
  const aggregates: Partial<Aggregates> = {};

  beforeAll(() => {
    /*
     * level:'error' - лог тут не нужен, а на info он сыплет в stderr на каждый вызов.
     * Редакция логгера работает и так, но самый надёжный способ ничего не выдать - молчать.
     */
    const logger = createLogger({ level: 'error', bindings: { component: 'e2e' } });
    const config = loadConfig();
    const profile = new PlaywrightProfile({ profileDir: config.paths.profileDir, logger });
    const auth = new CookieAuthProvider({
      profile,
      apiUrl: config.protocol.apiUrl,
      csrfTokenUrl: config.protocol.csrfTokenUrl,
      logger,
    });
    ws = new MessengerWsClient({
      auth,
      xivaUrl: config.protocol.xivaUrl,
      xivaServiceName: config.protocol.xivaServiceName,
      logger,
    });
    const http = new RegistryHttpClient({ apiUrl: config.protocol.apiUrl, auth, logger });
    deps = { ws, http, auth, config, logger, reactionMap: loadReactionMap() };
  });

  afterAll(() => {
    /* Сокет держит event loop: без close прогон не завершится */
    ws?.close();
    process.stderr.write(`\n[e2e aggregates] ${JSON.stringify(aggregates)}\n`);
  });

  it(
    'whoami: сессия залогинена по ДАННЫМ, а не по наличию кук',
    async () => {
      const { uid, guid } = await deps.auth.getWhoami();

      /*
       * Числовой uid - это и есть доказательство логина (Принцип 1 плана): у гостя его нет,
       * бандл подставляет туда GUID. Проверяем свойство, значение наружу не отдаём.
       */
      aggregates.whoami_uid_numeric = /^\d+$/.test(uid);
      aggregates.whoami_guid_present = guid.length > 0;

      expect(aggregates.whoami_uid_numeric).toBe(true);
      expect(aggregates.whoami_guid_present).toBe(true);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'list_chats: непустой список, свежие первыми, unread из того же ответа',
    async () => {
      const result = await listChats(deps, {});

      aggregates.chats = result.chats.length;
      aggregates.chats_unread = result.unread_chats;
      aggregates.chats_with_last_message = result.chats.filter((chat) => chat.last_message !== undefined).length;

      /* Непустой список - вторая половина доказательства логина: гость чатов не видит */
      expect(result.chats.length).toBeGreaterThan(0);

      /* Сортировка по свежести - на BigInt: метки 16-значные, float их не удержит */
      const stamps = result.chats.map((chat) => (chat.last_activity_mcs === undefined ? 0n : BigInt(chat.last_activity_mcs)));
      aggregates.recency_sorted = stamps.every((stamp, index) => index === 0 || stamps[index - 1]! >= stamp);
      expect(aggregates.recency_sorted).toBe(true);

      /* unread приходит тем же вызовом: если бы он требовал counters, флага бы не было ни у кого */
      expect(result.chats.every((chat) => typeof chat.unread === 'boolean')).toBe(true);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'get_history: страница реального чата, вложения только рефами',
    async () => {
      const { chats } = await listChats(deps, {});
      const first = chats[0];
      expect(first).toBeDefined();

      /*
       * Инвариант «чтение ничего не качает» проверяется по ФАКТУ на диске, а не по форме
       * рефа: url в AttachmentRef нет по типу, так что ассерт на его отсутствие был бы
       * тавтологией. Единственный честный признак скачивания - появившийся файл.
       */
      const filesBefore = await countDownloads(deps.config.paths.downloadsDir);

      const result = await getHistory(deps, { chat: first!.chat_id, limit: 20 });

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') {
        return;
      }

      const refs = result.messages.flatMap((message) => message.attachments);
      aggregates.history_messages = result.messages.length;
      aggregates.history_attachment_refs = refs.length;

      const filesAfter = await countDownloads(deps.config.paths.downloadsDir);
      aggregates.history_downloaded_files = filesAfter - filesBefore;
      expect(filesAfter).toBe(filesBefore);

      /* Реф обязан нести file_id: без него download_attachment нечем позвать */
      expect(refs.every((ref) => ref.file_id.length > 0)).toBe(true);

      /* Метка - канонический адрес сообщения: без неё пагинация не построится */
      expect(result.messages.every((message) => /^\d+$/.test(message.timestamp_mcs))).toBe(true);
      expect(result.messages.length).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );
});
