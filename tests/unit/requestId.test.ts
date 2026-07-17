import { describe, expect, it } from 'vitest';
import { createRequestId } from '../../src/transport/ws/requestId.js';

describe('createRequestId', () => {
  /* §14.8 пишет «26 hex», но в её же шаблоне xxxxxxxx-xxxx-xxxx-xxxxxxxx их 24: шаблон первичен */
  it('даёт форму 8-4-4-8: 24 hex и 3 дефиса', () => {
    const id = createRequestId();

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{8}$/);
    expect(id).toHaveLength(27);
  });

  it('НЕ канонический uuid v4: групп четыре, version/variant-нибблов нет', () => {
    const ids = Array.from({ length: 200 }, createRequestId);

    expect(ids.every((id) => id.split('-').length === 4)).toBe(true);
    /* У uuid v4 третья группа всегда начинается с 4, а четвёртая - с 8/9/a/b */
    expect(ids.every((id) => id.split('-')[2]?.startsWith('4'))).toBe(false);
  });

  it('не повторяется', () => {
    const ids = new Set(Array.from({ length: 1000 }, createRequestId));

    expect(ids.size).toBe(1000);
  });
});
