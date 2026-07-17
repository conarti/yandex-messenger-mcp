/**
 * Матрица кодека - порт проверок SPIKE 4 (13/13) плюс границы seq.
 *
 * Референсные байты заголовков сняты с живого клиента (§2.2), синтетика помечена явно:
 * кадры PROXY_STATUS/PUSH в захвате не разбирались побайтово, их форма взята из §14.9.
 */
import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeDataFrame } from '../../src/transport/ws/frameCodec.js';
import { FrameType } from '../../src/transport/ws/frameTypes.js';

/** Заголовки из §2.2: тип кадра + msgpack [0, seq, method] */
const REFERENCE_HEADERS: Record<string, { seq: number; hex: string }> = {
  whoami: { seq: 1, hex: '01930001a677686f616d69' },
  history: { seq: 2, hex: '019300 02 a7 686973746f7279'.replace(/\s/g, '') },
  push: { seq: 5, hex: '019300 05 a4 70757368'.replace(/\s/g, '') },
  subscribe: { seq: 9, hex: '019300 09 a9 737562736372696265'.replace(/\s/g, '') },
};

describe('encodeDataFrame', () => {
  it.each(Object.entries(REFERENCE_HEADERS))(
    'даёт побайтово точный заголовок §2.2 для %s',
    (method, { seq, hex }) => {
      const frame = encodeDataFrame({ serviceIndex: 0, reqId: seq, method, payload: { RequestId: 'x' } });

      /* 0x01 + 0x93 + serviceIndex(1б) + seq(1б) + fixstr-маркер(1б) + тело имени */
      const headerLength = 5 + Buffer.byteLength(method, 'utf8');
      expect(frame.subarray(0, headerLength).toString('hex')).toBe(hex);
    },
  );

  it('пишет разделитель 0x05 + 11 нулей: клиент шлёт нули, crc кладёт только сервер', () => {
    const frame = encodeDataFrame({ serviceIndex: 0, reqId: 1, method: 'whoami', payload: {} });

    /* 0x01 + 0x93 + serviceIndex(1б) + seq(1б) + fixstr-маркер(1б) + "whoami"(6б) */
    const separator = frame.subarray(11, 23);
    expect(separator[0]).toBe(0x05);
    expect(separator.subarray(1)).toEqual(Buffer.alloc(11));
  });

  it('кладёт тело обычным JSON, а не msgpack', () => {
    const payload = { RequestId: 'req-1', Limit: 0, ChatDataFilter: {} };
    const frame = encodeDataFrame({ serviceIndex: 0, reqId: 2, method: 'history', payload });

    /* заголовок 5 + "history"(7) + разделитель 12 */
    expect(frame.toString('utf8', 5 + 7 + 12)).toBe(JSON.stringify(payload));
  });
});

describe('round-trip', () => {
  it.each(Object.entries(REFERENCE_HEADERS))('encode -> decode сохраняет заголовок и тело для %s', (method, { seq }) => {
    const payload = { RequestId: `req-${method}`, foo: 5, bar: 'baz' };

    const decoded = decodeFrame(encodeDataFrame({ serviceIndex: 0, reqId: seq, method, payload }));

    expect(decoded.frameType).toBe(FrameType.Data);
    expect(decoded.elements).toEqual([0, seq, method]);
    expect(decoded.payload).toEqual(payload);
  });

  /* Границы msgpack uint: fixint -> uint8 -> uint16 -> uint32. Ошибка здесь = ответы уедут не к тем запросам */
  it.each([1, 127, 128, 255, 256, 65535, 65536, 4294967295])('переживает seq=%i без потери значения', (seq) => {
    const decoded = decodeFrame(encodeDataFrame({ serviceIndex: 0, reqId: seq, method: 'history', payload: { a: 1 } }));

    expect(decoded.elements[1]).toBe(seq);
    expect(decoded.elements[2]).toBe('history');
  });
});

describe('коллизия seq=5 с разделителем', () => {
  it('декодирует по длине заголовка, а не сканом 0x05: у push seq=5 = байт разделителя', () => {
    const frame = encodeDataFrame({ serviceIndex: 0, reqId: 5, method: 'push', payload: { RequestId: 'p' } });

    /* Наивный сканер остановился бы на байте seq и обрезал заголовок */
    const naiveSeparatorIndex = frame.indexOf(0x05);
    const decoded = decodeFrame(frame);

    expect(naiveSeparatorIndex).toBe(3);
    expect(decoded.headerEnd).toBeGreaterThan(naiveSeparatorIndex);
    expect(decoded.elements).toEqual([0, 5, 'push']);
    expect(decoded.payload).toEqual({ RequestId: 'p' });
  });
});

describe('арности заголовка (§14.9)', () => {
  it('DATA 0x93 [serviceIndex, reqId, method]', () => {
    const decoded = decodeFrame(encodeDataFrame({ serviceIndex: 0, reqId: 2, method: 'history', payload: {} }));

    expect(decoded.frameType).toBe(FrameType.Data);
    expect(decoded.elements).toHaveLength(3);
  });

  it('PROXY_STATUS 0x92 [reqId, errorCode], без data-секции (synthetic fixture, не captured)', () => {
    const frame = Buffer.from([0x02, 0x92, 0x07, 0x06]);

    const decoded = decodeFrame(frame);

    expect(decoded.frameType).toBe(FrameType.ProxyStatus);
    expect(decoded.elements).toEqual([7, 6]);
    expect(decoded.payload).toBeUndefined();
  });

  it('PUSH 0x94 [uid, service, event, transitId] + payload (synthetic fixture, не captured)', () => {
    const header = Buffer.concat([
      Buffer.from([0x03, 0x94, 0x00]),
      Buffer.from([0xa9]),
      Buffer.from('messenger', 'utf8'),
      Buffer.from([0xab]),
      Buffer.from('new_message', 'utf8'),
      Buffer.from([0x2a]),
    ]);
    const separator = Buffer.alloc(12);
    separator[0] = 0x05;
    const frame = Buffer.concat([header, separator, Buffer.from(JSON.stringify({ ClientMessage: { Plain: {} } }))]);

    const decoded = decodeFrame(frame);

    expect(decoded.frameType).toBe(FrameType.Push);
    expect(decoded.elements).toEqual([0, 'messenger', 'new_message', 42]);
    expect(decoded.payload).toEqual({ ClientMessage: { Plain: {} } });
  });
});

describe('длинные имена методов', () => {
  it('имя >31 символа кодируется str8 (0xd9) и читается обратно', () => {
    const method = 'a'.repeat(40);

    const frame = encodeDataFrame({ serviceIndex: 0, reqId: 3, method, payload: { RequestId: 'l' } });

    expect(frame[4]).toBe(0xd9);
    expect(decodeFrame(frame).elements[2]).toBe(method);
  });

  it('имя >255 символов кодируется str16 (0xda) и читается обратно', () => {
    const method = 'b'.repeat(300);

    const frame = encodeDataFrame({ serviceIndex: 0, reqId: 3, method, payload: {} });

    expect(frame[4]).toBe(0xda);
    expect(decodeFrame(frame).elements[2]).toBe(method);
  });
});

describe('битые кадры', () => {
  it('отвергает кадр, чей заголовок не fixarray', () => {
    expect(() => decodeFrame(Buffer.from([0x01, 0x80, 0x00]))).toThrow(/fixarray/);
  });
});
