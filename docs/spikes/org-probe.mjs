/**
 * Why is this (logged-in) account's messenger empty?
 * Hypothesis: chats live under a Yandex 360 organization -> need X-Ya-Organization-Id (§13.3),
 * or the personal messenger genuinely has no chats.
 *
 * PRIVACY: counts / ids-presence / error codes only. No chat names, no message text.
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PROFILE = path.join(os.homedir(), '.config', 'yandex-messenger-mcp', 'profile');
const EXEC = process.env.EXEC_PATH || (os.homedir() + '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, executablePath: EXEC, viewport: { width: 1360, height: 950 } });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://yandex.ru/chat', { waitUntil: 'domcontentloaded' }).catch(e => console.log('[nav]', e.message));
await page.waitForTimeout(10000);

const r = await page.evaluate(async () => {
  const BASE = 'https://yandex.ru/messenger/api/registry';
  const API = BASE + '/api/';
  let csrf = null;
  try { csrf = (await (await fetch(BASE + '/csrf-token/', { method: 'POST', credentials: 'include' })).json())?.token ?? null; } catch {}

  const post = async (method, params, orgId) => {
    const fd = new FormData();
    fd.append('request', JSON.stringify(params === undefined ? { method } : { method, params }));
    const headers = {};
    if (csrf) headers['X-CSRF-TOKEN'] = csrf;
    if (orgId) headers['X-Ya-Organization-Id'] = String(orgId);
    const res = await fetch(API, { method: 'POST', body: fd, credentials: 'include', headers });
    return res.json();
  };

  const out = {};

  /* 1. organizations */
  try {
    const d = await post('get_organizations', {});
    const orgs = d?.data?.organizations ?? d?.data;
    out.organizations = {
      status: d?.status,
      dataKeys: d?.data ? Object.keys(d.data) : null,
      count: Array.isArray(orgs) ? orgs.length : null,
      ids: Array.isArray(orgs) ? orgs.map(o => o?.id ?? o?.org_id ?? null).filter(Boolean) : null,
      errBody: d?.status === 'error' ? d?.data : undefined,
    };
  } catch (e) { out.organizations = { error: String(e).slice(0, 120) }; }

  /* 2. why does get_current_user_data error, even with csrf? */
  try {
    const d = await post('get_current_user_data', undefined);
    out.currentUserErr = { status: d?.status, body: d?.status === 'error' ? d?.data : { ok: true, keys: Object.keys(d?.data || {}).slice(0, 15) } };
  } catch (e) { out.currentUserErr = { error: String(e).slice(0, 120) }; }
  try {
    const d = await post('get_current_user_data', {});
    out.currentUserWithEmptyParams = { status: d?.status, body: d?.status === 'error' ? d?.data : { ok: true, keys: Object.keys(d?.data || {}).slice(0, 15) } };
  } catch (e) { out.currentUserWithEmptyParams = { error: String(e).slice(0, 120) }; }

  /* 3. search chats per org (if any) */
  out.searchPerOrg = [];
  const orgIds = out.organizations?.ids || [];
  for (const oid of [null, ...orgIds]) {
    try {
      const d = await post('search', { query: 'а', limit: 5, entities: ['chats', 'messages'] }, oid);
      out.searchPerOrg.push({ org: oid ?? 'none', chats: d?.data?.chats?.total ?? null, messages: d?.data?.messages?.total ?? null });
    } catch (e) { out.searchPerOrg.push({ org: oid ?? 'none', error: String(e).slice(0, 80) }); }
  }

  /* 4. recommended chats = cheap "does this account see any chat at all" */
  try {
    const d = await post('get_recommended_chats', { limit: 10 });
    out.recommendedChats = { status: d?.status, count: Array.isArray(d?.data?.chats) ? d.data.chats.length : null };
  } catch (e) { out.recommendedChats = { error: String(e).slice(0, 100) }; }

  /* 5. empty-state detection: UI chrome only, truncated hard */
  out.uiHint = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 160);
  return out;
});

console.log(JSON.stringify(r, null, 2));
await ctx.close();
