/**
 * Зависимости read-инструментов.
 *
 * Собираются один раз на старте и БЕЗ ввода-вывода: ни один конструктор здесь не лезет
 * в сеть и не поднимает браузер. Это важно для MCP-контракта - `tools/list` обязан
 * отвечать, не требуя живой сессии; авторизация случается лениво, на первом вызове,
 * который реально ходит к серверу.
 */
import type { AuthProvider } from '../../auth/AuthProvider.js';
import type { ReactionMap } from '../../config/reactionMap.js';
import type { Config } from '../../config/types.js';
import type { RegistryHttpClient } from '../../transport/RegistryHttpClient.js';
import type { MessengerWsClient } from '../../transport/ws/MessengerWsClient.js';
import type { Logger } from '../../util/logger.js';

export interface ToolDeps {
  ws: MessengerWsClient;
  http: RegistryHttpClient;
  auth: AuthProvider;
  config: Config;
  logger: Logger;
  /** Карта реакций (Phase 2): int type -> name/emoji для отрисовки в обогащённой выдаче */
  reactionMap: ReactionMap;
}
