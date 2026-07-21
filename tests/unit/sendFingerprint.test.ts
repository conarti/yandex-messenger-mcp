/**
 * Сериализация нагрузки send-пути (§6.1) и валидация её алфавита.
 *
 * Отпечаток покрывает РОВНО четыре вещи: guid, reply_to, forward_from, text. Инъективность
 * разбора держится на алфавите первых трёх полей, поэтому кейс валидации пишется АТАКУЮЩЕЙ
 * парой из §6.1, а НЕ корректными guid: тест на корректных данных остался бы зелёным и на
 * невалидирующей реализации поверх эксплуатируемой коллизии (см. сценарий 3 пре-мортема).
 */
import { describe, expect, it } from 'vitest';
import { buildSendPayload, sendFingerprint } from '../../src/mcp/tools/sendMessage.js';
import { ConfirmRejectedError } from '../../src/mcp/confirm.js';

const G1 = 'dddddddd-1111-2222-3333-444444444444';
const G2 = 'eeeeeeee-5555-6666-7777-888888888888';

describe('buildSendPayload: сериализация §6.1 дословно', () => {
  it('payload = guids.join(",") + \\n + reply + \\n + forward + \\n + text', () => {
    expect(buildSendPayload({ guids: [G1, G2], replyToMessageId: '100', forwardFrom: '200', text: 'привет' })).toBe(
      `${G1},${G2}\n100\n200\nпривет`,
    );
  });

  it('пустые поля дают пустую строку, разделители НЕ схлопываются', () => {
    /* Нет упоминаний, нет reply, нет forward: три ведущих \n на месте, иначе «нет reply» и «нет forward» неразличимы */
    expect(buildSendPayload({ guids: [], text: 'привет' })).toBe('\n\n\nпривет');
  });

  it('в отпечаток входят только guid: у функции нет параметра name/цитаты (§6.1 правило 1, §6.2)', () => {
    /* Четыре поля §6.1 и ничего больше: цитата приходит с сервера на confirm и в payload не попадает */
    expect(buildSendPayload({ guids: [G1], text: 't' })).toBe(`${G1}\n\n\nt`);
  });

  it('порядок guid значим: перестановка меняет payload и отпечаток (сортировка запрещена)', () => {
    expect(buildSendPayload({ guids: [G1, G2], text: 't' })).not.toBe(buildSendPayload({ guids: [G2, G1], text: 't' }));
    expect(sendFingerprint({ guids: [G1, G2], text: 't' })).not.toBe(sendFingerprint({ guids: [G2, G1], text: 't' }));
  });

  it('смена reply_to_message_id меняет отпечаток', () => {
    expect(sendFingerprint({ guids: [G1], replyToMessageId: '100', text: 't' })).not.toBe(
      sendFingerprint({ guids: [G1], replyToMessageId: '101', text: 't' }),
    );
  });

  it('тот же вход - стабильный отпечаток', () => {
    expect(sendFingerprint({ guids: [G1], text: 't' })).toBe(sendFingerprint({ guids: [G1], text: 't' }));
  });
});

describe('buildSendPayload: валидация алфавита - атакующая пара §6.1', () => {
  it('A(draft, guids=[]) собирается; B(confirm, guid c \\n) отвергается malformed_guid ДО отпечатка', () => {
    /*
     * A и B дают ОДИНАКОВЫЙ payload (шесть \n затем Y). Без валидации отпечатки совпали бы,
     * и одобренный текст "\n\n\nY" без упоминаний уехал бы как "Y" с мусорными MentionedUserIds
     * на пути, где push не ретраится. Валидация делает B недостижимым.
     */
    const a = buildSendPayload({ guids: [], text: '\n\n\nY' });
    expect(a).toBe('\n\n\n\n\n\nY');

    expect(() => buildSendPayload({ guids: ['\n\n\n'], text: 'Y' })).toThrow(ConfirmRejectedError);
    expect(() => buildSendPayload({ guids: ['\n\n\n'], text: 'Y' })).toThrow(/malformed_guid/);
    /* sendFingerprint не доходит до fingerprint: коллизия недостижима */
    expect(() => sendFingerprint({ guids: ['\n\n\n'], text: 'Y' })).toThrow(/malformed_guid/);
  });

  it('guid длиной 36, но содержащий \\n или запятую, отвергается (алфавит, не длина)', () => {
    const withNewline = 'dddddddd-1111-2222-3333-4444444444\n4';
    expect(withNewline).toHaveLength(36);
    expect(() => buildSendPayload({ guids: [withNewline], text: 't' })).toThrow(/malformed_guid/);

    const withComma = `${G1.slice(0, 34)},x`;
    expect(withComma).toHaveLength(36);
    expect(() => buildSendPayload({ guids: [withComma], text: 't' })).toThrow(/malformed_guid/);
  });

  it('корректные guid проходят валидацию и попадают в отпечаток', () => {
    expect(() => sendFingerprint({ guids: [G1, G2], text: 't' })).not.toThrow();
  });
});
