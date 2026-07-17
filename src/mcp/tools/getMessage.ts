/**
 * `get_message` - одно сообщение по ChatId+Timestamp ЛИБО по join-ссылке (§14.3/§17.11).
 *
 * ДВА СПОСОБА АДРЕСАЦИИ, один и тот же результат:
 *  - `chat` + `message_id`: чат резолвится как в `get_history` (литеральный ChatId либо запрос),
 *    `message_id` - это `Timestamp` сообщения в мкс (16 цифр, строкой);
 *  - `url`: join-ссылка (§17.11), из неё резолвится и чат (по invite_hash), и метка (хвост URL).
 *
 * БЕЗ ЗАГРУЗКИ ИСТОРИИ. Сообщение достаётся `message_info` (один WS-вызов), а не страницей.
 *
 * ДЕТАЛЬНЫЕ РЕАКЦИИ - ЧЕРЕЗ `list_reactions` (Phase 2, ДВА вызова на сообщение). Для ОДНОГО
 * сообщения это дёшево, поэтому `get_message` подтягивает полный список реакций и прочтений
 * (кто/что/когда), а не только обрезанные сиблинги. Обогащённая выдача `message_info` уже несёт
 * агрегаты; детальная выборка их дополняет.
 *
 * ТРЁХСЕГМЕНТНАЯ ССЫЛКА (сообщение в треде) АДРЕСУЕТСЯ (Phase 4). `resolveLink` деривирует
 * `thread_id` (§17.10, `buildThreadId`), и сообщение достаётся `message_info` по паре
 * `{thread_id, message_timestamp}` - тем же путём, что обычное сообщение. Бизнес-чат треда не
 * даёт (§17.10): тогда возвращается `thread_unsupported` с причиной, а не тихий отказ.
 */
import { resolveChat, type ChatCandidate } from '../../chat/resolveChat.js';
import { resolveLink } from '../../chat/resolveLink.js';
import { getMessageInfo, type MessageInfoResult } from '../../protocol/messageInfo.js';
import { listReactions, type MessageReactionsDetail } from '../../protocol/reactions.js';
import type { ToolDeps } from './deps.js';

/** `| undefined` в полях - осознанно: под exactOptionalPropertyTypes zod отдаёт именно такой тип */
export interface GetMessageInput {
  /** ChatId либо поисковый запрос (нужен вместе с `message_id`) */
  chat?: string | undefined;
  /** Метка сообщения в мкс строкой (нужна вместе с `chat`) */
  message_id?: string | undefined;
  /** join-ссылка (§17.11): альтернатива паре `chat`+`message_id` */
  url?: string | undefined;
  /** Тянуть ли детальные реакции/прочтения (2 вызова `list_reactions`). По умолчанию да */
  with_reactions?: boolean | undefined;
}

export type GetMessageResult =
  | ({
      status: 'ok';
      chat_id: string;
      /** Детальные реакции и прочтения (2 вызова `list_reactions`), если не отключены */
      reactions_detail?: MessageReactionsDetail;
    } & MessageInfoResult)
  | {
      /** 3-сегментная join-ссылка на бизнес-чат: тред недоступен (§17.10), деривации нет */
      status: 'thread_unsupported';
      parent_chat_id: string;
      invite_hash: string;
      thread_root_timestamp: string;
      thread_message_timestamp: string;
      reason: string;
    }
  | { status: 'ambiguous_chat'; candidates: ChatCandidate[] }
  | { status: 'chat_not_found'; query: string }
  | { status: 'invalid_input'; reason: string };

/** Одна цель адресации: чат, метка и (для ссылок) invite_hash */
interface MessageTarget {
  chatId: string;
  timestamp: string;
  inviteHash?: string;
}

export async function getMessage(deps: ToolDeps, input: GetMessageInput): Promise<GetMessageResult> {
  const { guid } = await deps.auth.getWhoami();

  const target = await resolveTarget(deps, input, guid);
  if (target.kind !== 'target') {
    return target.result;
  }
  const { chatId, timestamp, inviteHash } = target.value;

  const info = await getMessageInfo(
    deps.ws,
    { chatId, timestamp, ...(inviteHash !== undefined ? { inviteHash } : {}) },
    { myGuid: guid, reactionMap: deps.reactionMap },
  );

  let reactionsDetail: MessageReactionsDetail | undefined;
  if (input.with_reactions !== false) {
    /* Детальная выборка - 2 вызова list_reactions на одно сообщение (Phase 2), тут это дёшево */
    reactionsDetail = await listReactions(
      deps.ws,
      { chatId, timestamp, ...(inviteHash !== undefined ? { inviteHash } : {}) },
      deps.reactionMap,
    );
  }

  deps.logger.debug('get_message: сообщение получено', {
    via: input.url !== undefined ? 'url' : 'chat_id',
    reactions_detail: reactionsDetail !== undefined,
  });

  return {
    status: 'ok',
    chat_id: chatId,
    ...info,
    ...(reactionsDetail !== undefined ? { reactions_detail: reactionsDetail } : {}),
  };
}

/** Либо готовая цель, либо ранний результат (ambiguous/not_found/pending/invalid) */
type TargetResolution =
  | { kind: 'target'; value: MessageTarget }
  | { kind: 'result'; result: GetMessageResult };

async function resolveTarget(deps: ToolDeps, input: GetMessageInput, myGuid: string): Promise<TargetResolution> {
  if (input.url !== undefined) {
    return resolveByUrl(deps, input.url);
  }

  if (input.chat === undefined || input.message_id === undefined) {
    return {
      kind: 'result',
      result: {
        status: 'invalid_input',
        reason: 'нужны либо url, либо пара chat + message_id',
      },
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
  return { kind: 'target', value: { chatId: resolved.chat_id, timestamp: input.message_id } };
}

async function resolveByUrl(deps: ToolDeps, url: string): Promise<TargetResolution> {
  const link = await resolveLink({ http: deps.http }, url);
  if (link.thread !== undefined) {
    /* 3-сегментная: сообщение в треде. thread_id деривирован resolveLink (§17.10) */
    if (link.thread.status === 'unsupported') {
      return {
        kind: 'result',
        result: {
          status: 'thread_unsupported',
          parent_chat_id: link.chat_id,
          invite_hash: link.invite_hash,
          thread_root_timestamp: link.timestamp,
          thread_message_timestamp: link.thread.message_timestamp,
          reason: link.thread.reason,
        },
      };
    }
    /* Тред = чат: сообщение адресуется message_info по паре {thread_id, message_timestamp} */
    return {
      kind: 'target',
      value: {
        chatId: link.thread.thread_id,
        timestamp: link.thread.message_timestamp,
        inviteHash: link.invite_hash,
      },
    };
  }
  return {
    kind: 'target',
    value: { chatId: link.chat_id, timestamp: link.timestamp, inviteHash: link.invite_hash },
  };
}
