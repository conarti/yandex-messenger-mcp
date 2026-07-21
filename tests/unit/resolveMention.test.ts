/**
 * Резолв упоминания `@Имя | @<guid> | Имя` -> guid участника (§AC-2/AC-3).
 *
 * Главные утверждения: неоднозначность отказывает со списком (не гадает); `@<guid>` -
 * литерал без похода в поиск; приватный чат проверяет принадлежность бесплатно (строкой),
 * групповой - НЕ проверяет (заявленное ограничение, не баг).
 */
import { describe, expect, it, vi } from 'vitest';
import type { RegistryHttpClient } from '../../src/transport/RegistryHttpClient.js';
import { resolveMention } from '../../src/chat/resolveMention.js';

const MY_GUID = 'aaaaaaaa-1111-2222-3333-444444444444';
const PARTNER_GUID = 'bbbbbbbb-5555-6666-7777-888888888888';
const OTHER_GUID = 'cccccccc-9999-0000-1111-222222222222';
const PRIVATE_CHAT_ID = `${PARTNER_GUID}_${MY_GUID}`;
const GROUP_CHAT_ID = '0/0/7ba79b6d-1234-5678-9abc-def012345678';

/** Мок поиска: users-бакет как в живом захвате 2026-07-17 */
function fakeSearch(users: unknown[]) {
  const call = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    const entity = (params['entities'] as string[])[0] as string;
    const items = entity === 'users' ? users : [];
    return { [entity]: { items, total: items.length, limit: params['limit'], page: 1, pages: 1 } };
  });
  return { http: { call } as unknown as RegistryHttpClient, call };
}

function deps(users: unknown[], chatId = GROUP_CHAT_ID) {
  const { http, call } = fakeSearch(users);
  return { deps: { http, chatId, searchLimit: 50 }, call };
}

const userItem = (guid: string, displayName: string) => ({ data: { guid, display_name: displayName } });

describe('resolveMention: резолв и неоднозначность', () => {
  it('один кандидат -> resolved с guid и именем', async () => {
    const { deps: d } = deps([userItem(OTHER_GUID, 'Иван')]);

    expect(await resolveMention('Иван', d)).toEqual({ status: 'resolved', guid: OTHER_GUID, name: 'Иван' });
  });

  it('несколько кандидатов -> ambiguous со списком, БЕЗ гадания', async () => {
    const { deps: d } = deps([userItem(PARTNER_GUID, 'Иван П'), userItem(OTHER_GUID, 'Иван С')]);

    const result = await resolveMention('Иван', d);

    expect(result.status).toBe('ambiguous');
    if (result.status !== 'ambiguous') throw new Error('ожидались кандидаты');
    expect(result.candidates).toEqual([
      { guid: PARTNER_GUID, name: 'Иван П' },
      { guid: OTHER_GUID, name: 'Иван С' },
    ]);
  });

  it('ноль кандидатов -> not_found, не «отправим текстом»', async () => {
    const { deps: d } = deps([]);

    expect(await resolveMention('никого', d)).toEqual({ status: 'not_found' });
  });

  it('пустой запрос -> not_found, без сети', async () => {
    const { deps: d, call } = deps([]);

    expect(await resolveMention('   ', d)).toEqual({ status: 'not_found' });
    expect(call).not.toHaveBeenCalled();
  });

  it('@<guid> резолвится литералом без похода в поиск', async () => {
    const { deps: d, call } = deps([], PRIVATE_CHAT_ID);

    expect(await resolveMention(`@${PARTNER_GUID}`, d)).toEqual({ status: 'resolved', guid: PARTNER_GUID });
    expect(call).not.toHaveBeenCalled();
  });

  it('дубли по guid схлопываются с сохранением первого вхождения (один guid дважды -> resolved)', async () => {
    const { deps: d } = deps([userItem(OTHER_GUID, 'Первое имя'), userItem(OTHER_GUID, 'Второе имя')]);

    /* После схлопывания остаётся один кандидат -> resolved, а не ambiguous; имя - от первого */
    expect(await resolveMention('Иван', d)).toEqual({ status: 'resolved', guid: OTHER_GUID, name: 'Первое имя' });
  });
});

describe('resolveMention: проверка принадлежности чату (сценарий 2)', () => {
  it('приватный чат: guid ВНЕ половин chat_id -> not_in_chat, ноль запросов сверх поиска', async () => {
    const { deps: d } = deps([userItem(OTHER_GUID, 'Чужой')], PRIVATE_CHAT_ID);

    /* OTHER_GUID не входит в PARTNER_GUID_MY_GUID -> not_in_chat */
    expect(await resolveMention('Чужой', d)).toEqual({ status: 'not_in_chat', guid: OTHER_GUID });
  });

  it('приватный чат: guid, совпадающий с половиной chat_id -> resolved', async () => {
    const { deps: d } = deps([userItem(PARTNER_GUID, 'Собеседник')], PRIVATE_CHAT_ID);

    expect(await resolveMention('Собеседник', d)).toEqual({ status: 'resolved', guid: PARTNER_GUID, name: 'Собеседник' });
  });

  it('групповой чат: проверки принадлежности НЕТ - резолв проходит (заявленное ограничение)', async () => {
    const { deps: d } = deps([userItem(OTHER_GUID, 'Кто угодно')], GROUP_CHAT_ID);

    /* Для группового дешёвой проверки участников нет: любой резолвнутый guid проходит */
    expect(await resolveMention('Кто угодно', d)).toEqual({ status: 'resolved', guid: OTHER_GUID, name: 'Кто угодно' });
  });
});
