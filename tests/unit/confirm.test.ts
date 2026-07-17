/**
 * Общий confirm-токен (Fork B1). Главное утверждение фазы: токен НЕСЁТ операцию, и
 * кросс-op replay отвергается ДО сверки чата/отпечатка - это не проверка членства в
 * множестве инструментов, а сверка поля `op` внутри самого токена.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfirmRejectedError,
  decodeToken,
  encodeToken,
  fingerprint,
  recallResult,
  rememberResult,
  resetConfirmMemory,
  verifyConfirmToken,
  type DraftToken,
} from '../../src/mcp/confirm.js';

const CHAT = 'bbbb-2222_aaaa-1111';
const OTHER_CHAT = 'cccc-3333_aaaa-1111';

afterEach(() => {
  resetConfirmMemory();
});

describe('encodeToken / decodeToken', () => {
  it('round-trip сохраняет op, chat_id, fingerprint и payload_id', () => {
    const token: DraftToken = { op: 'send', chat_id: CHAT, fingerprint: fingerprint('send', 'hi'), payload_id: 'p1' };
    expect(decodeToken(encodeToken(token))).toEqual(token);
  });

  it('токен target-пути без payload_id тоже разбирается (delete/edit/vote)', () => {
    const token: DraftToken = { op: 'delete', chat_id: CHAT, fingerprint: fingerprint('delete', `${CHAT}:100`) };
    const decoded = decodeToken(encodeToken(token));
    expect(decoded).toEqual(token);
    expect(decoded?.payload_id).toBeUndefined();
  });

  it('мусор и токен без обязательных полей -> undefined, а не исключение', () => {
    expect(decodeToken('не-base64url-и-не-json')).toBeUndefined();
    expect(decodeToken(Buffer.from(JSON.stringify({ chat_id: CHAT }), 'utf8').toString('base64url'))).toBeUndefined();
    expect(
      decodeToken(Buffer.from(JSON.stringify({ op: 'send', fingerprint: 'x' }), 'utf8').toString('base64url')),
    ).toBeUndefined();
  });
});

describe('fingerprint домен-сепарирован операцией', () => {
  it('одинаковая нагрузка при разных op даёт РАЗНЫЙ отпечаток', () => {
    expect(fingerprint('send', 'hello')).not.toBe(fingerprint('delete', 'hello'));
    expect(fingerprint('edit', 'hello')).not.toBe(fingerprint('vote', 'hello'));
  });

  it('тот же op и та же нагрузка - стабильный отпечаток', () => {
    expect(fingerprint('send', 'hello')).toBe(fingerprint('send', 'hello'));
  });
});

describe('verifyConfirmToken: кросс-op replay', () => {
  it('токен op=send, предъявленный как delete, отвергается op_mismatch - ДАЖЕ при совпадении чата', () => {
    /* Чат совпадает, но операция другая: replay токена одной мутации на другую */
    const token = encodeToken({ op: 'send', chat_id: CHAT, fingerprint: fingerprint('send', 'x'), payload_id: 'p1' });

    expect(() =>
      verifyConfirmToken({ op: 'delete', token, chatId: CHAT, fingerprint: fingerprint('delete', `${CHAT}:100`) }),
    ).toThrow(/op_mismatch/);
  });

  it('op сверяется РАНЬШЕ чата: несовпадение op не маскируется под chat_mismatch', () => {
    const token = encodeToken({ op: 'vote', chat_id: CHAT, fingerprint: fingerprint('vote', 'x') });
    try {
      /* И op, и чат расходятся - причина обязана быть op_mismatch, а не chat_mismatch */
      verifyConfirmToken({ op: 'edit', token, chatId: OTHER_CHAT, fingerprint: fingerprint('edit', 'x') });
      throw new Error('ожидался отказ');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfirmRejectedError);
      expect((error as ConfirmRejectedError).reason).toBe('op_mismatch');
    }
  });
});

describe('verifyConfirmToken: сверка чата и отпечатка', () => {
  it('совпадение op+chat+fingerprint -> возвращает разобранный токен', () => {
    const token = encodeToken({ op: 'send', chat_id: CHAT, fingerprint: fingerprint('send', 'x'), payload_id: 'p1' });
    const draft = verifyConfirmToken({ op: 'send', token, chatId: CHAT, fingerprint: fingerprint('send', 'x') });
    expect(draft).toMatchObject({ op: 'send', chat_id: CHAT, payload_id: 'p1' });
  });

  it('чат резолвится в другой -> chat_mismatch', () => {
    const token = encodeToken({ op: 'send', chat_id: CHAT, fingerprint: fingerprint('send', 'x'), payload_id: 'p1' });
    expect(() =>
      verifyConfirmToken({ op: 'send', token, chatId: OTHER_CHAT, fingerprint: fingerprint('send', 'x') }),
    ).toThrow(/chat_mismatch/);
  });

  it('нагрузка отличается -> причина по умолчанию fingerprint_mismatch', () => {
    const token = encodeToken({ op: 'delete', chat_id: CHAT, fingerprint: fingerprint('delete', `${CHAT}:100`) });
    expect(() =>
      verifyConfirmToken({ op: 'delete', token, chatId: CHAT, fingerprint: fingerprint('delete', `${CHAT}:200`) }),
    ).toThrow(/fingerprint_mismatch/);
  });

  it('fingerprintMismatchReason переопределяет причину (send-путь зовёт её text_mismatch)', () => {
    const token = encodeToken({ op: 'send', chat_id: CHAT, fingerprint: fingerprint('send', 'x'), payload_id: 'p1' });
    expect(() =>
      verifyConfirmToken({
        op: 'send',
        token,
        chatId: CHAT,
        fingerprint: fingerprint('send', 'y'),
        fingerprintMismatchReason: 'text_mismatch',
      }),
    ).toThrow(/text_mismatch/);
  });

  it('токен отсутствует -> token_missing; битый -> token_malformed', () => {
    expect(() => verifyConfirmToken({ op: 'send', token: undefined, chatId: CHAT, fingerprint: 'f' })).toThrow(
      /token_missing/,
    );
    expect(() => verifyConfirmToken({ op: 'send', token: '', chatId: CHAT, fingerprint: 'f' })).toThrow(/token_missing/);
    expect(() => verifyConfirmToken({ op: 'send', token: 'битый', chatId: CHAT, fingerprint: 'f' })).toThrow(
      /token_malformed/,
    );
  });
});

describe('память израсходованных токенов', () => {
  it('rememberResult/recallResult отдаёт запомненный результат по токену', () => {
    rememberResult('tok', { status: 'sent', n: 1 });
    expect(recallResult('tok')).toEqual({ status: 'sent', n: 1 });
    expect(recallResult('нет-такого')).toBeUndefined();
  });

  it('resetConfirmMemory очищает всё', () => {
    rememberResult('tok', { a: 1 });
    resetConfirmMemory();
    expect(recallResult('tok')).toBeUndefined();
  });

  it('память ограничена сверху: старейшие вытесняются, свежие живут', () => {
    for (let i = 0; i < 150; i += 1) {
      rememberResult(`tok-${i}`, i);
    }
    /* Первые записи вытеснены, последние на месте: это защита от повтора в пределах сессии, не журнал */
    expect(recallResult('tok-0')).toBeUndefined();
    expect(recallResult('tok-149')).toBe(149);
  });
});
