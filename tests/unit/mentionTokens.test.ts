/**
 * Подстановка токена упоминания и обратный рендер имён (#15).
 *
 * Главные утверждения: подставляется НАЗВАННОЕ, а не «похожее на упоминание»; отображение идёт по
 * строке запроса, а не по позиции (иначе на необратимом пути guid уехал бы не тому человеку);
 * шесть правил границ и порядка покрыты по кейсу на правило, а у правил 5 и 6 - по два, потому что
 * у каждого есть граница действия.
 */
import { describe, expect, it } from 'vitest';
import { renderMentionNames, substituteMentionTokens } from '../../src/chat/mentionTokens.js';

const IVAN = 'dddddddd-1111-2222-3333-444444444444';
const PETR = 'eeeeeeee-5555-6666-7777-888888888888';
const OTHER = 'cccccccc-9999-0000-1111-222222222222';

const substitute = (text: string, pairs: Array<{ query: string; guid: string }>) =>
  substituteMentionTokens(text, pairs).text;

describe('substituteMentionTokens: правило 1 - нормализация запроса', () => {
  it('запрос сравнивается как его видит резолвер: ведущий @ и пробелы снимаются', () => {
    expect(substitute('привет @Иван', [{ query: '  @Иван ', guid: IVAN }])).toBe(`привет @${IVAN}`);
  });

  it('пустой после нормализации запрос не подставляет ничего', () => {
    expect(substitute('привет @Иван', [{ query: '@', guid: IVAN }])).toBe('привет @Иван');
  });
});

describe('substituteMentionTokens: правило 2 - приоритет формы с @ над голой', () => {
  it('`@<guid>` при названном том же guid даёт `@<guid>`, а НЕ `@@<guid>`', () => {
    expect(substitute(`привет @${IVAN}`, [{ query: IVAN, guid: IVAN }])).toBe(`привет @${IVAN}`);
  });

  it('голая форма ищется только когда сам запрос - guid: имя голой формой не ловится', () => {
    expect(substitute('привет Иван', [{ query: 'Иван', guid: IVAN }])).toBe('привет Иван');
  });

  it('голый guid в тексте при названном guid подставляется в форму с @', () => {
    expect(substitute(`привет ${IVAN}`, [{ query: IVAN, guid: IVAN }])).toBe(`привет @${IVAN}`);
  });
});

describe('substituteMentionTokens: правило 3 - левая граница голой формы', () => {
  it('голая форма после @ не засчитывается: `x@<guid>` не даёт второго @', () => {
    /* Форма с @ отсекается правилом 6 (слева буква), голая - правилом 3 (слева @) */
    expect(substitute(`x@${IVAN}`, [{ query: IVAN, guid: IVAN }])).toBe(`x@${IVAN}`);
  });
});

describe('substituteMentionTokens: правило 4 - правая граница', () => {
  it('`@Иван` не съедает начало `@Иванов`', () => {
    expect(substitute('привет @Иванов', [{ query: 'Иван', guid: IVAN }])).toBe('привет @Иванов');
  });

  it('знак препинания правой границей не является помехой', () => {
    expect(substitute('@Иван, привет', [{ query: 'Иван', guid: IVAN }])).toBe(`@${IVAN}, привет`);
  });

  it('конец строки - валидная правая граница', () => {
    expect(substitute('привет @Иван', [{ query: 'Иван', guid: IVAN }])).toBe(`привет @${IVAN}`);
  });
});

describe('substituteMentionTokens: правило 5 - порядок между парами и кратность', () => {
  it('названы обе строки: длинная выигрывает, `@Иван` не разрезает `@Иван Петров`', () => {
    const result = substitute('@Иван Петров', [
      { query: 'Иван', guid: IVAN },
      { query: 'Иван Петров', guid: PETR },
    ]);

    expect(result).toBe(`@${PETR}`);
  });

  it('ГРАНИЦА действия сортировки: при названном только `Иван` имя режется - принятое следствие', () => {
    expect(substitute('@Иван Петров', [{ query: 'Иван', guid: IVAN }])).toBe(`@${IVAN} Петров`);
  });

  it('заменяются ВСЕ вхождения, а не первое', () => {
    expect(substitute('@Иван, @Иван', [{ query: 'Иван', guid: IVAN }])).toBe(`@${IVAN}, @${IVAN}`);
  });
});

