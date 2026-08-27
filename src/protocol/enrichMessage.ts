/**
 * Обогащение прочитанного сообщения (Fork D1, §11.2/§9.1).
 *
 * ПОЧЕМУ ОТДЕЛЬНАЯ ФУНКЦИЯ, А НЕ ПРАВКА `normalizeMessage`. Обогащение приезжает НОВОЙ
 * функцией поверх немутируемого `base` и добавляет top-level ключи. ИНВАРИАНТ, который
 * действует и сегодня: v1-объект (`Message`) остаётся структурным подмножеством выхода -
 * каждый v1-ключ на месте с тем же значением, и слой обогащения ни одного из них не переписывает.
 *
 * ЗАМОРОЗКА ЗНАЧЕНИЙ СНЯТА, И ЭТО САНКЦИОНИРОВАНО. Прежняя редакция шапки утверждала, что
 * выход v1-нормализатора заморожен байт-в-байт. Это перестало быть верным: `kind` удалённого
 * сообщения разведён с `'unknown'` в собственное `'deleted'` (`messageShape.ts`, санкция AC-14).
 * Цена посчитана и уплачена - один ассерт в `messageShape.test.ts`. Структурная часть инварианта
 * (v1 ⊆ выход) при этом цела: она проверяется машинно и ничем не санкционирована к снятию.
 *
 * ГРАНИЦА ИНВАРИАНТА (P1, P5). Подмножество гарантируется ТОЛЬКО для v1-ключей `Message`. Слой
 * обогащения (reactions/reads/mentions/thread/forwarded/from_me) - это v2-контракт, и он НЕ
 * append-only между своими версиями: `reactions_raw` удалён, `reactions` сведён к единой форме
 * (`Reaction` по типу) до публикации - ломающая правка внутри окна P5. Поэтому «прошлый v2-выход
 * ⊆ нынешний» неверно; честнее говорить не «подмножество», а «v1-ключи сохранены, v2-слой пересобран».
 *
 * ИСТОЧНИК ДАННЫХ - СИБЛИНГИ. Прочтения, реакции, упоминания, форварды и корень треда
 * лежат СИБЛИНГАМИ `ClientMessage` на уровне `ServerMessage` (§11.2), а не внутри тела;
 * `normalizeMessage` их отбрасывает. Поэтому `enrichMessage` получает сырой
 * `ServerMessage`-уровень отдельным аргументом `ctx.siblings`.
 *
 * БЕЗ I/O. Чистая функция от уже полученных данных. Детальная выборка реакций/прочтений
 * (два вызова `list_reactions` на сообщение) - дело инструмента в Phase 2, не энричера.
 * Сиблинги `history` обрезаны (§17.12: `ReadsCount:10` при `RecentUserReads` длиной 3),
 * поэтому здесь они - «что приехало», а не полный список.
 *
 * ЛОВУШКА §17.13. Под `MessageDataFilter.DropPayload:true` пропадает и `From`. Отсутствие
 * автора НЕ значит «сообщение не моё»: `from_me` в этом случае `null` (неизвестно), не `false`.
 *
 * ФОРМАТИРОВАНИЕ §17.14. Структурированных entities протокол не даёт: `Text` несёт ровно
 * `MessageText`, разметку рисует клиент. `text` в `base` уже сырой - тут ничего не меняем.
 */
import type { AttachmentRef } from './attachmentRefs.js';
import { normalizeMessage, type Message, type MessageSender } from './messageShape.js';
import type { Reaction, ReactionActor, ReadReceipt } from './reactions.js';
import { asObject, numberOr, stringOr } from '../util/json.js';
import { microsToIso, parseMicros } from '../util/timestamps.js';
import { renderReactions, type ReactionMap } from '../config/reactionMap.js';

/**
 * Прочтения сообщения. Отсутствие сиблингов прочтений = «не отслеживается»
 * (`tracked:false`), а НЕ ноль: сервер не для всех чатов отдаёт read-state (§17.12).
 */
