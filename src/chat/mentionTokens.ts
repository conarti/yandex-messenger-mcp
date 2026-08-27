/**
 * Подстановка токена упоминания в исходящий текст и обратный рендер имён для превью (#15).
 *
 * ЗАЧЕМ. Яндекс несёт упоминание прямо в `MessageText` токеном `@<guid>`, а имя подставляет
 * клиент при рендере (наблюдено на входящих). Текст, набранный человеком как `@Имя`, приходит
 * адресату простым текстом и пинга не даёт: одного `MentionedUserIds` для рендера мало.
 *
 * ПЛЕЙСХОЛДЕР НЕ РАСПОЗНАЁТСЯ, А НАЗЫВАЕТСЯ. Ищутся ровно те строки, которые вызывающий сам
 * перечислил в `mentions`; грамматики упоминания здесь нет и не нужно. Позиционное отображение
 * «i-е вхождение -> guids[i]» ЗАПРЕЩЕНО: порядок массива `mentions` не связан с порядком вхождений
 * в тексте, и при `text:'@Иван и @Пётр'`, `mentions:['Пётр','Иван']` в НЕОБРАТИМОЕ сообщение ушёл
 * бы guid не того человека.
 *
 * Проход ОДИН, слева направо; выданный участок повторно НЕ сканируется. Отсюда структурно следуют
 * два свойства: каскад невозможен (подставленный guid не станет входом для следующей пары) и
 * второй `@` не ПОРОЖДАЕТСЯ. Принесённый самим текстом (`'@@Иван'`) остаётся - это безвредно
 * (guid принадлежит верному человеку, `MentionedUserIds` верен) и лучше, чем лишить названного
 * человека пинга отказом от подстановки.
 */
import type { MentionCandidate } from './resolveMention.js';

/** Пара «исходный запрос упоминания -> резолвнутый guid». Собирается МИМО дедупа по guid */
export interface MentionPair {
  query: string;
  guid: string;
}

/** Итог подстановки. Счётчик кормит draft-лог и условность поля превью, поэтому он не выводится из строк */
export interface MentionSubstitution {
  text: string;
  /** Сколько участков заменено. Ноль означает «подставлять было нечего», а не ошибку */
  substituted: number;
}

/**
 * guid упоминания: 36 символов `[0-9a-f-]` (§5), строго нижний регистр, флаг `i` не ставится
 * намеренно. Длина - первична, регулярка собирается из неё: раньше число и шаблон были двумя
 * независимыми объявлениями одного факта и разъехались бы молча.
 * Экспортируется, чтобы `sendMessage.ts` не заводил третью копию того же шаблона.
 */
const MENTION_GUID_LENGTH = 36;
export const MENTION_GUID = new RegExp(`^[0-9a-f-]{${MENTION_GUID_LENGTH}}$`);

/**
 * Символ, продолжающий токен: буква ЛЮБОГО алфавита, цифра, `_` или `-`. Флаг `u` обязателен -
 * без него `@Иван` съел бы начало `@Иванов`, потому что кириллица не попадает в ASCII-класс.
 */
const TOKEN_CHARACTER = /[\p{L}\p{N}_-]/u;

interface NormalizedPair {
  /** Форма с `@`: `'@' + normalized` */
  atForm: string;
  /** Голая форма - только когда сам запрос является guid; иначе искать её нельзя */
  bareForm: string | undefined;
  guid: string;
  length: number;
}

/**
 * Правило 1 (нормализация): запрос сравнивается так же, как его видит резолвер -
 * `input.trim().replace(/^@/, '')` (`resolveMention.ts:79`).
 * Правило 5 (порядок между парами): длинный запрос пробуется первым, иначе `@Иван` разрезал бы
 * названный `@Иван Петров`. ОГОВОРКА: при `mentions:['Иван']` и тексте `'@Иван Петров'` подстановка
 * всё равно режет имя (`'@<guid> Петров'`) - пробел проходит правую границу правила 4. Это принятое
 * следствие подхода «подставляем НАЗВАННОЕ», а не дефект сортировки: вызывающий назвал `Иван`.
 */
function normalizePairs(pairs: readonly MentionPair[]): NormalizedPair[] {
  const normalized: NormalizedPair[] = [];
  for (const pair of pairs) {
    const query = pair.query.trim().replace(/^@/, '');
    if (query.length === 0) {
      continue;
    }
    normalized.push({
      atForm: `@${query}`,
      bareForm: MENTION_GUID.test(query) ? query : undefined,
      guid: pair.guid,
      length: query.length,
    });
  }
  return normalized.sort((left, right) => right.length - left.length);
}

/** Правило 4 (правая граница): следующий символ не продолжает токен либо строка кончилась */
function endsAtBoundary(text: string, end: number): boolean {
  return end >= text.length || !TOKEN_CHARACTER.test(text.charAt(end));
}

