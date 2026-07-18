/**
 * Wire-level test: does poll_info hide voters for an ANONYMOUS poll?
 * Capture a real poll_info frame (from the non-anon "vote" poll's view-results),
 * then replay a crafted poll_info frame targeting the anon poll and read the response.
 * This is a READ (ReturnResults) on the user's own test chat.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, PROFILE, EXEC, initScript, decodeFrame, decodeAny } from './_capture-lib.mjs';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const CHAT_ID = process.env.CHAT_ID;                 // required
const ANON_TS = Number(process.env.ANON_TS);         // required: anon poll message Timestamp
const NEW_REQ = 2000000001;

function buildFrame(serviceIndex, reqId, method, jsonObj) {
  const parts = [0x01, 0x93];
  if (serviceIndex < 0x80) parts.push(serviceIndex); else { parts.push(0xcc, serviceIndex & 0xff); }
  parts.push(0xce, (reqId >>> 24) & 0xff, (reqId >>> 16) & 0xff, (reqId >>> 8) & 0xff, reqId & 0xff);
  const mb = Buffer.from(method, 'utf8');
  parts.push(0xa0 | mb.length); for (const b of mb) parts.push(b);
  parts.push(0x05); for (let i = 0; i < 11; i++) parts.push(0x00);
  const jb = Buffer.from(JSON.stringify(jsonObj), 'utf8'); for (const b of jb) parts.push(b);
  return parts;
}

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

/* trigger a real poll_info: click view-results on the non-anon "vote" poll */
const votePoll = page.locator('.yamb-poll-message', { has: page.locator('.yamb-poll-message__title', { hasText: 'vote' }) }).first();
await votePoll.scrollIntoViewIfNeeded().catch(() => {});
await votePoll.getByText('Посмотреть результаты', { exact: false }).first().click({ timeout: 5000 }).catch(e => console.log('[anon] view-results click:', e.message));
await page.waitForTimeout(3000);

/* find the real poll_info frame, get serviceIndex */
let serviceIndex = null, realBody = null;
const capSent = await page.evaluate(() => window.__cap.sockets.flatMap(s => s.sent.filter(f => f.b64).map(f => f.b64)));
for (const b64 of capSent) { const d = decodeFrame(b64); if (d.method === 'poll_info') { serviceIndex = d.serviceIndex; realBody = d.json; } }
console.log('[anon] real poll_info serviceIndex:', serviceIndex, '| body keys:', realBody ? JSON.stringify(Object.keys(realBody)) : null);
if (serviceIndex == null) { console.log('[anon] no real poll_info captured, aborting'); await ctx.close(); process.exit(1); }

/* craft + send poll_info for the anon poll */
const body = { RequestId: randomUUID(), ChatId: CHAT_ID, Timestamp: ANON_TS, Limit: 10, ReturnResults: true };
const frame = buildFrame(serviceIndex, NEW_REQ, 'poll_info', body);
const sendRes = await page.evaluate((arr) => window.__sendRaw(arr), frame);
console.log('[anon] sendRaw ->', sendRes, '| waiting for response reqId', NEW_REQ);
await page.waitForTimeout(4000);

/* find response with our reqId */
const capRecv = await page.evaluate(() => window.__cap.sockets.flatMap(s => s.recv.filter(f => f.b64).map(f => ({ kind: f.kind, b64: f.b64 }))));
let anonResp = null;
for (const f of capRecv) { const d = decodeAny(f); if (d.reqId === NEW_REQ) anonResp = d.json; }
fs.writeFileSync(path.join(DIR, 'raw-anon-pollinfo.json'), JSON.stringify({ sentBody: { ...body, RequestId: '<uuid>', ChatId: '<chatId>' }, serviceIndex, response: anonResp }, null, 2));
console.log('\n===== ANON poll_info RESPONSE =====');
console.log(JSON.stringify(anonResp, null, 1));
await page.waitForTimeout(2000);
await ctx.close();
console.log('[anon] done -> raw-anon-pollinfo.json');
