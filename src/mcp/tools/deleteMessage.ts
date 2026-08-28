/**
 * `delete_message` - необратимое удаление своего сообщения, поэтому двухшаговое (draft->confirm).
 *
 * ШАГ 1 (по умолчанию): резолв чата -> ПЕРЕЧИТЫВАНИЕ удаляемого (автор/время/текст) -> confirm-токен.
 * В сокет НЕ уходит ничего: превью строится чтением (`message_info`), а не удалением.
 * ШАГ 2 (`confirm:true` + токен): ре-верификация чата и цели -> пустой `Plain{ChatId, Timestamp}`
 * полным конвертом (§9.3). Удаление детектится при повторном чтении как `Deleted=true` (§9.1).
 *
 * ИДЕМПОТЕНТНОСТЬ - TARGET-ПУТЬ. Токен НЕ несёт `payload_id`: цель адресуется target-`Timestamp`.
 * Серверный `DUPLICATE(8)` на повторе НЕ обещается (см. шапку confirm.ts) - от повтора в пределах
 * сессии защищает локальная память `recallResult`, плюс естественная идемпотентность по метке.
 *
 * ЧУЖОЕ СООБЩЕНИЕ ОТКЛОНЯЕТ СЕРВЕР. Удаление не своего приходит некоммитнутым commit-статусом
 * (`NO_PERMISSION`/`SENDER_NOT_IN_CHAT`/...), и `pushMutation` поднимает его внятной ошибкой
 * через маппер §14.6. Своего ограничения тут нет - решает сервер.
 */
import { resolveChat, type ChatCandidate } from '../../chat/resolveChat.js';
import { buildChatResolveFailure, type ChatResolveFailure } from '../../chat/resolveFailure.js';
import { encodeToken, fingerprint, recallResult, rememberResult, verifyConfirmToken, type DraftToken } from '../confirm.js';
import { buildDeleteMutation, pushMutation } from '../../protocol/mutations.js';
import { getMessageInfo } from '../../protocol/messageInfo.js';
import type { ToolDeps } from './deps.js';

/** `| undefined` в полях - осознанно: под exactOptionalPropertyTypes zod отдаёт именно такой тип */
export interface DeleteMessageInput {
  chat: string;
  message_id: string;
  confirm?: boolean | undefined;
  confirm_token?: string | undefined;
}

/** Превью удаляемого сообщения (перечитано, ничего не удалено) */
export interface DeleteTargetPreview {
  from_guid?: string;
  from_name?: string;
  timestamp: string;
  timestamp_mcs: string;
  text?: string;
  /** Уже удалено ранее (повторное удаление) */
  already_deleted: boolean;
}

export interface DeleteMessageDraft {
  status: 'draft';
  chat_id: string;
  message_id: string;
  target: DeleteTargetPreview;
  confirm_token: string;
  next_step: string;
}

export interface DeleteMessageDeleted {
  status: 'deleted';
  chat_id: string;
  message_id: string;
  commit_status: number;
  commit_status_name: string;
}

export type DeleteMessageResult =
  | DeleteMessageDraft
  | DeleteMessageDeleted
  | { status: 'ambiguous_chat'; candidates: ChatCandidate[] }
  | ChatResolveFailure;

/** Отпечаток delete-пути: чат + метка цели. Текста нет - удаление адресуется меткой */
function deleteFingerprint(chatId: string, messageId: string): string {
  return fingerprint('delete', `${chatId}:${messageId}`);
}

export async function deleteMessage(deps: ToolDeps, input: DeleteMessageInput): Promise<DeleteMessageResult> {
  const { guid } = await deps.auth.getWhoami();

  const resolved = await resolveChat(input.chat, {
    http: deps.http,
    logger: deps.logger,
    myGuid: guid,
    searchLimit: deps.config.limits.searchDefaultLimit,
  });
  if (resolved.status === 'ambiguous') {
    return { status: 'ambiguous_chat', candidates: resolved.candidates };
  }
  if (resolved.status === 'not_found') {
    return buildChatResolveFailure({ query: input.chat, reason: 'name_not_found' });
  }

  if (input.confirm !== true) {
    /* Превью - чтением: ничего не удаляем, показываем что уйдёт */
    const info = await getMessageInfo(
      deps.ws,
      { chatId: resolved.chat_id, timestamp: input.message_id },
      { myGuid: guid, reactionMap: deps.reactionMap },
    );
    const message = info.message;
    const draft: DraftToken = {
      op: 'delete',
      chat_id: resolved.chat_id,
      fingerprint: deleteFingerprint(resolved.chat_id, input.message_id),
    };
    deps.logger.info('delete_message: подготовлен draft, ничего не удалено', { via: resolved.via });
    return {
      status: 'draft',
      chat_id: resolved.chat_id,
      message_id: input.message_id,
      target: {
        ...(message.from.guid.length > 0 ? { from_guid: message.from.guid } : {}),
        ...(message.from.name !== undefined ? { from_name: message.from.name } : {}),
        timestamp: message.timestamp,
        timestamp_mcs: message.timestamp_mcs,
        ...(message.text !== undefined ? { text: message.text } : {}),
        already_deleted: message.deleted,
      },
      confirm_token: encodeToken(draft),
      next_step:
        'Ничего не удалено. Чтобы удалить, повторите вызов с confirm:true, тем же confirm_token ' +
        'и НЕИЗМЕНЁННЫМИ chat и message_id: изменение любого из них отклонит удаление.',
    };
  }

  const token = input.confirm_token ?? '';
  const draft = verifyConfirmToken({
    op: 'delete',
    token,
    chatId: resolved.chat_id,
    fingerprint: deleteFingerprint(resolved.chat_id, input.message_id),
  });

  const remembered = recallResult<DeleteMessageDeleted>(token);
  if (remembered !== undefined) {
    deps.logger.warn('delete_message: повторный confirm тем же токеном, второй push не отправлен');
    return remembered;
  }

  const outcome = await pushMutation(
    { ws: deps.ws, auth: deps.auth, serviceId: deps.config.protocol.serviceId },
    buildDeleteMutation({ chatId: draft.chat_id, timestamp: input.message_id }),
  );

  const result: DeleteMessageDeleted = {
    status: 'deleted',
    chat_id: draft.chat_id,
    message_id: input.message_id,
    commit_status: outcome.status,
    commit_status_name: outcome.status_name,
  };
  rememberResult(token, result);
  deps.logger.info('delete_message: удалено', { commit: outcome.status_name });
  return result;
}
