/**
 * SPIKE 2 (search page-param) — resolved on the `users` bucket.
 *
 * Rationale: §3.3 shows the SAME page-based envelope {items,total,limit,page,pages}
 * for users/chats/messages, so the page-param name is bucket-agnostic. The `users`
 * bucket returns total=5 for this account -> limit=1 forces total>limit, which is
 * exactly the condition the research doc never got to test (§3.3: "нужен запрос с total>limit").
 * Using `users` keeps private message content out of the probe entirely.
 *
 * PRIVACY: no names, no ids. Only totals/page numbers/param names and a
 * hashed fingerprint used solely to detect "did the returned item change?".
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
await page.waitForTimeout(9000);

const res = await page.evaluate(async () => {
  const API = 'https://yandex.ru/messenger/api/registry/api/';
  const call = async (params) => {
    const fd = new FormData();
    fd.append('request', JSON.stringify({ method: 'search', params }));
    const r = await fetch(API, { method: 'POST', body: fd, credentials: 'include' });
    return r.json();
  };
  const shape = (d, ent) => {
    const b = d?.data?.[ent];
    return b ? { total: b.total, limit: b.limit, page: b.page, pages: b.pages, count: (b.items || []).length } : null;
  };
  /* hash the first item's identity; never store the raw value */
  const fp = (d, ent) => {
    const it = d?.data?.[ent]?.items?.[0];
    if (!it) return null;
    const key = JSON.stringify(it);
    let h = 0; for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    return String(h);
  };

  const ENT = 'users';
  const out = { entity: ENT, baseline: null, candidates: [], envelopeKeys: null };

  /* baseline: limit=1 -> total(5) > limit(1) */
  const b = await call({ query: 'а', limit: 1, entities: [ENT] });
  out.baseline = shape(b, ENT);
  out.envelopeKeys = b?.data?.[ENT] ? Object.keys(b.data[ENT]) : null;
  const baseFp = fp(b, ENT);
  if (!out.baseline || out.baseline.total <= out.baseline.limit) {
    return { ...out, error: 'total<=limit, нечего пагинировать' };
  }

  for (const name of ['page', 'offset', 'from', 'skip', 'page_number', 'pageNumber']) {
    try {
      const d = await call({ query: 'а', limit: 1, entities: [ENT], [name]: 2 });
      const s = shape(d, ENT);
      const f = fp(d, ENT);
      out.candidates.push({
        param: name,
        respPage: s?.page ?? null,
        respTotal: s?.total ?? null,
        count: s?.count ?? null,
        itemChanged: (f && baseFp) ? f !== baseFp : null,
        works: !!(s && (s.page === 2 || (f && baseFp && f !== baseFp))),
      });
    } catch (e) { out.candidates.push({ param: name, error: String(e).slice(0, 80) }); }
  }

  /* for the winning param: walk pages 1..pages and check every page returns a distinct item */
  const win = out.candidates.find(c => c.works);
  if (win) {
    const seen = new Set(); const walk = [];
    for (let p = 1; p <= Math.min(out.baseline.pages, 5); p++) {
      const d = await call({ query: 'а', limit: 1, entities: [ENT], [win.param]: p });
      const s = shape(d, ENT); const f = fp(d, ENT);
      walk.push({ requestedPage: p, respPage: s?.page ?? null, count: s?.count ?? null, distinct: f ? !seen.has(f) : null });
      if (f) seen.add(f);
    }
    out.fullWalk = { param: win.param, pages: out.baseline.pages, distinctItems: seen.size, walk };
  }
  return out;
});

console.log('===== SPIKE 2 (page-param via users bucket) =====');
console.log(JSON.stringify(res, null, 2));
fs.writeFileSync(OUT, JSON.stringify({ capturedAt: new Date().toISOString(), spike2: res }, null, 2));
console.log('\n[harness] ->', OUT);
await ctx.close();
