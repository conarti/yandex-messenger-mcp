import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ATTACHMENT_SIZES } from './attachments/downloadUrl.js';
import { SEARCH_ENTITIES } from './config/defaults.js';
import type { Config } from './config/types.js';
import type { ToolDeps } from './mcp/tools/deps.js';
import { downloadAttachment } from './mcp/tools/downloadAttachment.js';
import { getHistory, DEFAULT_HISTORY_LIMIT } from './mcp/tools/getHistory.js';
import { listChats } from './mcp/tools/listChats.js';
import { search } from './mcp/tools/search.js';
import { sendMessage } from './mcp/tools/sendMessage.js';
import type { Logger } from './util/logger.js';

export const SERVER_NAME = 'yandex-messenger-mcp';
export const SERVER_VERSION = '0.1.0';

/** Инструменты, которые сервер обязан выставлять */
export const TOOL_NAMES = [
  'list_chats',
  'get_history',
  'search',
  'send_message',
  'download_attachment',
] as const;

export interface CreateServerOptions {
  config: Config;
  logger: Logger;
  /** Транспорты и auth. Без них read-инструменты не работают (send/download - ещё заглушки) */
  deps: ToolDeps;
}

/** Успешный результат: структурный JSON - его потребитель тут машина, а не человек */
function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Ошибка инструмента -> MCP-ошибка. Полный маппинг трёх слоёв протокола - Phase 7;
 * здесь ошибка лишь не теряется и не выглядит как пустая выдача.
 */
function errorResult(tool: string, error: unknown, logger: Logger): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  logger.error('tool call failed', { tool, error: message });
  return { isError: true, content: [{ type: 'text', text: `${tool}: ${message}` }] };
}

export function createServer(options: CreateServerOptions): McpServer {
  const { config, logger, deps } = options;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'list_chats',
    {
      title: 'List chats',
      description:
        'Список чатов с метаданными (последнее сообщение, флаг непрочитанных), отсортированный по свежести.',
      inputSchema: {
        limit: z
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe(`Максимум чатов (по умолчанию ${config.limits.listChatsDefaultLimit})`),
        unread_only: z
          .boolean()
          .optional()
          .describe('Вернуть только чаты с непрочитанными сообщениями'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return jsonResult(await listChats(deps, args));
      } catch (error) {
        return errorResult('list_chats', error, logger);
      }
    },
  );

  server.registerTool(
    'get_history',
    {
      title: 'Get chat history',
      description: 'Страница сообщений конкретного чата с пагинацией по курсору.',
      inputSchema: {
        chat: z
          .string()
          .min(1)
          .describe('ChatId либо поисковый запрос (имя собеседника/чата) для резолва'),
        limit: z
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(`Максимум сообщений на страницу (по умолчанию ${DEFAULT_HISTORY_LIMIT})`),
        before: z
          .string()
          .regex(/^\d+$/)
          .optional()
          .describe(
            'Курсор: timestamp в микросекундах (строка, точность BigInt). Вернуть сообщения строго старше него; ' +
              'значение для следующей страницы - next_before из предыдущей выдачи',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return jsonResult(await getHistory(deps, args));
      } catch (error) {
        return errorResult('get_history', error, logger);
      }
    },
  );

  server.registerTool(
    'search',
    {
      title: 'Search messenger',
      description: 'Поиск по сообщениям, пользователям и чатам через HTTP registry.',
      inputSchema: {
        query: z.string().min(1).describe('Поисковый запрос'),
        entities: z
          .array(z.enum(SEARCH_ENTITIES))
          .nonempty()
          .optional()
          .describe(
            `Что искать (по умолчанию все): ${SEARCH_ENTITIES.join(', ')}. Значение contacts невалидно`,
          ),
        limit: z
          .int()
          .min(1)
          .optional()
          .describe(
            `Стартовый limit (по умолчанию ${config.limits.searchDefaultLimit}); при упоре эскалируется до полного набора`,
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return jsonResult(await search(deps, args));
      } catch (error) {
        return errorResult('search', error, logger);
      }
    },
  );

  server.registerTool(
    'send_message',
    {
      title: 'Send message',
      description:
        'Отправка текстового сообщения в два шага: без confirm возвращает превью (draft) и НЕ отправляет; ' +
        'с confirm:true и confirm_token из превью отправляет. Отправка необратима, ' +
        'поэтому чат и текст на шаге confirm сверяются с подтверждёнными; расхождение отклоняется.',
      inputSchema: {
        chat: z.string().min(1).describe('ChatId либо поисковый запрос для резолва чата'),
        text: z.string().min(1).describe('Текст сообщения'),
        confirm: z
          .boolean()
          .optional()
          .describe('false/отсутствует - вернуть draft-превью; true - отправить (необратимо)'),
        confirm_token: z
          .string()
          .min(1)
          .optional()
          .describe('Токен из draft-превью. Обязателен при confirm:true'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      try {
        return jsonResult(await sendMessage(deps, args));
      } catch (error) {
        return errorResult('send_message', error, logger);
      }
    },
  );

  server.registerTool(
    'download_attachment',
    {
      title: 'Download attachment',
      description:
        `Скачивает вложение по file_id в папку загрузок (${config.paths.downloadsDir}) и возвращает локальный путь.`,
      inputSchema: {
        file_id: z.string().min(1).describe('Идентификатор файла из file_info рефа сообщения'),
        chat_id: z
          .string()
          .min(1)
          .optional()
          .describe('ChatId источника - только контекст вызывающего, в запрос скачивания не идёт'),
        size: z
          .enum(ATTACHMENT_SIZES)
          .optional()
          .describe(
            'Размер превью для КАРТИНОК. Без него скачивается оригинал файла; для не-картинок бессмыслен',
          ),
      },
      /*
       * idempotentHint:false - повторный вызов НЕ бесплатен: имя вложения не уникально
       * (photo.jpg у всех), затирать чужой файл нельзя, поэтому повтор кладёт рядом копию
       * с суффиксом. Обещать клиенту идемпотентность, которой нет, - хуже, чем не обещать.
       */
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      try {
        return jsonResult(await downloadAttachment(deps, args));
      } catch (error) {
        return errorResult('download_attachment', error, logger);
      }
    },
  );

  logger.debug('tools registered', { tools: TOOL_NAMES, count: TOOL_NAMES.length });

  return server;
}
