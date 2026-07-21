import { describe, expect, it } from 'vitest';
import { normalizeMessage, normalizeMessages } from '../../src/protocol/messageShape.js';

/**
 * Фикстуры собраны по §11.1/§11.2 и сверены с формой живого захвата 2026-07-17:
 * ключи ServerMessageInfo {Deleted,From,LastEditTimestamp,PrevTimestamp,SeqNo,ThreadState,
 * Timestamp,Version}, ключи Plain {ChatId,CustomPayload,PayloadId,Text}, FileInfo
 * {Id2,Name,Size,Source}. Значения синтетические.
 */
const TS = 1784117592261029;

function serverMessage(overrides: {
  plain?: Record<string, unknown>;
  info?: Record<string, unknown>;
  clientMessage?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ClientMessage: overrides.clientMessage ?? {
      Plain: {
        ChatId: 'guid-a_guid-b',
        PayloadId: 'payload-1',
        Text: { MessageText: 'текст' },
        ...overrides.plain,
      },
    },
    ServerMessageInfo: {
      Timestamp: TS,
      SeqNo: 42,
      Version: 1,
      PrevTimestamp: 0,
      LastEditTimestamp: 0,
      Deleted: false,
      From: { Guid: 'guid-a', DisplayName: 'Имя' },
      ...overrides.info,
    },
  };
}

describe('normalizeMessage: базовая форма', () => {
  it('id и курсор - сырые мкс строкой, рядом ISO', () => {
    const message = normalizeMessage(serverMessage({}));

    expect(message?.id).toBe('1784117592261029');
    expect(message?.timestamp_mcs).toBe('1784117592261029');
    expect(message?.timestamp).toBe('2026-07-15T12:13:12.261Z');
    /* Метка не должна пройти через number и потерять хвост */
    expect(message?.timestamp_mcs).toHaveLength(16);
  });

  it('отправитель - имя и guid; текст и seq_no на месте', () => {
    const message = normalizeMessage(serverMessage({}));

    expect(message?.from).toEqual({ guid: 'guid-a', name: 'Имя' });
    expect(message?.text).toBe('текст');
    expect(message?.seq_no).toBe(42);
    expect(message?.kind).toBe('text');
    expect(message?.edited).toBe(false);
    expect(message?.deleted).toBe(false);
    expect(message?.attachments).toEqual([]);
  });

  it('без метки сообщение неадресуемо -> undefined', () => {
    expect(normalizeMessage(serverMessage({ info: { Timestamp: undefined } }))).toBeUndefined();
    expect(normalizeMessage(undefined)).toBeUndefined();
    expect(normalizeMessage({ ClientMessage: {} })).toBeUndefined();
  });
});

describe('правка и удаление (§9.2: отдельных типов НЕТ)', () => {
  it('LastEditTimestamp > 0 => edited + время правки', () => {
    const message = normalizeMessage(serverMessage({ info: { LastEditTimestamp: 1784117599000000, Version: 3 } }));

    expect(message?.edited).toBe(true);
    expect(message?.edited_at).toBe('2026-07-15T12:13:19.000Z');
  });

  it('LastEditTimestamp = 0 => не правка', () => {
    expect(normalizeMessage(serverMessage({}))?.edited).toBe(false);
    expect(normalizeMessage(serverMessage({}))?.edited_at).toBeUndefined();
  });

  it('Deleted = true => deleted, пустое тело не даёт ложных вложений', () => {
    const message = normalizeMessage(
      serverMessage({ info: { Deleted: true }, clientMessage: { Plain: { ChatId: 'guid-a_guid-b' } } }),
    );

    expect(message?.deleted).toBe(true);
    expect(message?.text).toBeUndefined();
    expect(message?.attachments).toEqual([]);
    expect(message?.kind).toBe('unknown');
  });
});

