/**
 * `set_reaction` - поставить/снять реакцию ОДНИМ вызовом, без confirm: реверсибельно
 * (`Action:REMOVE=1` откатывает тем же инструментом, спека Round 7).
 *
 * ВАЛИДАЦИЯ ТИПА ДО ОТПРАВКИ. Сервер `Type` не валидирует вовсе (§17.12: `999999`, `1` ->
 * `Status:1`, читаются обратно дословно, видят все). Значит валидировать обязаны МЫ, на
 * входе: тип вне карты (`reaction-map.json`) на провод не уходит. `1` - мусор (не 👍),
 * `999999` - несуществующий артворк; оба отвергаются здесь, ДО поиска чата и любой сети.
 *
 * Полный конверт `ClientMessage` (§17.12): плоский `push({Reaction})` дал бы ложный
 * `NO_SUCH_CHAT`. Сборку конверта и бренд-защиту от плоской формы держит protocol/mutations.
 */
import { resolveChat, type ChatCandidate } from '../../chat/resolveChat.js';
import { buildChatResolveFailure, type ChatResolveFailure } from '../../chat/resolveFailure.js';
import { buildReactionMutation, pushMutation } from '../../protocol/mutations.js';
import type { ToolDeps } from './deps.js';

/** `| undefined` в полях - осознанно: под exactOptionalPropertyTypes zod отдаёт именно такой тип */
export interface SetReactionInput {
  chat: string;
  message_id: string;
  type: number;
  /** true -> снять реакцию (`Action:REMOVE=1`); по умолчанию поставить */
  remove?: boolean | undefined;
}

export type SetReactionResult =
  | {
      status: 'ok';
      chat_id: string;
      message_id: string;
      type: number;
      action: 'add' | 'remove';
      commit_status: number;
      commit_status_name: string;
    }
  | { status: 'invalid_type'; type: number; hint: string }
  | { status: 'ambiguous_chat'; candidates: ChatCandidate[] }
  | ChatResolveFailure;

export async function setReaction(deps: ToolDeps, input: SetReactionInput): Promise<SetReactionResult> {
  /* Тип - первым, ДО поиска чата: мусорный тип не должен даже трогать сеть */
  if (!deps.reactionMap.isKnown(input.type)) {
    return {
      status: 'invalid_type',
      type: input.type,
      hint:
        'Тип реакции отсутствует в reaction-map.json и на провод не отправлен (сервер принял бы любой int). ' +
        'Возьмите type из поля reactions прочитанного сообщения.',
    };
  }

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

  const remove = input.remove === true;
  const outcome = await pushMutation(
    { ws: deps.ws, auth: deps.auth, serviceId: deps.config.protocol.serviceId },
    buildReactionMutation({ chatId: resolved.chat_id, timestamp: input.message_id, type: input.type, remove }),
  );

  deps.logger.info('set_reaction: отправлено', { action: remove ? 'remove' : 'add', commit: outcome.status_name });
  return {
    status: 'ok',
    chat_id: resolved.chat_id,
    message_id: input.message_id,
    type: input.type,
    action: remove ? 'remove' : 'add',
    commit_status: outcome.status,
    commit_status_name: outcome.status_name,
  };
}
