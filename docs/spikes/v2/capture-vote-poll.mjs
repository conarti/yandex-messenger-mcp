/**
 * Vote on a poll identified by TITLE, capture the Vote push + poll_info read.
 * env: TITLE (poll title to target), IDX (answer index, default 0), VIEW=1 (click "view results"),
 *      OUT="raw-votepoll-x.json"
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, PROFILE, EXEC, initScript, decodeAny } from './_capture-lib.mjs';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const TITLE = process.env.TITLE || 'vote';
const IDX = Number(process.env.IDX || '0');
const EXTRA = (process.env.EXTRA || '').split(',').filter(x => x !== '').map(Number);
const VIEW = process.env.VIEW === '1';
const OUT = process.env.OUT || 'raw-votepoll.json';

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false, executablePath: EXEC, viewport: { width: 1400, height: 950 },
});
const page = ctx.pages()[0] || await ctx.newPage();
await ctx.addInitScript(initScript);
await page.goto('https://yandex.ru/chat', { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(6000);
const chat = page.getByText('mcp test', { exact: false }).first();
await chat.waitFor({ timeout: 15000 });
await chat.click();
await page.waitForTimeout(4000);

/* locate the poll-message whose title matches TITLE */
const poll = page.locator('.yamb-poll-message', { has: page.locator('.yamb-poll-message__title', { hasText: TITLE }) }).first();
await poll.scrollIntoViewIfNeeded().catch(() => {});
await page.waitForTimeout(800);
const answers = poll.locator('.yamb-poll-answer-base_clickable');
const n = await answers.count();
console.log('[vp] poll "%s" answers:', TITLE, n, '| voting idx', IDX);
await answers.nth(IDX).click();
await page.waitForTimeout(500);
for (const ei of EXTRA) { await answers.nth(ei).click(); await page.waitForTimeout(400); }
await page.waitForTimeout(300);
await poll.locator('.yamb-poll-message__button, .yamb-poll-message__vote').first().click({ timeout: 5000 }).catch(() => {});
console.log('[vp] submitted, waiting...');
await page.waitForTimeout(3500);

if (VIEW) {
  await poll.getByText('Посмотреть результаты', { exact: false }).first().click({ timeout: 4000 }).catch(e => console.log('[vp] no view-results:', e.message));
  await page.waitForTimeout(3500);
}

const cap = await page.evaluate(() => window.__cap);
const sent = [], recv = [];
for (const s of cap.sockets) { for (const f of s.sent) if (f.b64) sent.push(f); for (const f of s.recv) if (f.b64) recv.push(f); }
const respByReq = {};
for (const f of recv) { const d = decodeAny(f); if (d.reqId != null && respByReq[d.reqId] === undefined) respByReq[d.reqId] = d.json; }

const out = { capturedAt: new Date().toISOString(), title: TITLE, idx: IDX, votePush: null, pollInfo: null, pollBody: null };
for (const f of sent) {
  const d = decodeAny(f);
  if (d.method === 'push' && d.json?.ClientMessage?.Vote) out.votePush = { params: d.json.ClientMessage.Vote, response: respByReq[d.reqId] ?? null };
  if (d.method === 'poll_info') out.pollInfo = { params: d.json, response: respByReq[d.reqId] ?? null };
}
/* pull the matching poll body from any history response */
for (const f of recv) {
  const d = decodeAny(f);
  const resp = d.json; if (!resp) continue;
  const stk = [resp];
  while (stk.length) { const o = stk.pop(); if (o && typeof o === 'object') { if (o.Poll && o.Poll.Title === TITLE) { out.pollBody = o.Poll; } for (const k of Object.keys(o)) stk.push(o[k]); } }
}
fs.writeFileSync(path.join(DIR, OUT), JSON.stringify(out, null, 2));
console.log('[vp] Vote:', JSON.stringify(out.votePush?.params), '| Status:', out.votePush?.response?.Status);
console.log('[vp] poll_info resp keys:', out.pollInfo ? JSON.stringify(Object.keys(out.pollInfo.response || {})) : 'none');
console.log('[vp] wrote', OUT);
await page.screenshot({ path: path.join(DIR, OUT.replace('.json', '.png')) }).catch(() => {});
await page.waitForTimeout(2000);
await ctx.close();
console.log('[vp] done.');
