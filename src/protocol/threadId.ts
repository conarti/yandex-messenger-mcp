/**
 * Деривация `thread_id` из родительского чата (§17.10, спайк 1).
 *
 * ТРЕД - ЭТО ЧАТ, СОЗДАНИЯ НА СЕРВЕРЕ НЕТ. Кнопка «Обсудить» ничего не создаёт: `thread_id`
 * вычисляется на клиенте детерминированной строковой функцией из `{ChatId родителя, Timestamp
 * родительского сообщения}`, тред открывается как обычный чат (`history` по `thread_id`) и
 * материализуется первым `push`. Поэтому здесь только строковая арифметика, без сети.
 *
 * ТРИ СЛУЧАЯ ПРЕФИКСА (§17.10):
 *  - группа `0/0/<uuid>`      -> `100/0/<uuid>_<ts>`;
 *  - канал  `1/0/<uuid>`      -> `101/0/<uuid>_<ts>`;
 *  - приватный `<guid>_<guid>` -> `110/0/<guid>_<guid>_<ts>`.
 *
 * RADIX 10, НЕ RADIX 2. В бандле деривация написана как `100+parseInt(prefix,2)` - это мина:
 * radix 2 совпадает с radix 10 лишь на префиксах `0`/`1`, а бизнес-префикс `2` даёт `NaN`.
 * Авторитетен обратный парсер бандла, он использует `parseInt(prefix,10)`, поэтому вперёд тоже
 * берём radix 10. Но бизнес-чаты (`2/…`) через эту деривацию треды НЕ получают (спайк 1): в
 * radix 10 `parseInt("2",10)=2` не роняется само собой, поэтому префикс вне `{0,1}` помечается
 * недоступным ЯВНО - не роняя вызов, а возвращая признак `unsupported`.
 *
 * МЕТКА - 16 цифр, СТРОКОЙ. Клиент бандла гонит `<ts>` через `parseInt` (теряя точность у 2^53),
 * но инвариант проекта строже: метка разбирается `parseMicros` (BigInt) и остаётся строкой.
 */
import { parseMicros } from '../util/timestamps.js';

/** Приватный чат `<guid>_<guid>` (бандл: `C=/^[a-z0-9-]{36}_[a-z0-9-]{36}$/`) */
const PRIVATE_CHAT_ID = /^[a-z0-9-]{36}_[a-z0-9-]{36}$/i;
/** Числовой ChatId `<prefix>/<ns>/<rest>` (бандл: `A=/^(\d+)\/(\d+)\/(.+)$/`) */
const NUMERIC_CHAT_ID = /^(\d+)\/(\d+)\/(.+)$/;
/** thread_id: `1<dd>/<ns>/<rest>_<16 цифр>` (бандл: `w=/^1(\d\d)\/(\d+)\/(.+)_(\d{16})$/`) */
const THREAD_ID = /^1(\d\d)\/(\d+)\/(.+)_(\d{16})$/;

/** Префикс родителя, для которого деривация треда определена протоколом */
const THREADABLE_PREFIXES: ReadonlySet<string> = new Set(['0', '1']);

/** Разобранный `thread_id`: родительский чат и метка родительского сообщения */
export interface ParsedThreadId {
  /** ChatId родительского чата */
  chatId: string;
  /** Метка родительского сообщения (мкс строкой, полная точность) */
  timestamp: string;
}

/** Результат деривации: либо готовый `thread_id`, либо явный отказ (не роняя вызов) */
export type BuildThreadIdResult =
  | { status: 'ok'; thread_id: string }
  | { status: 'unsupported'; reason: string };

/** Нормализует метку родительского сообщения в 16-значную строку мкс либо кидает */
function normalizeTimestamp(timestamp: string | bigint | number): string {
  return parseMicros(timestamp).toString();
}

/**
 * Деривирует `thread_id` из родительского `ChatId` и метки родительского сообщения (§17.10).
 *
 * Приватный чат уходит в ветку `110/0/…`, числовой (группа/канал) - в `10<prefix>/…` по radix 10.
 * Бизнес-чат (`2/…`) и любой префикс вне `{0,1}` -> `unsupported`: деривация треда для них
 * протоколом не определена (спайк 1). Битая метка -> исключение `parseMicros` (метка обязана
 * быть валидной, тихо её проглатывать нельзя).
 */
export function buildThreadId(chatId: string, timestamp: string | bigint | number): BuildThreadIdResult {
  const ts = normalizeTimestamp(timestamp);

  if (PRIVATE_CHAT_ID.test(chatId)) {
    return { status: 'ok', thread_id: `110/0/${chatId}_${ts}` };
  }

  const match = NUMERIC_CHAT_ID.exec(chatId);
  if (match === null) {
    return { status: 'unsupported', reason: `ChatId "${chatId}" не распознан как чат, деривация треда невозможна` };
  }
  const [, prefix, namespace, rest] = match;
  if (prefix === undefined || !THREADABLE_PREFIXES.has(prefix)) {
    /* Бизнес-чат (`2/…`) и экзотические префиксы: тред через «Обсудить» недоступен (спайк 1) */
    return {
      status: 'unsupported',
      reason: `тред для чата с префиксом "${prefix ?? ''}" недоступен: деривация определена только для групп (0) и каналов (1)`,
    };
  }
  const code = 100 + Number.parseInt(prefix, 10);
  return { status: 'ok', thread_id: `${code}/${namespace}/${rest}_${ts}` };
}

/**
 * Обратный разбор `thread_id` в родительский чат и метку (§17.10). Возвращает `undefined`,
 * если строка не является `thread_id`.
 *
 * Префикс `110` (i=`10`) - это приватный тред: родитель - сам `<guid>_<guid>` из середины.
 * Прочие (`100`/`101`, i=`00`/`01`) собирают числовой ChatId обратно как `<prefix>/<ns>/<rest>`.
 */
export function parseThreadId(threadId: string): ParsedThreadId | undefined {
  const match = THREAD_ID.exec(threadId);
  if (match === null) {
    return undefined;
  }
  const [, code, namespace, rest, tail] = match;
  if (code === undefined || namespace === undefined || rest === undefined || tail === undefined) {
    return undefined;
  }
  try {
    const timestamp = parseMicros(tail).toString();
    /* i==="10" -> приватный тред: родитель это `rest` целиком (`<guid>_<guid>`) */
    const chatId = code === '10' ? rest : `${Number.parseInt(code, 10)}/${namespace}/${rest}`;
    return { chatId, timestamp };
  } catch {
    return undefined;
  }
}

/** `true`, если строка - валидный `thread_id`. Нужно резолверу чата: тред = валидный ChatId */
export function isThreadId(value: string): boolean {
  return THREAD_ID.test(value);
}
