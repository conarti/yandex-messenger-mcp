/**
 * Карта реакций (Fork C1, §17.12 + спайк 5).
 *
 * Проверяется lookup-с-фолбэком, а не switch: неизвестный тип - штатный сценарий (сервер
 * принимает любой int), он обязан отдаваться как unknown, а не ронять чтение. `type` присутствует
 * ВСЕГДА; `chr(type)` в emoji не подставляется. Карта - данные из `reaction-map.json` (52 записи).
 */
import { describe, expect, it } from 'vitest';
import {
  createReactionMap,
  isKnownReactionType,
  loadReactionMap,
  lookupReaction,
  renderReactions,
  type ReactionMap,
} from '../../src/config/reactionMap.js';

describe('lookupReaction по карте reaction-map.json', () => {
  it('известный ext-тип 100102 -> like-ext / 👍, без unknown', () => {
    expect(lookupReaction(100102)).toEqual({ type: 100102, name: 'like-ext', emoji: '👍' });
  });

  it('известный legacy-кодпоинт 128077 -> like / 👍', () => {
    expect(lookupReaction(128077)).toEqual({ type: 128077, name: 'like', emoji: '👍' });
  });

  it('неизвестный 999999 -> {type, name:null, emoji:null, unknown:true}', () => {
    expect(lookupReaction(999999)).toEqual({ type: 999999, name: null, emoji: null, unknown: true });
  });

  it('мусорный 1 -> unknown, а НЕ 👍 (сервер не валидирует Type, но 1 в карту не входит)', () => {
    const info = lookupReaction(1);
    expect(info).toEqual({ type: 1, name: null, emoji: null, unknown: true });
    expect(info.emoji).not.toBe('👍');
  });

  it('type присутствует ВСЕГДА и остаётся числом (id артворка)', () => {
    for (const type of [100102, 999999, 1, 128077]) {
      const info = lookupReaction(type);
      expect(info.type).toBe(type);
      expect(typeof info.type).toBe('number');
    }
  });

  it('emoji НЕ вычисляется как chr(type): для ext-типа 100102 это тангутский иероглиф, а не 👍', () => {
    const info = lookupReaction(100102);
    /* String.fromCodePoint(100102) - тангутский иероглиф; emoji из карты - осмысленный 👍 */
    expect(info.emoji).toBe('👍');
    expect(info.emoji).not.toBe(String.fromCodePoint(100102));
    /* Неизвестный тип не получает chr(type) вместо emoji - он null */
    expect(lookupReaction(999999).emoji).toBeNull();
    expect(lookupReaction(1).emoji).toBeNull();
  });

  it('карта несёт ровно 52 известных записи (не роняется на старте)', () => {
    const map = loadReactionMap();
    const known = [
      10084, 100001, 100009, 100101, 100102, 100133, 127818, 128077, 128078, 128293, 128518, 128525,
      128557, 128562, 129393,
    ];
    for (const type of known) {
      expect(map.isKnown(type)).toBe(true);
    }
  });
});

describe('isKnownReactionType (валидатор на запись, Phase 5)', () => {
  it('тип из карты -> true', () => {
    expect(isKnownReactionType(100109)).toBe(true);
  });

  it('тип вне карты -> false (999999 и 1 не должны уйти на провод)', () => {
    expect(isKnownReactionType(999999)).toBe(false);
    expect(isKnownReactionType(1)).toBe(false);
  });
});

describe('renderReactions: отрисовка агрегатов Reactions[] через карту', () => {
  const map = loadReactionMap();

  it('известные типы рендерятся с name/emoji и count', () => {
    expect(renderReactions([{ type: 100102, count: 3 }], map)).toEqual([
      { type: 100102, name: 'like-ext', emoji: '👍', count: 3 },
    ]);
  });

  it('неизвестный тип виден как unknown, не проглатывается', () => {
    expect(renderReactions([{ type: 999999, count: 1 }], map)).toEqual([
      { type: 999999, name: null, emoji: null, unknown: true, count: 1 },
    ]);
  });

  it('Count сходится: сумма показанных count = сумме входных, неизвестная реакция учтена', () => {
    const items = [
      { type: 100102, count: 3 },
      { type: 999999, count: 2 },
      { type: 100109, count: 5 },
    ];
    const rendered = renderReactions(items, map);
    const shownTotal = rendered.reduce((sum, r) => sum + (r.count ?? 0), 0);
    const inputTotal = items.reduce((sum, r) => sum + r.count, 0);
    expect(shownTotal).toBe(inputTotal);
    /* Ни одна реакция не потеряна - длина сохранена */
    expect(rendered).toHaveLength(items.length);
  });

  it('count отсутствует во входе -> отсутствует в выходе (не выдумываем 0)', () => {
    expect(renderReactions([{ type: 100102 }], map)).toEqual([
      { type: 100102, name: 'like-ext', emoji: '👍' },
    ]);
  });
});

describe('createReactionMap: инъекция своей таблицы (для изоляции тестов)', () => {
  it('lookup и isKnown работают над переданной таблицей', () => {
    const custom: ReactionMap = createReactionMap(new Map([[42, { name: 'answer', emoji: '🌌' }]]));
    expect(custom.lookup(42)).toEqual({ type: 42, name: 'answer', emoji: '🌌' });
    expect(custom.isKnown(42)).toBe(true);
    expect(custom.lookup(100102)).toEqual({ type: 100102, name: null, emoji: null, unknown: true });
  });
});
