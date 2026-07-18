/**
 * General capture: open "mcp test", optionally click a selector, dump ALL outgoing
 * WS methods + matched responses (by reqId) + HTTP. Raw/unredacted -> OUT file.
 * env: CLICK="<css selector>"  OUT="raw-x.json"  WAIT_MS=4000  CLICK2="<sel>"
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, PROFILE, EXEC, initScript, decodeAny } from './_capture-lib.mjs';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const OUT = process.env.OUT || 'raw-all.json';
const CLICK = process.env.CLICK || '';
const CLICK2 = process.env.CLICK2 || '';
const WAIT_MS = Number(process.env.WAIT_MS || '4000');

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false, executablePath: EXEC, viewport: { width: 1400, height: 950 },
});
const page = ctx.pages()[0] || await ctx.newPage();
await ctx.addInitScript(initScript);
await page.goto('https://yandex.ru/chat', { waitUntil: 'domcontentloaded' }).catch(e => console.log('[nav]', e.message));
await page.waitForTimeout(6000);
const chat = page.getByText('mcp test', { exact: false }).first();
await chat.waitFor({ timeout: 15000 });
await chat.click();
await page.waitForTimeout(4500);

if (CLICK) {
  console.log('[all] clicking', CLICK);
  await page.locator(CLICK).first().click({ timeout: 6000 }).catch(e => console.log('[click err]', e.message));
  await page.waitForTimeout(WAIT_MS);
}
if (CLICK2) {
  console.log('[all] clicking2', CLICK2);
  await page.locator(CLICK2).first().click({ timeout: 6000 }).catch(e => console.log('[click2 err]', e.message));
  await page.waitForTimeout(WAIT_MS);
}
await page.waitForTimeout(1500);

const cap = await page.evaluate(() => window.__cap);
const sent = [], recv = [];
for (const s of cap.sockets) { for (const f of s.sent) if (f.b64) sent.push(f); for (const f of s.recv) if (f.b64) recv.push(f); }
const respByReq = {};
for (const f of recv) { const d = decodeAny(f); if (d.reqId != null && respByReq[d.reqId] === undefined) respByReq[d.reqId] = d.json; }

const calls = [];
for (const f of sent) {
  const d = decodeAny(f);
  if (!d.method) continue;
  calls.push({ reqId: d.reqId, method: d.method, params: d.json, response: respByReq[d.reqId] ?? null });
}
const out = { capturedAt: new Date().toISOString(), calls, http: cap.http };
fs.writeFileSync(path.join(DIR, OUT), JSON.stringify(out, null, 2));

const methodCounts = {};
for (const c of calls) methodCounts[c.method] = (methodCounts[c.method] || 0) + 1;
console.log('[all] methods:', JSON.stringify(methodCounts));
console.log('[all] http:', cap.http.length, cap.http.map(h => h.method + ' ' + h.url.replace(/\/\/[^/]+/, '//<host>')).slice(0, 8));
console.log('[all] wrote', OUT);
await page.screenshot({ path: path.join(DIR, OUT.replace('.json', '.png')) }).catch(() => {});
await page.waitForTimeout(2000);
await ctx.close();
console.log('[all] done.');
