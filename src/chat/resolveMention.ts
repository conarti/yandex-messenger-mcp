/**
 * `@Имя | @<guid> | Имя` -> guid участника (§AC-2/AC-3).
 *
 * Образец - `resolveChat`: контракт результата (`resolveChat.ts:31-44`), отказ по
 * неоднозначности (`resolveChat.ts:171-191`), литеральный шорткат (`resolveChat.ts:147-149`).
 *
 * НЕОДНОЗНАЧНОСТЬ НЕ РАЗРЕШАЕТСЯ ГАДАНИЕМ (P2). Резолв идёт по ГЛОБАЛЬНОМУ каталогу
 * организации (бакет `users`), а НЕ по участникам чата: `@Иван` может вернуть много Иванов
 * (отказ со списком) либо ровно одного НЕ ТОГО (проходит гарды, потому что кандидат один -
 * защита остаётся только draft-превью). Это записано в README как заявленное ограничение.
 *
 * ПРОВЕРКА ПРИНАДЛЕЖНОСТИ. Для приватного чата оба guid лежат в самой строке `chat_id`
 * (§5, `<guidA>_<guidB>`), поэтому резолвнутый guid вне половин - отказ `not_in_chat`, ноль
 * запросов. Для группового дешёвой проверки нет (эндпоинта участников в коде нет): резолв
 * проходит, ограничение документировано.
 */
import type { SearchEntity } from '../config/defaults.js';
import { searchWithEscalation, type SearchDeps } from '../protocol/search.js';
import { asObject, stringOr } from '../util/json.js';

/**
 * guid участника: 36 символов из `[0-9a-f-]` (§5). Тот же алфавит, что у половин `chat_id`.
 * Регистр строго нижний: guid - lowercase UUID (§5), заглавный на проводе не встречается. Флаг
 * `i` намеренно НЕ ставится - иначе заглавный hex прошёл бы валидацию и ушёл на провод как есть.
 */
const MENTION_GUID = /^[0-9a-f-]{36}$/;
/** Приватный чат: `<guidA>_<guidB>` (§5). Половины - те же lowercase-guid, флаг регистра не нужен */
const PRIVATE_CHAT_ID = /^[0-9a-f-]{36}_[0-9a-f-]{36}$/;

/** Кандидат резолва упоминания. Минимальнее `ChatCandidate`: `via`/`kind` для человека бессмысленны */
export interface MentionCandidate {
  guid: string;
  name?: string;
}

export type ResolveMentionResult =
  | { status: 'resolved'; guid: string; name?: string }
  | { status: 'ambiguous'; candidates: MentionCandidate[] }
  | { status: 'not_found' }
  | { status: 'not_in_chat'; guid: string };

export interface ResolveMentionDeps extends SearchDeps {
  /** Резолвнутый `chat_id`: для приватного чата даёт бесплатную проверку принадлежности */
  chatId: string;
  /** Стартовый limit поиска - тот же, что у инструмента search */
  searchLimit: number;
}

/** Элемент бакета `users`: `{data:{guid, display_name|public_name, ...}}` (живой захват 2026-07-17) */
function toMentionCandidate(item: unknown): MentionCandidate | undefined {
  const data = asObject(asObject(item)?.['data']);
  const guid = stringOr(data?.['guid']);
  if (guid === undefined) {
    return undefined;
  }
  const name = stringOr(data?.['display_name']) ?? stringOr(data?.['public_name']);
  return { guid, ...(name !== undefined ? { name } : {}) };
}

/**
 * Принадлежность резолвнутого guid приватному чату. `null` = чат не приватный (проверки нет).
 * Приватный `chat_id` (§5) - ровно пара guid через `_`, поэтому проверка чисто строковая, без сети.
 */
function isPrivateChatMember(guid: string, chatId: string): boolean | null {
  if (!PRIVATE_CHAT_ID.test(chatId)) {
    return null;
  }
  return chatId.split('_').includes(guid);
}

function finalize(guid: string, name: string | undefined, chatId: string): ResolveMentionResult {
  if (isPrivateChatMember(guid, chatId) === false) {
    return { status: 'not_in_chat', guid };
  }
  return { status: 'resolved', guid, ...(name !== undefined ? { name } : {}) };
}

export async function resolveMention(input: string, deps: ResolveMentionDeps): Promise<ResolveMentionResult> {
  const query = input.trim().replace(/^@/, '');
  if (query.length === 0) {
    return { status: 'not_found' };
  }

  /* Литерал `@<guid>` (или голый guid) - поиск не нужен, только проверка принадлежности */
  if (MENTION_GUID.test(query)) {
    return finalize(query, undefined, deps.chatId);
  }

  const outcome = await searchWithEscalation(deps, {
    query,
    entities: ['users'] as SearchEntity[],
    startLimit: deps.searchLimit,
  });
  /* Дубли по guid схлопываются с сохранением первого вхождения (зеркально buildMentions, §6.1) */
  const candidates: MentionCandidate[] = [];
  const seen = new Set<string>();
  for (const item of outcome.buckets['users'] ?? []) {
    const candidate = toMentionCandidate(item);
    if (candidate !== undefined && !seen.has(candidate.guid)) {
      seen.add(candidate.guid);
      candidates.push(candidate);
    }
  }

  if (candidates.length === 0) {
    return { status: 'not_found' };
  }
  if (candidates.length > 1) {
    return { status: 'ambiguous', candidates };
  }
  const only = candidates[0]!;
  return finalize(only.guid, only.name, deps.chatId);
}
