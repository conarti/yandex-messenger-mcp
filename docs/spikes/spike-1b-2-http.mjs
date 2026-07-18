/**
 * SPIKE 1b (sign derivation) + SPIKE 2 (search page-param).
 *
 * 1b: patch fetch/XHR, record registry calls; after WS opens, find which HTTP
 *     response body CONTAINS the WS `sign` value -> that call is the source.
 *     If none contains it -> sign is computed client-side (then: grep bundle).
 * 2 : call `search` in-page (cookies automatic, enableCSRF:false per §3.3) with
 *     limit=1 to force total>limit, then probe page-param candidates.
 *
 * PRIVACY: no message text, no ids, no sign/session values persisted.
 * Only booleans, counts, method names, param names.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PROFILE = path.join(os.homedir(), '.config', 'yandex-messenger-mcp', 'profile');
const OUT = path.join(process.env.SPIKE_DIR || '.', 'spike-1b-2-findings.json');
const EXEC = process.env.EXEC_PATH || (os.homedir() + '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

/* ---------- in-page: record WS url + HTTP calls (bodies kept in page only) ---------- */
const initScript = () => {
  const cap = { wsUrls: [], http: [] };
  window.__cap2 = cap;

  const NativeWS = window.WebSocket;
  function PatchedWS(url, protocols) {
    cap.wsUrls.push(String(url));
    return protocols ? new NativeWS(url, protocols) : new NativeWS(url);
  }
  PatchedWS.prototype = NativeWS.prototype;
  Object.assign(PatchedWS, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = PatchedWS;

  const methodFromBody = (body) => {
    try {
      if (body instanceof FormData) {
        const r = body.get('request');
        if (r) return JSON.parse(r).method;
      }
      if (typeof body === 'string' && body.includes('"method"')) return JSON.parse(body).method;
    } catch {}
    return undefined;
  };

  const origFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = methodFromBody(init && init.body);
    const res = await origFetch(input, init);
    try {
      const clone = res.clone();
      const text = await clone.text();
      cap.http.push({ url: String(url), rpcMethod: method, body: text }); // body stays in page
    } catch {}
    return res;
  };

  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const x = new OrigXHR();
    let _url = '', _method;
    const origOpen = x.open;
    x.open = function (m, u, ...rest) { _url = String(u); return origOpen.call(x, m, u, ...rest); };
    const origSend = x.send;
    x.send = function (body) {
      _method = methodFromBody(body);
      x.addEventListener('load', () => {
        try { cap.http.push({ url: _url, rpcMethod: _method, body: String(x.responseText || '') }); } catch {}
      });
      return origSend.call(x, body);
    };
    return x;
  }
  window.XMLHttpRequest = PatchedXHR;
};

/* ---------- main ---------- */
const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, executablePath: EXEC, viewport: { width: 1280, height: 900 } });
const page = ctx.pages()[0] || await ctx.newPage();
await ctx.addInitScript(initScript);
console.log('[harness] navigating (profile should already be logged in)...');
await page.goto('https://yandex.ru/chat', { waitUntil: 'domcontentloaded' }).catch(e => console.log('[nav]', e.message));

// let the app boot, open WS, and make its registry calls
for (let i = 0; i < 15; i++) {
  await page.waitForTimeout(2000);
  const s = await page.evaluate(() => ({ ws: (window.__cap2 || {}).wsUrls?.length || 0, http: (window.__cap2 || {}).http?.length || 0 })).catch(() => ({ ws: 0, http: 0 }));
  console.log('[wait]', JSON.stringify(s));
  if (s.ws >= 1 && s.http >= 3) break;
}

