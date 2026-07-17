/**
 * Билдеры вариантов ClientMessage мутаций (§9.3) и защита формы: вариант уходит ВНУТРИ
 * полного конверта (рядом с LogData), плоский `push({Reaction:{...}})` не собирается.
 * Плоская форма - причина ложного NO_SUCH_CHAT (§17.12), поэтому запрет и на типах, и на форме.
 *
 * `Timestamp` целевого сообщения на проводе - ЧИСЛО (проверено живьём 2026-07-17, см. шапку
 * src/protocol/mutations.ts): билдер принимает строку мкс, но кладёт в тело `toWireTimestamp(
 * parseMicros(...))`. Прежняя строковая форма давала `BACKEND_CALL_ERROR(2)` на голосе.
 */
import { describe, expect, it } from 'vitest';
import {
  buildDeleteMutation,
  buildEditMutation,
  buildPinMutation,
  buildReactionMutation,
  buildReadMarkerMutation,
  buildVoteMutation,
  REACTION_ACTION_REMOVE,
  type MutationClientMessage,
} from '../../src/protocol/mutations.js';
import { buildPushParams } from '../../src/protocol/push.js';

const CHAT = 'bbbb-2222_aaaa-1111';
const TS = '1784287503814009';
const TS_WIRE = 1784287503814009;
const SUBSCRIPTION_ID = 'a'.repeat(40);

describe('buildReactionMutation (§9.3)', () => {
  it('постановка: ChatId, Timestamp (число мкс на проводе), Type (int), Action НЕ шлётся (ADD - дефолт)', () => {
    const message = buildReactionMutation({ chatId: CHAT, timestamp: TS, type: 100102 });
    expect(message).toEqual({ Reaction: { ChatId: CHAT, Timestamp: TS_WIRE, Type: 100102 } });
    /* Метка на проводе - число (регресс на BACKEND_CALL_ERROR(2), живая проба 2026-07-17), тип - число */
    const reaction = (message as unknown as { Reaction: { Timestamp: unknown; Type: unknown } }).Reaction;
    expect(typeof reaction.Timestamp).toBe('number');
    expect(typeof reaction.Type).toBe('number');
  });

  it('снятие: remove:true добавляет Action:REMOVE=1', () => {
    const message = buildReactionMutation({ chatId: CHAT, timestamp: TS, type: 100102, remove: true });
    expect(message).toEqual({ Reaction: { ChatId: CHAT, Timestamp: TS_WIRE, Type: 100102, Action: REACTION_ACTION_REMOVE } });
    expect(REACTION_ACTION_REMOVE).toBe(1);
  });
});

describe('buildPinMutation (§9.3, семантика доко-выведена)', () => {
  it('закреп: метка присутствует, на проводе - число', () => {
    const message = buildPinMutation({ chatId: CHAT, timestamp: TS });
    expect(message).toEqual({ Pin: { ChatId: CHAT, Timestamp: TS_WIRE } });
    const pin = (message as unknown as { Pin: { Timestamp: unknown } }).Pin;
    expect(typeof pin.Timestamp).toBe('number');
  });

  it('открепление: метки нет (пустой Pin.Timestamp)', () => {
    expect(buildPinMutation({ chatId: CHAT })).toEqual({ Pin: { ChatId: CHAT } });
  });
});

describe('buildReadMarkerMutation (§9.3, выбран SeenMarker - доко-выведено)', () => {
  it('SeenMarker с ChatId и Timestamp (число на проводе); SeqNo опционален', () => {
    const message = buildReadMarkerMutation({ chatId: CHAT, timestamp: TS });
    expect(message).toEqual({ SeenMarker: { ChatId: CHAT, Timestamp: TS_WIRE } });
    const seenMarker = (message as unknown as { SeenMarker: { Timestamp: unknown } }).SeenMarker;
    expect(typeof seenMarker.Timestamp).toBe('number');

    expect(buildReadMarkerMutation({ chatId: CHAT, timestamp: TS, seqNo: 42 })).toEqual({
      SeenMarker: { ChatId: CHAT, Timestamp: TS_WIRE, SeqNo: 42 },
    });
  });
});

describe('buildDeleteMutation (§9.3): пустой Plain с меткой', () => {
  it('удаление = Plain{ChatId, Timestamp} БЕЗ content-поля, Timestamp - число на проводе', () => {
    const message = buildDeleteMutation({ chatId: CHAT, timestamp: TS });
    expect(message).toEqual({ Plain: { ChatId: CHAT, Timestamp: TS_WIRE } });
    /* Content-поля нет - именно это отличает удаление от отправки (§9.2) */
    const plain = (message as unknown as { Plain: Record<string, unknown> }).Plain;
    expect(plain).not.toHaveProperty('Text');
    expect(typeof plain['Timestamp']).toBe('number');
  });
});

