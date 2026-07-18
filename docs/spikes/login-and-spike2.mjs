/**
 * Waits for a REAL Yandex login in the persistent profile, then runs SPIKE 2
 * (search page-param) against the account's actual message history.
 *
 * The previous profile held an anonymous/guest messenger identity: get_current_user_data
 * errored, 0 chats, search total=0 across all entities -> nothing to paginate.
 *
 * PRIVACY: only counts / param names / booleans persisted. No message text, no ids.
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

console.log('[harness] ==> ЗАЛОГИНЬСЯ В ЯНДЕКС В ОТКРЫТОМ ОКНЕ (QR или пароль). Жду до 6 минут...');
await page.goto('https://passport.yandex.ru/auth?retpath=https%3A%2F%2Fyandex.ru%2Fchat', { waitUntil: 'domcontentloaded' }).catch(e => console.log('[nav]', e.message));

/* poll until a real account is present */
const isLoggedIn = async () => page.evaluate(async () => {
  try {
    const fd = new FormData();
    fd.append('request', JSON.stringify({ method: 'get_current_user_data' }));
    const r = await fetch('https://yandex.ru/messenger/api/registry/api/', { method: 'POST', body: fd, credentials: 'include' });
    const j = await r.json();
    return { status: j && j.status, ok: j && j.status === 'ok' };
  } catch (e) { return { status: 'exception', ok: false }; }
}).catch(() => ({ status: 'nav', ok: false }));

const deadline = Date.now() + 360000;
let logged = false;
while (Date.now() < deadline) {
  await page.waitForTimeout(5000);
  if (!/yandex\.ru\/chat/.test(page.url())) continue; // still on passport
  const s = await isLoggedIn();
  console.log('[wait] logged-in check:', JSON.stringify(s), '| url:', page.url().slice(0, 60));
  if (s.ok) { logged = true; break; }
}
if (!logged) {
  console.log('[harness] НЕ ДОЖДАЛСЯ ЛОГИНА. Запусти снова и залогинься в окне.');
  await ctx.close();
  process.exit(2);
}
console.log('[harness] логин есть. Жду загрузки чатов...');
await page.waitForTimeout(8000);

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
    const m = d && d.data && d.data.messages;
    return m ? { total: m.total, limit: m.limit, page: m.page, pages: m.pages, count: (m.items || []).length } : null;
  };
  /* fingerprint first item by stable ids only -> hashed, never stored raw */
  const fp = (d) => {
    const it = d?.data?.messages?.items?.[0];
    if (!it) return null;
    const key = JSON.stringify([it.timestamp ?? it.ts ?? null, it.chat_id ?? it.chatId ?? null, it.seqno ?? null]);
    let h = 0; for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    return String(h);
  };

  const out = { queriesTried: [], baseline: null, candidates: [], itemKeysSample: null };
  let base = null, q = null;
  for (const cand of ['а', 'не', 'да', 'привет', 'спасибо', 'что', 'о']) {
    const d = await call({ query: cand, limit: 1, entities: ['messages'] });
    const s = shape(d);
    out.queriesTried.push({ qLen: cand.length, total: s?.total ?? null });
    if (s && s.total > 1) { base = { d, s }; q = cand; break; }
  }
  if (!base) return { ...out, error: 'даже с логином ни один запрос не дал total>1' };
  out.baseline = base.s;
  out.itemKeysSample = Object.keys(base.d?.data?.messages?.items?.[0] || {}).slice(0, 15); // keys only
  const baseFp = fp(base.d);

  for (const name of ['page', 'offset', 'from', 'skip', 'page_number']) {
    try {
      const d = await call({ query: q, limit: 1, entities: ['messages'], [name]: 2 });
      const s = shape(d);
      const f = fp(d);
      out.candidates.push({
        param: name,
        respPage: s?.page ?? null,
        respTotal: s?.total ?? null,
        count: s?.count ?? null,
        itemChangedVsPage1: (f && baseFp) ? f !== baseFp : null,
        works: !!(s && (s.page === 2 || (f && baseFp && f !== baseFp))),
      });
    } catch (e) { out.candidates.push({ param: name, error: String(e).slice(0, 80) }); }
  }
  return out;
});

console.log('\n===== SPIKE 2 (search page-param) =====');
console.log(JSON.stringify(spike2, null, 2));
fs.writeFileSync(OUT, JSON.stringify({ capturedAt: new Date().toISOString(), spike2 }, null, 2));
console.log('\n[harness] ->', OUT);
await ctx.close();
