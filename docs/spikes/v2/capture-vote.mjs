import fs from 'node:fs';
import path from 'node:path';
import { chromium, PROFILE, EXEC, initScript, decodeAny } from './_capture-lib.mjs';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const OPTION_INDEX = Number(process.env.OPT ?? '0');          // which answer to select (0-based)
const SELECT_EXTRA = (process.env.EXTRA ?? '').split(',').filter(x => x !== '').map(Number); // extra indexes for multi

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
await page.waitForTimeout(4000);

/* mark capture boundary: remember current sent-frame count */
const before = await page.evaluate(() => (window.__cap.sockets.reduce((n, s) => n + s.sent.length, 0)));
console.log('[vote] sent frames before action:', before);

/* select answer(s) then submit */
const answers = page.locator('.yamb-poll-answer-base_clickable');
const n = await answers.count();
console.log('[vote] answers found:', n, '| selecting index', OPTION_INDEX, 'extra', JSON.stringify(SELECT_EXTRA));
await answers.nth(OPTION_INDEX).click();
await page.waitForTimeout(600);
for (const ei of SELECT_EXTRA) { await answers.nth(ei).click(); await page.waitForTimeout(400); }

const submit = page.locator('.yamb-poll-message__button, .yamb-poll-message__vote').first();
await submit.click({ timeout: 5000 }).catch(async () => {
  /* fallback: coordinate click at the button */
  await page.mouse.click(1170, 790);
});
console.log('[vote] submit clicked, waiting for push+response...');
await page.waitForTimeout(4000);

/* collect ALL frames after boundary, decode raw */
const cap = await page.evaluate(() => window.__cap);
const allSent = [];
for (const s of cap.sockets) for (const f of s.sent) if (f.b64) allSent.push(f);
const allRecv = [];
for (const s of cap.sockets) for (const f of s.recv) if (f.b64) allRecv.push(f);

/* find push frames whose body has Vote (or Poll) */
const pushes = [];
for (const f of allSent) {
  const d = decodeAny(f);
  if (d.method !== 'push') continue;
  const cm = d.json && d.json.ClientMessage;
  const hasVote = cm && (cm.Vote || cm.Poll || cm.Plain?.Poll);
  pushes.push({ reqId: d.reqId, method: d.method, hasVote: !!hasVote, cmKeys: cm ? Object.keys(cm) : null, json: d.json, t: f.t });
}
const votePushes = pushes.filter(p => p.hasVote);
console.log('[vote] total push frames:', pushes.length, '| vote-bearing:', votePushes.length);
console.log('[vote] push cmKeys seen:', JSON.stringify(pushes.map(p => p.cmKeys)));

/* match responses by reqId */
const respByReq = {};
for (const f of allRecv) {
  const d = decodeAny(f);
  if (d.reqId != null) respByReq[d.reqId] = d.json;
}

const raw = { capturedAt: new Date().toISOString(), votePushes, responses: {} };
for (const p of votePushes) raw.responses[p.reqId] = respByReq[p.reqId] ?? null;
/* also dump ALL push envelopes (for envelope shape) even non-vote */
raw.allPushEnvelopes = pushes.map(p => ({ reqId: p.reqId, cmKeys: p.cmKeys, json: p.json, response: respByReq[p.reqId] ?? null }));
fs.writeFileSync(path.join(DIR, 'raw-vote.json'), JSON.stringify(raw, null, 2));
console.log('[vote] wrote raw-vote.json (RAW, unredacted - delete after extraction)');

/* print vote push shape immediately */
for (const p of votePushes) {
  console.log('\n===== VOTE PUSH =====');
  console.log('reqId:', p.reqId, 'cmKeys:', JSON.stringify(p.cmKeys));
  console.log('ClientMessage.Vote:', JSON.stringify(p.json?.ClientMessage?.Vote));
  console.log('full envelope top keys:', JSON.stringify(Object.keys(p.json || {})));
  console.log('response:', JSON.stringify(raw.responses[p.reqId]));
}

await page.screenshot({ path: path.join(DIR, 'after-vote.png') }).catch(() => {});
await page.waitForTimeout(2500);
await ctx.close();
console.log('[vote] done.');