/* ---------- SPIKE 1b: where does `sign` come from? (analysis in-page, only verdict out) ---------- */
const spike1b = await page.evaluate(() => {
  const cap = window.__cap2 || { wsUrls: [], http: [] };
  const wsUrl = cap.wsUrls.find(u => /push\.yandex\.ru|uniproxy/.test(u));
  if (!wsUrl) return { error: 'no messenger WS url captured' };
  const q = new URL(wsUrl.replace(/^ws/, 'http')).searchParams;
  const sign = q.get('sign'), ts = q.get('ts'), user = q.get('user'), session = q.get('session');
  const hits = [];
  for (const h of cap.http) {
    if (!h.body) continue;
    const containsSign = sign ? h.body.includes(sign) : false;
    const mentionsSecretSign = /secretSign|secret_sign/i.test(h.body);
    if (containsSign || mentionsSecretSign) {
      hits.push({
        rpcMethod: h.rpcMethod,
        urlTail: String(h.url).split('/').slice(-3).join('/').slice(0, 80),
        containsSignValue: containsSign,
        mentionsSecretSignKey: mentionsSecretSign,
      });
    }
  }
  return {
    signPresent: !!sign,
    signLen: sign ? sign.length : 0,
    tsPresent: !!ts,
    tsLooksUnixSec: ts ? (Number(ts) > 1e9 && Number(ts) < 2e9) : false,
    userIsGuid: user ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user) : false,
    sessionFormat: session ? session.replace(/[0-9a-f]/gi, 'x') : null,
    rpcMethodsSeen: [...new Set(cap.http.map(h => h.rpcMethod).filter(Boolean))],
    sourceHits: hits,
    verdict: hits.some(h => h.containsSignValue) ? 'SIGN_FROM_HTTP_RESPONSE' : 'SIGN_NOT_IN_ANY_HTTP_RESPONSE(client-computed?)',
  };
});
console.log('\n===== SPIKE 1b (sign derivation) =====');
console.log(JSON.stringify(spike1b, null, 2));

/* ---------- SPIKE 2: search page-param ---------- */
const spike2 = await page.evaluate(async () => {
  const API = 'https://yandex.ru/messenger/api/registry/api/';
  const call = async (params) => {
    const fd = new FormData();
    fd.append('request', JSON.stringify({ method: 'search', params }));
    const r = await fetch(API, { method: 'POST', body: fd, credentials: 'include' });
    return r.json();
  };
  const shape = (d) => {
    const m = d && d.data && d.data.messages;
    if (!m) return null;
    return { total: m.total, limit: m.limit, page: m.page, pages: m.pages, count: (m.items || []).length };
  };
  /* fingerprint an item WITHOUT storing content: hash of its stable ids */
  const fp = (d) => {
    const it = d && d.data && d.data.messages && d.data.messages.items && d.data.messages.items[0];
    if (!it) return null;
    const key = JSON.stringify([it.timestamp ?? it.ts ?? null, it.chat_id ?? it.chatId ?? null, it.seqno ?? null]);
    let h = 0; for (let i = 0; i < key.length; i++) { h = ((h << 5) - h + key.charCodeAt(i)) | 0; }
    return String(h);
  };

  const out = { queriesTried: [], baseline: null, candidates: [] };
  /* find a query with total > 1 */
  let base = null, usedQuery = null;
  for (const q of ['а', 'да', 'не', 'привет', 'что']) {
    const d = await call({ query: q, limit: 1, entities: ['messages'] });
    const s = shape(d);
    out.queriesTried.push({ queryLen: q.length, total: s ? s.total : null });
    if (s && s.total > 1) { base = { d, s }; usedQuery = q; break; }
  }
  if (!base) return { ...out, error: 'no query produced total>1 (нет данных для проверки пагинации)' };
  out.baseline = base.s;
  const baseFp = fp(base.d);

  /* probe candidate page params */
  for (const name of ['page', 'offset', 'from', 'skip', 'page_number']) {
    try {
      const d = await call({ query: usedQuery, limit: 1, entities: ['messages'], [name]: 2 });
      const s = shape(d);
      const f = fp(d);
      out.candidates.push({
        param: name,
        respPage: s ? s.page : null,
        respTotal: s ? s.total : null,
        count: s ? s.count : null,
        itemChangedVsPage1: f !== null && baseFp !== null ? (f !== baseFp) : null,
        looksLikeWorks: !!(s && ((s.page === 2) || (f && baseFp && f !== baseFp))),
      });
    } catch (e) { out.candidates.push({ param: name, error: String(e).slice(0, 80) }); }
  }
  return out;
});
console.log('\n===== SPIKE 2 (search page-param) =====');
console.log(JSON.stringify(spike2, null, 2));

fs.writeFileSync(OUT, JSON.stringify({ capturedAt: new Date().toISOString(), spike1b, spike2 }, null, 2));
console.log('\n[harness] findings ->', OUT);
await ctx.close();
console.log('[harness] done.');
