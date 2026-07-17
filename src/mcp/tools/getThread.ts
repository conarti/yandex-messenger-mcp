/**
 * `get_thread` - сообщения треда как микро-чата (§17.10, спайк 1).
 *
 * ДВА СПОСОБА АДРЕСАЦИИ, один результат:
 *  - `thread_id`: готовый ChatId треда (дериватив `buildThreadId`), открывается напрямую;
 *  - `chat` + `message_id`: родительский чат резолвится как в `get_history`, из него и метки
 *    родительского сообщения деривируется `thread_id` (§17.10) - это и есть «Обсудить». Реверса
 *    не требует: создания на сервере нет, деривация чисто строковая.
 *
 * СОЗДАНИЕ ТРЕДА = ДЕРИВАЦИЯ + ПЕРВЫЙ PUSH. Отдельного «создать» тут нет: несуществующий тред
 * приезжает как `empty:true` (сервер ответил `ENTITY_NOT_FOUND`), а материализует его первый
 * `push` - его делает существующий `send_message` с `thread_id` как ChatId (его же draft->confirm).
 * `thread_id` возвращается всегда, поэтому вызывающий знает, куда слать.
 *
 * ПРИЗНАК ТРЕДА И КОРЕНЬ - ИЗ PHASE 1. Каждое сообщение приезжает через `enrichMessage`, неся
 * `thread.has_thread`/`thread.root`. Корень самого треда (`ThreadParentMessage`) отдаётся отдельно
 * полем `parent_message` - он приходит внутри элемента чата, отдельный запрос не нужен.
 *
 * БИЗНЕС-ЧАТ -> `thread_unsupported`. Деривация треда для префикса `2` (и экзотических) не
 * определена (спайк 1): это честный отказ с причиной, а не тихая пустая выдача.
 */
import { resolveChat, type ChatCandidate } from '../../chat/resolveChat.js';
import type { EnrichedMessage } from '../../protocol/enrichMessage.js';
import type { Message } from '../../protocol/messageShape.js';
import { buildThreadId, isThreadId, parseThreadId } from '../../protocol/threadId.js';
import { openThread } from '../../protocol/threads.js';
import type { ToolDeps } from './deps.js';

/** `| undefined` в полях - осознанно: под exactOptionalPropertyTypes zod отдаёт именно такой тип */
export interface GetThreadInput {
  /** Готовый ChatId треда (альтернатива паре chat + message_id) */
  thread_id?: string | undefined;
  /** Родительский чат: ChatId либо поисковый запрос (нужен вместе с message_id) */
  chat?: string | undefined;
  /** Метка родительского сообщения в мкс строкой (нужна вместе с chat) */
  message_id?: string | undefined;
  limit?: number | undefined;
  /** Курсор: метка в мкс строкой, вернуть сообщения строго старше неё */
  before?: string | undefined;
}

export type GetThreadResult =
  | {
      status: 'ok';
      thread_id: string;
      /** Родительский чат треда, если известен (из деривации либо разбора thread_id) */
      parent_chat_id?: string;
      /** true = тред ещё не материализован; создастся первым send_message в этот thread_id */
      empty: boolean;
      messages: EnrichedMessage[];
      /** Корень треда (ThreadParentMessage), если пришёл */
      parent_message?: Message;
      next_before?: string;
      has_more: boolean;
    }
  | { status: 'thread_unsupported'; parent_chat_id: string; reason: string }
  | { status: 'ambiguous_chat'; candidates: ChatCandidate[] }
  | { status: 'chat_not_found'; query: string }
  | { status: 'invalid_input'; reason: string };

export const DEFAULT_THREAD_LIMIT = 40;

/** Либо готовый ChatId треда, либо ранний результат (unsupported/ambiguous/not_found/invalid) */
type ThreadResolution =
  | { kind: 'thread'; threadId: string; parentChatId?: string }
  | { kind: 'result'; result: GetThreadResult };

export async function getThread(deps: ToolDeps, input: GetThreadInput): Promise<GetThreadResult> {
  const { guid } = await deps.auth.getWhoami();

  const resolved = await resolveThreadId(deps, input, guid);
  if (resolved.kind !== 'thread') {
    return resolved.result;
  }
  const { threadId, parentChatId } = resolved;

  const limit = input.limit ?? DEFAULT_THREAD_LIMIT;
  const history = await openThread(
    deps.ws,
    {
      threadId,
      limit,
      ...(input.before !== undefined ? { before: input.before } : {}),
    },
    { myGuid: guid, reactionMap: deps.reactionMap },
  );

  deps.logger.debug('get_thread: тред открыт', {
    thread_id: threadId,
    empty: history.empty,
    count: history.messages.length,
  });

  return {
    status: 'ok',
    thread_id: history.thread_id,
    ...(parentChatId !== undefined ? { parent_chat_id: parentChatId } : {}),
    empty: history.empty,
    messages: history.messages,
    ...(history.parent_message !== undefined ? { parent_message: history.parent_message } : {}),
    ...(history.next_before !== undefined ? { next_before: history.next_before } : {}),
    has_more: history.has_more,
  };
}

async function resolveThreadId(deps: ToolDeps, input: GetThreadInput, myGuid: string): Promise<ThreadResolution> {
  /* Прямой thread_id: открываем как есть; родительский чат восстанавливаем разбором (§17.10) */
  if (input.thread_id !== undefined) {
    if (!isThreadId(input.thread_id)) {
      return {
        kind: 'result',
        result: { status: 'invalid_input', reason: `thread_id "${input.thread_id}" не распознан как id треда` },
      };
    }
    const parent = parseThreadId(input.thread_id);
    return {
      kind: 'thread',
      threadId: input.thread_id,
      ...(parent !== undefined ? { parentChatId: parent.chatId } : {}),
    };
  }

  if (input.chat === undefined || input.message_id === undefined) {
    return {
      kind: 'result',
      result: { status: 'invalid_input', reason: 'нужны либо thread_id, либо пара chat + message_id' },
    };
  }

  const resolved = await resolveChat(input.chat, {
    http: deps.http,
    logger: deps.logger,
    myGuid,
    searchLimit: deps.config.limits.searchDefaultLimit,
  });
  if (resolved.status === 'ambiguous') {
    return { kind: 'result', result: { status: 'ambiguous_chat', candidates: resolved.candidates } };
  }
  if (resolved.status === 'not_found') {
    return { kind: 'result', result: { status: 'chat_not_found', query: input.chat } };
  }

  /* «Обсудить»: деривируем thread_id из родительского чата и метки родительского сообщения */
  const built = buildThreadId(resolved.chat_id, input.message_id);
  if (built.status === 'unsupported') {
    return {
      kind: 'result',
      result: { status: 'thread_unsupported', parent_chat_id: resolved.chat_id, reason: built.reason },
    };
  }
  return { kind: 'thread', threadId: built.thread_id, parentChatId: resolved.chat_id };
}