export interface MessageReads {
  tracked: boolean;
  count?: number;
  recent?: ReadReceipt[];
  /** Метка «увидено собеседником» строкой (мкс), не float */
  seen_by_partner_mcs?: string;
}

/** Упоминание. Нет имени для guid - явный `unresolved`, а не молча guid вместо имени (§AC-6) */
export interface MentionRef {
  guid: string;
  name?: string;
  unresolved?: boolean;
}

/** Признак «есть тред» + корень (`ThreadState`/`ThreadParentMessage`, §9.1) */
export interface ThreadInfo {
  has_thread: boolean;
  /** Корень треда, нормализованный тем же v1-нормализатором */
  root?: Message;
}

/** Оригинал пересылки (сиблинг `ForwardedMessages`, §11.2). НОВЫЙ ключ, НЕ `context.refs[]` */
export interface ForwardedOriginal {
  source_author: MessageSender;
  source_chat?: string;
  source_date: string;
  source_date_mcs: string;
  source_text?: string;
  attachments: AttachmentRef[];
}

/**
 * Выход обогащения: `base` v1 плюс НОВЫЕ top-level ключи. `extends Message` гарантирует,
 * что все v1-поля на месте и типобезопасно передаются наружу.
 */
export interface EnrichedMessage extends Message {
  /** Автор == я. `null`, если `From` срезан `DropPayload` (§17.13) - не выдаём за `false` */
  from_me: boolean | null;
  reads: MessageReads;
  mentions: MentionRef[];
  /**
   * Единая форма реакций (ось B1): `Reaction` сгруппированы по типу, name/emoji отрисованы картой,
   * акторы и `actors_complete` из усечённых сиблингов history. Поле ОБЯЗАТЕЛЬНО (пустой массив,
   * если реакций нет) - `reactions_raw` снят, разнесённой сырой формы больше нет.
   */
  reactions: Reaction[];
  thread: ThreadInfo;
  forwarded: ForwardedOriginal[];
}

export interface EnrichContext {
  myGuid: string;
  /**
   * Карта реакций. ОБЯЗАТЕЛЬНА: `reactions` собирается всегда, и без карты сырые `type` не
   * отрисовать в name/emoji (карту нельзя загрузить внутри чистой функции - это I/O). Все четыре
   * read-инструмента прокидывают `deps.reactionMap`, поэтому обязательность не сужает вызов.
   */
  reactionMap: ReactionMap;
  /** Сырой `ServerMessage`-уровень: то, что `normalizeMessage` отбросил */
  siblings: unknown;
}

/** `UserInfo` (§11.2) -> отправитель. Без непустого guid - бесполезен */
function userRef(raw: unknown): MessageSender | undefined {
  const info = asObject(raw);
  if (info === undefined) {
    return undefined;
  }
  const guid = stringOr(info['Guid']);
  if (guid === undefined) {
    return undefined;
  }
  const name = stringOr(info['DisplayName']);
  return { guid, ...(name !== undefined ? { name } : {}) };
}

/** Метка (мкс) -> `{timestamp, timestamp_mcs}`; `0`/битую отдаёт как отсутствие, а не роняет */
function microsMark(raw: unknown): { timestamp: string; timestamp_mcs: string } | undefined {
  if (raw === undefined || raw === null || raw === 0) {
    return undefined;
  }
  try {
    const micros = parseMicros(raw);
    return { timestamp: microsToIso(micros), timestamp_mcs: micros.toString() };
  } catch {
    return undefined;
  }
}

function userReceipt(user: MessageSender | undefined): { guid?: string; name?: string } {
  if (user === undefined) {
    return {};
  }
  return { guid: user.guid, ...(user.name !== undefined ? { name: user.name } : {}) };
}

