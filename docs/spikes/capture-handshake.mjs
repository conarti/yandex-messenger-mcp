/**
 * Live SPIKE harness: capture Yandex Messenger WS handshake + control frames.
 * Resolves: SPIKE 3 (handshake url: secretSign? user=uid|puid?), push<->subscribe order.
 *
 * PRIVACY: outgoing frames (our own control/subscribe/push) captured fully.
 * Incoming frames (history / other people's messages) -> only structural metadata
 * (frame type, msgpack method, subscription-id, status). No message text hits disk.
 *
 * Run: NODE_PATH=<npx playwright node_modules> node capture-handshake.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PROFILE = path.join(os.homedir(), '.config', 'yandex-messenger-mcp', 'profile');
const OUT = path.join(process.env.SPIKE_DIR || '.', 'capture-redacted.json');
fs.mkdirSync(PROFILE, { recursive: true });

/* ---------- in-page WebSocket capture (installed before page scripts) ---------- */
const initScript = () => {
  const cap = { sockets: [] };
  window.__cap = cap;
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
    let seq = 0;
    const origSend = ws.send.bind(ws);
    ws.send = (data) => {
      const idx = seq++;
      try {
        if (typeof data === 'string') rec.sent.push({ idx, kind: 'text', b64: btoa(unescape(encodeURIComponent(data))) });
        else if (data instanceof ArrayBuffer) rec.sent.push({ idx, kind: 'bin', b64: toB64(data) });
        else if (ArrayBuffer.isView(data)) rec.sent.push({ idx, kind: 'bin', b64: toB64(data.buffer) });
        else if (data instanceof Blob) { const e = { idx, kind: 'bin', b64: null }; rec.sent.push(e); data.arrayBuffer().then(b => e.b64 = toB64(b)); }
      } catch (err) { rec.sent.push({ idx, kind: 'err', msg: String(err) }); }
      return origSend(data);
    };
    ws.addEventListener('message', (ev) => {
      const idx = seq++;
      const d = ev.data;
      try {
        if (typeof d === 'string') rec.recv.push({ idx, kind: 'text', b64: btoa(unescape(encodeURIComponent(d))) });
        else if (d instanceof ArrayBuffer) rec.recv.push({ idx, kind: 'bin', b64: toB64(d) });
        else if (d instanceof Blob) { const e = { idx, kind: 'bin', b64: null }; rec.recv.push(e); d.arrayBuffer().then(b => e.b64 = toB64(b)); }
      } catch (err) { rec.recv.push({ idx, kind: 'err', msg: String(err) }); }
    });
    return ws;
  }
  Patched.prototype = NativeWS.prototype;
  Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Patched;
};

