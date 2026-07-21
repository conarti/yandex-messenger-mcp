/**
 * Обогащение чтения (Fork D1, §11.2/§9.1/§17.13).
 *
 * Фикстуры СИНТЕТИЧЕСКИЕ (никаких живых uid/guid/текста), собраны по §11.2: reads/reactions/
 * mentions/forwards - сиблинги `ClientMessage` на уровне `ServerMessage`, а не внутри тела.
 * `messageShape.test.ts` НЕ редактируется - v1-регрессия держится там, здесь только дельта.
 */
import { describe, expect, it } from 'vitest';
import { enrichMessage, enrichMessages, type EnrichContext } from '../../src/protocol/enrichMessage.js';
import { normalizeMessage } from '../../src/protocol/messageShape.js';
import { createReactionMap } from '../../src/config/reactionMap.js';

const TS = 1784117592261029;
const MY_GUID = 'guid-me';
const PARTNER_GUID = 'guid-partner';

/** Карта с одним известным типом: проверяем известный (name/emoji) и unknown-путь отрисовки */
const MAP = createReactionMap(new Map([[100102, { name: 'like-ext', emoji: '👍' }]]));

/** Собирает `ServerMessage`-уровень: тело + `ServerMessageInfo` + любые сиблинги сверху */
function serverMessage(overrides: {
  plain?: Record<string, unknown>;
  info?: Record<string, unknown>;
  clientMessage?: Record<string, unknown>;
  siblings?: Record<string, unknown>;
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
      From: { Guid: PARTNER_GUID, DisplayName: 'Собеседник' },
      ...overrides.info,
    },
    ...overrides.siblings,
  };
}

function enrich(raw: Record<string, unknown>, ctx?: Partial<EnrichContext>) {
  const base = normalizeMessage(raw);
  if (base === undefined) {
    throw new Error('фикстура должна нормализоваться');
  }
  return enrichMessage(base, { myGuid: MY_GUID, reactionMap: MAP, siblings: raw, ...ctx });
}

describe('golden: v1-объект = структурное подмножество v2-выхода', () => {
  /*
   * ЗАМОРОЖЕННЫЙ v1-объект. Пин литералом, а не вызовом normalizeMessage: если кто-то
   * поменяет форму v1-нормализатора (например замаршрутит forward в context.refs),
   * `toEqual` ниже сломается - ровно то, что требует Fork D1.
   */
  const GOLDEN_V1 = {
    id: '1784117592261029',
    chat_id: 'guid-a_guid-b',
    timestamp: '2026-07-15T12:13:12.261Z',
    timestamp_mcs: '1784117592261029',
    seq_no: 42,
    from: { guid: PARTNER_GUID, name: 'Собеседник' },
    kind: 'text',
    text: 'текст',
    attachments: [],
    edited: false,
    deleted: false,
  };

  it('normalizeMessage выдаёт ровно замороженную v1-форму (ломается при мутации нормализатора)', () => {
    expect(normalizeMessage(serverMessage({}))).toEqual(GOLDEN_V1);
  });

  it('enrichMessage несёт все v1-ключи и значения на месте, добавлены только новые', () => {
    const enriched = enrich(serverMessage({}));

    /* Каждый v1-ключ присутствует с тем же значением */
    expect(enriched).toMatchObject(GOLDEN_V1);
    /* И появились новые top-level ключи */
    expect(enriched).toHaveProperty('reads');
    expect(enriched).toHaveProperty('mentions');
    /* Единая форма реакций (ось B1): reactions обязателен, разнесённого reactions_raw больше нет */
    expect(enriched).toHaveProperty('reactions');
    expect(enriched).not.toHaveProperty('reactions_raw');
    expect(enriched).toHaveProperty('thread');
    expect(enriched).toHaveProperty('forwarded');
    expect(enriched).toHaveProperty('from_me');
  });

  it('enrichMessage не мутирует base', () => {
    const base = normalizeMessage(serverMessage({}));
    enrichMessage(base!, { myGuid: MY_GUID, siblings: serverMessage({}) });
    /* base остался ровно v1-формой, лишних ключей в нём нет */
    expect(base).toEqual(GOLDEN_V1);
  });
});