describe('substituteMentionTokens: правило 6 - левая граница формы с @', () => {
  it('`пиши на petr@Иван` при mentions:[Иван] возвращается НЕИЗМЕННЫМ', () => {
    expect(substitute('пиши на petr@Иван', [{ query: 'Иван', guid: IVAN }])).toBe('пиши на petr@Иван');
  });

  it('почтовый адрес с точкой того же класса не трогается', () => {
    expect(substitute('пиши на ivan@Иван.ru', [{ query: 'Иван', guid: IVAN }])).toBe('пиши на ivan@Иван.ru');
  });

  it('ГРАНИЦА действия: `@Иван@Пётр` при обоих названных подставляется ПОЛНОСТЬЮ', () => {
    /* Поглощённый предыдущей подстановкой участок левой границей не служит, иначе Пётр не получит пинга */
    const result = substitute('@Иван@Пётр', [
      { query: 'Иван', guid: IVAN },
      { query: 'Пётр', guid: PETR },
    ]);

    expect(result).toBe(`@${IVAN}@${PETR}`);
  });
});

describe('substituteMentionTokens: схлопнутые дубли, каскад, пустой вход', () => {
  it('два РАЗНЫХ запроса в один guid заменяются ОБА', () => {
    const result = substitute('@Ваня и @Иван', [
      { query: 'Ваня', guid: IVAN },
      { query: 'Иван', guid: IVAN },
    ]);

    expect(result).toBe(`@${IVAN} и @${IVAN}`);
  });

  it('каскада нет: подставленный guid не становится входом для следующей пары', () => {
    const result = substitute('@Иван', [
      { query: 'Иван', guid: IVAN },
      { query: IVAN, guid: OTHER },
    ]);

    expect(result).toBe(`@${IVAN}`);
  });

  it('пустые mentions возвращают текст БАЙТ В БАЙТ', () => {
    const text = `@Иван, ivan@yandex.ru, @channel и посторонний ${OTHER}`;

    expect(substituteMentionTokens(text, [])).toEqual({ text, substituted: 0 });
  });

  it('счётчик замен считает участки, а не пары', () => {
    expect(substituteMentionTokens('@Иван, @Иван и @Пётр', [
      { query: 'Иван', guid: IVAN },
      { query: 'Пётр', guid: PETR },
    ]).substituted).toBe(3);
  });

  it('названный, но не встреченный в тексте запрос даёт ноль замен и исходный текст', () => {
    expect(substituteMentionTokens('привет', [{ query: 'Иван', guid: IVAN }])).toEqual({
      text: 'привет',
      substituted: 0,
    });
  });
});

describe('renderMentionNames: обратный рендер для превью', () => {
  it('`@<guid>` разворачивается в `@Имя`', () => {
    expect(renderMentionNames(`привет @${IVAN}`, [{ guid: IVAN, name: 'Иван' }])).toBe('привет @Иван');
  });

  it('два упоминания подряд: границы не путаются, каждый guid развёрнут в СВОЁ имя', () => {
    const result = renderMentionNames(`@${IVAN}@${PETR}`, [
      { guid: IVAN, name: 'Иван' },
      { guid: PETR, name: 'Пётр' },
    ]);

    expect(result).toBe('@Иван@Пётр');
  });

  it('кандидат БЕЗ name оставляет участок дословно: ни undefined, ни пустого имени, ни заглушки', () => {
    const result = renderMentionNames(`@${IVAN} и @${PETR}`, [{ guid: IVAN, name: 'Иван' }, { guid: PETR }]);

    expect(result).toBe(`@Иван и @${PETR}`);
    expect(result).not.toContain('undefined');
  });

  it('два запроса в один guid дают ОДНО имя: рендер идёт по кандидатам, ничего не удваивается', () => {
    expect(renderMentionNames(`@${IVAN} и @${IVAN}`, [{ guid: IVAN, name: 'Иван' }])).toBe('@Иван и @Иван');
  });

  it('незнакомый guid остаётся как есть', () => {
    expect(renderMentionNames(`@${OTHER}`, [{ guid: IVAN, name: 'Иван' }])).toBe(`@${OTHER}`);
  });
});
