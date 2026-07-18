import fs from 'node:fs';
import path from 'node:path';
import { chromium, PROFILE, EXEC, initScript, decodeAny } from './_capture-lib.mjs';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false, executablePath: EXEC, viewport: { width: 1400, height: 950 },
});
const page = ctx.pages()[0] || await ctx.newPage();
await ctx.addInitScript(initScript);
console.log('[recon] navigating...');
await page.goto('https://yandex.ru/chat', { waitUntil: 'domcontentloaded' }).catch(e => console.log('[nav]', e.message));
await page.waitForTimeout(6000);

/* find + open "mcp test" chat */
let opened = false;
try {
  const loc = page.getByText('mcp test', { exact: false }).first();
  await loc.waitFor({ timeout: 15000 });
  await loc.click();
  opened = true;
  console.log('[recon] clicked "mcp test"');
} catch (e) { console.log('[recon] could not click chat by text:', e.message); }
await page.waitForTimeout(4000);

await page.screenshot({ path: path.join(DIR, 'recon-chat.png'), fullPage: false }).catch(e => console.log('[shot]', e.message));

/* dump poll-ish DOM: elements with data-test-tag or containing option text */
const dom = await page.evaluate(() => {
  const out = { testTags: [], pollCandidates: [], composerButtons: [] };
  const seen = new Set();
  document.querySelectorAll('[data-test-tag]').forEach(el => {
    const tag = el.getAttribute('data-test-tag');
    if (tag && !seen.has(tag)) { seen.add(tag); out.testTags.push(tag); }
  });
  /* poll candidates: elements whose direct text is a bare option number or contains 'vote' */
  document.querySelectorAll('*').forEach(el => {
    const txt = (el.textContent || '').trim();
    const cls = el.className && el.className.toString ? el.className.toString() : '';
    if (/poll|vote|opros|answer/i.test(cls)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.pollCandidates.push({ cls: cls.slice(0, 120), tag: el.getAttribute('data-test-tag'), text: txt.slice(0, 40), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) });
    }
  });
  return out;
});
fs.writeFileSync(path.join(DIR, 'recon-dom.json'), JSON.stringify(dom, null, 2));
console.log('[recon] testTags count:', dom.testTags.length);
console.log('[recon] testTags sample:', JSON.stringify(dom.testTags.filter(t => /poll|vote|answer|opros/i.test(t))));
console.log('[recon] pollCandidates:', dom.pollCandidates.length);

/* dump captured outgoing methods so far (subscribe/history/etc) */
const cap = await page.evaluate(() => window.__cap).catch(() => ({ sockets: [], http: [] }));
const methods = new Set();
for (const s of cap.sockets) for (const f of s.sent) { if (!f.b64) continue; const d = decodeAny(f); if (d.method) methods.add(d.method); }
console.log('[recon] outgoing WS methods seen:', JSON.stringify([...methods]));
console.log('[recon] http captured:', cap.http.length);

console.log('[recon] leaving open 5s...');
await page.waitForTimeout(5000);
await ctx.close();
console.log('[recon] done. screenshot -> recon-chat.png ; dom -> recon-dom.json');