describe('reads (§11.2): отслеживается / не отслеживается', () => {
  it('сиблинги прочтений присутствуют -> tracked с кем и когда', () => {
    const enriched = enrich(
      serverMessage({
        siblings: {
          ReadsCount: 2,
          SeenByPartnerMcs: 1784117000000000,
          RecentUserReads: [{ UserInfo: { Guid: 'guid-reader', DisplayName: 'Читатель' }, Timestamp: 1784117000000000 }],
        },
      }),
    );

    expect(enriched.reads.tracked).toBe(true);
    expect(enriched.reads.count).toBe(2);
    /* Вложенная форма (ось E1): актор отдельным ключом, метка на уровне receipt */
    expect(enriched.reads.recent).toEqual([
      { actor: { guid: 'guid-reader', name: 'Читатель' }, timestamp: '2026-07-15T12:03:20.000Z', timestamp_mcs: '1784117000000000' },
    ]);
    /* Метка строкой, не float */
    expect(enriched.reads.seen_by_partner_mcs).toBe('1784117000000000');
  });

  it('ReadsCount:0 при наличии ключа - всё равно tracked (0 прочтений, а не «не отслеживается»)', () => {
    const enriched = enrich(serverMessage({ siblings: { ReadsCount: 0 } }));

    /* Ключ есть -> отслеживается; count честно 0, это НЕ «не отслеживается» */
    expect(enriched.reads).toEqual({ tracked: true, count: 0 });
  });

  it('сиблингов прочтений нет -> «не отслеживается», НЕ ноль', () => {
    const enriched = enrich(serverMessage({}));

    expect(enriched.reads).toEqual({ tracked: false });
    /* Именно не отслеживается, а не count:0 */
    expect(enriched.reads.count).toBeUndefined();
  });
});

describe('mentions (§AC-6): резолв в имена или явный unresolved', () => {
  it('имя из MentionedUsers подставляется по guid из MentionedUserIds', () => {
    const enriched = enrich(
      serverMessage({
        plain: { MentionedUserIds: ['guid-x'] },
        siblings: { MentionedUsers: [{ Guid: 'guid-x', DisplayName: 'Пётр' }] },
      }),
    );

    expect(enriched.mentions).toEqual([{ guid: 'guid-x', name: 'Пётр' }]);
  });

  it('нет имени для guid -> unresolved, НЕ молча guid вместо имени', () => {
    const enriched = enrich(
      serverMessage({
        plain: { MentionedUserIds: ['guid-x', 'guid-y'] },
        siblings: { MentionedUsers: [{ Guid: 'guid-x', DisplayName: 'Пётр' }] },
      }),
    );

    expect(enriched.mentions).toEqual([
      { guid: 'guid-x', name: 'Пётр' },
      { guid: 'guid-y', unresolved: true },
    ]);
    /* guid не выдан за имя */
    expect(enriched.mentions[1]).not.toHaveProperty('name');
  });

  it('упоминаний нет -> пустой массив', () => {
    expect(enrich(serverMessage({})).mentions).toEqual([]);
  });
});

describe('forwarded (§11.2): оригинал в НОВЫЙ ключ forwarded, НЕ в context.refs', () => {
  it('ForwardedMessages -> автор/чат/дата/текст оригинала', () => {
    const original = serverMessage({
      plain: { ChatId: 'guid-src-a_guid-src-b', Text: { MessageText: 'оригинал' } },
      info: { Timestamp: 1784117000000000, From: { Guid: 'guid-author', DisplayName: 'Автор' } },
    });
    const enriched = enrich(serverMessage({ siblings: { ForwardedMessages: [original] } }));

    expect(enriched.forwarded).toEqual([
      {
        source_author: { guid: 'guid-author', name: 'Автор' },
        source_chat: 'guid-src-a_guid-src-b',
        source_date: '2026-07-15T12:03:20.000Z',
        source_date_mcs: '1784117000000000',
        source_text: 'оригинал',
        attachments: [],
      },
    ]);
  });

  it('оригинал пересылки НЕ маршрутизируется в context.refs (регресс-запрет Fork D1)', () => {
    const original = serverMessage({
      info: { Timestamp: 1784117000000000, From: { Guid: 'guid-author', DisplayName: 'Автор' } },
    });
    const enriched = enrich(serverMessage({ siblings: { ForwardedMessages: [original] } }));

    /* context остаётся v1-формой: у обычного сообщения его нет вовсе */
    expect(enriched.context).toBeUndefined();
    expect(enriched.forwarded).toHaveLength(1);
  });

  it('пересылки нет -> пустой массив', () => {
    expect(enrich(serverMessage({})).forwarded).toEqual([]);
  });
});

describe('thread (§9.1): признак треда + корень', () => {
  it('ThreadState.LastSeqNo>0 -> has_thread true', () => {
    const enriched = enrich(serverMessage({ info: { ThreadState: { LastSeqNo: 3 } } }));

    expect(enriched.thread.has_thread).toBe(true);
  });

  it('ThreadParentMessage -> has_thread true и корень нормализован', () => {
    const parent = serverMessage({
      plain: { Text: { MessageText: 'корень треда' } },
      info: { Timestamp: 1784117000000000, From: { Guid: 'guid-root', DisplayName: 'Корневой' } },
    });
    const enriched = enrich(serverMessage({ siblings: { ThreadParentMessage: parent } }));

    expect(enriched.thread.has_thread).toBe(true);
    expect(enriched.thread.root?.text).toBe('корень треда');
    expect(enriched.thread.root?.timestamp_mcs).toBe('1784117000000000');
    expect(enriched.thread.root?.from).toEqual({ guid: 'guid-root', name: 'Корневой' });
  });

  it('ThreadState.LastSeqNo:0 и нет родителя -> has_thread false, без root', () => {
    const enriched = enrich(serverMessage({ info: { ThreadState: { LastSeqNo: 0 } } }));

    expect(enriched.thread).toEqual({ has_thread: false });
  });
});