describe('buildEditMutation (§9.3): convertMessageToPlain + Timestamp', () => {
  it('правка = Plain{ChatId, Timestamp, Text:{MessageText}} с меткой целевого, Timestamp - число на проводе', () => {
    const message = buildEditMutation({ chatId: CHAT, timestamp: TS, text: 'новый' });
    expect(message).toEqual({ Plain: { ChatId: CHAT, Timestamp: TS_WIRE, Text: { MessageText: 'новый' } } });
    /* Timestamp присутствует - именно он превращает Plain из «новое сообщение» в «правка» */
    const plain = (message as unknown as { Plain: { Timestamp: unknown } }).Plain;
    expect(typeof plain.Timestamp).toBe('number');
  });
});

describe('buildVoteMutation (§9.3/§11.4, форма ПОДТВЕРЖДЕНА живьём: 2026-07-17)', () => {
  it('голос = Vote{ChatId, Timestamp, Action:0, Choices} БЕЗ Results', () => {
    const message = buildVoteMutation({ chatId: CHAT, timestamp: TS, choices: [0, 2] });
    expect(message).toEqual({ Vote: { ChatId: CHAT, Timestamp: TS_WIRE, Action: 0, Choices: [0, 2] } });
    /* Results - read-only агрегат, в исходящем голосе его быть не должно */
    const vote = (message as unknown as { Vote: Record<string, unknown> }).Vote;
    expect(vote).not.toHaveProperty('Results');
  });

  it('Choices - 0-based индексы Poll.Answers[] (проверено живьём), Timestamp - число на проводе', () => {
    const message = buildVoteMutation({ chatId: CHAT, timestamp: TS, choices: [1] });
    const vote = (message as unknown as { Vote: { Choices: unknown; Timestamp: unknown; Action: unknown } }).Vote;
    expect(vote.Choices).toEqual([1]);
    expect(vote.Action).toBe(0);
    /* Регресс: прежняя форма клала сюда строку message_id и получала BACKEND_CALL_ERROR(2) */
    expect(typeof vote.Timestamp).toBe('number');
    expect(vote.Timestamp).toBe(TS_WIRE);
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
      Reaction: { ChatId: CHAT, Timestamp: TS_WIRE, Type: 100102 },
      LogData: { YandexUid: '1234567890123456789' },
    });
  });

  it('delete/edit/vote тоже уходят ВНУТРИ ClientMessage (тот же брендированный путь)', () => {
    const del = buildPushParams({
      clientMessage: buildDeleteMutation({ chatId: CHAT, timestamp: TS }) as unknown as Record<string, unknown>,
      subscriptionId: SUBSCRIPTION_ID,
      yandexUid: '1',
      serviceId: 27,
    });
    expect(del).not.toHaveProperty('Plain');
    expect(del.ClientMessage).toMatchObject({ Plain: { ChatId: CHAT, Timestamp: TS_WIRE }, LogData: { YandexUid: '1' } });

    const vote = buildPushParams({
      clientMessage: buildVoteMutation({ chatId: CHAT, timestamp: TS, choices: [0] }) as unknown as Record<string, unknown>,
      subscriptionId: SUBSCRIPTION_ID,
      yandexUid: '1',
      serviceId: 27,
    });
    expect(vote).not.toHaveProperty('Vote');
    expect(vote.ClientMessage).toMatchObject({ Vote: { ChatId: CHAT, Timestamp: TS_WIRE, Action: 0, Choices: [0] } });
  });

  it('type-level: плоский литерал НЕ является MutationClientMessage (брендированный тип)', () => {
    /*
     * Тип-уровневая гарантия через `extends`, а НЕ через @ts-expect-error: брендированный
     * `MutationClientMessage` несёт скрытое поле-символ, которого у плоского литерала нет,
     * поэтому литерал не входит в тип и `pushMutation` его не принимает. `extends`-проверка
     * устойчива к квиркам excess-property и не зависит от того, чекает ли тулчейн тесты.
     * Если инвариант сломается, `FlatIsNotMutation` станет false и присваивание не скомпилится.
     */
    type FlatReaction = { Reaction: { ChatId: string; Timestamp: number; Type: number } };
    type FlatIsNotMutation = FlatReaction extends MutationClientMessage ? false : true;
    const flatRejected: FlatIsNotMutation = true;
    expect(flatRejected).toBe(true);
  });
});
