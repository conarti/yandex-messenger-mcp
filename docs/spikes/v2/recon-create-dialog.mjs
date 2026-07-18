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

await page.mouse.click(494, 914);          // attach
await page.waitForTimeout(1000);
await page.getByText('Создать опрос', { exact: false }).first().click().catch(async () => { await page.mouse.click(565, 839); });
await page.waitForTimeout(2000);
await page.screenshot({ path: path.join(DIR, 'create-dialog.png') }).catch(() => {});

const dlg = await page.evaluate(() => {
  const out = { inputs: [], toggles: [], texts: [], buttons: [] };
  document.querySelectorAll('input, textarea, [contenteditable=true]').forEach(el => {
    const r = el.getBoundingClientRect();
    out.inputs.push({ type: el.type || el.tagName.toLowerCase(), placeholder: el.placeholder || el.getAttribute('data-placeholder') || '', name: el.name || '', checked: el.checked, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) });
  });
  document.querySelectorAll('[role=switch], [role=checkbox], .ui-switch, .ui-toggle, [class*="switch"], [class*="toggle"], [class*="checkbox"]').forEach(el => {
    const r = el.getBoundingClientRect(); if (r.width === 0) return;
    out.toggles.push({ cls: (el.className || '').toString().slice(0, 80), role: el.getAttribute('role'), ariaChecked: el.getAttribute('aria-checked'), text: (el.textContent || '').trim().slice(0, 40), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  });
  document.querySelectorAll('button, .ui-button, [class*="button"]').forEach(el => {
    const r = el.getBoundingClientRect(); const t = (el.textContent || '').trim();
    if (r.width > 0 && t && t.length < 40) out.buttons.push({ text: t, cls: (el.className || '').toString().slice(0, 60), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  });
  /* any label/text mentioning settings */
  document.querySelectorAll('label, [class*="poll"] *, [class*="modal"] *, [class*="dialog"] *').forEach(el => {
    const t = (el.textContent || '').trim();
    if (t && t.length < 50 && /анонимн|несколько|вариант|голос|ответ|настройк|можно выбрать|один|множеств/i.test(t)) {
      const r = el.getBoundingClientRect(); if (r.width > 0) out.texts.push({ text: t, cls: (el.className || '').toString().slice(0, 60), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    }
  });
  return out;
});
fs.writeFileSync(path.join(DIR, 'create-dialog.json'), JSON.stringify(dlg, null, 2));
console.log('[dlg] inputs:', dlg.inputs.length, 'toggles:', dlg.toggles.length, 'texts:', dlg.texts.length);
console.log('[dlg] toggles:', JSON.stringify(dlg.toggles.slice(0, 12), null, 1));
console.log('[dlg] texts:', JSON.stringify([...new Set(dlg.texts.map(t => t.text))]));
console.log('[dlg] buttons:', JSON.stringify([...new Set(dlg.buttons.map(b => b.text))]));
await page.waitForTimeout(4000);
await ctx.close();
console.log('[dlg] done -> create-dialog.png / create-dialog.json');