describe('reactions (ось B1): единая форма, сгруппирована по типу, акторы + actors_complete', () => {
  it('Reactions[] джойнятся с RecentUserReactions по типу; известный отрисован картой, unknown виден', () => {
    const enriched = enrich(
      serverMessage({
        siblings: {
          Reactions: [
            { Type: 100102, Count: 3 },
            { Type: 999999, Count: 1 },
          ],
          RecentUserReactions: [{ UserInfo: { Guid: 'guid-fan', DisplayName: 'Фанат' }, Type: 100102, Timestamp: 1784117000000000 }],
        },
      }),
    );

    expect(enriched.reactions).toEqual([
      {
        type: 100102,
        name: 'like-ext',
        emoji: '👍',
        count: 3,
        /* Актор несёт метку внутри (ось E1) */
        actors: [{ guid: 'guid-fan', name: 'Фанат', timestamp: '2026-07-15T12:03:20.000Z', timestamp_mcs: '1784117000000000' }],
        /* count 3 > 1 актора -> список усечён */
        actors_complete: false,
      },
      {
        type: 999999,
        name: null,
        emoji: null,
        unknown: true,
        count: 1,
        actors: [],
        /* count 1 > 0 акторов -> усечён */
        actors_complete: false,
      },
    ]);
    /* type - число (id артворка), не emoji и не кодпоинт */
    expect(enriched.reactions.every((reaction) => typeof reaction.type === 'number')).toBe(true);
  });

  it('неизвестный тип 999999 не роняет обогащение, отдаётся сырым type с unknown', () => {
    const enriched = enrich(serverMessage({ siblings: { Reactions: [{ Type: 999999, Count: 1 }] } }));

    expect(enriched.reactions[0]?.type).toBe(999999);
    expect(enriched.reactions[0]?.unknown).toBe(true);
  });

  it('actors_complete:false, когда count больше числа акторов этого типа', () => {
    const enriched = enrich(
      serverMessage({
        siblings: {
          Reactions: [{ Type: 100102, Count: 3 }],
          RecentUserReactions: [{ UserInfo: { Guid: 'guid-fan' }, Type: 100102, Timestamp: 1784117000000000 }],
        },
      }),
    );

    expect(enriched.reactions[0]?.count).toBe(3);
    expect(enriched.reactions[0]?.actors).toHaveLength(1);
    expect(enriched.reactions[0]?.actors_complete).toBe(false);
  });

  it('actors_complete:true, когда count сходится с числом акторов', () => {
    const enriched = enrich(
      serverMessage({
        siblings: {
          Reactions: [{ Type: 100102, Count: 2 }],
          RecentUserReactions: [
            { UserInfo: { Guid: 'guid-a' }, Type: 100102, Timestamp: 1784117000000000 },
            { UserInfo: { Guid: 'guid-b' }, Type: 100102, Timestamp: 1784117000000000 },
          ],
        },
      }),
    );

    expect(enriched.reactions[0]?.count).toBe(2);
    expect(enriched.reactions[0]?.actors).toHaveLength(2);
    expect(enriched.reactions[0]?.actors_complete).toBe(true);
  });

  it('реакций нет -> пустой массив', () => {
    expect(enrich(serverMessage({})).reactions).toEqual([]);
  });
});

describe('from_me и ловушка §17.13 (DropPayload срезает From)', () => {
  it('мой guid -> from_me true', () => {
    const enriched = enrich(serverMessage({ info: { From: { Guid: MY_GUID, DisplayName: 'Я' } } }));

    expect(enriched.from_me).toBe(true);
  });

  it('чужой guid -> from_me false', () => {
    expect(enrich(serverMessage({})).from_me).toBe(false);
  });

  it('From срезан (DropPayload) -> from_me null, НЕ false («не моё»)', () => {
    const dropped = serverMessage({ info: { From: undefined } });
    const enriched = enrich(dropped);

    /* Автор неопределим - но это НЕ значит «сообщение не моё» */
    expect(enriched.from_me).toBeNull();
    expect(enriched.from_me).not.toBe(false);
  });
});

describe('enrichMessages: разворот Messages[] + обогащение', () => {
  it('нормализует, обогащает и отбрасывает неадресуемое', () => {
    const messages = enrichMessages(
      [
        { ServerMessage: serverMessage({ siblings: { ReadsCount: 1 } }) },
        { ServerMessage: { ClientMessage: {} } },
        { Meta: { Origin: 27 } },
      ],
      { myGuid: MY_GUID, reactionMap: MAP },
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe('1784117592261029');
    expect(messages[0]?.reads.tracked).toBe(true);
    expect(messages[0]?.from_me).toBe(false);
  });

  it('на не-массиве отдаёт пусто, а не падает', () => {
    expect(enrichMessages(undefined, { myGuid: MY_GUID, reactionMap: MAP })).toEqual([]);
  });
});
