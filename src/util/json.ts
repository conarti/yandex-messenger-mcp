/**
 * Гварды для разбора недоверенного JSON с провода.
 *
 * Живут в одном месте, потому что каждый парсер протокола делает ровно эти три проверки,
 * и разъехавшиеся копии тут опаснее дублирования: `asObject` успел разойтись на два
 * варианта (с отсевом массивов и без), хотя ни один вызывающий на массив не рассчитывает.
 */

/**
 * Объект и только объект.
 *
 * Массив отсеивается намеренно: на проводе он никогда не значит «тело со строковыми
 * ключами», а `typeof [] === 'object'` пропустил бы его дальше в разбор.
 */
export function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Непустая строка. Пустая приравнивается к отсутствию: как идентификатор она бесполезна */
export function stringOr(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
