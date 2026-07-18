/**
 * SPIKE 2 diagnostic: why does search entities:["messages"] return total=0?
 * Distinguishes: (a) search API misused/broken, (b) account has no data,
 * (c) messages not indexed / need different scope.
 *
 * PRIVACY: only counts, keys, booleans. No content, no ids.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PROFILE = path.join(os.homedir(), '.config', 'yandex-messenger-mcp', 'profile');
const OUT = path.join(process.env.SPIKE_DIR || '.', 'spike-2-diag-findings.json');
const EXEC = process.env.EXEC_PATH || (os.homedir() + '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, executablePath: EXEC, viewport: { width: 1280, height: 900 } });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://yandex.ru/chat', { waitUntil: 'domcontentloaded' }).catch(e => console.log('[nav]', e.message));
await page.waitForTimeout(8000); // let app boot / session settle

const diag = await page.evaluate(async () => {
  const API = 'https://yandex.ru/messenger/api/registry/api/';
  const call = async (method, params) => {
    const fd = new FormData();
    fd.append('request', JSON.stringify({ method, params }));
    const r = await fetch(API, { method: 'POST', body: fd, credentials: 'include' });
    const j = await r.json();
    return j;
  };
  const bucketShape = (b) => b ? { total: b.total, limit: b.limit, page: b.page, pages: b.pages, count: (b.items || []).length } : null;

  const out = { searchByEntity: [], envelope: null, chatsAvailable: null, notes: [] };

  /* 1. does search work at all, per entity type? */
  for (const ent of ['messages', 'users', 'chats', 'contacts']) {
    try {
      const d = await call('search', { query: 'а', limit: 5, entities: [ent] });
      out.searchByEntity.push({
        entity: ent,
        status: d && d.status,
        dataKeys: d && d.data ? Object.keys(d.data) : null,
        shape: d && d.data ? bucketShape(d.data[ent]) : null,
      });
    } catch (e) { out.searchByEntity.push({ entity: ent, error: String(e).slice(0, 100) }); }
  }

  /* 2. full envelope for a messages search (keys only, no content) */
  try {
    const d = await call('search', { query: 'привет', limit: 5, entities: ['messages'] });
    out.envelope = {
      status: d && d.status,
      topKeys: d ? Object.keys(d) : null,
      dataKeys: d && d.data ? Object.keys(d.data) : null,
      messagesKeys: d && d.data && d.data.messages ? Object.keys(d.data.messages) : null,
      messagesShape: d && d.data ? bucketShape(d.data.messages) : null,
      warnings: d && d.data ? d.data.warnings : undefined,
    };
  } catch (e) { out.envelope = { error: String(e).slice(0, 100) }; }

  /* 3. does the account actually have chats with messages? (counts only) */
  try {
    const d = await call('get_chats_info', { chat_id: '', supported_features: ['should_return_alternative_accounts'] });
    out.chatsAvailable = { status: d && d.status, dataKeys: d && d.data ? Object.keys(d.data) : null };
  } catch (e) { out.chatsAvailable = { error: String(e).slice(0, 100) }; }

  /* 4. multi-entity at once (as web does) */
  try {
    const d = await call('search', { query: 'а', limit: 5, entities: ['messages', 'users', 'chats'] });
    out.multiEntity = {
      status: d && d.status,
      dataKeys: d && d.data ? Object.keys(d.data) : null,
      totals: d && d.data ? { messages: d.data.messages?.total, users: d.data.users?.total, chats: d.data.chats?.total } : null,
    };
  } catch (e) { out.multiEntity = { error: String(e).slice(0, 100) }; }

  return out;
});

console.log(JSON.stringify(diag, null, 2));
fs.writeFileSync(OUT, JSON.stringify({ capturedAt: new Date().toISOString(), diag }, null, 2));
console.log('\n[harness] ->', OUT);
await ctx.close();
