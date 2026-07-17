/**
 * HTTP-поиск с ЭСКАЛАЦИЕЙ `limit` (§17.5).
 *
 * Page-based пагинации в этом API НЕТ - доказано отрицательным спайком и перепроверено
 * живьём 2026-07-17 (bucket `users`, свип): `limit=1→total=1`, `5→5`, `10/20/50/100→7`
 * (плато), `pages` = 1 ВСЕГДА, а параметры `page`/`offset`/`from`/`skip`/`page_number`
 * сервер игнорирует.
 *
 * Отсюда семантика: `total` = число ВОЗВРАЩЁННЫХ элементов (`min(limit, реальное)`), а НЕ
 * общее число совпадений. Значит:
 *   total == limit -> упёрлись в потолок выдачи, за ним может быть ещё -> поднять limit;
 *   total <  limit -> плато, найдено всё.
 * Поля `page`/`pages` не читаются вовсе - они вестигиальны.
 *
 * `limit` задаётся ЯВНО: серверный дефолт (5, а не 10 как в §3.3) не подразумевается.
 *
 * Потолок сервера не обнаружен (живьём `limit=1000` отвечает штатно). Если он всё же
 * найдётся - результат помечается `truncated`, а не обрезается молча.
 */
import { SEARCH_ENTITIES, SEARCH_LIMIT_CEILING, SEARCH_LIMIT_FACTOR, type SearchEntity } from '../config/defaults.js';
import type { RegistryHttpClient } from '../transport/RegistryHttpClient.js';
import type { Logger } from '../util/logger.js';

/** Конверт бакета в ответе (§3.3): `{items, total, limit, page, pages}` */
interface RawBucket {
  items?: unknown;
  total?: unknown;
  limit?: unknown;
}

export interface SearchInput {
  query: string;
  entities: SearchEntity[];
  /** Стартовый limit; при насыщении поднимается множителем до плато */
  startLimit: number;
}

export interface SearchOutcome {
  /** Сырые items по бакетам: форму знает вызывающий (chats/users/messages различны) */
  buckets: Record<string, unknown[]>;
  startLimit: number;
  /** limit, на котором выдача вышла на плато (или упёрлась в потолок) */
  finalLimit: number;
  /** Сколько раз пришлось перезапросить */
  requests: number;
  /** true => набор НЕ полон: сервер отдал ровно limit на потолке эскалации */
  truncated: boolean;
  truncationReason?: string;
}

export class SearchEntityError extends Error {
  constructor(readonly entity: string) {
    super(
      `search: entity "${entity}" не поддерживается. ` +
        `Валидны: ${SEARCH_ENTITIES.join(', ')}. ` +
        `Сервер на "contacts" отвечает ошибкой - он выкидывает невалидную entity из списка ` +
        `и падает с bad_request "entities are required".`,
    );
    this.name = 'SearchEntityError';
  }
}

/**
 * Отвергает невалидные entities НА ВХОДЕ (§17.6), не доводя до сервера:
 * его ошибка (`bad_request: entities are required`) о настоящей причине не говорит.
 */
function assertValidEntities(entities: readonly string[]): asserts entities is SearchEntity[] {
  if (entities.length === 0) {
    throw new SearchEntityError('<пусто>');
  }
  for (const entity of entities) {
    if (!(SEARCH_ENTITIES as readonly string[]).includes(entity)) {
      throw new SearchEntityError(entity);
    }
  }
}

function readBucket(data: unknown, entity: string): { items: unknown[]; total: number } {
  const bucket = (data as Record<string, unknown> | null)?.[entity] as RawBucket | undefined;
  const items = Array.isArray(bucket?.items) ? bucket.items : [];
  /* total - число возвращённых, но доверяем длине items: она и есть факт */
  const total = typeof bucket?.total === 'number' ? bucket.total : items.length;
  return { items, total };
}

export interface SearchDeps {
  http: RegistryHttpClient;
  logger?: Logger;
}

/** Насыщен ли хоть один бакет: total == limit значит «за горизонтом может быть ещё» */
function isSaturated(buckets: Record<string, unknown[]>, totals: Record<string, number>, limit: number): boolean {
  return Object.keys(buckets).some((entity) => (totals[entity] ?? 0) >= limit);
}

export async function searchWithEscalation(deps: SearchDeps, input: SearchInput): Promise<SearchOutcome> {
  assertValidEntities(input.entities);
  if (!Number.isInteger(input.startLimit) || input.startLimit < 1) {
    throw new RangeError(`search: стартовый limit должен быть целым >= 1, получено ${input.startLimit}`);
  }

  let limit = input.startLimit;
  /*
   * limit, на котором собрана выдача в `buckets`. Отдельная переменная, а не арифметика
   * от отвергнутого limit: эскалация КЛАМПИТСЯ о потолок (320 -> min(1280, 1000) = 1000),
   * поэтому обратное деление на FACTOR соврало бы (250 вместо 320).
   */
  let collectedAtLimit = input.startLimit;
  let requests = 0;
  let buckets: Record<string, unknown[]> = {};
  let totals: Record<string, number> = {};

  for (;;) {
    let data: unknown;
    try {
      data = await deps.http.call('search', {
        query: input.query,
        limit,
        entities: input.entities,
      });
    } catch (error) {
      /* Упёрлись в неизвестный потолок сервера: отдаём последнее удачное, но ЯВНО помечаем */
      if (requests > 0) {
        deps.logger?.warn('search: сервер отверг поднятый limit, отдаём последнюю удачную выдачу', {
          limit,
          collectedAtLimit,
        });
        return {
          buckets,
          startLimit: input.startLimit,
          finalLimit: collectedAtLimit,
          requests,
          truncated: true,
          truncationReason:
            `сервер отверг limit=${limit} (${error instanceof Error ? error.message : String(error)}); ` +
            `результат собран на limit=${collectedAtLimit} и может быть неполным`,
        };
      }
      throw error;
    }

    requests += 1;
    collectedAtLimit = limit;
    buckets = {};
    totals = {};
    for (const entity of input.entities) {
      const { items, total } = readBucket(data, entity);
      buckets[entity] = items;
      totals[entity] = total;
    }

    if (!isSaturated(buckets, totals, limit)) {
      /* Плато: выдача меньше запрошенного - значит это всё, что есть */
      return { buckets, startLimit: input.startLimit, finalLimit: limit, requests, truncated: false };
    }

    if (limit >= SEARCH_LIMIT_CEILING) {
      deps.logger?.warn('search: достигнут клиентский потолок limit, выдача может быть неполной', { limit });
      return {
        buckets,
        startLimit: input.startLimit,
        finalLimit: limit,
        requests,
        truncated: true,
        truncationReason:
          `выдача насыщена на клиентском потолке limit=${limit}: сервер вернул ровно столько, ` +
          `сколько запрошено, поэтому за горизонтом могут быть ещё совпадения`,
      };
    }

    limit = Math.min(limit * SEARCH_LIMIT_FACTOR, SEARCH_LIMIT_CEILING);
    deps.logger?.debug('search: выдача насыщена, поднимаем limit', { limit });
  }
}
