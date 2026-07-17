/**
 * Сборка вариантов `ClientMessage` для мутаций-близнецов (Reaction, Pin, read-marker),
 * уходящих ВНУТРИ полного конверта `push` через `buildPushParams` (§9.3/§14.4).
 *
 * ПОЧЕМУ ПОЛНЫЙ КОНВЕРТ, А НЕ ПЛОСКИЙ push. Плоский `push({Reaction:{...}})` сервер
 * принимает синтаксически, но отвечает ЛОЖНЫМ `NO_SUCH_CHAT` (§17.12): вариант мутации
 * обязан лежать внутри `ClientMessage` рядом с `LogData`, как это делает `buildPushParams`.
 * Чтобы плоскую форму нельзя было собрать по НЕДОСМОТРУ, билдеры возвращают брендированный
 * тип `MutationClientMessage`; `pushMutation` принимает только его. Литерал `{Reaction:{...}}`
 * бренду не соответствует и на уровне типов в отправку не пройдёт.
 *
 * МЕТКИ - СТРОКИ (мкс), НЕ float: `Timestamp` целевого сообщения несёт полную точность
 * курсора. `Reaction.Type` - int (id артворка, §17.12), не emoji.
 */
import type { AuthProvider } from '../auth/AuthProvider.js';
import type { MessengerWsClient } from '../transport/ws/MessengerWsClient.js';
import { buildPushParams, parsePushResponse, PushNotCommittedError, type PushOutcome } from './push.js';

/**
 * Бренд: вариант `ClientMessage` собран билдером этого модуля, а не литералом на месте.
 * Символ живёт только в системе типов - в рантайме к объекту не прикасается.
 *
 * ПОЧЕМУ ЧИСТЫЙ ИНТЕРФЕЙС, А НЕ `Record<string, unknown> & {бренд}`. Пересечение с
 * индексной сигнатурой `Record` РАЗМЫВАЕТ бренд: литерал `{Reaction:{...}}` проходит как
 * структурно совместимый, и плоскую форму собрать всё-таки можно. Чистый интерфейс без
 * индексной сигнатуры отвергает такой литерал (TS2353: 'Reaction' does not exist in type).
 * Совместимость с `Record` (нужна только `buildPushParams`) обеспечивается точечным cast
 * внутри `pushMutation`, а не размытием бренда.
 */
declare const mutationBrand: unique symbol;
export interface MutationClientMessage {
  readonly [mutationBrand]: true;
}

function asMutation(message: Record<string, unknown>): MutationClientMessage {
  return message as unknown as MutationClientMessage;
}

/** `Reaction.Action` (§9.3). ADD - серверный дефолт (поле не шлём); документированы REMOVE/REPLACE */
export const REACTION_ACTION_REMOVE = 1;
export const REACTION_ACTION_REPLACE = 2;

export interface ReactionMutationInput {
  chatId: string;
  /** Метка целевого сообщения (мкс, строка) */
  timestamp: string;
  /** int id артворка (§17.12). Валидацию по карте делает инструмент ДО сборки */
  type: number;
  /** true -> `Action:REMOVE=1` (снять). По умолчанию постановка (Action не шлём) */
  remove?: boolean;
}

/** `push({ Reaction:{ChatId,Timestamp,Type,Action?} })` внутри полного конверта (§9.3) */
export function buildReactionMutation(input: ReactionMutationInput): MutationClientMessage {
  return asMutation({
    Reaction: {
      ChatId: input.chatId,
      Timestamp: input.timestamp,
      Type: input.type,
      ...(input.remove === true ? { Action: REACTION_ACTION_REMOVE } : {}),
    },
  });
}

export interface PinMutationInput {
  chatId: string;
  /**
   * Метка закрепляемого сообщения (мкс). ⚠️ ДОКО-ВЫВЕДЕНО (US-009/Phase 0): семантика
   * `Pin.Timestamp?` живьём не проверена. Принято по §9.3: метка присутствует = закрепить
   * это сообщение, отсутствует = открепить. Заменяется одной правкой этого билдера.
   */
  timestamp?: string;
}

/** `push({ Pin:{ChatId,Timestamp?} })` внутри полного конверта (§9.3) */
export function buildPinMutation(input: PinMutationInput): MutationClientMessage {
  return asMutation({
    Pin: {
      ChatId: input.chatId,
      ...(input.timestamp !== undefined ? { Timestamp: input.timestamp } : {}),
    },
  });
}

export interface ReadMarkerInput {
  chatId: string;
  /** Метка последнего увиденного сообщения (мкс, строка) */
  timestamp: string;
  /** SeqNo последнего увиденного (§9.3 SeenMarker несёт SeqNo); необязателен */
  seqNo?: number;
}

/**
 * Маркер прочтения. ⚠️ ДОКО-ВЫВЕДЕНО (US-009/Phase 0), живьём НЕ подтверждено.
 *
 * Из трёх маркеров §9.3 (`SeenMarker`/`UnseenMarker`/`ReadMarker`) выбран `SeenMarker`:
 * непрочитанное в §17.9 считается как `LastSeqNo - LastSeenByMeSeqNo`, и обнулить его =
 * подвинуть «последнее увиденное МНОЙ» (`LastSeenByMe*`) вперёд - ровно семантика
 * `SeenMarker` (seen by me). `ReadMarker` целится в перечень `Timestamps[]`,
 * `UnseenMarker` помечает НЕпрочитанным (обратное действие). US-009 подтверждает или
 * заменяет маркер ОДНОЙ правкой этого билдера - структура инструмента не меняется.
 *
 * `push({ SeenMarker:{ChatId,Timestamp,SeqNo?} })` внутри полного конверта.
 */
