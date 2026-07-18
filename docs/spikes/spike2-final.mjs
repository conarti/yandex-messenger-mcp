/**
 * Proper login diagnostic + SPIKE 2 (search page-param).
 *
 * Fixes prior mistake: get_current_user_data is NOT read-only in §10 (no ✓),
 * so enableCSRF=true -> it needs X-CSRF-TOKEN (§13.4, csrfTokenUrl §15).
 * Calling it bare always returned status:"error", which wrongly looked like "not logged in".
 *
 * PRIVACY: identity shown to its owner only in console; findings file keeps
 * counts/param names/booleans. No message text, no ids, no cookie values.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PROFILE = path.join(os.homedir(), '.config', 'yandex-messenger-mcp', 'profile');
const OUT = path.join(process.env.SPIKE_DIR || '.', 'spike-2-findings.json');
const EXEC = process.env.EXEC_PATH || (os.homedir() + '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, executablePath: EXEC, viewport: { width: 1360, height: 950 } });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://yandex.ru/chat', { waitUntil: 'domcontentloaded' }).catch(e => console.log('[nav]', e.message));
await page.waitForTimeout(10000);

/* httpOnly cookies are invisible to document.cookie -> ask Playwright */
const cookies = await ctx.cookies('https://yandex.ru');
const cookieNames = cookies.map(c => c.name);
console.log('[diag] passport cookies present:', {
  Session_id: cookieNames.includes('Session_id'),
  sessionid2: cookieNames.includes('sessionid2'),
  yandexuid: cookieNames.includes('yandexuid'),
  totalCookies: cookieNames.length,
});

const diag = await page.evaluate(async () => {
  const BASE = 'https://yandex.ru/messenger/api/registry';
  const API = BASE + '/api/';
  const post = async (method, params, csrf) => {
    const fd = new FormData();
    fd.append('request', JSON.stringify(params === undefined ? { method } : { method, params }));
    const headers = csrf ? { 'X-CSRF-TOKEN': csrf } : undefined;
    const r = await fetch(API, { method: 'POST', body: fd, credentials: 'include', headers });
    return r.json();
  };

  const out = {};

  /* 1. CSRF token (§15 csrfTokenUrl) */
  let csrf = null;
  try {
    const r = await fetch(BASE + '/csrf-token/', { method: 'POST', credentials: 'include' });
    const j = await r.json();
    csrf = j?.data?.token ?? j?.token ?? j?.data?.['csrf-token'] ?? null;
    out.csrf = { status: j?.status ?? 'n/a', gotToken: !!csrf, respKeys: Object.keys(j || {}), dataKeys: j?.data ? Object.keys(j.data) : null };
  } catch (e) { out.csrf = { error: String(e).slice(0, 100) }; }

  /* 2. current user WITH csrf */
  try {
    const d = await post('get_current_user_data', undefined, csrf);
    const u = d?.data;
    out.currentUser = {
      status: d?.status,
      displayName: u?.display_name ?? u?.displayName ?? null,
      nickname: u?.nickname ?? null,
      keys: u ? Object.keys(u).slice(0, 20) : null,
    };
  } catch (e) { out.currentUser = { error: String(e).slice(0, 100) }; }

  /* 3. search totals (enableCSRF:false per §3.3) */
  out.searchTotals = {};
  for (const ent of ['chats', 'users', 'messages']) {
    try {
      const d = await post('search', { query: 'а', limit: 5, entities: [ent] });
      out.searchTotals[ent] = d?.data?.[ent]?.total ?? null;
    } catch { out.searchTotals[ent] = 'err'; }
  }

  /* 4. DOM chat rows */
  out.domChats = document.querySelectorAll('a[href*="/chat#/chats/"], [data-testid*="chat-list-item"], [class*="chat-list" i] a').length;
  out.bodyTextLen = document.body?.innerText?.length ?? 0;
  return out;
});
console.log('[diag]', JSON.stringify(diag, null, 2));

/* ---------- SPIKE 2 ---------- */
const spike2 = await page.evaluate(async () => {
  const API = 'https://yandex.ru/messenger/api/registry/api/';
  const call = async (params) => {
    const fd = new FormData();
    fd.append('request', JSON.stringify({ method: 'search', params }));
    const r = await fetch(API, { method: 'POST', body: fd, credentials: 'include' });
    return r.json();
  };
  const shape = (d) => {
    const m = d?.data?.messages;
    return m ? { total: m.total, limit: m.limit, page: m.page, pages: m.pages, count: (m.items || []).length } : null;
  };
  const fp = (d) => {
    const it = d?.data?.messages?.items?.[0];
    if (!it) return null;
    const key = JSON.stringify([it.timestamp ?? it.ts ?? null, it.chat_id ?? it.chatId ?? null, it.seqno ?? null]);
    let h = 0; for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    return String(h);
  };

  const out = { queriesTried: [], baseline: null, itemKeys: null, candidates: [] };
  let base = null, q = null;
  for (const cand of ['а', 'не', 'да', 'привет', 'спасибо', 'что', 'о', 'the', 'a']) {
    const d = await call({ query: cand, limit: 1, entities: ['messages'] });
    const s = shape(d);
    out.queriesTried.push({ qLen: cand.length, total: s?.total ?? null });
    if (s && s.total > 1) { base = { d, s }; q = cand; break; }
  }
  if (!base) return { ...out, error: 'ни один запрос не дал total>1' };
  out.baseline = base.s;
  out.itemKeys = Object.keys(base.d?.data?.messages?.items?.[0] || {}).slice(0, 15);
  const baseFp = fp(base.d);

  for (const name of ['page', 'offset', 'from', 'skip', 'page_number']) {
    try {
      const d = await call({ query: q, limit: 1, entities: ['messages'], [name]: 2 });
      const s = shape(d);
      const f = fp(d);
      out.candidates.push({
        param: name,
        respPage: s?.page ?? null,
        count: s?.count ?? null,
        itemChangedVsPage1: (f && baseFp) ? f !== baseFp : null,
        works: !!(s && (s.page === 2 || (f && baseFp && f !== baseFp))),
      });
    } catch (e) { out.candidates.push({ param: name, error: String(e).slice(0, 80) }); }
  }
  return out;
});
console.log('\n===== SPIKE 2 =====');
console.log(JSON.stringify(spike2, null, 2));

fs.writeFileSync(OUT, JSON.stringify({
  capturedAt: new Date().toISOString(),
  cookiesPresent: { Session_id: cookieNames.includes('Session_id'), sessionid2: cookieNames.includes('sessionid2'), yandexuid: cookieNames.includes('yandexuid') },
  diag: { ...diag, currentUser: diag.currentUser ? { status: diag.currentUser.status, hasDisplayName: !!diag.currentUser.displayName, keys: diag.currentUser.keys } : null },
  spike2,
}, null, 2));
console.log('\n[harness] ->', OUT);
await ctx.close();
