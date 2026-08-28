/**
 * Резолв ВСЕГО состава упоминаний одного исходящего сообщения (#15).
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ ФУНКЦИЯ ВНУТРИ ИНСТРУМЕНТА. Состав упоминаний резолвят два
 * исходящих пути - `send_message` и `edit_message`. Импорт одного инструмента другим связал бы
 * их напрямую; общий модуль лежит здесь, рядом с `resolveMention`, потому что зависимости у
 * функции ровно те же (`ResolveMentionDeps`: поиск, логгер, чат, лимит), а не весь `ToolDeps` -
 * ни сокет, ни auth, ни карта реакций ей не нужны.
 *
 * ОТКАЗ - СОБСТВЕННЫЙ ТИП, а не тип результата инструмента (образец - `ChatResolveFailure`,
 * `resolveFailure.ts`). Три формы отказа принадлежат резолву упоминаний, а не отправке, поэтому
 * каждый инструмент подмешивает `MentionResolveFailure` в свой юнион слагаемым.
 */
import { resolveMention, type MentionCandidate, type ResolveMentionDeps } from './resolveMention.js';
import type { MentionPair } from './mentionTokens.js';
import type { Logger } from '../util/logger.js';

/**
 * Отказ резолва состава. `query` несёт КАКОЕ ИМЕННО @X не разрешилось: упоминаний в одном
 * сообщении может быть несколько (§6.4), и без запроса отказ не диагностируем.
 */
export type MentionResolveFailure =
  | { status: 'ambiguous_mention'; query: string; candidates: MentionCandidate[] }
  | { status: 'mention_not_in_chat'; query: string; guid: string; chat_id: string }
  | { status: 'mention_not_found'; query: string };

/** Итог резолва всех упоминаний draft: либо кандидаты и пары, либо готовый отказ наружу */
export type MentionsOutcome =
  | { status: 'ok'; candidates: MentionCandidate[]; pairs: MentionPair[] }
  | { status: 'fail'; failure: MentionResolveFailure };

/** Логгер обязателен: у `SearchDeps` он опционален, а этот путь пишет решения по каждому запросу */
export interface ResolveMentionsDeps extends ResolveMentionDeps {
  logger: Logger;
}

/**
 * Резолвит каждый запрос упоминания на DRAFT и схлопывает дубли по guid с сохранением
 * первого вхождения (зеркально `buildMentions`, §6.1 правило 3). Первый неразрешённый -
 * немедленный отказ наружу: неоднозначность блокирует исходящую операцию, а не угадывает (P2/AC-3).
 *
 * Возвращает ДВА поля с разным назначением. `candidates` схлопнуты по guid и кормят отпечаток и
 * `mentions[]` в выдаче draft. `pairs` собираются МИМО дедупа, по элементу на каждый запрос: два
 * разных запроса-синонима, схлопнувшихся в один guid, обязаны быть подставлены ОБА, иначе при
 * `text:'@Ваня и @Иван'` половина текста ушла бы в необратимое сообщение неподставленной.
 */
export async function resolveMentions(
  queries: readonly string[],
  deps: ResolveMentionsDeps,
): Promise<MentionsOutcome> {
  const candidates: MentionCandidate[] = [];
  const pairs: MentionPair[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    const resolved = await resolveMention(query, deps);
    if (resolved.status === 'ambiguous') {
      deps.logger.info('упоминание неоднозначно, состав отклонён', { candidates: resolved.candidates.length });
      return { status: 'fail', failure: { status: 'ambiguous_mention', query, candidates: resolved.candidates } };
    }
    if (resolved.status === 'not_in_chat') {
      deps.logger.info('упоминание вне чата, состав отклонён');
      return {
        status: 'fail',
        failure: { status: 'mention_not_in_chat', query, guid: resolved.guid, chat_id: deps.chatId },
      };
    }
    if (resolved.status === 'not_found') {
      deps.logger.info('упоминание не найдено, состав отклонён');
      return { status: 'fail', failure: { status: 'mention_not_found', query } };
    }
    pairs.push({ query, guid: resolved.guid });
    if (!seen.has(resolved.guid)) {
      seen.add(resolved.guid);
      candidates.push({ guid: resolved.guid, ...(resolved.name !== undefined ? { name: resolved.name } : {}) });
    }
  }
  return { status: 'ok', candidates, pairs };
}
