/**
 * Генератор `RequestId` (§14.8) - backend-корреляция, впрыскивается в тело каждого get/push.
 *
 * Форма `xxxxxxxx-xxxx-xxxx-xxxxxxxx` (шаблон из бандла, `M8(...)`): группы 8-4-4-8.
 * Это НЕ канонический uuid v4: групп четыре (а не пять), нет version/variant-нибблов.
 *
 * §14.8 подписывает шаблон как «26 hex + 3 дефиса», но в самом шаблоне 8+4+4+8 = **24** hex
 * (длина 27). Шаблон - первичен (он снят с кода), подпись - арифметическая описка доки.
 * Не путать с `reqId`/seq из msgpack-заголовка - тот коррелирует транспорт (§14.8).
 */
import { randomBytes } from 'node:crypto';

const GROUP_LENGTHS = [8, 4, 4, 8];

function randomHex(length: number): string {
  return randomBytes(Math.ceil(length / 2))
    .toString('hex')
    .slice(0, length);
}

export function createRequestId(): string {
  return GROUP_LENGTHS.map(randomHex).join('-');
}