export function buildReadMarkerMutation(input: ReadMarkerInput): MutationClientMessage {
  return asMutation({
    SeenMarker: {
      ChatId: input.chatId,
      Timestamp: input.timestamp,
      ...(input.seqNo !== undefined ? { SeqNo: input.seqNo } : {}),
    },
  });
}

export interface DeleteMutationInput {
  chatId: string;
  /** Метка удаляемого сообщения (мкс, строка) */
  timestamp: string;
}

/**
 * Удаление своего сообщения (§9.3): пустой `Plain{ChatId, Timestamp}` без content-поля.
 * Именно отсутствие content при наличии `Timestamp` целевого сообщения = «удалить это»
 * (детект при чтении - `ServerMessageInfo.Deleted=true`, §9.1). Серверный `DUPLICATE(8)`
 * на повторе НЕ обещается (target-путь, см. шапку confirm.ts).
 *
 * `push({ Plain:{ChatId, Timestamp} })` внутри полного конверта.
 */
export function buildDeleteMutation(input: DeleteMutationInput): MutationClientMessage {
  return asMutation({
    Plain: {
      ChatId: input.chatId,
      Timestamp: input.timestamp,
    },
  });
}

export interface EditMutationInput {
  chatId: string;
  /** Метка правимого сообщения (мкс, строка) */
  timestamp: string;
  /** Новый текст */
  text: string;
}

/**
 * Правка своего сообщения (§9.3): `convertMessageToPlain` + `Timestamp` целевого сообщения.
 * Тот же `Plain` с новым `Text`, но с проставленным `Timestamp` = «переписать это сообщение»,
 * а не отправить новое (детект при чтении - непустой `LastEditTimestamp`, §9.1). Серверный
 * `DUPLICATE(8)` на повторе НЕ обещается (target-путь).
 *
 * `push({ Plain:{ChatId, Timestamp, Text:{MessageText}} })` внутри полного конверта.
 */
export function buildEditMutation(input: EditMutationInput): MutationClientMessage {
  return asMutation({
    Plain: {
      ChatId: input.chatId,
      Timestamp: input.timestamp,
      Text: { MessageText: input.text },
    },
  });
}

export interface VoteMutationInput {
  chatId: string;
  /** Метка сообщения-опроса (мкс, строка) */
  timestamp: string;
  /** Выбранные варианты. Единица (индекс/id) и обязательность ДОКО-ВЫВЕДЕНЫ (§11.4) */
  choices: number[];
}

/**
 * Голос в опросе (§9.3/§11.4). ⚠️ ФОРМА ДОКО-ВЫВЕДЕНА, живьём НЕ наблюдалась: единица
 * `Choices` (индекс варианта? id?) и семантика `Results` неизвестны, голос в self-чате
 * отправкой не проверить (создание опроса - Non-Goal). Инструмент `vote_in_poll` выпускается
 * experimental, его выдача несёт `form_status: experimental_unverified`. Механики снятия/смены
 * голоса в протоколе не обнаружено - отсюда confirm. Заменяется одной правкой билдера, если
 * живой прогон уточнит форму.
 *
 * `Results:true` - доко-выведенная просьба вернуть результаты после голоса (аналог
 * `poll_info.ReturnResults`); значение живьём не подтверждено.
 *
 * `push({ Vote:{ChatId, Timestamp, Choices, Results} })` внутри полного конверта.
 */
export function buildVoteMutation(input: VoteMutationInput): MutationClientMessage {
  return asMutation({
    Vote: {
      ChatId: input.chatId,
      Timestamp: input.timestamp,
      Choices: input.choices,
      Results: true,
    },
  });
}

/** Минимум транспорта для одноразовой мутации: без confirm, без ретрая push (§14.4) */
export interface MutationTransport {
  ws: Pick<MessengerWsClient, 'request' | 'waitForSubscriptionId'>;
  auth: Pick<AuthProvider, 'getAuthContext'>;
  /** `Meta.Origin` = serviceId (27, §15) */
  serviceId: number;
}

/**
 * Отправляет вариант мутации полным конвертом и подтверждает commit. `push` необратим и
 * НЕ ретраится (§14.4); некоммитнутый статус - громкая ошибка (`PushNotCommittedError`),
 * а не тихий успех. Принимает ТОЛЬКО брендированный `MutationClientMessage` - плоскую
 * форму сюда не передать.
 */
export async function pushMutation(deps: MutationTransport, message: MutationClientMessage): Promise<PushOutcome> {
  const { yandexUid } = await deps.auth.getAuthContext();
  /* Готовность к отправке наступает на кадре subscribed, не на open (§17.2) */
  const subscriptionId = await deps.ws.waitForSubscriptionId();
  const params = buildPushParams({
    /* Единственная точка, где бренд снимается к Record: буквальные литералы сюда не доходят */
    clientMessage: message as unknown as Record<string, unknown>,
    subscriptionId,
    yandexUid,
    serviceId: deps.serviceId,
  });
  const outcome = parsePushResponse(await deps.ws.request('push', params, { requireSubscriptionId: subscriptionId }));
  if (!outcome.committed) {
    throw new PushNotCommittedError(outcome);
  }
  return outcome;
}
