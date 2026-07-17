import { describe, expect, it } from 'vitest';
import { countUnread, normalizeChat, normalizeChats } from '../../src/protocol/chatShape.js';

/**
 * Фикстуры повторяют форму живого захвата 2026-07-17 (13 чатов реального профиля):
 * ключи элемента Chats[] и, в частности, тот факт, что `Counters` несёт
 * {HiddenMessageCount, TotalMessageCount} - объём чата, а НЕ непрочитанное.
 */
function rawChat(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ChatId: 'guid-a_guid-b',
    LastSeqNo: 10,
    LastSeenByMeSeqNo: 10,
    LastTsMcs: 1784117592261029,
    Counters: { HiddenMessageCount: 0, TotalMessageCount: 350 },
    PrivateChatInfo: { Version: 1 },
    PartnerInfo: { Guid: 'guid-b', DisplayName: 'Собеседник' },
    ...overrides,
  };
}

describe('countUnread: непрочитанное считается из history(Limit:0/1), counters-вызов не нужен', () => {
  it('LastSeqNo - LastSeenByMeSeqNo', () => {
    expect(countUnread(rawChat({ LastSeqNo: 15, LastSeenByMeSeqNo: 10 }))).toBe(5);
  });

  it('всё просмотрено -> ноль', () => {
    expect(countUnread(rawChat())).toBe(0);
  });

  it('LastSeenByMeSeqNo впереди (свои исходящие) -> ноль, а не минус', () => {
    expect(countUnread(rawChat({ LastSeqNo: 10, LastSeenByMeSeqNo: 12 }))).toBe(0);
  });

  it('поля отсутствуют -> ноль, без падения', () => {
    expect(countUnread({})).toBe(0);
  });

  it('Counters НЕ участвует: 350 сообщений в чате - это не 350 непрочитанных', () => {
    expect(countUnread(rawChat({ Counters: { TotalMessageCount: 350, HiddenMessageCount: 7 } }))).toBe(0);
  });
});

describe('normalizeChat', () => {
  it('приватный чат: имя от собеседника, kind private', () => {
    const chat = normalizeChat(rawChat());

    expect(chat?.name).toBe('Собеседник');
    expect(chat?.kind).toBe('private');
    expect(chat?.chat_id).toBe('guid-a_guid-b');
  });

  it('групповой чат: имя из ChatInfo, kind group', () => {
    const chat = normalizeChat(
      rawChat({ PrivateChatInfo: undefined, PartnerInfo: undefined, ChatInfo: { Name: 'Команда' } }),
    );

    expect(chat?.name).toBe('Команда');
    expect(chat?.kind).toBe('group');
  });

  it('свежесть: ISO и сырые 16-значные мкс рядом', () => {
    const chat = normalizeChat(rawChat());

    expect(chat?.last_activity).toBe('2026-07-15T12:13:12.261Z');
    expect(chat?.last_activity_mcs).toBe('1784117592261029');
  });

  it('unread-флаг и счётчик', () => {
    const chat = normalizeChat(rawChat({ LastSeqNo: 12, LastSeenByMeSeqNo: 10 }));

    expect(chat?.unread).toBe(true);
    expect(chat?.unread_count).toBe(2);
  });

  it('Muted пробрасывается', () => {
    expect(normalizeChat(rawChat({ Muted: true }))?.muted).toBe(true);
    expect(normalizeChat(rawChat())?.muted).toBe(false);
  });

  it('без ChatId элемент отбрасывается', () => {
    expect(normalizeChat({ LastSeqNo: 1 })).toBeUndefined();
    expect(normalizeChat(undefined)).toBeUndefined();
  });

  it('Limit:0 (без Messages) -> last_message отсутствует, но чат валиден', () => {
    const chat = normalizeChat(rawChat());

    expect(chat?.last_message).toBeUndefined();
    expect(chat?.chat_id).toBe('guid-a_guid-b');
  });

  it('Limit:1 -> last_message нормализовано', () => {
    const chat = normalizeChat(
      rawChat({
        Messages: [
          {
            ServerMessage: {
              ClientMessage: { Plain: { ChatId: 'guid-a_guid-b', Text: { MessageText: 'последнее' } } },
              ServerMessageInfo: { Timestamp: 1784117592261029, SeqNo: 10, From: { Guid: 'guid-b', DisplayName: 'С' } },
            },
          },
        ],
      }),
    );

    expect(chat?.last_message?.text).toBe('последнее');
    expect(chat?.last_message?.timestamp_mcs).toBe('1784117592261029');
  });
});

describe('normalizeChats: сортировка по свежести', () => {
  it('свежие первыми', () => {
    const chats = normalizeChats([
      rawChat({ ChatId: 'старый', LastTsMcs: 1784117000000000 }),
      rawChat({ ChatId: 'свежий', LastTsMcs: 1784117592261029 }),
      rawChat({ ChatId: 'средний', LastTsMcs: 1784117500000000 }),
    ]);

    expect(chats.map((c) => c.chat_id)).toEqual(['свежий', 'средний', 'старый']);
  });

  it('сортировка точна на соседних мкс: сравнение идёт BigInt, не float', () => {
    const chats = normalizeChats([
      rawChat({ ChatId: 'младше', LastTsMcs: 1784117592261029 }),
      rawChat({ ChatId: 'старше', LastTsMcs: 1784117592261028 }),
    ]);

    expect(chats.map((c) => c.chat_id)).toEqual(['младше', 'старше']);
  });

  it('чат без метки уезжает в конец, а не роняет сортировку', () => {
    const chats = normalizeChats([rawChat({ ChatId: 'безметки', LastTsMcs: undefined }), rawChat({ ChatId: 'сметкой' })]);

    expect(chats.map((c) => c.chat_id)).toEqual(['сметкой', 'безметки']);
  });

  it('на не-массиве отдаёт пусто', () => {
    expect(normalizeChats(undefined)).toEqual([]);
  });
});
