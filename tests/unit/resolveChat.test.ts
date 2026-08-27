import { describe, expect, it, vi } from 'vitest';
import type { RegistryHttpClient } from '../../src/transport/RegistryHttpClient.js';
import { buildPrivateChatId, isChatId, resolveChat } from '../../src/chat/resolveChat.js';

const MY_GUID = 'aaaaaaaa-1111-2222-3333-444444444444';
const PARTNER_GUID = 'bbbbbbbb-5555-6666-7777-888888888888';
const PARTNER_GUID_LESS_THAN_MY_GUID = '00000000-5555-6666-7777-888888888888';
const OTHER_GUID = 'cccccccc-9999-0000-1111-222222222222';
const GROUP_CHAT_ID = '0/0/7ba79b6d-1234-5678-9abc-def012345678';

/** Мок поиска: отдаёт заданные бакеты, форма items - как в живом захвате 2026-07-17 */
function fakeSearch(buckets: { chats?: unknown[]; users?: unknown[] }) {
  const call = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    const entity = (params['entities'] as string[])[0] as 'chats' | 'users';
    const items = buckets[entity] ?? [];
    return { [entity]: { items, total: items.length, limit: params['limit'], page: 1, pages: 1 } };
  });
  return { http: { call } as unknown as RegistryHttpClient, call };
}

function deps(buckets: { chats?: unknown[]; users?: unknown[] }) {
  const { http, call } = fakeSearch(buckets);
  return { deps: { http, myGuid: MY_GUID, searchLimit: 50 }, call };
}

const chatItem = (chatId: string, name: string) => ({ data: { chat_id: chatId, name } });
const userItem = (guid: string, displayName: string) => ({ data: { guid, display_name: displayName } });

describe('isChatId', () => {
  it('узнаёт приватный и групповой ChatId (§5)', () => {
    expect(isChatId(`${PARTNER_GUID}_${MY_GUID}`)).toBe(true);
    expect(isChatId(GROUP_CHAT_ID)).toBe(true);
  });

  it('не принимает произвольный запрос за ChatId', () => {
    expect(isChatId('Иван')).toBe(false);
    expect(isChatId(PARTNER_GUID)).toBe(false);
    expect(isChatId('')).toBe(false);
  });
});

describe('buildPrivateChatId', () => {
  /* Порядок не декоративный: перестановка даёт другую строку и другой чат (§5) */
  it('guid собеседника лексикографически больше моего -> мой guid идёт первым', () => {
    expect(buildPrivateChatId(PARTNER_GUID, MY_GUID)).toBe(`${MY_GUID}_${PARTNER_GUID}`);
  });

  it('guid собеседника лексикографически меньше моего -> его guid идёт первым', () => {
    expect(buildPrivateChatId(PARTNER_GUID_LESS_THAN_MY_GUID, MY_GUID)).toBe(
      `${PARTNER_GUID_LESS_THAN_MY_GUID}_${MY_GUID}`,
    );
  });
});

describe('resolveChat', () => {
  it('готовый ChatId возвращается как есть, без похода в сеть', async () => {
    const { deps: d, call } = deps({});

    const result = await resolveChat(`${PARTNER_GUID}_${MY_GUID}`, d);

    expect(result).toEqual({ status: 'resolved', chat_id: `${PARTNER_GUID}_${MY_GUID}`, via: 'literal' });
    expect(call).not.toHaveBeenCalled();
  });

  /* Имя доносится до вызывающего: превью send_message подтверждают по имени, не по guid */
  it('одно совпадение среди чатов -> прямой ChatId и имя чата', async () => {
    const { deps: d } = deps({ chats: [chatItem(GROUP_CHAT_ID, 'Команда')] });

    const result = await resolveChat('Команда', d);

    expect(result).toEqual({ status: 'resolved', chat_id: GROUP_CHAT_ID, via: 'chat_search', name: 'Команда' });
  });

  it('НЕСКОЛЬКО чатов -> кандидаты, БЕЗ гадания', async () => {
    const { deps: d } = deps({
      chats: [chatItem(GROUP_CHAT_ID, 'Команда А'), chatItem('0/0/aaaa1111-2222-3333-4444-555566667777', 'Команда Б')],
    });

    const result = await resolveChat('Команда', d);

    expect(result.status).toBe('ambiguous');
    if (result.status !== 'ambiguous') throw new Error('ожидались кандидаты');
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((c) => c.name)).toEqual(['Команда А', 'Команда Б']);
    expect(result.candidates.every((c) => c.via === 'chat_search')).toBe(true);
  });

  it('чатов нет, один пользователь -> приватный ChatId из отсортированной пары guid', async () => {
    const { deps: d } = deps({ chats: [], users: [userItem(PARTNER_GUID, 'Иван')] });

    const result = await resolveChat('Иван', d);

    expect(result).toEqual({
      status: 'resolved',
      chat_id: `${MY_GUID}_${PARTNER_GUID}`,
      via: 'user_search',
      name: 'Иван',
    });
  });

  it('НЕСКОЛЬКО пользователей -> кандидаты с готовыми ChatId', async () => {
    const { deps: d } = deps({ chats: [], users: [userItem(PARTNER_GUID, 'Иван П'), userItem(OTHER_GUID, 'Иван С')] });

    const result = await resolveChat('Иван', d);

    expect(result.status).toBe('ambiguous');
    if (result.status !== 'ambiguous') throw new Error('ожидались кандидаты');
    expect(result.candidates.map((c) => c.chat_id)).toEqual([
      `${MY_GUID}_${PARTNER_GUID}`,
      `${MY_GUID}_${OTHER_GUID}`,
    ]);
    expect(result.candidates.every((c) => c.kind === 'private')).toBe(true);
  });

  it('к пользователям идёт только если среди чатов пусто', async () => {
    const { deps: d, call } = deps({ chats: [chatItem(GROUP_CHAT_ID, 'Команда')], users: [userItem(PARTNER_GUID, 'Х')] });

    await resolveChat('Команда', d);

    expect(call).toHaveBeenCalledTimes(1);
    expect((call.mock.calls[0]?.[1] as Record<string, unknown>)['entities']).toEqual(['chats']);
  });

  it('я сам себе не кандидат: свой guid отфильтрован', async () => {
    const { deps: d } = deps({ chats: [], users: [userItem(MY_GUID, 'Я')] });

    expect(await resolveChat('Я', d)).toEqual({ status: 'not_found' });
  });

  it('ничего не нашлось -> not_found', async () => {
    const { deps: d } = deps({ chats: [], users: [] });

    expect(await resolveChat('кого-нет', d)).toEqual({ status: 'not_found' });
  });

  it('пустой запрос -> not_found, без сети', async () => {
    const { deps: d, call } = deps({});

    expect(await resolveChat('   ', d)).toEqual({ status: 'not_found' });
    expect(call).not.toHaveBeenCalled();
  });

  it('элементы без идентификатора не превращаются в кандидатов', async () => {
    const { deps: d } = deps({ chats: [{ data: { name: 'без id' } }], users: [{ data: { display_name: 'без guid' } }] });

    expect(await resolveChat('что-то', d)).toEqual({ status: 'not_found' });
  });
});
