/**
 * SPIKE 2 decisive test: what do `total` / `pages` actually mean?
 *
 * Observed: users q="а" limit=5 -> total=5 ; limit=1 -> total=1, pages=1.
 * Hypothesis A: total == number of items returned (== min(limit, real)) -> the
 *   page-based pagination inferred in §3.3 is a misreading; paging is done by `limit`.
 * Hypothesis B: total is the real match count and the account really has 1 / 5.
 *
 * Sweep limit and see whether total tracks limit. If total plateaus at N < limit,
 * that N is the real count (Hypothesis B for that query).
 *
 * PRIVACY: only numbers. No names, no ids, no content.
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
  const b = (d, e) => {
    const x = d?.data?.[e];
    return x ? { total: x.total, limit: x.limit, page: x.page, pages: x.pages, count: (x.items || []).length } : null;
  };

  const out = { sweeps: [], pageParamOnDeepBucket: [] };

  /* 1. sweep limit for users (known to have >=5 matches for "а") */
  for (const lim of [1, 2, 3, 5, 10, 20, 50, 100]) {
    const d = await call({ query: 'а', limit: lim, entities: ['users'] });
    out.sweeps.push({ entity: 'users', reqLimit: lim, ...(b(d, 'users') || { null: true }) });
  }

  /* 2. sweep limit without the limit param at all (default per §3.3 = 10) */
  const dDef = await call({ query: 'а', entities: ['users'] });
  out.noLimitParam = b(dDef, 'users');

  /* 3. if a limit sweep shows a real plateau N, try page-param at limit=1 against that bucket */
  const plateau = (() => {
    const s = out.sweeps.filter(x => typeof x.total === 'number');
    for (let i = 1; i < s.length; i++) if (s[i].total === s[i - 1].total && s[i].reqLimit > s[i - 1].reqLimit) return s[i].total;
    return null;
  })();
  out.realCountPlateau = plateau;

  if (plateau && plateau > 1) {
    const base = await call({ query: 'а', limit: 1, entities: ['users'] });
    const fpOf = (d) => { const it = d?.data?.users?.items?.[0]; if (!it) return null; const k = JSON.stringify(it); let h = 0; for (let i = 0; i < k.length; i++) h = ((h << 5) - h + k.charCodeAt(i)) | 0; return String(h); };
    const baseFp = fpOf(base);
    for (const name of ['page', 'offset', 'from', 'skip', 'page_number']) {
      const d = await call({ query: 'а', limit: 1, entities: ['users'], [name]: 2 });
      const s = b(d, 'users');
      const f = fpOf(d);
      out.pageParamOnDeepBucket.push({
        param: name, respPage: s?.page ?? null, respTotal: s?.total ?? null,
        itemChanged: (f && baseFp) ? f !== baseFp : null,
        works: !!(s && (s.page === 2 || (f && baseFp && f !== baseFp))),
      });
    }
  }
  return out;
});

console.log('===== SPIKE 2: limit sweep =====');
console.log(JSON.stringify(res, null, 2));
fs.writeFileSync(OUT, JSON.stringify({ capturedAt: new Date().toISOString(), spike2LimitSweep: res }, null, 2));
console.log('\n[harness] ->', OUT);
await ctx.close();
