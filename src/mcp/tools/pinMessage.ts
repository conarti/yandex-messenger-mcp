/**
 * `pin_message` - закрепить/открепить ОДНИМ вызовом, без confirm: легко снять, ничего не
 * разрушает (спека Round 7).
 *
 * ⚠️ СЕМАНТИКА ДОКО-ВЫВЕДЕНА (US-009/Phase 0), живьём НЕ подтверждена. По §9.3
 * `push({ Pin:{ChatId,Timestamp?} })`: метка присутствует = закрепить это сообщение,
 * отсутствует = открепить. «Пустой `Pin.Timestamp` = открепить» - предположение, до
 * живого подтверждения помечено в README; в выдаче виден `form_status`. Форму держит
 * protocol/mutations.buildPinMutation - заменяется одной правкой.
 */
import { resolveChat, type ChatCandidate } from '../../chat/resolveChat.js';
import { buildPinMutation, pushMutation } from '../../protocol/mutations.js';
import type { ToolDeps } from './deps.js';

/** `| undefined` в полях - осознанно: под exactOptionalPropertyTypes zod отдаёт именно такой тип */
export interface PinMessageInput {
  chat: string;
  /** Метка (мкс) закрепляемого сообщения. Без неё - открепить (доко-выведено) */
  message_id?: string | undefined;
}

export type PinMessageResult =
  | {
      status: 'ok';
      chat_id: string;
      action: 'pin' | 'unpin';
      message_id?: string;
      commit_status: number;
      commit_status_name: string;
      /** Семантика Pin.Timestamp доко-выведена (US-009): предупреждение видно в выдаче */
      form_status: 'doc_derived_unverified';
    }
  | { status: 'ambiguous_chat'; candidates: ChatCandidate[] }
  | { status: 'chat_not_found'; query: string };

export async function pinMessage(deps: ToolDeps, input: PinMessageInput): Promise<PinMessageResult> {
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
    return { status: 'chat_not_found', query: input.chat };
  }

  const pinning = input.message_id !== undefined;
  const outcome = await pushMutation(
    { ws: deps.ws, auth: deps.auth, serviceId: deps.config.protocol.serviceId },
    buildPinMutation({
      chatId: resolved.chat_id,
      ...(input.message_id !== undefined ? { timestamp: input.message_id } : {}),
    }),
  );

  deps.logger.info('pin_message: отправлено', { action: pinning ? 'pin' : 'unpin', commit: outcome.status_name });
  return {
    status: 'ok',
    chat_id: resolved.chat_id,
    action: pinning ? 'pin' : 'unpin',
    ...(input.message_id !== undefined ? { message_id: input.message_id } : {}),
    commit_status: outcome.status,
    commit_status_name: outcome.status_name,
    form_status: 'doc_derived_unverified',
  };
}