/** Тело `Plain`/`Ephemeral` из сырого `ServerMessage` (нужно ради `MentionedUserIds`) */
function resolvePlain(siblings: Record<string, unknown>): Record<string, unknown> | undefined {
  const clientMessage = asObject(siblings['ClientMessage']);
  if (clientMessage === undefined) {
    return undefined;
  }
  return asObject(clientMessage['Plain']) ?? asObject(clientMessage['Ephemeral']);
}

function buildReads(siblings: Record<string, unknown>): MessageReads {
  /* Ключ ПРИСУТСТВУЕТ = отслеживается, даже если `ReadsCount:0`. Отсутствие всех = не отслеживается */
  const tracked =
    'ReadsCount' in siblings || 'RecentUserReads' in siblings || 'SeenByPartnerMcs' in siblings;
  if (!tracked) {
    return { tracked: false };
  }

  const count = numberOr(siblings['ReadsCount']);
  const rawRecent = Array.isArray(siblings['RecentUserReads']) ? siblings['RecentUserReads'] : [];
  const recent: ReadReceipt[] = [];
  for (const entry of rawRecent) {
    const obj = asObject(entry);
    if (obj === undefined) {
      continue;
    }
    const user = userRef(obj['UserInfo']);
    const mark = microsMark(obj['Timestamp']);
    if (user === undefined && mark === undefined) {
      continue;
    }
    /* Вложенная форма (ось E1): актор отдельным ключом, метка прочтения - на уровне receipt */
    recent.push({ actor: userReceipt(user), ...(mark !== undefined ? mark : {}) });
  }

  const seenMcs = numberOr(siblings['SeenByPartnerMcs']);
  return {
    tracked: true,
    ...(count !== undefined ? { count } : {}),
    ...(recent.length > 0 ? { recent } : {}),
    ...(seenMcs !== undefined && seenMcs > 0 ? { seen_by_partner_mcs: seenMcs.toString() } : {}),
  };
}

function buildMentions(siblings: Record<string, unknown>): MentionRef[] {
  const rawUsers = Array.isArray(siblings['MentionedUsers']) ? siblings['MentionedUsers'] : [];
  const nameByGuid = new Map<string, string>();
  for (const raw of rawUsers) {
    const user = userRef(raw);
    if (user?.name !== undefined) {
      nameByGuid.set(user.guid, user.name);
    }
  }

  /* Порядок и состав упоминаний - из `MentionedUserIds` тела; имена подставляем из сиблинга */
  const plain = resolvePlain(siblings);
  const rawIds = Array.isArray(plain?.['MentionedUserIds']) ? plain['MentionedUserIds'] : [];
  const guids: string[] = [];
  for (const raw of rawIds) {
    const guid = stringOr(raw);
    if (guid !== undefined) {
      guids.push(guid);
    }
  }
  /* Тело без `MentionedUserIds`, но сиблинг с именами - берём состав из сиблинга */
  if (guids.length === 0) {
    for (const raw of rawUsers) {
      const user = userRef(raw);
      if (user !== undefined) {
        guids.push(user.guid);
      }
    }
  }

  const mentions: MentionRef[] = [];
  const seen = new Set<string>();
  for (const guid of guids) {
    if (seen.has(guid)) {
      continue;
    }
    seen.add(guid);
    const name = nameByGuid.get(guid);
    if (name !== undefined && name.length > 0) {
      mentions.push({ guid, name });
    } else {
      mentions.push({ guid, unresolved: true });
    }
  }
  return mentions;
}

/**
 * Единая форма реакций (ось B1): агрегаты `Reactions[]` джойнятся с пофамильными
 * `RecentUserReactions[]` по типу, отрисовываются картой (`renderReactions`), к каждому типу
 * прикладываются акторы и вычисляется `actors_complete`. Ноль дополнительных запросов - это
 * джойн двух массивов ОДНОГО ответа, чистая функция без I/O (§17.12, AC-15).
 */
