/**
 * Кодек WS-кадров (§2.2/§14.9). Порт `spike4-framecodec.mjs` (13/13 PASSED, оффлайн).
 *
 * Кадр: `0x01` + MessagePack `[serviceIndex, reqId, method]` + `0x05` + 11×`0x00` + UTF-8 JSON.
 * msgpack нужен ТОЛЬКО заголовку (короткий массив uint/str), тело - обычный JSON,
 * поэтому кодек ручной: готовая либа не даёт удобно снять байтовый offset конца заголовка.
 *
 * КРИТИЧНО: конец заголовка находится РАЗБОРОМ ДЛИН msgpack-элементов, а НЕ поиском
 * разделителя `0x05`. При `seq=5` байт seq кодируется как fixint `0x05` и совпадает
 * с разделителем - наивный скан обрежет заголовок на seq (эмпирически подтверждено
 * на реальном push-кадре, у которого seq=5).
 */

/** Разделитель data-секции: `0x05` + 11 нулей. Клиент всегда шлёт нули; сервер кладёт crc/msg-id */
const DATA_SECTION_PREFIX_LENGTH = 12;
const DATA_SECTION_MARKER = 0x05;

/** Арности msgpack-заголовка по типу кадра (§14.9) */
const FIXARRAY_MASK = 0xf0;
const FIXARRAY_TAG = 0x90;

/* ---------- msgpack encode: только то, что нужно заголовку ---------- */

function encodeUint(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`msgpack uint ожидает неотрицательное целое, получено ${value}`);
  }
  if (value < 0x80) {
    return Buffer.from([value]); /* positive fixint */
  }
  if (value < 0x100) {
    return Buffer.from([0xcc, value]); /* uint8 */
  }
  if (value < 0x10000) {
    return Buffer.from([0xcd, value >> 8, value & 0xff]); /* uint16 */
  }
  const buffer = Buffer.alloc(5);
  buffer[0] = 0xce; /* uint32 */
  buffer.writeUInt32BE(value >>> 0, 1);
  return buffer;
}

function encodeStr(value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  if (body.length < 0x20) {
    return Buffer.concat([Buffer.from([0xa0 | body.length]), body]); /* fixstr */
  }
  if (body.length < 0x100) {
    return Buffer.concat([Buffer.from([0xd9, body.length]), body]); /* str8 */
  }
  const header = Buffer.alloc(3);
  header[0] = 0xda; /* str16 */
  header.writeUInt16BE(body.length, 1);
  return Buffer.concat([header, body]);
}

/* ---------- msgpack decode: продвижение по разобранной длине, без сканов ---------- */

interface Decoded {
  value: number | string;
  next: number;
}

function decodeUint(buffer: Buffer, offset: number): Decoded {
  const tag = buffer[offset];
  if (tag === undefined) {
    throw new RangeError(`msgpack uint: кадр оборван на ${offset}`);
  }
  if (tag < 0x80) {
    return { value: tag, next: offset + 1 };
  }
  if (tag === 0xcc) {
    return { value: buffer.readUInt8(offset + 1), next: offset + 2 };
  }
  if (tag === 0xcd) {
    return { value: buffer.readUInt16BE(offset + 1), next: offset + 3 };
  }
  if (tag === 0xce) {
    return { value: buffer.readUInt32BE(offset + 1), next: offset + 5 };
  }
  throw new RangeError(`msgpack: неизвестный uint-тип 0x${tag.toString(16)} на ${offset}`);
}

function decodeStr(buffer: Buffer, offset: number): Decoded {
  const tag = buffer[offset];
  if (tag === undefined) {
    throw new RangeError(`msgpack str: кадр оборван на ${offset}`);
  }
  let length: number;
  let start: number;
  if ((tag & 0xe0) === 0xa0) {
    length = tag & 0x1f; /* fixstr */
    start = offset + 1;
  } else if (tag === 0xd9) {
    length = buffer.readUInt8(offset + 1); /* str8 */
    start = offset + 2;
  } else if (tag === 0xda) {
    length = buffer.readUInt16BE(offset + 1); /* str16 */
    start = offset + 3;
  } else {
    throw new RangeError(`msgpack: неизвестный str-тип 0x${tag.toString(16)} на ${offset}`);
  }
  return { value: buffer.toString('utf8', start, start + length), next: start + length };
}