/* ---------- node-side msgpack header parse (from validated SPIKE 4 codec) ---------- */
function decHeader(buf) {
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

/* redact an outgoing frame: keep control structure, strip any free text */
function summarizeSent(frameB64) {
  const buf = Buffer.from(frameB64, 'base64');
  if (buf[0] === undefined) return { empty: true };
  const h = decHeader(buf);
  const out = { frameType: h.frameType, method: h.elems ? h.elems[2] : undefined, seq: h.elems ? h.elems[1] : undefined };
  // body JSON after 12-byte data prefix
  try {
    const jsonStart = h.headerEnd + 12;
    if (jsonStart < buf.length) {
      const body = JSON.parse(buf.toString('utf8', jsonStart));
      // keep only structural / control keys relevant to spikes
      out.body = pickControl(body);
    }
  } catch { /* not a DATA/json frame */ }
  return out;
}
function pickControl(o) {
  if (o == null || typeof o !== 'object') return undefined;
  const keep = {};
  for (const k of ['RequestId', 'ChatId', 'Limit', 'ToGuid', 'TtlMcs', 'MessageBodyType', 'ClientSupportedFeatures', 'ClientTransportId', 'UserAgent', 'Meta']) {
    if (o[k] !== undefined) keep[k] = o[k];
  }
  if (o.ClientMessage) {
    const cm = o.ClientMessage;
    keep.ClientMessage = { kinds: Object.keys(cm), ClientTransportId: o.ClientTransportId };
    if (cm.Heartbeat) keep.ClientMessage.Heartbeat = cm.Heartbeat;
    if (cm.Typing) keep.ClientMessage.Typing = { ChatId: cm.Typing.ChatId };
    if (cm.Plain) keep.ClientMessage.Plain = { keys: Object.keys(cm.Plain), hasText: !!(cm.Plain.Text) }; // no text value
  }
  return keep;
}
/* redact an incoming frame: only method + operation metadata + status, NO body text */
function summarizeRecv(frameB64) {
  const buf = Buffer.from(frameB64, 'base64');
  const b0 = buf[0];
  // Xiva operation frames arrive as text JSON (operation/subscribed/ping)
  const h = (b0 === 0x01 || b0 === 0x02 || b0 === 0x03) ? decHeader(buf) : null;
  const out = { frameType: b0, method: h && h.elems ? h.elems[2] : undefined, seq: h && h.elems ? h.elems[1] : undefined };
  try {
    const start = h ? h.headerEnd + 12 : 0;
    if (start < buf.length) {
      const body = JSON.parse(buf.toString('utf8', start));
      out.topKeys = Object.keys(body).slice(0, 12);
      for (const k of ['operation', 'subscription-id', 'server-interval-sec', 'status', 'Status', 'RequestId']) {
        if (body[k] !== undefined) out[k] = body[k];
      }
    }
  } catch { /* binary/non-json */ }
  return out;
}
function summarizeRecvText(b64) {
  try {
    const s = Buffer.from(b64, 'base64').toString('utf8');
    const body = JSON.parse(s);
    const out = { kind: 'text', topKeys: Object.keys(body).slice(0, 12) };
    for (const k of ['operation', 'subscription-id', 'server-interval-sec', 'status', 'RequestId']) if (body[k] !== undefined) out[k] = body[k];
    return out;
  } catch { return { kind: 'text', unparsed: true }; }
}

/* ---------- main ---------- */
const EXEC = process.env.EXEC_PATH || (os.homedir() + '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  executablePath: EXEC,
  viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] || await ctx.newPage();
await ctx.addInitScript(initScript);
console.log('[harness] navigating to yandex.ru/chat ... log in if prompted (QR/password).');
await page.goto('https://yandex.ru/chat', { waitUntil: 'domcontentloaded' }).catch(e => console.log('[nav]', e.message));

/* wait until a push.yandex.ru WS opened AND we saw >=1 outgoing subscribe or push (or timeout) */
const deadline = Date.now() + 180000;
let done = false;
while (Date.now() < deadline && !done) {
  await page.waitForTimeout(2000);
  const state = await page.evaluate(() => {
    const c = window.__cap || { sockets: [] };
    return c.sockets.map(s => ({ url: s.url, sent: s.sent.length, recv: s.recv.length }));
  }).catch(() => []);
  const pushWs = state.find(s => /push\.yandex\.ru|uniproxy/.test(s.url));
  if (pushWs && pushWs.sent >= 2 && pushWs.recv >= 2) { done = true; }
  console.log('[wait]', JSON.stringify(state));
}

const cap = await page.evaluate(() => window.__cap).catch(() => ({ sockets: [] }));

/* redact + summarize; write only safe metadata */
const report = { capturedAt: new Date().toISOString(), sockets: [] };
for (const s of cap.sockets) {
  const u = new URL(s.url.replace(/^ws/, 'http'));
  const q = Object.fromEntries(u.searchParams.entries());
  const sock = {
    urlBase: u.origin + u.pathname,
    query: q,
    query_has_secretSign: 'secretSign' in q || 'sign' in q,
    query_user: q.user,
    sentSummary: s.sent.filter(f => f.b64).map(f => f.kind === 'text' ? summarizeRecvText(f.b64) : summarizeSent(f.b64)),
    recvSummary: s.recv.filter(f => f.b64).map(f => f.kind === 'text' ? summarizeRecvText(f.b64) : summarizeRecv(f.b64)),
  };
  report.sockets.push(sock);
}
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

/* ---------- analysis for the spikes ---------- */
console.log('\n===== SPIKE ANALYSIS =====');
for (const s of report.sockets) {
  if (!/push\.yandex\.ru|uniproxy/.test(s.urlBase)) continue;
  console.log('WS:', s.urlBase);
  console.log('  query:', JSON.stringify(s.query));
  console.log('  SPIKE3 secretSign in handshake URL?:', s.query_has_secretSign, '| user=', s.query_user);
  const sentMethods = s.sentSummary.map(x => x.method || x.operation || x.kind).filter(Boolean);
  const recvOps = s.recvSummary.map(x => x.operation || x.method).filter(Boolean);
  console.log('  sent order:', JSON.stringify(sentMethods));
  console.log('  recv ops/methods:', JSON.stringify(recvOps.slice(0, 15)));
  const firstPush = s.sentSummary.findIndex(x => x.method === 'push');
  const firstSub = s.sentSummary.findIndex(x => x.method === 'subscribe');
  const subscribedOp = s.recvSummary.find(x => x.operation === 'subscribed' || x['subscription-id']);
  console.log('  push<->subscribe: firstSubscribeIdx=', firstSub, 'firstPushIdx=', firstPush,
              '| subscribed-op-received?', !!subscribedOp, subscribedOp ? '(sub-id present)' : '');
  const pushFrame = s.sentSummary.find(x => x.method === 'push');
  if (pushFrame && pushFrame.body && pushFrame.body.ClientTransportId) {
    console.log('  push ClientTransportId:', JSON.stringify(pushFrame.body.ClientTransportId));
  }
}
console.log('\n[harness] redacted report ->', OUT);
console.log('[harness] leaving browser open 8s for any late frames...');
await page.waitForTimeout(8000);
await ctx.close();
console.log('[harness] done.');