function buildReactions(siblings: Record<string, unknown>, map: ReactionMap): Reaction[] {
  /* Агрегаты `Reactions[]` -> сырые {type, count}; порядок сохраняется, дубли типа схлопываются */
  const aggregates: { type: number; count?: number }[] = [];
  const indexByType = new Map<number, number>();
  const rawItems = Array.isArray(siblings['Reactions']) ? siblings['Reactions'] : [];
  for (const raw of rawItems) {
    const obj = asObject(raw);
    if (obj === undefined) {
      continue;
    }
    /* Тип - int (§17.12). Без числового типа реакция неадресуема - не тащим мусор */
    const type = numberOr(obj['Type']);
    if (type === undefined || indexByType.has(type)) {
      continue;
    }
    const count = numberOr(obj['Count']);
    indexByType.set(type, aggregates.length);
    aggregates.push({ type, ...(count !== undefined ? { count } : {}) });
  }

  /* Пофамильные акторы `RecentUserReactions[]`, сгруппированы по типу */
  const actorsByType = new Map<number, ReactionActor[]>();
  const rawRecent = Array.isArray(siblings['RecentUserReactions']) ? siblings['RecentUserReactions'] : [];
  for (const raw of rawRecent) {
    const obj = asObject(raw);
    if (obj === undefined) {
      continue;
    }
    const type = numberOr(obj['Type']);
    if (type === undefined) {
      continue;
    }
    const user = userRef(obj['UserInfo']);
    const mark = microsMark(obj['Timestamp']);
    const actor: ReactionActor = { ...userReceipt(user), ...(mark !== undefined ? mark : {}) };
    let bucket = actorsByType.get(type);
    if (bucket === undefined) {
      bucket = [];
      actorsByType.set(type, bucket);
      /* Тип есть в recent, но не в агрегатах - дотягиваем в хвост, чтобы актора не потерять */
      if (!indexByType.has(type)) {
        indexByType.set(type, aggregates.length);
        aggregates.push({ type });
      }
    }
    bucket.push(actor);
  }

  /* Отрисовка через карту: type -> name/emoji/count; неизвестный виден как unknown, не проглатывается */
  return renderReactions(aggregates, map).map((info) => {
    const actors = actorsByType.get(info.type) ?? [];
    /*
     * actors_complete: сравнение `count` (из `Reactions[].Count`) с числом акторов этого типа в recent.
     * `count === undefined` (агрегата нет, сравнивать не с чем) трактуется как `true`: неполноту не
     * заявляем без доказательства, и это согласуется с `list_reactions`, где список всегда полный.
     * ГРЕЙД (P1): механизм усечения ПОДТВЕРЖДЁН живьём для `RecentUserReads` (§17.12, `reactions.ts`),
     * для `RecentUserReactions` срабатывание НЕ наблюдалось. Вычисление корректно независимо от
     * наблюдения - это сравнение двух чисел из ОДНОГО ответа, а не вывод о поведении сервера.
     */
    const actorsComplete = info.count === undefined || actors.length >= info.count;
    return { ...info, actors, actors_complete: actorsComplete };
  });
}

function buildThread(siblings: Record<string, unknown>): ThreadInfo {
  const info = asObject(siblings['ServerMessageInfo']);
  const threadState = asObject(info?.['ThreadState']);
  const lastSeqNo = numberOr(threadState?.['LastSeqNo']) ?? 0;

  const parentRaw = siblings['ThreadParentMessage'];
  /* Корень нормализуем тем же v1-нормализатором: у него та же форма ServerMessage */
  const root = normalizeMessage(parentRaw) ?? normalizeMessage(asObject(parentRaw)?.['ServerMessage']);
  const hasParent = asObject(parentRaw) !== undefined;

  return {
    has_thread: lastSeqNo > 0 || hasParent,
    ...(root !== undefined ? { root } : {}),
  };
}

