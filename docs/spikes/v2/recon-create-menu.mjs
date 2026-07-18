import fs from 'node:fs';
import path from 'node:path';
import { chromium, PROFILE, EXEC, initScript } from './_capture-lib.mjs';

const DIR = path.dirname(new URL(import.meta.url).pathname);
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

/* dump composer area buttons (bottom bar) */
const composer = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('button, [role=button], .ui-pressable, [data-test-tag]').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.y < 820 || r.width === 0) return;  // bottom bar only
    out.push({ tag: el.getAttribute('data-test-tag'), title: el.getAttribute('title') || el.getAttribute('aria-label'), cls: (el.className || '').toString().slice(0, 80), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  });
  return out;
});
fs.writeFileSync(path.join(DIR, 'composer-buttons.json'), JSON.stringify(composer, null, 2));
console.log('[menu] composer buttons:', composer.length);

/* click the attach (paperclip) button - try common selectors */
const attachSelectors = [
  '[data-test-tag="attach-btn"]', '[data-test-tag="input-attach"]',
  '[title*="Прикрепить"]', '[aria-label*="Прикрепить"]',
];
let clicked = false;
for (const sel of attachSelectors) {
  const loc = page.locator(sel).first();
  if (await loc.count().catch(() => 0)) { await loc.click().catch(() => {}); clicked = true; console.log('[menu] clicked attach via', sel); break; }
}
if (!clicked) { await page.mouse.click(494, 914); console.log('[menu] clicked attach by coord 494,914'); }
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(DIR, 'create-menu.png') }).catch(() => {});

/* dump any popup/menu items now visible */
const menu = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('[role=menuitem], .ui-menu__item, [class*="menu"] [class*="item"], [class*="popup"] *').forEach(el => {
    const txt = (el.textContent || '').trim();
    const r = el.getBoundingClientRect();
    if (txt && txt.length < 40 && r.width > 0 && r.height > 0) out.push({ text: txt, cls: (el.className || '').toString().slice(0, 70), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  });
  /* also any element mentioning Опрос/poll */
  document.querySelectorAll('*').forEach(el => {
    const t = (el.textContent || '').trim();
    if (/^Опрос$|Опрос|Poll/i.test(t) && t.length < 20) { const r = el.getBoundingClientRect(); if (r.width > 0) out.push({ text: t, cls: (el.className || '').toString().slice(0, 70), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), pollish: true }); }
  });
  return out;
});
fs.writeFileSync(path.join(DIR, 'create-menu.json'), JSON.stringify(menu, null, 2));
console.log('[menu] menu items:', menu.length);
console.log('[menu] pollish:', JSON.stringify(menu.filter(m => m.pollish).slice(0, 5)));
await page.waitForTimeout(4000);
await ctx.close();
console.log('[menu] done -> create-menu.png / create-menu.json / composer-buttons.json');
