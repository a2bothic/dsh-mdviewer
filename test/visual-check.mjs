/*
 * Visual + DOM verification of the Tauri frontend in a real Chromium.
 *
 * The Tauri IPC layer does not exist in a plain browser, so a minimal mock is
 * installed before the app module loads. Everything else — marked, shiki,
 * KaTeX, DOMPurify and the CSS — is the real production bundle.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

// Resolve everything relative to this file so the suite runs anywhere,
// including CI, rather than depending on a developer's checkout path.
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'test-output');
fs.mkdirSync(OUT, { recursive: true });

const md = fs.readFileSync(path.join(ROOT, 'test', 'fixture.md'), 'utf8');

// Point the launcher at a specific browser when one is supplied; otherwise
// let Playwright resolve the one it installed.
const CHROME = process.env.MDREADER_CHROME || '';
// A writable profile directory is required in this environment, which means
// the persistent-context API rather than launch().
//
// `--headless=old` works around a crashpad failure in the sandboxed container
// this suite was developed in. It is opt-in via MDREADER_HEADLESS_OLD so CI
// uses Playwright's normal headless mode.
const args = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
if (process.env.MDREADER_HEADLESS_OLD === '1') args.push('--headless=old');

const context = await chromium.launchPersistentContext(
  path.join(ROOT, '.chrome-profile'),
  {
    ...(CHROME && fs.existsSync(CHROME) ? { executablePath: CHROME } : {}),
    viewport: { width: 1280, height: 900 },
    args,
  },
);
const page = context.pages()[0] ?? await context.newPage();

const errors = [];
page.on('console', (m) => {
  // A missing favicon is not an application error.
  if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text());
});
page.on('response', (r) => {
  if (r.status() >= 400 && !r.url().includes('favicon')) {
    errors.push(`HTTP ${r.status()} ${r.url()}`);
  }
});
page.on('pageerror', (e) => errors.push(String(e)));

// Mock the Tauri bridge before any module code runs.
await page.addInitScript(({ doc }) => {
  // eslint-disable-next-line
  const invoke = async (cmd, args) => {
    if (cmd === 'pick_folder') return '/mock/docs';
    if (cmd === 'scan_folder') {
      return [
        { path: '/mock/docs/guide/intro.md', name: 'intro.md', rel: 'guide/intro.md', dir: 'guide', size: 1200 },
        { path: '/mock/docs/guide/setup.md', name: 'setup.md', rel: 'guide/setup.md', dir: 'guide', size: 3400 },
        { path: '/mock/docs/README.md', name: 'README.md', rel: 'README.md', dir: '', size: 800 },
      ];
    }
    if (cmd === 'read_document') return doc;
    if (cmd === 'search_documents') {
      return {
        hits: [
          { path: '/mock/docs/README.md', name: 'README.md', rel: 'README.md', line: 3,
            text: 'A paragraph that mentions typography and rhythm.', start: 26, end: 36 },
          { path: '/mock/docs/guide/setup.md', name: 'setup.md', rel: 'guide/setup.md', line: 12,
            text: '…the typography section explains it…', start: 5, end: 15 },
        ],
        truncated: false, files_scanned: 3,
      };
    }
    throw new Error('unmocked command: ' + cmd);
  };
  window.__TAURI_INTERNALS__ = { invoke, transformCallback: (cb) => cb, metadata: {} };
  // plugin-opener resolves through the same bridge.
  window.__TAURI_INTERNALS__.plugins = {};
}, { doc: md });

await page.goto('http://localhost:4173/', { waitUntil: 'load' });
await page.waitForTimeout(1500);

// The persistent profile carries preferences (theme, sidebar, splitter) across
// runs, so clear them and reload to guarantee a known starting state.
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1500);

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

// Sidebar renders the welcome state before a folder is opened.
check('welcome visible', await page.locator('#welcome').isVisible());
await page.screenshot({ path: path.join(OUT, '01-welcome.png') });

// Open a folder through the mocked picker.
await page.click('#open-folder');
await page.locator('.tree-item').first().waitFor({ state: 'visible', timeout: 10000 });
const treeCount = await page.locator('.tree-item').count();
check('file tree populated', treeCount === 3, `${treeCount} items`);
check('tree groups by dir', (await page.locator('.tree-dir').count()) === 1);

// Open a document, then wait for the async highlighter to colour a token
// rather than sleeping a fixed amount.
await page.click('.tree-item >> nth=0');
await page.locator('#content h1').first().waitFor({ state: 'visible', timeout: 10000 });
await page.locator('#content span[style*="color"]').first()
  .waitFor({ state: 'attached', timeout: 15000 });

check('content visible', await page.locator('#content').isVisible());
check('h1 rendered', (await page.locator('#content h1').count()) >= 1);
const tocCount = await page.locator('#toc a').count();
check('toc populated', tocCount >= 5, `${tocCount} entries`);
// Every heading in the fixture must reach the table of contents.
const headingCount = await page.locator('#content h1, #content h2, #content h3, #content h4').count();
check('toc lists every heading', tocCount === headingCount,
  `toc=${tocCount} headings=${headingCount}`);

// Shiki highlighting present in the DOM.
const tokens = await page.locator('#content span[style*="color"]').count();
check('shiki tokens', tokens > 40, `${tokens} tokens`);

// KaTeX rendered and laid out (not just present in markup).
const katexCount = await page.locator('#content .katex').count();
check('katex rendered', katexCount >= 1, `${katexCount} nodes`);
const katexBox = await page.locator('#content .katex').first().boundingBox();
check('katex has layout', !!katexBox && katexBox.width > 5 && katexBox.height > 5,
  katexBox ? `${Math.round(katexBox.width)}x${Math.round(katexBox.height)}` : 'no box');

// Typography: verify the DSH rhythm actually applies.
const pStyle = await page.locator('#content p').nth(1).evaluate((el) => {
  const cs = getComputedStyle(el);
  return { marginTop: cs.marginTop, lineHeight: cs.lineHeight, fontSize: cs.fontSize };
});
check('paragraph gap is 16px', pStyle.marginTop === '16px', pStyle.marginTop);
check('line height is 24px', pStyle.lineHeight === '24px', pStyle.lineHeight);

const h2Style = await page.locator('#content h2').first().evaluate((el) => {
  const cs = getComputedStyle(el);
  return { marginTop: cs.marginTop, marginBottom: cs.marginBottom, weight: cs.fontWeight };
});
check('heading gap 32/16', h2Style.marginTop === '32px' && h2Style.marginBottom === '16px',
  `${h2Style.marginTop}/${h2Style.marginBottom}`);
check('heading weight 700', h2Style.weight === '700', h2Style.weight);

const listStyle = await page.locator('#content ul').first().evaluate((el) => ({
  paddingLeft: getComputedStyle(el).paddingLeft,
  margin: getComputedStyle(el).marginTop,
}));
check('list indent 18px', listStyle.paddingLeft === '18px', listStyle.paddingLeft);

const strongWeight = await page.locator('#content strong').first().evaluate(
  (el) => getComputedStyle(el).fontWeight);
check('bold weight 600', strongWeight === '600', strongWeight);

// Defaults: the column starts at Wide (52rem) and the label must agree.
const colWidth = await page.locator('#content').evaluate((el) => el.getBoundingClientRect().width);
check('reading measure defaults to Wide (52rem)', Math.abs(colWidth - 832) < 40,
  `${Math.round(colWidth)}px`);
check('width button shows Wide',
  (await page.locator('#width-btn').textContent())?.trim() === 'Wide');
check('font button shows M',
  (await page.locator('#font-btn').textContent())?.trim() === 'M');
const defFont = await page.locator('#content p').nth(1).evaluate(
  (el) => getComputedStyle(el).fontSize);
check('text size defaults to 16px', defFont === '16px', defFont);

await page.screenshot({ path: path.join(OUT, '02-document-light.png') });
await page.screenshot({ path: path.join(OUT, '02-document-light-full.png'), fullPage: true });

// Search.
await page.fill('#filter', 'typography');
await page.waitForTimeout(600);
const hits = await page.locator('.hit').count();
check('search returns hits', hits === 2, `${hits} hits`);
check('search highlights match', (await page.locator('.hit mark').count()) === 2);
const marked = await page.locator('.hit mark').allTextContents();
check('highlight points at the query', marked[0]?.toLowerCase() === 'typography',
  JSON.stringify(marked));
check('sidebar title reflects search',
  (await page.locator('#side-title').textContent())?.includes('Search'));
await page.screenshot({ path: path.join(OUT, '03-search.png') });

// Clear search restores the tree.
await page.fill('#filter', '');
await page.waitForTimeout(500);
check('clearing search restores tree', (await page.locator('.tree-item').count()) === 3);

// Dark theme (state was cleared at the start, so this always starts light).
await page.click('#theme-btn');
await page.waitForTimeout(500);
check('dark theme applied',
  await page.locator('html').evaluate((el) => el.classList.contains('theme-dark')));
await page.screenshot({ path: path.join(OUT, '04-document-dark.png') });

// Font size control scales the rhythm.
const before = await page.locator('#content p').nth(1).evaluate(
  (el) => getComputedStyle(el).fontSize);
await page.click('#font-btn');
await page.waitForTimeout(300);
const after = await page.locator('#content p').nth(1).evaluate(
  (el) => getComputedStyle(el).fontSize);
check('font size control works', before !== after, `${before} -> ${after}`);

// Width control: from the Wide default one click lands on Full.
const wideBefore = await page.locator('#content').evaluate((el) => el.getBoundingClientRect().width);
await page.click('#width-btn');
await page.waitForTimeout(300);
const wideCol = await page.locator('#content').evaluate((el) => el.getBoundingClientRect().width);
check('width control works',
  wideCol > wideBefore && (await page.locator('#width-btn').textContent())?.trim() === 'Full',
  `${Math.round(wideBefore)} -> ${Math.round(wideCol)}`);

// Copy button exists on every code block.
const codeBlocks = await page.locator('#content .code-block').count();
check('copy buttons on every code block',
  (await page.locator('#content [data-copy]').count()) === codeBlocks,
  `${codeBlocks} blocks`);

// --- sidebar sections ----------------------------------------------------
// Hiding the document list removes the whole pane (not just its contents) and
// lets the outline fill the column, exactly like the Sidebar button.
check('documents toggle exists in the toolbar',
  await page.locator('#toggle-docs').isVisible());

const splitGeo = async () => page.evaluate(() => {
  const box = (id) => {
    const el = document.getElementById(id);
    if (!el || el.offsetParent === null) return null;
    const b = el.getBoundingClientRect();
    return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) };
  };
  const side = document.getElementById('side').getBoundingClientRect();
  return {
    side: { top: Math.round(side.top), h: Math.round(side.height) },
    outline: box('toc-wrap'), splitter: box('toc-splitter'), docs: box('tree-wrap'),
  };
});

const g0 = await splitGeo();
check('the two panes meet with no gap',
  g0.splitter.top === g0.outline.bottom && g0.docs.top === g0.splitter.bottom,
  `outline->${g0.splitter.top - g0.outline.bottom}px, splitter->docs ${g0.docs.top - g0.splitter.bottom}px`);
check('the panes fill the sidebar exactly',
  Math.abs((g0.docs.bottom - g0.side.top) - g0.side.h) <= 1,
  `${g0.docs.bottom - g0.side.top} of ${g0.side.h}`);

// Neither list may overflow its pane. If it does it covers the other pane and
// steals its clicks — a stale `#toc { flex: 0 0 260px }` rule caused exactly
// that once. The list must be longer than its pane for this to be reachable,
// so load a heading-heavy document first.
await page.evaluate(() => {
  const internals = window.__TAURI_INTERNALS__;
  const original = internals.invoke;
  internals.invoke = async (cmd, args) => {
    if (cmd === 'read_document') {
      const parts = ['# Long outline'];
      for (let i = 1; i <= 60; i++) parts.push(`\n## Heading ${i}\n\nbody\n`);
      return parts.join('');
    }
    return original(cmd, args);
  };
});
await page.locator('.tree-item').first().click();
await page.waitForTimeout(1000);
const headings = await page.locator('#toc a').count();
check('long outline is loaded for the overflow check', headings >= 40, `${headings} entries`);

const overflow = await page.evaluate(() => {
  const pane = (id) => document.getElementById(id).getBoundingClientRect();
  const list = (id) => document.getElementById(id).getBoundingClientRect();
  return {
    tocPane: pane('toc-wrap'), tocList: list('toc'),
    treePane: pane('tree-wrap'), treeList: list('tree'),
  };
});
check('outline list stays inside its pane',
  Math.round(overflow.tocList.bottom) <= Math.round(overflow.tocPane.bottom) + 1,
  `list ends ${Math.round(overflow.tocList.bottom - overflow.tocPane.bottom)}px past the pane`);
// A stale `#toc { flex: 0 0 260px }` from the standalone reader pinned the list
// to a fixed height, so a tall pane showed only 260px of outline and left the
// rest empty — the same wasted-space symptom, just inside the pane.
check('outline list fills its pane instead of a fixed height',
  Math.round(overflow.tocPane.height - overflow.tocList.height) < 40,
  `pane ${Math.round(overflow.tocPane.height)}px, list ${Math.round(overflow.tocList.height)}px`);
check('document list stays inside its pane',
  Math.round(overflow.treeList.bottom) <= Math.round(overflow.treePane.bottom) + 1,
  `list ends ${Math.round(overflow.treeList.bottom - overflow.treePane.bottom)}px past the pane`);
check('outline pane does not overlap the document pane',
  Math.round(overflow.tocPane.bottom) <= Math.round(overflow.treePane.top) + 1,
  `${Math.round(overflow.tocPane.bottom)} vs ${Math.round(overflow.treePane.top)}`);

// The document list must actually be clickable, not covered by the outline.
await page.locator('.tree-item').first().click();
await page.waitForTimeout(600);
check('document list is clickable, not covered',
  (await page.locator('.tree-item').first().getAttribute('class'))?.includes('active'),
  'clicked item became active');

// Dragging the divider reassigns space between the two panes.
const sideBox = await page.locator('#side').boundingBox();
await page.mouse.move(sideBox.x + sideBox.width / 2, g0.splitter.top + 3);
await page.mouse.down();
await page.mouse.move(sideBox.x + sideBox.width / 2, g0.splitter.top + 153, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(300);
const g1 = await splitGeo();
check('dragging the divider grows the outline', g1.outline.h > g0.outline.h + 100,
  `${g0.outline.h} -> ${g1.outline.h}`);
check('dragging the divider shrinks the document list', g1.docs.h < g0.docs.h - 100,
  `${g0.docs.h} -> ${g1.docs.h}`);
check('panes still fill the sidebar after a drag',
  Math.abs((g1.docs.bottom - g1.side.top) - g1.side.h) <= 1,
  `${g1.docs.bottom - g1.side.top} of ${g1.side.h}`);
check('the split survives a reload',
  Number(await page.evaluate(() => localStorage.getItem('mdviewer.outlineShare'))) > 0);

// Hiding the document list: the pane and its header both go, outline fills.
await page.click('#toggle-docs');
await page.waitForTimeout(400);
const g2 = await splitGeo();
check('hiding documents removes the whole pane',
  g2.docs === null && g2.splitter === null, JSON.stringify(g2.docs));
check('outline fills the sidebar when documents are hidden',
  Math.abs(g2.outline.h - g2.side.h) <= 1, `${g2.outline.h} of ${g2.side.h}`);
check('toolbar button reports the hidden state',
  (await page.locator('#toggle-docs').getAttribute('aria-pressed')) === 'true');

await page.click('#toggle-docs');
await page.waitForTimeout(400);
const g3 = await splitGeo();
check('the previous split returns when documents come back',
  Math.abs(g3.outline.h - g1.outline.h) <= 2, `${g1.outline.h} -> ${g3.outline.h}`);

// Hiding the outline leaves the document list alone.
await page.click('#toggle-outline');
await page.waitForTimeout(400);
const g4 = await splitGeo();
check('hiding the outline removes its pane', g4.outline === null && g4.splitter === null);
check('document list survives the outline being hidden',
  g4.docs !== null && Math.abs(g4.docs.h - g4.side.h) <= 1,
  g4.docs ? `${g4.docs.h} of ${g4.side.h}` : 'gone');
await page.click('#toggle-outline');
await page.waitForTimeout(400);
check('outline returns', (await splitGeo()).outline !== null);

// --- sidebar collapse + centring ----------------------------------------
const widthWithSidebar = await page.evaluate(() => {
  const c = document.getElementById('content').getBoundingClientRect();
  return { left: c.left, right: c.right, win: window.innerWidth };
});
const centreWith = (widthWithSidebar.left + widthWithSidebar.right) / 2;
check('reading pane centres with the sidebar open',
  Math.abs(centreWith - (widthWithSidebar.left + widthWithSidebar.win) / 2) <
    widthWithSidebar.left,
  `centre=${Math.round(centreWith)}`);

await page.click('#toggle-side');
await page.waitForTimeout(350);
check('sidebar hidden', !(await page.locator('#side').isVisible()));
check('toggle reports pressed state',
  (await page.locator('#toggle-side').getAttribute('aria-pressed')) === 'true');

// With the sidebar gone the column must re-centre in the FULL window width.
const widthNoSidebar = await page.evaluate(() => {
  const c = document.getElementById('content').getBoundingClientRect();
  return { left: c.left, right: c.right, win: window.innerWidth };
});
const centreWithout = (widthNoSidebar.left + widthNoSidebar.right) / 2;
check('reading pane re-centres when collapsed',
  Math.abs(centreWithout - widthNoSidebar.win / 2) < 2,
  `centre=${Math.round(centreWithout)} win=${widthNoSidebar.win}`);
check('column shifted left as the sidebar vanished',
  widthNoSidebar.left < widthWithSidebar.left - 100,
  `${Math.round(widthWithSidebar.left)} -> ${Math.round(widthNoSidebar.left)}`);

// Scrolling must still work while collapsed. page.mouse.wheel needs a real
// compositor and is unreliable in headless CI, so drive the container
// directly and assert it genuinely moves.
const collapsed = await page.evaluate(async () => {
  const s = document.getElementById('scroll');
  s.scrollTop = 0;
  await new Promise((r) => setTimeout(r, 120));
  const before = s.scrollTop;
  s.scrollTop = 500;
  // scroll-behavior is smooth, so wait for the animation rather than one frame.
  for (let i = 0; i < 40 && s.scrollTop < 400; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return {
    before,
    after: s.scrollTop,
    clientH: s.clientHeight,
    scrollH: s.scrollHeight,
  };
});
check('reading pane still scrollable when collapsed',
  collapsed.scrollH > collapsed.clientH,
  `${collapsed.clientH}/${collapsed.scrollH}`);
check('reading pane scrolls when collapsed',
  collapsed.after > collapsed.before,
  `scrollTop ${collapsed.before} -> ${collapsed.after}`);

// Keyboard shortcut restores it.
await page.keyboard.press('Control+b');
await page.waitForTimeout(350);
check('Ctrl+B toggles the sidebar back', await page.locator('#side').isVisible());

// The preference must persist.
check('sidebar state persists',
  (await page.evaluate(() => localStorage.getItem('mdviewer.sidebarOpen'))) === '1');

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  (' + r.detail + ')' : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
console.log(`screenshots in ${OUT}`);

await context.close();
process.exit(failed ? 1 : 0);
