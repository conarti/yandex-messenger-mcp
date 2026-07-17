/**
 * Билдеры вариантов ClientMessage мутаций (§9.3) и защита формы: вариант уходит ВНУТРИ
 * полного конверта (рядом с LogData), плоский `push({Reaction:{...}})` не собирается.
 * Плоская форма - причина ложного NO_SUCH_CHAT (§17.12), поэтому запрет и на типах, и на форме.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPinMutation,
  buildReactionMutation,
  buildReadMarkerMutation,
  REACTION_ACTION_REMOVE,
  type MutationClientMessage,
} from '../../src/protocol/mutations.js';
import { buildPushParams } from '../../src/protocol/push.js';

const CHAT = 'bbbb-2222_aaaa-1111';
const TS = '1784287503814009';
const SUBSCRIPTION_ID = 'a'.repeat(40);

describe('buildReactionMutation (§9.3)', () => {
  it('постановка: ChatId, Timestamp (строка мкс), Type (int), Action НЕ шлётся (ADD - дефолт)', () => {
    const message = buildReactionMutation({ chatId: CHAT, timestamp: TS, type: 100102 });
    expect(message).toEqual({ Reaction: { ChatId: CHAT, Timestamp: TS, Type: 100102 } });
    /* Метка - строка, тип - число: точность метки и int-семантика Type */
    const reaction = (message as unknown as { Reaction: { Timestamp: unknown; Type: unknown } }).Reaction;
    expect(typeof reaction.Timestamp).toBe('string');
    expect(typeof reaction.Type).toBe('number');
  });

  it('снятие: remove:true добавляет Action:REMOVE=1', () => {
    const message = buildReactionMutation({ chatId: CHAT, timestamp: TS, type: 100102, remove: true });
    expect(message).toEqual({ Reaction: { ChatId: CHAT, Timestamp: TS, Type: 100102, Action: REACTION_ACTION_REMOVE } });
    expect(REACTION_ACTION_REMOVE).toBe(1);
  });
});

describe('buildPinMutation (§9.3, семантика доко-выведена)', () => {
  it('закреп: метка присутствует', () => {
    expect(buildPinMutation({ chatId: CHAT, timestamp: TS })).toEqual({ Pin: { ChatId: CHAT, Timestamp: TS } });
  });

  it('открепление: метки нет (пустой Pin.Timestamp)', () => {
    expect(buildPinMutation({ chatId: CHAT })).toEqual({ Pin: { ChatId: CHAT } });
  });
});

describe('buildReadMarkerMutation (§9.3, выбран SeenMarker - доко-выведено)', () => {
  it('SeenMarker с ChatId и Timestamp; SeqNo опционален', () => {
    expect(buildReadMarkerMutation({ chatId: CHAT, timestamp: TS })).toEqual({
      SeenMarker: { ChatId: CHAT, Timestamp: TS },
    });
    expect(buildReadMarkerMutation({ chatId: CHAT, timestamp: TS, seqNo: 42 })).toEqual({
      SeenMarker: { ChatId: CHAT, Timestamp: TS, SeqNo: 42 },
    });
  });
});

describe('форма запроса: вариант уходит ВНУТРИ ClientMessage, не плоско', () => {
  it('через buildPushParams вариант оказывается в ClientMessage рядом с LogData, а НЕ top-level', () => {
    const params = buildPushParams({
      /* pushMutation снимает бренд к Record этим же cast'ом - тут воспроизводим ту же границу */
      clientMessage: buildReactionMutation({ chatId: CHAT, timestamp: TS, type: 100102 }) as unknown as Record<
        string,
        unknown
      >,
      subscriptionId: SUBSCRIPTION_ID,
      yandexUid: '1234567890123456789',
      serviceId: 27,
    });
    /* Плоская форма исключена: на верхнем уровне params нет Reaction */
    expect(params).not.toHaveProperty('Reaction');
    expect(params.ClientMessage).toMatchObject({
      Reaction: { ChatId: CHAT, Timestamp: TS, Type: 100102 },
      LogData: { YandexUid: '1234567890123456789' },
    });
  });

  it('type-level: плоский литерал НЕ является MutationClientMessage (брендированный тип)', () => {
    /*
     * Тип-уровневая гарантия через `extends`, а НЕ через @ts-expect-error: брендированный
     * `MutationClientMessage` несёт скрытое поле-символ, которого у плоского литерала нет,
     * поэтому литерал не входит в тип и `pushMutation` его не принимает. `extends`-проверка
     * устойчива к квиркам excess-property и не зависит от того, чекает ли тулчейн тесты.
     * Если инвариант сломается, `FlatIsNotMutation` станет false и присваивание не скомпилится.
     */
    type FlatReaction = { Reaction: { ChatId: string; Timestamp: string; Type: number } };
    type FlatIsNotMutation = FlatReaction extends MutationClientMessage ? false : true;
    const flatRejected: FlatIsNotMutation = true;
    expect(flatRejected).toBe(true);
  });
});