function matchAt(
  text: string,
  cursor: number,
  pairs: readonly NormalizedPair[],
  previousWasSubstitution: boolean,
): { guid: string; length: number } | undefined {
  const previous = cursor > 0 ? text.charAt(cursor - 1) : '';
  for (const pair of pairs) {
    /*
     * Правило 2: форма с `@` пробуется ПЕРВОЙ. На тексте `'привет @<guid>'` при названном том же
     * guid она совпадает раньше голой формы и уводит курсор за конец совпадения, поэтому `'@@'`
     * не возникает.
     * Правило 6: левая граница формы с `@` закрывает `'пиши на petr@Иван'`. Участок, только что
     * ставший упоминанием, левой границей НЕ служит - иначе `'@Иван@Пётр'` подставился бы
     * наполовину, и второй названный человек не получил бы пинга (это ровно баг #15 для него).
     */
    if (
      text.startsWith(pair.atForm, cursor) &&
      endsAtBoundary(text, cursor + pair.atForm.length) &&
      (cursor === 0 || previousWasSubstitution || !TOKEN_CHARACTER.test(previous))
    ) {
      return { guid: pair.guid, length: pair.atForm.length };
    }
    /*
     * Правило 3: голая форма не засчитывается сразу после `@`. При однопроходной реализации правило
     * избыточно, но записано явно, чтобы переписывание «глобальной регуляркой» не проскочило мимо.
     * Правило 6 действует и здесь, симметрично форме с `@`: без левой границы текст, содержащий
     * приватный `chat_id` (`<guidA>_<guidB>`, §5), при названном ВТОРОМ guid получил бы `@` посреди
     * идентификатора - `<guidA>_@<guidB>`. Первый guid пары от этого защищён правой границей
     * (`_` продолжает токен), второй не был защищён ничем.
     * Поблажки `previousWasSubstitution`, как у формы с `@`, здесь НЕТ намеренно: она была бы
     * недостижима. Предыдущее совпадение обязано кончаться на не-токенном символе (`endsAtBoundary`),
     * а голая форма начинается hex-символом, который токен продолжает - два условия несовместимы.
     */
    if (
      pair.bareForm !== undefined &&
      text.startsWith(pair.bareForm, cursor) &&
      endsAtBoundary(text, cursor + pair.bareForm.length) &&
      previous !== '@' &&
      (cursor === 0 || !TOKEN_CHARACTER.test(previous))
    ) {
      return { guid: pair.guid, length: pair.bareForm.length };
    }
  }
  return undefined;
}

/**
 * Заменяет НАЗВАННЫЕ вызывающим строки на токены `@<guid>`. Заменяются ВСЕ вхождения каждого
 * запроса, а не первое: половинчатая замена оставила бы в подтверждаемой человеком строке два
 * разных обозначения одного человека. Пустые `pairs` возвращают текст байт в байт.
 */
export function substituteMentionTokens(text: string, pairs: readonly MentionPair[]): MentionSubstitution {
  const normalized = normalizePairs(pairs);
  if (normalized.length === 0) {
    return { text, substituted: 0 };
  }
  let output = '';
  let cursor = 0;
  let substituted = 0;
  let previousWasSubstitution = false;
  while (cursor < text.length) {
    const match = matchAt(text, cursor, normalized, previousWasSubstitution);
    if (match === undefined) {
      output += text.charAt(cursor);
      cursor += 1;
      previousWasSubstitution = false;
      continue;
    }
    output += `@${match.guid}`;
    cursor += match.length;
    substituted += 1;
    previousWasSubstitution = true;
  }
  return { text: output, substituted };
}

/**
 * Обратный рендер для ПОЛЯ ПРЕВЬЮ: `@<guid>` -> `@<имя>`. Строка производная, на провод не уходит
 * и в отпечаток не входит; эхом на confirm возвращается канонический текст, а не превью.
 *
 * Источник имён - `candidates` (отображение guid -> имя), а НЕ пары запросов: у пары имени нет, и
 * для одного guid пар может быть несколько. Кандидат БЕЗ `name` (поле необязательное,
 * `resolveMention.ts:31-34`) оставляет участок `@<guid>` ДОСЛОВНО: заглушек, пустых строк и
 * `undefined` в превью не бывает. Границы здесь не нужны - guid фиксированной длины из
 * фиксированного алфавита, его вхождение однозначно.
 */
export function renderMentionNames(text: string, candidates: readonly MentionCandidate[]): string {
  const names = new Map<string, string>();
  for (const candidate of candidates) {
    if (candidate.name !== undefined) {
      names.set(candidate.guid, candidate.name);
    }
  }
  if (names.size === 0) {
    return text;
  }
  let output = '';
  let cursor = 0;
  while (cursor < text.length) {
    if (text.charAt(cursor) === '@') {
      const name = names.get(text.slice(cursor + 1, cursor + 1 + MENTION_GUID_LENGTH));
      if (name !== undefined) {
        output += `@${name}`;
        cursor += 1 + MENTION_GUID_LENGTH;
        continue;
      }
    }
    output += text.charAt(cursor);
    cursor += 1;
  }
  return output;
}
