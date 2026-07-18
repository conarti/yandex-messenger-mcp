/**
 * SPIKE 4 - WS frame codec round-trip (offline, no auth, no network).
 * Validates: 0x01 + msgpack[serviceIndex, seq, method] + 0x05 + 11x0x00 + JSON
 * Reference frames from yandex-messenger-api-research.md §2.2 / §14.9.
 * Critical case: push has seq=5 -> byte 0x05 collides with the separator byte,
 * so the decoder MUST parse the msgpack header length, never scan for 0x05.
 */

/* ---------- minimal msgpack encode (only what the header needs) ---------- */

function encUint(n) {
  if (n < 0) throw new Error('neg');
  if (n < 0x80) return Buffer.from([n]);                 // positive fixint
  if (n < 0x100) return Buffer.from([0xcc, n]);          // uint8
  if (n < 0x10000) return Buffer.from([0xcd, n >> 8, n & 0xff]); // uint16
  const b = Buffer.alloc(5); b[0] = 0xce; b.writeUInt32BE(n >>> 0, 1); return b;
}

function encStr(s) {
  const body = Buffer.from(s, 'utf8');
  const len = body.length;
  if (len < 0x20) return Buffer.concat([Buffer.from([0xa0 | len]), body]); // fixstr
  if (len < 0x100) return Buffer.concat([Buffer.from([0xd9, len]), body]); // str8
  const h = Buffer.alloc(3); h[0] = 0xda; h.writeUInt16BE(len, 1);          // str16
  return Buffer.concat([h, body]);
}

function encArray3(a, b, c) {
  return Buffer.concat([Buffer.from([0x93]), a, b, c]);
}

/* ---------- frame encode ---------- */

const FRAME_DATA = 0x01;
const DATA_PREFIX = Buffer.concat([Buffer.from([0x05]), Buffer.alloc(11)]); // 0x05 + 11 zeros

function encodeDataFrame(serviceIndex, seq, method, jsonObj) {
  const header = encArray3(encUint(serviceIndex), encUint(seq), encStr(method));
  const json = Buffer.from(JSON.stringify(jsonObj), 'utf8');
  return Buffer.concat([Buffer.from([FRAME_DATA]), header, DATA_PREFIX, json]);
}

/* ---------- minimal msgpack decode (by length, never by scan) ---------- */

function decUint(buf, off) {
  const t = buf[off];
  if (t < 0x80) return { val: t, next: off + 1 };
  if (t === 0xcc) return { val: buf[off + 1], next: off + 2 };
  if (t === 0xcd) return { val: buf.readUInt16BE(off + 1), next: off + 3 };
  if (t === 0xce) return { val: buf.readUInt32BE(off + 1), next: off + 5 };
  throw new Error('uint type 0x' + t.toString(16) + ' @' + off);
}

function decStr(buf, off) {
  const t = buf[off];
  let len, start;
  if ((t & 0xe0) === 0xa0) { len = t & 0x1f; start = off + 1; }
  else if (t === 0xd9) { len = buf[off + 1]; start = off + 2; }
  else if (t === 0xda) { len = buf.readUInt16BE(off + 1); start = off + 2; }
  else throw new Error('str type 0x' + t.toString(16) + ' @' + off);
  return { val: buf.toString('utf8', start, start + len), next: start + len };
}

/* generic element skip/read for header ints/strings */
function decElem(buf, off) {
  const t = buf[off];
  if (t < 0x80 || t === 0xcc || t === 0xcd || t === 0xce) return decUint(buf, off);
  if ((t & 0xe0) === 0xa0 || t === 0xd9 || t === 0xda) return decStr(buf, off);
  throw new Error('elem type 0x' + t.toString(16) + ' @' + off);
}

function decodeFrame(buf) {
  const frameType = buf[0];
  let off = 1;
  const arrHead = buf[off];
  const arrLen = arrHead & 0x0f;
  if ((arrHead & 0xf0) !== 0x90) throw new Error('not fixarray @' + off);
  off += 1;
  const elems = [];
  for (let i = 0; i < arrLen; i++) {
    const r = decElem(buf, off);
    elems.push(r.val);
    off = r.next; // <-- advance by parsed length, NEVER scan for 0x05
  }
  const headerEnd = off;
  // data-section: 12-byte prefix (0x05 + 11 bytes) then JSON to end
  const prefix = buf.subarray(headerEnd, headerEnd + 12);
  const jsonStart = headerEnd + 12;
  let json = null;
  if (jsonStart < buf.length) {
    json = JSON.parse(buf.toString('utf8', jsonStart, buf.length));
  }
  return { frameType, arrLen, elems, prefixByte0: prefix[0], headerEnd, json };
}

/* ---------- reference header hex from §2.2 (frame-type byte + header only) ---------- */

