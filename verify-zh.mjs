import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
const ROOT = '/home/neeq/test/dsh-mdviewer';
const md = fs.readFileSync(path.join(ROOT, 'README.zh.md'), 'utf8');
const ctx = await chromium.launchPersistentContext(path.join(ROOT, '.chrome-profile'), {
  viewport: { width: 1280, height: 900 },
  args: ['--no-sandbox', '--disable-gpu', '--headless=old'],
});
const page = ctx.pages()[0] ?? await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.addInitScript(({ doc }) => {
  window.__TAURI_INTERNALS__ = { invoke: async (cmd) => {
    if (cmd === 'pick_folder') return '/mock/docs';
    if (cmd === 'scan_folder') return [
      { path: '/mock/docs/README.zh.md', name: 'README.zh.md', rel: 'README.zh.md', dir: '', size: 6168 }];
    if (cmd === 'read_document') return doc;
    if (cmd === 'search_documents') return { hits: [], truncated: false, files_scanned: 1 };
    return null;
  }, transformCallback: (cb) => cb, metadata: {} };
}, { doc: md });
await page.goto('http://localhost:4173/', { waitUntil: 'load' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1500);
await page.click('#open-folder');
await page.waitForTimeout(400);
await page.click('.tree-item');
await page.waitForTimeout(1200);
const stats = await page.evaluate(() => ({
  h1: document.querySelectorAll('#content h1').length,
  h2: document.querySelectorAll('#content h2').length,
  tables: document.querySelectorAll('#content table').length,
  code: document.querySelectorAll('#content .code-block').length,
  toc: document.querySelectorAll('#toc a').length,
}));
console.log('rendered:', JSON.stringify(stats));
console.log('page errors:', errs.length ? errs : 'none');
await page.screenshot({ path: path.join(ROOT, 'test-output', '12-readme-zh.png') });
await ctx.close();
