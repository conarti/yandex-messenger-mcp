/**
 * Create a poll of a given type in "mcp test" and capture the outgoing create push.
 * env: TITLE, OPTS="a,b,c", ANON=1, MULTI=1, IMPORTANT=1, SILENT=1, OUT="raw-create-x.json"
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, PROFILE, EXEC, initScript, decodeAny } from './_capture-lib.mjs';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const TITLE = process.env.TITLE || 'spike';
const OPTS = (process.env.OPTS || 'a,b').split(',');
const ANON = process.env.ANON === '1';
const MULTI = process.env.MULTI === '1';
const IMPORTANT = process.env.IMPORTANT === '1';
const SILENT = process.env.SILENT === '1';
const OUT = process.env.OUT || 'raw-create.json';

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
await page.waitForTimeout(3500);

await page.mouse.click(494, 914);
await page.waitForTimeout(900);
await page.getByText('Создать опрос', { exact: false }).first().click().catch(async () => { await page.mouse.click(565, 839); });
await page.waitForTimeout(1500);

/* title */
await page.locator('input[placeholder="Введите тему"], textarea[placeholder="Введите тему"]').first().fill(TITLE).catch(async () => {
  await page.getByPlaceholder('Введите тему').first().fill(TITLE);
});
/* options: fill first two, add more as needed */
for (let i = 0; i < OPTS.length; i++) {
  if (i >= 2) { await page.getByText('Добавить вариант', { exact: false }).first().click().catch(() => {}); await page.waitForTimeout(400); }
  const ph = `Вариант ответа ${i + 1}`;
  await page.getByPlaceholder(ph).first().fill(OPTS[i]).catch(async () => {
    const inputs = page.locator('input[placeholder^="Вариант ответа"]');
    await inputs.nth(i).fill(OPTS[i]).catch(() => {});
  });
  await page.waitForTimeout(300);
}
/* toggles by label */
async function toggle(label) {
  const sw = page.getByRole('switch').filter({ hasText: label }).first();
  await sw.click({ timeout: 4000 }).catch(async () => {
    await page.getByText(label, { exact: false }).first().click().catch(() => {});
  });
  await page.waitForTimeout(400);
}
if (ANON) await toggle('Анонимное голосование');
if (MULTI) await toggle('Можно выбрать несколько ответов');
if (SILENT) await toggle('Отправить без звука');
if (IMPORTANT) await toggle('Отметить как важное');

await page.waitForTimeout(500);
await page.screenshot({ path: path.join(DIR, OUT.replace('.json', '-dialog.png')) }).catch(() => {});

/* submit */
await page.getByRole('button', { name: 'Создать опрос' }).first().click({ timeout: 5000 }).catch(async () => {
  await page.getByText('Создать опрос', { exact: true }).last().click().catch(() => {});
});
console.log('[create] submitted, waiting for push...');
await page.waitForTimeout(4000);

/* collect create push (Plain with Poll) */
const cap = await page.evaluate(() => window.__cap);
const sent = [], recv = [];
for (const s of cap.sockets) { for (const f of s.sent) if (f.b64) sent.push(f); for (const f of s.recv) if (f.b64) recv.push(f); }
const respByReq = {};
for (const f of recv) { const d = decodeAny(f); if (d.reqId != null && respByReq[d.reqId] === undefined) respByReq[d.reqId] = d.json; }

const creates = [];
for (const f of sent) {
  const d = decodeAny(f);
  if (d.method !== 'push') continue;
  const plain = d.json && d.json.ClientMessage && d.json.ClientMessage.Plain;
  if (plain && plain.Poll) creates.push({ reqId: d.reqId, plain, response: respByReq[d.reqId] ?? null });
}
fs.writeFileSync(path.join(DIR, OUT), JSON.stringify({ capturedAt: new Date().toISOString(), config: { TITLE, OPTS, ANON, MULTI, IMPORTANT, SILENT }, creates }, null, 2));

for (const c of creates) {
  console.log('\n===== CREATE PUSH (Plain) =====');
  console.log('Plain sibling keys:', JSON.stringify(Object.keys(c.plain)));
  console.log('Plain.Poll:', JSON.stringify(c.plain.Poll));
  console.log('Plain.IsImportant:', c.plain.IsImportant, '| NotificationBehaviour:', JSON.stringify(c.plain.NotificationBehaviour), '| IsSilent:', c.plain.IsSilent);
  console.log('response Status:', c.response && c.response.Status);
}
console.log('[create] wrote', OUT);
await page.waitForTimeout(2000);
await ctx.close();
console.log('[create] done.');