describe('рефы вложений (§11.1/§12.4)', () => {
  it('Image -> реф с Id2/Name/Size/Source и размерами', () => {
    const message = normalizeMessage(
      serverMessage({
        plain: {
          Text: undefined,
          Image: { Width: 800, Height: 600, Animated: false, FileInfo: { Id2: 'doc-1', Name: 'p.jpg', Size: 1024, Source: 0 } },
        },
      }),
    );

    expect(message?.kind).toBe('image');
    expect(message?.attachments).toEqual([
      { kind: 'image', file_id: 'doc-1', name: 'p.jpg', size: 1024, source: 'mds', width: 800, height: 600, animated: false },
    ]);
  });

  it('MiscFile с Source=1 -> source disk', () => {
    const message = normalizeMessage(
      serverMessage({ plain: { Text: undefined, MiscFile: { FileInfo: { Id2: 'doc-2', Name: 'a.pdf', Size: 9, Source: 1 } } } }),
    );

    expect(message?.kind).toBe('file');
    expect(message?.attachments[0]).toMatchObject({ kind: 'file', file_id: 'doc-2', source: 'disk' });
  });

  it('Voice -> реф с длительностью, распознанный текст попадает в text', () => {
    const message = normalizeMessage(
      serverMessage({
        plain: { Text: undefined, Voice: { FileInfo: { Id2: 'doc-3', Source: 0 }, Duration: 12, Text: 'расшифровка' } },
      }),
    );

    expect(message?.kind).toBe('voice');
    expect(message?.attachments[0]).toMatchObject({ kind: 'voice', file_id: 'doc-3', duration: 12 });
    expect(message?.text).toBe('расшифровка');
  });

  it('Gallery -> реф на КАЖДЫЙ элемент', () => {
    const message = normalizeMessage(
      serverMessage({
        plain: {
          Text: undefined,
          Gallery: {
            Items: [
              { Image: { Width: 1, Height: 2, FileInfo: { Id2: 'doc-4', Source: 0 } } },
              { Image: { Width: 3, Height: 4, FileInfo: { Id2: 'doc-5', Source: 0 } } },
            ],
            Text: 'подпись',
          },
        },
      }),
    );

    expect(message?.kind).toBe('gallery');
    expect(message?.attachments.map((a) => a.file_id)).toEqual(['doc-4', 'doc-5']);
    expect(message?.attachments.every((a) => a.kind === 'gallery_image')).toBe(true);
  });

  it('FileInfo без Id2 отбрасывается: скачивать по такому рефу нечего', () => {
    const message = normalizeMessage(
      serverMessage({ plain: { Text: undefined, Image: { FileInfo: { Name: 'no-id.jpg', Size: 1 } } } }),
    );

    expect(message?.attachments).toEqual([]);
  });

  it('неизвестный Source не выдаётся за mds', () => {
    const message = normalizeMessage(
      serverMessage({ plain: { Text: undefined, MiscFile: { FileInfo: { Id2: 'doc-6', Source: 77 } } } }),
    );

    expect(message?.attachments[0]?.source).toBe('unknown');
  });

  it('ничего не качает: реф несёт только doc id, без URL', () => {
    const message = normalizeMessage(
      serverMessage({ plain: { Text: undefined, Image: { FileInfo: { Id2: 'doc-7', Source: 0 } } } }),
    );

    expect(Object.keys(message?.attachments[0] ?? {})).not.toContain('url');
  });
});

