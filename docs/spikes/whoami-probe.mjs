/**
 * Diagnostic: which account is the Playwright profile logged into, and does it have chats?
 * Needed to interpret SPIKE 2's total=0 across all entities.
 * Shows the user their OWN identity so they can confirm it's the right account.
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PROFILE = path.join(os.homedir(), '.config', 'yandex-messenger-mcp', 'profile');
const EXEC = process.env.EXEC_PATH || (os.homedir() + '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, executablePath: EXEC, viewport: { width: 1280, height: 900 } });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://yandex.ru/chat', { waitUntil: 'domcontentloaded' }).catch(e => console.log('[nav]', e.message));
await page.waitForTimeout(9000);

const r = await page.evaluate(async () => {
  const API = 'https://yandex.ru/messenger/api/registry/api/';
  const call = async (method, params) => {
    const fd = new FormData();
    fd.append('request', JSON.stringify({ method, params }));
    const res = await fetch(API, { method: 'POST', body: fd, credentials: 'include' });
    return res.json();
  };
  const out = {};
  try {
    const d = await call('get_current_user_data', undefined);
    const u = d && d.data;
    out.currentUser = u ? {
      status: d.status,
      displayName: u.display_name ?? u.displayName ?? null,
      nickname: u.nickname ?? null,
      hasPhone: !!(u.phone || u.phone_id),
      keys: Object.keys(u).slice(0, 20),
    } : { status: d && d.status, raw: d && d.data ? 'present' : 'absent' };
  } catch (e) { out.currentUser = { error: String(e).slice(0, 120) }; }

  /* is the user logged in at page level? */
  out.pageUrl = location.href;
  out.looksLoggedIn = !/passport\.yandex|auth/.test(location.href);

  /* count chat-list rows in the DOM (best-effort selectors) */
  const counts = {};
  for (const sel of ['[data-testid*="chat"]', '[class*="chatlist" i] li', '[class*="ChatList" i] a', 'a[href*="/chat#/chats/"]', '[role="listitem"]']) {
    try { counts[sel] = document.querySelectorAll(sel).length; } catch {}
  }
  out.domChatCounts = counts;
  out.bodyTextLen = document.body ? document.body.innerText.length : 0;
  return out;
});

console.log(JSON.stringify(r, null, 2));
await ctx.close();
