/**
 * Карта реакций Яндекс.Мессенджера: int `Reaction.Type` (id артворка) -> {name, emoji}.
 *
 * ДАННЫЕ, А НЕ КОД. Сама карта лежит рядом в `reaction-map.json` (52 записи, снято спайком 5),
 * и перегенерируется свипом по `/reactions/{type}/small` (301 vs 404 + имя из `Location`) - без
 * бандла. Здесь только загрузчик и lookup.
 *
 * LOOKUP С ФОЛБЭКОМ, А НЕ `switch`, КОТОРЫЙ БРОСАЕТ. Пространство типов ОТКРЫТО: сервер не
 * валидирует `Type` и принимает любой int (`999999` -> Status:1, читается дословно). Значит
 * карта не может быть полной, а неизвестный тип - штатный сценарий чтения, а не баг. Он не
 * имеет права ронять `get_message`: неизвестный тип отдаётся как `unknown`, а не исключением.
 *
 * КОЛОНКА `emoji` - НАША АППРОКСИМАЦИЯ артворка, а НЕ то, что отдаёт сервер. Яндекс рендерит
 * реакции PNG-артворком по id (`https://files.messenger.yandex.net/reactions/{type}/{size}`),
 * Unicode-эмодзи он не использует. Авторитетны `type` (пришёл с провода) и `name` (имя ассета
 * с сервера); `emoji` выдавать за «эмодзи от Яндекса» нельзя.
 *
 * `chr(type)` КАК EMOJI НЕ ПОДСТАВЛЯЕТСЯ. Для `100102` кодпоинт - тангутский иероглиф, для
 * `999999` - вообще не символ. Правило «type == кодпоинт» верно ровно для 10 legacy-записей и
 * больше нигде, поэтому оно зашито данными карты, а не вычислением.
 */
import { readFileSync } from 'node:fs';
import { asObject, numberOr, stringOr } from '../util/json.js';

/** Результат lookup: `type` присутствует ВСЕГДА, остальное - интерпретация по карте */
export interface ReactionInfo {
  /** int с провода (id артворка), присутствует всегда */
  type: number;
  /** Имя ассета с сервера; `null`, если тип неизвестен карте */
  name: string | null;
  /** Аппроксимация артворка (не «эмодзи от Яндекса»); `null`, если тип неизвестен */
  emoji: string | null;
  /** `true`, когда типа нет в карте: реакция не глотается, отдаётся сырой `type` */
  unknown?: true;
}

/** Реакция, отрисованная поверх сырого `type` из `Reactions[]` (агрегат `{type, count}`) */
export interface RenderedReaction extends ReactionInfo {
  /** Число поставивших (из `Reactions[].Count`), если пришло */
  count?: number;
}

export interface ReactionMap {
  /** Известный -> `{type, name, emoji}`; неизвестный -> `{type, name:null, emoji:null, unknown:true}` */
  lookup(type: number): ReactionInfo;
  /** Валидатор для записи (Phase 5, `set_reaction`): тип вне карты на провод не уходит */
  isKnown(type: number): boolean;
}

interface ReactionEntry {
  name: string;
  emoji: string | null;
}

/** Разбирает `reactions` из JSON-файла в таблицу `type -> {name, emoji}`. Битые записи пропускает */
function readReactionTable(): Map<number, ReactionEntry> {
  /*
   * Путь резолвится от самого модуля: в тестах (vitest гоняет TS из `src`) это
   * `src/config/reaction-map.json`, в проде (`dist`) - `dist/config/reaction-map.json`
   * (build копирует JSON рядом с `reactionMap.js`).
   */
  const fileUrl = new URL('./reaction-map.json', import.meta.url);
  const parsed = asObject(JSON.parse(readFileSync(fileUrl, 'utf8'))) ?? {};
  const reactions = asObject(parsed['reactions']) ?? {};

  const table = new Map<number, ReactionEntry>();
  for (const [key, value] of Object.entries(reactions)) {
    const type = Number(key);
    if (!Number.isInteger(type)) {
      continue;
    }
    const entry = asObject(value);
    const name = stringOr(entry?.['name']);
    if (name === undefined) {
      continue;
    }
    /* emoji - аппроксимация, может отсутствовать; тогда null, а не строка */
    const emoji = stringOr(entry?.['emoji']) ?? null;
    table.set(type, { name, emoji });
  }
  return table;
}

/** Строит `ReactionMap` над готовой таблицей. Отдельно от загрузки - чтобы тест мог подсунуть свою */
export function createReactionMap(table: ReadonlyMap<number, ReactionEntry>): ReactionMap {
  return {
    lookup(type: number): ReactionInfo {
      const hit = table.get(type);
      if (hit === undefined) {
        return { type, name: null, emoji: null, unknown: true };
      }
      return { type, name: hit.name, emoji: hit.emoji };
    },
    isKnown(type: number): boolean {
      return table.has(type);
    },
  };
}

let cached: ReactionMap | undefined;

/** Карта по умолчанию из `reaction-map.json`. Файл читается один раз и кэшируется */
export function loadReactionMap(): ReactionMap {
  cached ??= createReactionMap(readReactionTable());
  return cached;
}

/** Lookup по карте по умолчанию: известный -> name/emoji, неизвестный -> unknown */
export function lookupReaction(type: number): ReactionInfo {
  return loadReactionMap().lookup(type);
}

/** Валидатор на запись: тип вне карты по умолчанию отвергается (`999999`/`1` не уходят на провод) */
export function isKnownReactionType(type: number): boolean {
  return loadReactionMap().isKnown(type);
}

/**
 * Отрисовка агрегатов `Reactions[]` (сырой `{type, count}`) через карту в финальную форму.
 *
 * СХОДИМОСТЬ `Count`. Отрисовываются ВСЕ элементы, включая неизвестные: неизвестная реакция
 * видна как `unknown` со своим `count`, а не проглатывается. Поэтому сумма показанных `count`
 * сходится с суммой `Reactions[].Count` - данные не теряются.
 */
export function renderReactions(
  items: ReadonlyArray<{ type: number; count?: number }>,
  map: ReactionMap,
): RenderedReaction[] {
  return items.map((item) => {
    const info = map.lookup(item.type);
    return { ...info, ...(item.count !== undefined ? { count: item.count } : {}) };
  });
}