const REF = {
  whoami:    '019300 01 a6 77686f616d69',
  history:   '019300 02 a7 686973746f7279',
  push:      '019300 05 a4 70757368',
  subscribe: '019300 09 a9 737562736372696265',
};
const norm = (s) => s.replace(/\s+/g, '').toLowerCase();

/* ---------- run ---------- */

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const cases = [
  { method: 'whoami', seq: 1 },
  { method: 'history', seq: 2 },
  { method: 'push', seq: 5 },        // <-- seq byte == 0x05 == separator byte
  { method: 'subscribe', seq: 9 },
];

console.log('--- encode: header bytes vs §2.2 reference ---');
for (const c of cases) {
  const frame = encodeDataFrame(0, c.seq, c.method, { RequestId: 'x' });
  /* header bytes = 0x01 + 0x93 + serviceIndex(fixint 1b) + seq(fixint 1b) + fixstr-marker(1b) + method body */
  const headerLen = 5 + Buffer.from(c.method, 'utf8').length;
  const headerHex = frame.subarray(0, headerLen).toString('hex');
  ok(`encode ${c.method}(seq=${c.seq}) header`, headerHex === norm(REF[c.method]),
     `got=${headerHex} ref=${norm(REF[c.method])}`);
}

console.log('\n--- round-trip: encode -> decode ---');
for (const c of cases) {
  const payload = { RequestId: 'req-' + c.method, foo: 5, bar: 'baz' };
  const frame = encodeDataFrame(0, c.seq, c.method, payload);
  const d = decodeFrame(frame);
  const good = d.elems[0] === 0 && d.elems[1] === c.seq && d.elems[2] === c.method &&
               JSON.stringify(d.json) === JSON.stringify(payload) && d.prefixByte0 === 0x05;
  ok(`round-trip ${c.method}(seq=${c.seq})`, good,
     `elems=${JSON.stringify(d.elems)} jsonOK=${JSON.stringify(d.json) === JSON.stringify(payload)}`);
}

console.log('\n--- critical: push seq=5 must NOT false-match separator ---');
{
  const frame = encodeDataFrame(0, 5, 'push', { RequestId: 'p' });
  // A naive scanner for first 0x05 would stop at the seq byte (index 3), truncating the header.
  const naiveIdx = frame.indexOf(0x05);
  const d = decodeFrame(frame);
  ok('length-based decode ignores 0x05 collision',
     d.elems[1] === 5 && d.elems[2] === 'push' && d.headerEnd > naiveIdx,
     `naive0x05@${naiveIdx} realHeaderEnd@${d.headerEnd}`);
}

console.log('\n--- synthetic non-DATA arities (0x92 PROXY_STATUS, 0x94 PUSH) ---');
{
  // PROXY_STATUS(2): [reqId, errorCode] -> 0x92
  const proxy = Buffer.concat([Buffer.from([0x02, 0x92]), encUint(7), encUint(6)]); // reqId=7, TOO_MANY_REQUESTS=7? errorCode=6 SERVICE_UNAVAILABLE
  const dp = decodeFrame(proxy);
  ok('decode PROXY_STATUS 0x92 [reqId,errorCode] (synthetic)',
     dp.frameType === 0x02 && dp.arrLen === 2 && dp.elems[0] === 7 && dp.elems[1] === 6,
     `elems=${JSON.stringify(dp.elems)}`);
}
{
  // PUSH(3): [uid, service, event, transitId] -> 0x94, then payload JSON after 12-byte prefix
  const head = Buffer.concat([Buffer.from([0x03, 0x94]), encUint(0), encStr('messenger'), encStr('new_message'), encUint(42)]);
  const full = Buffer.concat([head, DATA_PREFIX, Buffer.from(JSON.stringify({ ClientMessage: { Plain: {} } }))]);
  const du = decodeFrame(full);
  ok('decode PUSH 0x94 [uid,service,event,transitId] + payload (synthetic)',
     du.frameType === 0x03 && du.arrLen === 4 && du.elems[2] === 'new_message' && du.json && du.json.ClientMessage,
     `elems=${JSON.stringify(du.elems)}`);
}

console.log('\n--- str8 path: long method name (>31 chars) uses 0xd9 ---');
{
  const longName = 'a'.repeat(40);
  const frame = encodeDataFrame(0, 3, longName, { RequestId: 'l' });
  const d = decodeFrame(frame);
  ok('str8 encode/decode long method', d.elems[2] === longName && frame[2 + 3 - 1] !== undefined);
  // verify 0xd9 marker present at method position (after 0x01,0x93, serviceIndex(1b), seq(1b))
  ok('str8 marker 0xd9 emitted', frame[4] === 0xd9, `byte@4=0x${frame[4].toString(16)}`);
}

console.log(`\n=== SPIKE 4 result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
