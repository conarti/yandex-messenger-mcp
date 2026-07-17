import { describe, expect, it, vi } from 'vitest';
import { REDACTED, createLogger } from '../../src/util/logger.js';

/**
 * Синтетический uid формы «10 цифр».
 *
 * ЗДЕСЬ БЫЛ НАСТОЯЩИЙ uid ВЛАДЕЛЬЦА ПРОФИЛЯ (снят живым захватом и попавший в §2.1
 * research как «пример»). Фикстуре живое значение не нужно: тест проверяет, что логгер
 * редактирует поле по ИМЕНИ ключа и по форме строки, а не конкретное число. Настоящий uid
 * в этой роли ничего не доказывает, но переживает процесс - он остаётся в исходниках, в
 * истории git и в любом форке. Значение обязано быть заведомо фальшивым.
 */
const FAKE_UID = '1111111111';

function capture() {
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', write: (line) => lines.push(line) });
  return { lines, logger, parsed: () => lines.map((line) => JSON.parse(line)) };
}

describe('logger', () => {
  it('пишет структурный JSON с уровнем и сообщением', () => {
    const { logger, parsed } = capture();

    logger.info('ws connected', { reqId: 42 });

    const [entry] = parsed();
    expect(entry.level).toBe('info');
    expect(entry.msg).toBe('ws connected');
    expect(entry.reqId).toBe(42);
    expect(typeof entry.ts).toBe('string');
  });

  it('редактирует секреты сессии и содержимое переписки', () => {
    const { logger, parsed } = capture();

    logger.info('push', {
      cookieHeader: 'Session_id=live-secret',
      sign: 'deadbeefdeadbeefdeadbeefdeadbeef',
      session: 'aaaa-bbbb-cccc-dddd',
      yandexUid: '1234567890',
      text: 'приватное сообщение',
      chatId: 'guid-a_guid-b',
    });

    const [entry] = parsed();
    expect(entry.cookieHeader).toBe(REDACTED);
    expect(entry.sign).toBe(REDACTED);
    expect(entry.session).toBe(REDACTED);
    expect(entry.yandexUid).toBe(REDACTED);
    expect(entry.text).toBe(REDACTED);
    /* Несекретные поля остаются читаемыми для диагностики */
    expect(entry.chatId).toBe('guid-a_guid-b');
    expect(JSON.stringify(entry)).not.toContain('приватное сообщение');
    expect(JSON.stringify(entry)).not.toContain('live-secret');
  });

  it('редактирует секреты во вложенных структурах', () => {
    const { logger, parsed } = capture();

    logger.debug('frame', { frame: { params: { Text: 'x', text: 'приватное' }, seq: 5 } });

    const [entry] = parsed();
    expect(entry.frame.params.text).toBe(REDACTED);
    expect(entry.frame.seq).toBe(5);
  });

  it('фильтрует записи ниже установленного уровня', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', write: (line) => lines.push(line) });

    logger.debug('noise');
    logger.info('noise');
    logger.warn('kept');

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).msg).toBe('kept');
  });

  /*
   * stdout принадлежит MCP stdio-транспорту: там идёт JSON-RPC. Одна строка лога в stdout
   * делает поток неразбираемым и роняет сессию целиком, поэтому это не стилистика, а инвариант.
   */
  describe('stdout не трогается никогда', () => {
    it('по умолчанию пишет в stderr и ни байта в stdout', () => {
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        const logger = createLogger({ level: 'debug' });
        logger.debug('debug');
        logger.info('info');
        logger.warn('warn');
        logger.error('error', { error: new Error('boom') });
        logger.child({ component: 'ws' }).info('child');

        expect(stdout).not.toHaveBeenCalled();
        expect(stderr).toHaveBeenCalledTimes(5);
        expect(stderr.mock.calls[0]?.[0]).toMatch(/\n$/);
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
      }
    });

    it('запись ниже уровня не идёт никуда', () => {
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        createLogger({ level: 'error' }).info('дальше не пойдёт');

        expect(stdout).not.toHaveBeenCalled();
        expect(stderr).not.toHaveBeenCalled();
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
      }
    });
  });

  describe('редакция', () => {
    it('редактирует идентификаторы сессии: uid, guid, subscription-id', () => {
      const { logger, parsed } = capture();

      logger.info('ws', {
        uid: FAKE_UID,
        guid: '00000000-0000-4000-8000-000000000000',
        userUid: FAKE_UID,
        userGuid: '00000000-0000-4000-8000-000000000000',
        subscriptionId: 'a'.repeat(40),
        xivaSubscriptionId: 'a'.repeat(40),
        session_id: 'live',
        reqId: 7,
      });

      const [entry] = parsed();
      for (const key of ['uid', 'guid', 'userUid', 'userGuid', 'subscriptionId', 'xivaSubscriptionId', 'session_id']) {
        expect(entry[key]).toBe(REDACTED);
      }
      /* Несекретная диагностика остаётся читаемой - иначе лог бесполезен */
      expect(entry.reqId).toBe(7);
    });

    it('редактирует текст сообщений во всех известных контейнерах', () => {
      const { logger, parsed } = capture();

      logger.debug('push', {
        text: 'приватное',
        messageText: 'приватное',
        plain: { ChatId: 'a_b', Text: { MessageText: 'приватное' } },
        preview: 'приватное',
        snippet: 'приватное',
        last_message: 'приватное',
      });

      expect(JSON.stringify(parsed()[0])).not.toContain('приватное');
    });

    /* Секрет чаще приезжает внутри строки (URL, заголовок), где имя ключа его не выдаёт */
    it('вычищает секреты из значений-строк, а не только из ключей', () => {
      const { logger, parsed } = capture();

      logger.info('ws: соединение', {
        url: `wss://push.yandex.ru/v2/subscribe/websocket?service=messenger-prod&sign=deadbeefcafe&ts=1784117592&user=${FAKE_UID}`,
        header: 'Session_id=3:live-secret-value; yandexuid=1234567890',
        error: new Error('handshake failed for wss://push.yandex.ru/?sign=deadbeefcafe'),
      });

      const serialized = JSON.stringify(parsed()[0]);
      expect(serialized).not.toContain('deadbeefcafe');
      expect(serialized).not.toContain('live-secret-value');
      expect(serialized).not.toContain('1234567890');
      /* Диагностическая часть URL сохраняется: иначе нечего расследовать */
      expect(serialized).toContain('push.yandex.ru');
      expect(serialized).toContain('service=messenger-prod');
    });
  });

  it('child наследует и дополняет bindings', () => {
    const { logger, parsed } = capture();

    logger.child({ component: 'ws' }).info('open', { url: 'wss://push.yandex.ru' });

    const [entry] = parsed();
    expect(entry.component).toBe('ws');
    expect(entry.url).toBe('wss://push.yandex.ru');
  });
});
