/*
 * Capture the screenshots embedded in the README.
 *
 * Drives the real production bundle with a mocked Tauri bridge so the images
 * show actual rendering rather than a mock-up. Output goes to docs/images/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'docs', 'images');
fs.mkdirSync(OUT, { recursive: true });

const md = fs.readFileSync(path.join(ROOT, 'test', 'fixture.md'), 'utf8');

const FILES = [
  { path: '/mock/docs/README.md', name: 'README.md', rel: 'README.md', dir: '', size: 2100 },
  { path: '/mock/docs/guide/intro.md', name: 'intro.md', rel: 'guide/intro.md', dir: 'guide', size: 1840 },
  { path: '/mock/docs/guide/typography.md', name: 'typography.md', rel: 'guide/typography.md', dir: 'guide', size: 3260 },
  { path: '/mock/docs/guide/building.md', name: 'building.md', rel: 'guide/building.md', dir: 'guide', size: 980 },
];

const HITS = [
  { path: '/mock/docs/guide/typography.md', name: 'typography.md', rel: 'guide/typography.md',
    line: 9, text: '| Paragraph gap | 16px | Two thirds of the line height |', start: 2, end: 15 },
  { path: '/mock/docs/README.md', name: 'README.md', rel: 'README.md',
    line: 14, text: 'The reading rhythm is what makes a document comfortable.', start: 12, end: 25 },
  { path: '/mock/docs/guide/intro.md', name: 'intro.md', rel: 'guide/intro.md',
    line: 27, text: 'Spacing is deliberate, not incidental.', start: 8, end: 21 },
];

const CHROME = process.env.MDREADER_CHROME || '';

const ctx = await chromium.launchPersistentContext(path.join(ROOT, '.chrome-profile'), {
  viewport: { width: 1280, height: 820 },
  deviceScaleFactor: 2,
  ...(CHROME && fs.existsSync(CHROME) ? { executablePath: CHROME } : {}),
  args: ['--no-sandbox', '--disable-gpu', '--headless=old'],
});
const page = ctx.pages()[0] ?? await ctx.newPage();

await page.addInitScript(({ doc, files, hits }) => {
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd) => {
      if (cmd === 'pick_folder') return '/mock/docs';
      if (cmd === 'scan_folder') return files;
      if (cmd === 'read_document') return doc;
      if (cmd === 'search_documents') {
        return { hits, truncated: false, files_scanned: files.length };
      }
      return null;
    },
    transformCallback: (cb) => cb,
    metadata: {},
  };
}, { doc: md, files: FILES, hits: HITS });

const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, name) });
  console.log('  wrote', name);
};

await page.goto('http://localhost:4173/', { waitUntil: 'load' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1600);

await page.click('#open-folder');
await page.waitForTimeout(400);
await page.click('.tree-item >> nth=0');
await page.waitForTimeout(1400);

// 1. The reading view with the sidebar open.
await shot('screenshot-light.png');

// 2. Search results in the sidebar.
await page.fill('#filter', 'rhythm');
await page.waitForTimeout(700);
await shot('screenshot-search.png');
await page.fill('#filter', '');
await page.waitForTimeout(600);

// 3. Dark theme.
await page.click('#theme-btn');
await page.waitForTimeout(600);
await shot('screenshot-dark.png');
await page.click('#theme-btn');
await page.waitForTimeout(500);

// 4. Code and math further down the document.
await page.evaluate(() => {
  const h = [...document.querySelectorAll('#content h2')]
    .find((el) => el.textContent.trim() === 'Code');
  h?.scrollIntoView({ block: 'start' });
});
await page.waitForTimeout(900);
await shot('screenshot-code.png');

await page.evaluate(() => {
  const h = [...document.querySelectorAll('#content h2')]
    .find((el) => el.textContent.trim() === 'Math');
  h?.scrollIntoView({ block: 'start' });
});
await page.waitForTimeout(900);
await shot('screenshot-math.png');

// 5. Sidebar collapsed, column re-centred.
await page.click('#toggle-side');
await page.waitForTimeout(700);
await shot('screenshot-collapsed.png');

await ctx.close();
console.log('screenshots in', OUT);