describe('text из content-типов (§11.1, ревизия всех CONTENT_KINDS - AC-9..AC-12)', () => {
  it('Text.MessageText -> text', () => {
    const message = normalizeMessage(serverMessage({ plain: { Text: { MessageText: 'обычный текст' } } }));

    expect(message?.kind).toBe('text');
    expect(message?.text).toBe('обычный текст');
  });

  it('Sticker не несёт текстового поля на проводе - text отсутствует', () => {
    const message = normalizeMessage(
      serverMessage({ plain: { Text: undefined, Sticker: { StickerId: 'sticker-1' } } }),
    );

    expect(message?.kind).toBe('sticker');
    expect(message?.text).toBeUndefined();
  });

  it('Image не несёт текстового поля на проводе - text отсутствует', () => {
    const message = normalizeMessage(
      serverMessage({ plain: { Text: undefined, Image: { FileInfo: { Id2: 'doc-1', Source: 0 } } } }),
    );

    expect(message?.kind).toBe('image');
    expect(message?.text).toBeUndefined();
  });

  it('MiscFile не несёт текстового поля на проводе - text отсутствует', () => {
    const message = normalizeMessage(
      serverMessage({ plain: { Text: undefined, MiscFile: { FileInfo: { Id2: 'doc-2', Source: 0 } } } }),
    );

    expect(message?.kind).toBe('file');
    expect(message?.text).toBeUndefined();
  });

  it('Card сознательно не читается (AC-11) - text отсутствует, даже если поля похожи на текстовые', () => {
    const message = normalizeMessage(
      serverMessage({
        plain: { Text: undefined, Card: { Title: 'заголовок карточки', Description: 'описание карточки' } },
      }),
    );

    expect(message?.kind).toBe('card');
    expect(message?.text).toBeUndefined();
  });

  it('Gallery.Text -> непустой text: картинка с подписью не теряет текст (AC-9)', () => {
    const message = normalizeMessage(
      serverMessage({
        plain: {
          Text: undefined,
          Gallery: { Items: [{ Image: { FileInfo: { Id2: 'doc-3', Source: 0 } } }], Text: 'подпись к галерее' },
        },
      }),
    );

    expect(message?.kind).toBe('gallery');
    expect(message?.text).toBe('подпись к галерее');
  });

  it('Gallery без Text - text отсутствует, а не пустая строка', () => {
    const message = normalizeMessage(
      serverMessage({
        plain: { Text: undefined, Gallery: { Items: [{ Image: { FileInfo: { Id2: 'doc-4', Source: 0 } } }] } },
      }),
    );

    expect(message?.text).toBeUndefined();
  });

  it('Voice.Text -> распознанная речь в text', () => {
    const message = normalizeMessage(
      serverMessage({
        plain: { Text: undefined, Voice: { FileInfo: { Id2: 'doc-5', Source: 0 }, Text: 'расшифровка речи' } },
      }),
    );

    expect(message?.kind).toBe('voice');
    expect(message?.text).toBe('расшифровка речи');
  });

  it('Poll.Title НЕ подставляется в text (AC-12): заголовок отдаётся через get_poll', () => {
    const message = normalizeMessage(
      serverMessage({ plain: { Text: undefined, Poll: { Title: 'вопрос опроса', Answers: ['да', 'нет'] } } }),
    );

    expect(message?.kind).toBe('poll');
    expect(message?.text).toBeUndefined();
  });
});

describe('контекст reply/forward (§11.1: reply = форвард с цитатой)', () => {
  it('ForwardedMessageRefs + Quote => is_reply с цитатой и ссылкой', () => {
    const message = normalizeMessage(
      serverMessage({
        plain: {
          ForwardedMessageRefs: [{ ChatId: 'guid-c_guid-d', Timestamp: 1784117000000000 }],
          ForwardedMessageStyles: [{ Quote: 'исходный фрагмент' }],
        },
      }),
    );

    expect(message?.context?.is_reply).toBe(true);
    expect(message?.context?.quotes).toEqual(['исходный фрагмент']);
    expect(message?.context?.refs).toEqual([
      { chat_id: 'guid-c_guid-d', timestamp: '2026-07-15T12:03:20.000Z', timestamp_mcs: '1784117000000000' },
    ]);
  });

  it('refs без Quote => форвард, а не reply', () => {
    const message = normalizeMessage(
      serverMessage({ plain: { ForwardedMessageRefs: [{ ChatId: 'guid-c_guid-d', Timestamp: 1784117000000000 }] } }),
    );

    expect(message?.context?.is_reply).toBe(false);
    expect(message?.context?.refs).toHaveLength(1);
  });

  it('обычное сообщение контекста не несёт', () => {
    expect(normalizeMessage(serverMessage({}))?.context).toBeUndefined();
  });

  it('битая метка в ref не роняет разбор - ссылка отдаётся без времени', () => {
    const message = normalizeMessage(
      serverMessage({ plain: { ForwardedMessageRefs: [{ ChatId: 'guid-c_guid-d', Timestamp: 0 }] } }),
    );

    expect(message?.context?.refs).toEqual([{ chat_id: 'guid-c_guid-d' }]);
  });
});

describe('normalizeMessages', () => {
  it('разворачивает ServerMessage и отбрасывает неадресуемые', () => {
    const messages = normalizeMessages([
      { ServerMessage: serverMessage({}) },
      { ServerMessage: { ClientMessage: {} } },
      { Meta: { Origin: 27 } },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe('1784117592261029');
  });

  it('на не-массиве отдаёт пусто, а не падает', () => {
    expect(normalizeMessages(undefined)).toEqual([]);
  });

  it('SystemMessage распознаётся как system', () => {
    const messages = normalizeMessages([
      { ServerMessage: serverMessage({ clientMessage: { SystemMessage: { ChatId: 'x', UserAction: 0 } } }) },
    ]);

    expect(messages[0]?.kind).toBe('system');
  });
});
