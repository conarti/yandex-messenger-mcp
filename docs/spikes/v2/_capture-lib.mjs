/**
 * Shared capture lib for poll spike. Patches WS + fetch + XHR in-page to record
 * OUTGOING requests. Node-side decoder for the Yandex WS frame:
 *   0x01 + msgpack[serviceIndex,reqId,method] + 0x05 + 11×0x00 + UTF-8 JSON
 * Privacy: caller must redact live values before writing to disk.
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
export const { chromium } = require('playwright');

export const PROFILE = path.join(os.homedir(), '.config', 'yandex-messenger-mcp', 'profile');
export const EXEC = process.env.EXEC_PATH || (os.homedir() +
  '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

/* ---- in-page capture: WS.send + fetch + XHR (outgoing) and WS recv ---- */
export const initScript = () => {
  const cap = { sockets: [], http: [] };
  window.__cap = cap;
  const live = [];                 // live ws refs, never serialized
  window.__live = live;
  /* send a raw byte array through the first OPEN push/uniproxy socket */
  window.__sendRaw = (arr) => {
    const buf = new Uint8Array(arr);
    const ws = live.find(w => /push\.yandex|uniproxy/.test(w.url) && w.readyState === 1) || live.find(w => w.readyState === 1);
    if (!ws) return 'no-open-ws';
    ws.__origSend(buf);
    return 'sent:' + ws.url;
  };
  const NativeWS = window.WebSocket;
  const toB64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  };
  function Patched(url, protocols) {
    const ws = protocols ? new NativeWS(url, protocols) : new NativeWS(url);
    const rec = { url: String(url), sent: [], recv: [], openedAt: Date.now() };
    cap.sockets.push(rec);
    live.push(ws);
    let seq = 0;
    const origSend = ws.send.bind(ws);
    ws.__origSend = origSend;
    ws.send = (data) => {
      const idx = seq++;
      const t = Date.now();
      try {
        if (typeof data === 'string') rec.sent.push({ idx, t, kind: 'text', b64: btoa(unescape(encodeURIComponent(data))) });
        else if (data instanceof ArrayBuffer) rec.sent.push({ idx, t, kind: 'bin', b64: toB64(data) });
        else if (ArrayBuffer.isView(data)) rec.sent.push({ idx, t, kind: 'bin', b64: toB64(data.buffer) });
        else if (data instanceof Blob) { const e = { idx, t, kind: 'bin', b64: null }; rec.sent.push(e); data.arrayBuffer().then(b => e.b64 = toB64(b)); }
      } catch (err) { rec.sent.push({ idx, t, kind: 'err', msg: String(err) }); }
      return origSend(data);
    };
    ws.addEventListener('message', (ev) => {
      const idx = seq++;
      const t = Date.now();
      const d = ev.data;
      try {
        if (typeof d === 'string') rec.recv.push({ idx, t, kind: 'text', b64: btoa(unescape(encodeURIComponent(d))) });
        else if (d instanceof ArrayBuffer) rec.recv.push({ idx, t, kind: 'bin', b64: toB64(d) });
        else if (d instanceof Blob) { const e = { idx, t, kind: 'bin', b64: null }; rec.recv.push(e); d.arrayBuffer().then(b => e.b64 = toB64(b)); }
      } catch (err) { rec.recv.push({ idx, t, kind: 'err', msg: String(err) }); }
    });
    return ws;
  }
  Patched.prototype = NativeWS.prototype;
  Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Patched;

  /* fetch */
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      const body = init && init.body;
      if (/messenger|poll|vote/i.test(url)) cap.http.push({ t: Date.now(), via: 'fetch', method, url: String(url), body: typeof body === 'string' ? body : null });
    } catch { /* ignore */ }
    return origFetch.apply(this, arguments);
  };
  /* XHR */
  const origOpen = XMLHttpRequest.prototype.open;
  const origXSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__m = m; this.__u = u; return origOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    try { if (/messenger|poll|vote/i.test(this.__u || '')) cap.http.push({ t: Date.now(), via: 'xhr', method: this.__m, url: String(this.__u), body: typeof b === 'string' ? b : null }); } catch { /* ignore */ }
    return origXSend.apply(this, arguments);
  };
};

/* ---- node-side msgpack header + JSON tail decoder ---- */
export function decHeader(buf) {
  const frameType = buf[0];
  let off = 1;
  const arrHead = buf[off];
  if ((arrHead & 0xf0) !== 0x90) return { frameType, note: 'not-fixarray', head0: arrHead };
  const arrLen = arrHead & 0x0f; off += 1;
  const elems = [];
  for (let i = 0; i < arrLen; i++) {
    const t = buf[off];
    if (t < 0x80) { elems.push(t); off += 1; }
    else if (t === 0xcc) { elems.push(buf[off + 1]); off += 2; }
    else if (t === 0xcd) { elems.push(buf.readUInt16BE(off + 1)); off += 3; }
    else if (t === 0xce) { elems.push(buf.readUInt32BE(off + 1)); off += 5; }
    else if ((t & 0xe0) === 0xa0) { const l = t & 0x1f; elems.push(buf.toString('utf8', off + 1, off + 1 + l)); off += 1 + l; }
    else if (t === 0xd9) { const l = buf[off + 1]; elems.push(buf.toString('utf8', off + 2, off + 2 + l)); off += 2 + l; }
    else { elems.push('?0x' + t.toString(16)); off += 1; }
  }
  return { frameType, arrLen, elems, headerEnd: off };
}

/** Full decode of a captured frame into {frameType, method, reqId, json} - raw, unredacted. */
export function decodeFrame(b64) {
  const buf = Buffer.from(b64, 'base64');
  if (buf[0] === undefined) return { empty: true };
  const h = decHeader(buf);
  const out = { frameType: h.frameType, serviceIndex: h.elems ? h.elems[0] : undefined, reqId: h.elems ? h.elems[1] : undefined, method: h.elems ? h.elems[2] : undefined };
  try {
    const jsonStart = (h.headerEnd || 1) + 12;
    if (jsonStart < buf.length) out.json = JSON.parse(buf.toString('utf8', jsonStart));
  } catch { /* not json */ }
  return out;
}

/** Try both offsets (some recv frames are plain text JSON). */
export function decodeAny(frame) {
  if (frame.kind === 'text') {
    try { return { kind: 'text', json: JSON.parse(Buffer.from(frame.b64, 'base64').toString('utf8')) }; }
    catch { return { kind: 'text', unparsed: true }; }
  }
  return { kind: 'bin', ...decodeFrame(frame.b64) };
}
