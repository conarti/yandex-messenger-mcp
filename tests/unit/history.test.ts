import { describe, expect, it } from 'vitest';
import { buildHistoryParams, extractChats, findChatEntry } from '../../src/protocol/history.js';

describe('buildHistoryParams', () => {
  it('список чатов: Limit:0 + пустой ChatDataFilter (§2.4)', () => {
    expect(buildHistoryParams({ limit: 0, withChatData: true })).toEqual({ Limit: 0, ChatDataFilter: {} });
  });

  it('страница чата: ChatId + Limit', () => {
    expect(buildHistoryParams({ chatId: 'guid-a_guid-b', limit: 40 })).toEqual({
      ChatId: 'guid-a_guid-b',
      Limit: 40,
    });
  });

  it('курсор BigInt уезжает на провод числом без потери разрядов', () => {
    const params = buildHistoryParams({ chatId: 'x', limit: 20, maxTimestamp: 1784117592261029n });

    expect(params['MaxTimestamp']).toBe(1784117592261029);
    /* Тело кадра - JSON, BigInt в нём невыразим: значение обязано быть number */
    expect(typeof params['MaxTimestamp']).toBe('number');
  });

  it('курсор за 2^53 роняет сборку, а не теряет разряд молча', () => {
    expect(() => buildHistoryParams({ chatId: 'x', limit: 20, maxTimestamp: 9007199254740993n })).toThrow(RangeError);
  });

  it('MinTimestamp и Offset пробрасываются', () => {
    const params = buildHistoryParams({ chatId: 'x', limit: 20, minTimestamp: 1784117000000000n, offset: 20 });

    expect(params['MinTimestamp']).toBe(1784117000000000);
    expect(params['Offset']).toBe(20);
  });

  it('DropPayload -> MessageDataFilter (§14.2)', () => {
    expect(buildHistoryParams({ limit: 0, dropPayload: true })['MessageDataFilter']).toEqual({ DropPayload: true });
  });

  it('необязательные поля не попадают в params пустыми', () => {
    const params = buildHistoryParams({ limit: 1 });

    expect(Object.keys(params)).toEqual(['Limit']);
  });

  it('отвергает отрицательный Limit и Offset', () => {
    expect(() => buildHistoryParams({ limit: -1 })).toThrow(RangeError);
    expect(() => buildHistoryParams({ limit: 1, offset: -5 })).toThrow(RangeError);
  });

  it('ChatIds - батч (§2.4)', () => {
    expect(buildHistoryParams({ chatIds: ['a', 'b'], limit: 0 })['ChatIds']).toEqual(['a', 'b']);
  });
});

describe('extractChats / findChatEntry', () => {
  const response = { Chats: [{ ChatId: 'a' }, { ChatId: 'b' }], RequestId: 'r' };

  it('достаёт Chats', () => {
    expect(extractChats(response)).toHaveLength(2);
  });

  it('на пустом/битом ответе отдаёт пусто, а не падает', () => {
    expect(extractChats(undefined)).toEqual([]);
    expect(extractChats({ Chats: 'не массив' })).toEqual([]);
  });

  it('находит элемент нужного чата', () => {
    expect(findChatEntry(response, 'b')).toEqual({ ChatId: 'b' });
    expect(findChatEntry(response, 'нет')).toBeUndefined();
  });
});
