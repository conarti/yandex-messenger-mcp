/**
 * Разбор join-ссылки (§17.11): хвост = Timestamp (BigInt, не float), hash = invite_hash,
 * резолв чата через get_chats_info {invite_hash} без CSRF.
 *
 * 2-сегментная ссылка резолвится ПОЛНОСТЬЮ; 3-сегментная (сообщение в треде) - распознаётся,
 * но деривация thread_id остаётся на Phase 4. Фикстуры синтетические, сети нет.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  JoinLinkParseError,
  LinkChatNotFoundError,
  parseJoinLink,
  resolveLink,
} from '../../src/chat/resolveLink.js';

const CHAT_ID = '0/0/11111111-1111-1111-1111-111111111111';
/** 16-значная метка: у границы 2^53 parseInt/Number потеряли бы разряд - тут проверяем BigInt */
const TAIL = '1784287503814009';

function fakeHttp(response: unknown): { http: { call: ReturnType<typeof vi.fn> } } {
  return { http: { call: vi.fn(async () => response as never) } };
}

describe('parseJoinLink: сегменты, decodeURIComponent, BigInt-хвост', () => {
  it('2-сегментная ссылка: invite_hash + Timestamp хвостом', () => {
    const parsed = parseJoinLink(`https://yandex.ru/chat#/join/abc-hash/${TAIL}`);
    expect(parsed).toEqual({ invite_hash: 'abc-hash', timestamp: TAIL, segments: 2 });
  });

  it('3-сегментная ссылка (сообщение в треде) распознаётся: 3 сегмента, оба Timestamp', () => {
    const parsed = parseJoinLink(`https://yandex.ru/chat#/join/abc-hash/${TAIL}/1784288000000000`);
    expect(parsed?.segments).toBe(3);
    expect(parsed?.invite_hash).toBe('abc-hash');
    expect(parsed?.timestamp).toBe(TAIL);
    expect(parsed?.thread_message_timestamp).toBe('1784288000000000');
  });

  it('каждый сегмент прогоняется через decodeURIComponent', () => {
    const parsed = parseJoinLink(`https://yandex.ru/chat#/join/hash%2Fwith%2Fslash/${TAIL}`);
    expect(parsed?.invite_hash).toBe('hash/with/slash');
  });

  it('хвост разбирается как BigInt, точность 16-значной метки не теряется', () => {
    /* 9007199254740993 = 2^53+1: в double неотличимо от 2^53, строкой обязано дожить как есть */
    const parsed = parseJoinLink('https://yandex.ru/chat#/join/h/9007199254740993');
    expect(parsed?.timestamp).toBe('9007199254740993');
  });

  it('query и fragment после метки не утекают в сегмент', () => {
    const parsed = parseJoinLink(`https://yandex.ru/chat#/join/h/${TAIL}?utm=x`);
    expect(parsed?.timestamp).toBe(TAIL);
    expect(parsed?.segments).toBe(2);
  });

  it('не join-ссылка -> undefined (не ошибка): вызывающий отличит «не ссылка» от «битая»', () => {
    expect(parseJoinLink('https://yandex.ru/chat#/some/other/path')).toBeUndefined();
  });

  it('битая ссылка (нет метки / лишние сегменты) -> JoinLinkParseError', () => {
    expect(() => parseJoinLink('https://x/join/only-hash')).toThrow(JoinLinkParseError);
    expect(() => parseJoinLink('https://x/join/h/not-a-number')).toThrow(JoinLinkParseError);
    expect(() => parseJoinLink('https://x/join/h/1/2/3/4')).toThrow(JoinLinkParseError);
  });
});

describe('resolveLink: 2-сегментная резолвится полностью, get_chats_info без CSRF', () => {
  it('резолвит invite_hash в chat_id и отдаёт метку сообщения', async () => {
    const deps = fakeHttp({ chats: [{ chat_id: CHAT_ID, name: 'Команда' }] });

    const resolved = await resolveLink(deps, `https://yandex.ru/chat#/join/abc-hash/${TAIL}`);

    expect(resolved).toEqual({ chat_id: CHAT_ID, timestamp: TAIL, invite_hash: 'abc-hash' });
    /* Резолв идёт строго через get_chats_info {invite_hash} - один из трёх допустимых ключей */
    expect(deps.http.call).toHaveBeenCalledWith('get_chats_info', { invite_hash: 'abc-hash' });
  });

  it('поддерживает PascalCase ChatId в ответе get_chats_info', async () => {
    const deps = fakeHttp({ chats: [{ ChatId: CHAT_ID }] });
    const resolved = await resolveLink(deps, `https://x/join/h/${TAIL}`);
    expect(resolved.chat_id).toBe(CHAT_ID);
  });

  it('нет чата в ответе -> LinkChatNotFoundError', async () => {
    const deps = fakeHttp({ chats: [] });
    await expect(resolveLink(deps, `https://x/join/h/${TAIL}`)).rejects.toThrow(LinkChatNotFoundError);
  });
});

describe('resolveLink: 3-сегментная - чат резолвится, thread_id деривируется (Phase 4)', () => {
  it('возвращает parent chat_id и цель треда с деривированным thread_id', async () => {
    const deps = fakeHttp({ chats: [{ chat_id: CHAT_ID }] });

    const resolved = await resolveLink(deps, `https://x/join/abc-hash/${TAIL}/1784288000000000`);

    expect(resolved.chat_id).toBe(CHAT_ID);
    expect(resolved.timestamp).toBe(TAIL);
    if (resolved.thread?.status !== 'resolved') throw new Error('ожидался resolved thread');
    /* thread_id = `10<prefix>/<ns>/<rest>_<parent_ts>` (§17.10, radix 10) */
    expect(resolved.thread.thread_id).toBe(`100/0/11111111-1111-1111-1111-111111111111_${TAIL}`);
    expect(resolved.thread.message_timestamp).toBe('1784288000000000');
  });

  it('бизнес-чат (префикс 2) -> thread unsupported, а не тихий отказ', async () => {
    const businessChat = '2/1234/11111111-1111-1111-1111-111111111111';
    const deps = fakeHttp({ chats: [{ chat_id: businessChat }] });

    const resolved = await resolveLink(deps, `https://x/join/abc-hash/${TAIL}/1784288000000000`);

    if (resolved.thread?.status !== 'unsupported') throw new Error('ожидался unsupported thread');
    expect(resolved.thread.reason).toMatch(/недоступен/);
    expect(resolved.thread.message_timestamp).toBe('1784288000000000');
  });
});