/**
 * Приводит элемент `ForwardedMessages` к форме, которую понимает v1-нормализатор.
 *
 * ЖИВОЙ КАДР 2026-08-28 (`docs/spikes/v2/SPIKE-FORWARD-FRAME.md`): элемент приходит как
 * `{Payload, ServerMessageInfo}`, где `Payload` - это САМО ТЕЛО (`Text.MessageText`, `ChatId`,
 * `PayloadId`, `CustomPayload`), то есть содержимое `ClientMessage.Plain`, а не `ServerMessage`.
 * Прежние две догадки (`raw` как `ServerMessage` и `raw.ServerMessage`) не совпали с проводом
 * ни разу - в этом и была причина пустого `forwarded[]` (#22). Обе оставлены запасным разбором
 * и помечены честно: они ВЫВЕДЕНЫ, живьём не наблюдались.
 */
function toServerMessageShape(raw: unknown): unknown {
  const element = asObject(raw);
  if (element === undefined) {
    return undefined;
  }
  const payload = asObject(element['Payload']);
  if (payload !== undefined) {
    return { ClientMessage: { Plain: payload }, ServerMessageInfo: element['ServerMessageInfo'] };
  }
  return element['ServerMessage'] ?? element;
}

function buildForwarded(siblings: Record<string, unknown>): ForwardedOriginal[] {
  const rawList = Array.isArray(siblings['ForwardedMessages']) ? siblings['ForwardedMessages'] : [];
  const forwarded: ForwardedOriginal[] = [];
  for (const raw of rawList) {
    /* Оригинал разбирается той же v1-логикой: переписывать нормализацию заново незачем */
    const original = normalizeMessage(toServerMessageShape(raw));
    if (original === undefined) {
      continue;
    }
    forwarded.push({
      source_author: original.from,
      ...(original.chat_id !== undefined ? { source_chat: original.chat_id } : {}),
      source_date: original.timestamp,
      source_date_mcs: original.timestamp_mcs,
      ...(original.text !== undefined ? { source_text: original.text } : {}),
      attachments: original.attachments,
    });
  }
  return forwarded;
}

/**
 * `base` (немутируемый выход `normalizeMessage`) + НОВЫЕ top-level ключи из сиблингов.
 * `base` не мутируется: все его поля переносятся спредом, новые ключи не пересекаются с v1.
 */
export function enrichMessage(base: Message, ctx: EnrichContext): EnrichedMessage {
  const siblings = asObject(ctx.siblings) ?? {};
  const fromGuid = base.from.guid;

  return {
    ...base,
    /* Пустой guid = `From` срезан (§17.13) -> авторство неизвестно, а не «не моё» */
    from_me: fromGuid.length === 0 ? null : fromGuid === ctx.myGuid,
    reads: buildReads(siblings),
    mentions: buildMentions(siblings),
    /* Единая форма: агрегаты + акторы + actors_complete, отрисовано картой. Неизвестный тип виден как unknown */
    reactions: buildReactions(siblings, ctx.reactionMap),
    thread: buildThread(siblings),
    forwarded: buildForwarded(siblings),
  };
}

/**
 * Разворачивает `Messages[]` history-ответа: нормализует v1-логикой и обогащает,
 * прокидывая сырой `ServerMessage` каждого элемента как сиблинги. Неадресуемые
 * элементы отбрасываются - как в `normalizeMessages`.
 */
export function enrichMessages(rawMessages: unknown, ctx: Omit<EnrichContext, 'siblings'>): EnrichedMessage[] {
  if (!Array.isArray(rawMessages)) {
    return [];
  }
  const messages: EnrichedMessage[] = [];
  for (const raw of rawMessages) {
    const serverMessage = asObject(raw)?.['ServerMessage'];
    const base = normalizeMessage(serverMessage);
    if (base === undefined) {
      continue;
    }
    messages.push(enrichMessage(base, { ...ctx, siblings: serverMessage }));
  }
  return messages;
}
