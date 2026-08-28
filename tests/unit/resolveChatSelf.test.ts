/**
 * Ветка self-чата («Избранное») в общем резолвере (GAP, Phase 8, AC-30).
 *
 * Гейт спайка 5: `ChatId === <myGuid>_<myGuid>` + `PrivateChatInfo` + `PartnerInfo.Guid === myGuid`.
 *
 * ГЛАВНОЕ УТВЕРЖДЕНИЕ: ветка self НЕ меняет резолв не-self чатов. Существующий
 * `resolveChat.test.ts` остаётся неотредактированным; здесь проверяется, что тот же не-self
 * вход даёт тот же выход, что в v1, а self-элемент резолвится в канонический `<myGuid>_<myGuid>`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RegistryHttpClient } from '../../src/transport/RegistryHttpClient.js';
import { resolveChat } from '../../src/chat/resolveChat.js';

const MY_GUID = 'aaaaaaaa-1111-2222-3333-444444444444';
const PARTNER_GUID = 'bbbbbbbb-5555-6666-7777-888888888888';
const GROUP_CHAT_ID = '0/0/7ba79b6d-1234-5678-9abc-def012345678';
const SELF_CHAT_ID = `${MY_GUID}_${MY_GUID}`;

/** Мок поиска: тот же контракт, что в resolveChat.test.ts (бакет по entities[0]) */
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

describe('ветка self НЕ меняет резолв не-self чатов', () => {
  it('готовый не-self ChatId - тот же выход, что в v1 (literal, без сети)', async () => {
    const { deps: d, call } = deps({});

    expect(await resolveChat(`${PARTNER_GUID}_${MY_GUID}`, d)).toEqual({
      status: 'resolved',
      chat_id: `${PARTNER_GUID}_${MY_GUID}`,
      via: 'literal',
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('одно совпадение среди чатов (группа) - тот же выход, что в v1', async () => {
    const { deps: d } = deps({ chats: [chatItem(GROUP_CHAT_ID, 'Команда')] });

    expect(await resolveChat('Команда', d)).toEqual({
      status: 'resolved',
      chat_id: GROUP_CHAT_ID,
      via: 'chat_search',
      name: 'Команда',
    });
  });

  it('один пользователь (не я) - тот же приватный ChatId из отсортированной пары, что в v1', async () => {
    const { deps: d } = deps({ chats: [], users: [userItem(PARTNER_GUID, 'Иван')] });

    expect(await resolveChat('Иван', d)).toEqual({
      status: 'resolved',
      chat_id: `${MY_GUID}_${PARTNER_GUID}`,
      via: 'user_search',
      name: 'Иван',
    });
  });

  it('свой guid в бакете users по-прежнему отфильтрован -> not_found (user-путь не тронут)', async () => {
    const { deps: d } = deps({ chats: [], users: [userItem(MY_GUID, 'Я')] });

    /* Голый user-результат без гейта self-чата - не сигнал: инвариант v1 держится */
    expect(await resolveChat('Я', d)).toEqual({ status: 'not_found' });
  });
});

describe('ветка self-чата резолвит «Избранное» в <myGuid>_<myGuid>', () => {
  it('гейт спайка 5 (PrivateChatInfo + PartnerInfo.Guid === myGuid) без chat_id в выдаче', async () => {
    const { deps: d } = deps({
      chats: [{ data: { name: 'Избранное', PrivateChatInfo: {}, PartnerInfo: { Guid: MY_GUID } } }],
    });

    expect(await resolveChat('Избранное', d)).toEqual({
      status: 'resolved',
      chat_id: SELF_CHAT_ID,
      via: 'chat_search',
      name: 'Избранное',
    });
  });

  it('self-чат по паре одинаковых guid в chat_id', async () => {
    const { deps: d } = deps({ chats: [chatItem(SELF_CHAT_ID, 'Избранное')] });

    expect(await resolveChat('Избранное', d)).toEqual({
      status: 'resolved',
      chat_id: SELF_CHAT_ID,
      via: 'chat_search',
      name: 'Избранное',
    });
  });

  it('готовый self ChatId - literal, без сети', async () => {
    const { deps: d, call } = deps({});

    expect(await resolveChat(SELF_CHAT_ID, d)).toEqual({
      status: 'resolved',
      chat_id: SELF_CHAT_ID,
      via: 'literal',
    });
    expect(call).not.toHaveBeenCalled();
  });
});
