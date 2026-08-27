/**
 * Единая форма отказа резолва чата (#18).
 *
 * ПОЧЕМУ ОДНО МЕСТО. Форма `chat_not_found` была объявлена четырнадцать раз независимо, и
 * рассогласованность выдачи - прямое следствие этого. Тип и билдер живут здесь, инструменты
 * их импортируют, а согласованность держит `tsc`, а не ревью.
 *
 * ЛИТЕРАЛ `status:'chat_not_found'` СОХРАНЁН НАМЕРЕННО. Потребитель, который ветвится по нему
 * сегодня, продолжает работать: расширение аддитивное - к статусу добавились `reason`,
 * `candidates` и `next_step`.
 *
 * НАГРУЗКА РАСПРЕДЕЛЕНА ПО ПРИЧИНАМ НЕРАВНОМЕРНО, и это не недосмотр:
 *  - `name_not_found` структурно не может нести кандидатов. `resolveChat` отдаёт `not_found`
 *    только на пустом запросе и когда оба бакета поиска пусты; всё, где кандидатов два и
 *    больше, уходит в `ambiguous`, а один - в `resolved`. Диагностику здесь несёт `next_step`.
 *  - `chat_absent_for_user` несёт ровно одного кандидата: человек нашёлся, переписки с ним нет.
 *  - `backend_entity_not_found` кандидатов не несёт: сущность отверг сам бэкенд.
 *
 * Значение `chat_absent_or_no_data` не заводится: оно предназначалось для исхода живой пробы,
 * который не наступил (код 4 означает отсутствие чата и НЕ означает отсутствия данных по
 * запросу - проверено живьём 2026-08-28). Недостижимых значений в юнионе нет.
 */
import { isDefaultApplicationHint, MessengerError } from '../protocol/errors.js';
import { ResponseStatus } from '../transport/ws/frameTypes.js';
import type { ChatCandidate } from './resolveChat.js';

/** Машиночитаемый дискриминатор причины промаха (AC-19) */
export type ChatResolveFailureReason = 'name_not_found' | 'chat_absent_for_user' | 'backend_entity_not_found';

export interface ChatResolveFailure {
  status: 'chat_not_found';
  /** Строка, которой вызывающий адресовал чат */
  query: string;
  reason: ChatResolveFailureReason;
  /** Тот же формат, что у пути неоднозначности (`ChatCandidate`), второй формы нет (AC-20) */
  candidates: ChatCandidate[];
  /** Что делать вызывающему дальше: без этого дискриминатор причины остаётся немым */
  next_step: string;
}

const NEXT_STEPS: Record<ChatResolveFailureReason, string> = {
  name_not_found:
    'ни чата, ни человека с таким именем не нашлось: передайте в chat готовый ChatId ' +
    '(`<guidA>_<guidB>` для лички, `0/0/<guid>` для группы) либо уточните имя и найдите чат через list_chats или search',
  chat_absent_for_user:
    'человек найден, но переписки с ним ещё нет: чат заводится первым сообщением - ' +
    'вызовите send_message по chat_id из candidates',
  backend_entity_not_found:
    'бэкенд не нашёл сущность по этому chat_id: сверьте chat_id через list_chats - ' +
    'чат мог быть удалён либо доступ к нему потерян',
};

/**
 * Аргумент билдера. Кандидат физически не отделим от причины: пара `reason` + `candidates`
 * не может разъехаться, потому что для двух причин из трёх поля кандидата в типе просто нет.
 */
export type ChatResolveFailureInit =
  | { query: string; reason: 'name_not_found' | 'backend_entity_not_found' }
  | { query: string; reason: 'chat_absent_for_user'; candidate: ChatCandidate };

export function buildChatResolveFailure(init: ChatResolveFailureInit): ChatResolveFailure {
  return {
    status: 'chat_not_found',
    query: init.query,
    reason: init.reason,
    candidates: init.reason === 'chat_absent_for_user' ? [init.candidate] : [],
    next_step: NEXT_STEPS[init.reason],
  };
}

/** Разрешённый чат в объёме, который нужен для сборки отказа: полную форму даёт `resolveChat` */
export interface ResolvedChatAddress {
  chat_id: string;
  via: 'literal' | 'chat_search' | 'user_search';
  name?: string;
}

export interface ChatAddressedCallContext {
  /**
   * Явное объявление предпосылки П1: в параметрах запроса адресуется РОВНО ОДНА сущность - чат.
   *
   * Поле обязательное и без дефолта осознанно. Код 4 сам по себе дискриминатора сущности не
   * несёт («чат, сообщение либо пользователь»), поэтому вызов, который адресует ещё и
   * сообщение, не сможет выставить это поле, не солгав, - и его код 4 останется ошибкой
   * сообщения, а не превратится в отказ резолва чата с кандидатами по существующему чату.
   */
  addresses: 'chat_only';
  query: string;
  resolved: ResolvedChatAddress;
}

export type ChatAddressedOutcome<T> = { ok: true; value: T } | { ok: false; failure: ChatResolveFailure };

/**
 * Один серверный вызов, у которого единственная адресуемая сущность - чат: `ENTITY_NOT_FOUND(4)`
 * от бэкенда превращается в отказ резолва с причиной, а не утекает наружу сырым (AC-21).
 *
 * Разведение двух причин. `via:'user_search'` значит, что чат сконструирован из guid найденного
 * человека, - тогда код 4 говорит именно «переписки ещё нет». Но если бэкенд прислал СВОЙ текст
 * в `Details` (а не нашу словарную расшифровку кода), верить надо ему: причина становится
 * `backend_entity_not_found` независимо от `via`.
 *
 * Всё, что не код 4 прикладного слоя, пробрасывается как было: подменять чужие ошибки отказом
 * резолва - ровно та деградация диагностики, ради устранения которой заведён #18.
 */
export async function requestChatAddressed<T>(
  context: ChatAddressedCallContext,
  request: () => Promise<T>,
): Promise<ChatAddressedOutcome<T>> {
  try {
    return { ok: true, value: await request() };
  } catch (error) {
    if (!isEntityNotFound(error)) {
      throw error;
    }
    return { ok: false, failure: failureForEntityNotFound(context, error) };
  }
}

function isEntityNotFound(error: unknown): error is MessengerError {
  return (
    error instanceof MessengerError &&
    error.layer === 'application' &&
    error.code === ResponseStatus.ENTITY_NOT_FOUND
  );
}

function failureForEntityNotFound(context: ChatAddressedCallContext, error: MessengerError): ChatResolveFailure {
  const serverSaidItsOwn = !isDefaultApplicationHint(error.code, error.details);
  if (serverSaidItsOwn || context.resolved.via !== 'user_search') {
    return buildChatResolveFailure({ query: context.query, reason: 'backend_entity_not_found' });
  }
  return buildChatResolveFailure({
    query: context.query,
    reason: 'chat_absent_for_user',
    candidate: {
      chat_id: context.resolved.chat_id,
      ...(context.resolved.name !== undefined ? { name: context.resolved.name } : {}),
      /* Через user_search приходит только сконструированная пара guid, а это всегда личка */
      kind: 'private',
      via: 'user_search',
    },
  });
}