function decodeElement(buffer: Buffer, offset: number): Decoded {
  const tag = buffer[offset];
  if (tag === undefined) {
    throw new RangeError(`msgpack: кадр оборван на ${offset}`);
  }
  if (tag < 0x80 || tag === 0xcc || tag === 0xcd || tag === 0xce) {
    return decodeUint(buffer, offset);
  }
  if ((tag & 0xe0) === 0xa0 || tag === 0xd9 || tag === 0xda) {
    return decodeStr(buffer, offset);
  }
  throw new RangeError(`msgpack: неизвестный тип элемента 0x${tag.toString(16)} на ${offset}`);
}

/* ---------- кадры ---------- */

export interface EncodeDataFrameOptions {
  /** `this.index` транспорта, в наблюдаемом трафике всегда 0 */
  serviceIndex: number;
  /** Он же seq: per-connection счётчик, эхом возвращается в ответе */
  reqId: number;
  method: string;
  /** Тело `{RequestId, ...params}`; сериализуется обычным JSON, не msgpack */
  payload: unknown;
}

/** Собирает исходящий DATA-кадр. Отправляется как binary (opcode 2) */
export function encodeDataFrame(options: EncodeDataFrameOptions): Buffer {
  const header = Buffer.concat([
    Buffer.from([0x93]), /* fixarray[3] */
    encodeUint(options.serviceIndex),
    encodeUint(options.reqId),
    encodeStr(options.method),
  ]);
  const dataSection = Buffer.alloc(DATA_SECTION_PREFIX_LENGTH);
  dataSection[0] = DATA_SECTION_MARKER;
  return Buffer.concat([
    Buffer.from([0x01]), /* FrameType.Data */
    header,
    dataSection,
    Buffer.from(JSON.stringify(options.payload), 'utf8'),
  ]);
}

/** Разобранный кадр без интерпретации: элементы заголовка как есть */
export interface RawFrame {
  /** Байт 0: см. FrameType */
  frameType: number;
  /** Элементы msgpack-заголовка; их количество = арность (2/3/4) */
  elements: (number | string)[];
  /** Offset конца заголовка - получен разбором длин, а не поиском `0x05` */
  headerEnd: number;
  /** Тело: undefined у кадров без data-секции (напр. PROXY_STATUS) */
  payload: unknown;
}

/**
 * Разбирает входящий кадр любой арности.
 * Тип кадра читается из байта 0, длина заголовка - из msgpack-тегов.
 */
export function decodeFrame(frame: Buffer): RawFrame {
  const frameType = frame[0];
  if (frameType === undefined) {
    throw new RangeError('кадр пуст');
  }
  const arrayTag = frame[1];
  if (arrayTag === undefined || (arrayTag & FIXARRAY_MASK) !== FIXARRAY_TAG) {
    throw new RangeError(`заголовок кадра не fixarray: 0x${(arrayTag ?? 0).toString(16)}`);
  }

  const arity = arrayTag & 0x0f;
  const elements: (number | string)[] = [];
  let offset = 2;
  for (let index = 0; index < arity; index += 1) {
    const decoded = decodeElement(frame, offset);
    elements.push(decoded.value);
    offset = decoded.next; /* продвижение по разобранной длине - НИКОГДА не скан 0x05 */
  }

  const headerEnd = offset;
  const jsonStart = headerEnd + DATA_SECTION_PREFIX_LENGTH;
  const payload = jsonStart < frame.length ? JSON.parse(frame.toString('utf8', jsonStart, frame.length)) : undefined;

  return { frameType, elements, headerEnd, payload };
}
