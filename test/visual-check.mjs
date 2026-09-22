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

// --- draggable Contents / Documents splitter -----------------------------
const splitter = page.locator('#toc-splitter');
check('splitter present', await splitter.isVisible());
check('splitter is a separator role',
  (await splitter.getAttribute('role')) === 'separator');

// The panel is capped, not fixed, so it only grows when the outline is long
// enough. Open a heading-heavy document first, otherwise the drag has nothing
// to reveal and the check would be meaningless.
await page.evaluate(() => {
  const win = window;
  win.__LONG_DOC__ = true;
});
await page.evaluate(async () => {
  // Re-open the same file with a long outline by patching the mock bridge.
  const internals = window.__TAURI_INTERNALS__;
  const original = internals.invoke;
  internals.invoke = async (cmd, args) => {
    if (cmd === 'read_document') {
      const parts = ['# Top'];
      for (let i = 1; i <= 40; i++) parts.push(`\n## Section ${i}\n\ntext\n`);
      return parts.join('');
    }
    return original(cmd, args);
  };
});
await page.click('.tree-item >> nth=0');
await page.waitForTimeout(800);

const sideBox = await page.locator('#side').boundingBox();
const h0 = (await page.locator('#toc-wrap').boundingBox()).height;

// Drag the divider downward by 100px.
await page.mouse.move(sideBox.x + sideBox.width / 2, sideBox.y + h0);
await page.mouse.down();
await page.mouse.move(sideBox.x + sideBox.width / 2, sideBox.y + h0 + 100, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(300);
const h1 = (await page.locator('#toc-wrap').boundingBox()).height;
check('drag resizes the outline panel', h1 > h0 + 40,
  `${Math.round(h0)} -> ${Math.round(h1)}`);

// The Documents panel must remain usable (not crushed to nothing).
const treeBox = await page.locator('#tree-wrap').boundingBox();
check('documents panel keeps usable height', treeBox.height > 40,
  `${Math.round(treeBox.height)}px`);

// Dragging far past the top must clamp, not collapse the panel.
await page.mouse.move(sideBox.x + sideBox.width / 2, sideBox.y + h1);
await page.mouse.down();
await page.mouse.move(sideBox.x + sideBox.width / 2, sideBox.y - 400, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(250);
const hMin = (await page.locator('#toc-wrap').boundingBox()).height;
check('drag clamps at the minimum', hMin >= 50 && hMin < 200, `${Math.round(hMin)}px`);

// Keyboard: ArrowDown must grow the panel.
await splitter.focus();
const hk0 = (await page.locator('#toc-wrap').boundingBox()).height;
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(200);
const hk1 = (await page.locator('#toc-wrap').boundingBox()).height;
check('keyboard resizes the panel', hk1 > hk0, `${Math.round(hk0)} -> ${Math.round(hk1)}`);

// The choice must survive a reload.
const persisted = await page.evaluate(() => localStorage.getItem('mdviewer.tocHeight'));
check('splitter position persists', Number(persisted) > 0, `stored=${persisted}`);

// --- layout/scroll regression -------------------------------------------
// The shell is a flex column; if #app is not a bounded flex container the
// reading pane grows to content height and the wheel does nothing.
const layout = await page.evaluate(() => {
  const app = document.getElementById('app');
  const scroller = document.getElementById('scroll');
  const cs = getComputedStyle(app);
  return {
    appHeight: app.clientHeight,
    winHeight: window.innerHeight,
    appDisplay: cs.display,
    scrollOverflowY: getComputedStyle(scroller).overflowY,
    scrollClientH: scroller.clientHeight,
    scrollScrollH: scroller.scrollHeight,
  };
});
check('#app is a bounded flex container',
  layout.appDisplay === 'flex' && Math.abs(layout.appHeight - layout.winHeight) <= 2,
  `display=${layout.appDisplay} app=${layout.appHeight} win=${layout.winHeight}`);
check('reading pane can scroll',
  layout.scrollOverflowY === 'auto' && layout.scrollScrollH > layout.scrollClientH,
  `overflowY=${layout.scrollOverflowY} ${layout.scrollClientH}/${layout.scrollScrollH}`);

// The wheel must actually move the reading pane.
await page.evaluate(() => { document.getElementById('scroll').scrollTop = 0; });
const beforeWheel = await page.evaluate(() => document.getElementById('scroll').scrollTop);
await page.mouse.move(900, 500);
await page.mouse.wheel(0, 600);
await page.waitForTimeout(400);
const afterWheel = await page.evaluate(() => document.getElementById('scroll').scrollTop);
check('wheel scrolls the document', afterWheel > beforeWheel,
  `scrollTop ${beforeWheel} -> ${afterWheel}`);
await page.evaluate(() => { document.getElementById('scroll').scrollTop = 0; });

// --- CJK fallback coverage -----------------------------------------------
// Chinese must resolve to a real CJK family rather than falling through to
// the generic keyword, which renders tofu boxes on Linux.
const fontStack = await page.evaluate(() =>
  getComputedStyle(document.body).getPropertyValue('--font-sans'));
check('font stack includes a Windows CJK family',
  fontStack.includes('Microsoft YaHei'), 'Microsoft YaHei');
check('font stack includes a macOS CJK family',
  fontStack.includes('PingFang SC'), 'PingFang SC');
check('font stack includes a Linux CJK family',
  fontStack.includes('Noto Sans CJK SC'), 'Noto Sans CJK SC');
check('CJK families precede the generic keyword',
  fontStack.indexOf('Microsoft YaHei') < fontStack.indexOf('sans-serif'),
  'ordering');
check('mono stack also has a CJK fallback',
  (await page.evaluate(() =>
    getComputedStyle(document.body).getPropertyValue('--font-mono')))
    .includes('Microsoft YaHei'));

// --- sidebar section collapse -------------------------------------------
check('outline header is a collapse toggle',
  (await page.locator('#toc-title').getAttribute('aria-expanded')) === 'true');
check('documents header is a collapse toggle',
  (await page.locator('#side-title-btn').getAttribute('aria-expanded')) === 'true');

// Collapsing Documents must leave the outline visible.
await page.click('#side-title-btn');
await page.waitForTimeout(350);
check('documents panel collapses', await page.locator('#tree').isHidden());
check('outline survives documents collapse',
  await page.locator('#toc').isVisible() &&
  (await page.locator('#toc a').count()) > 0);
check('collapse state is exposed to assistive tech',
  (await page.locator('#side-title-btn').getAttribute('aria-expanded')) === 'false');
await page.click('#side-title-btn');
await page.waitForTimeout(300);
check('documents panel restores', await page.locator('#tree').isVisible());

// Collapsing the outline hides the divider too, since it would have nothing
// left to resize.
await page.click('#toc-title');
await page.waitForTimeout(350);
check('outline panel collapses', await page.locator('#toc').isHidden());
check('divider hides with the outline',
  await page.locator('#toc-splitter').isHidden());
check('documents survives outline collapse', await page.locator('#tree').isVisible());
await page.click('#toc-title');
await page.waitForTimeout(300);
check('outline panel restores', await page.locator('#toc').isVisible());
check('divider returns with the outline',
  await page.locator('#toc-splitter').isVisible());

// --- no blank block above the divider ------------------------------------
// The bug: the outline panel had a fixed height, so a short outline left a
// dead block above the divider. This must be measured with no drag applied,
// otherwise it reports on a pinned height instead of the default layout.
await page.evaluate(() => localStorage.removeItem('mdviewer.tocHeight'));
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1500);
await page.click('#open-folder');
await page.locator('.tree-item').first().waitFor({ state: 'visible' });
await page.click('.tree-item >> nth=0');
await page.waitForTimeout(1200);

const outlineGap = await page.evaluate(() => {
  const wrap = document.getElementById('toc-wrap').getBoundingClientRect();
  const list = document.getElementById('toc').getBoundingClientRect();
  const wrapStyle = getComputedStyle(document.getElementById('toc-wrap'));
  return {
    gap: Math.round(wrap.bottom - list.bottom),
    pinned: document.getElementById('toc-wrap').style.height || '(none)',
    wrapH: Math.round(wrap.height),
    listH: Math.round(list.height),
    maxH: wrapStyle.maxHeight,
  };
});
check('outline is not pinned before any drag', outlineGap.pinned === '(none)',
  outlineGap.pinned);
check('no blank gap under the outline list',
  outlineGap.gap >= 0 && outlineGap.gap < 12,
  `${outlineGap.gap}px (panel ${outlineGap.wrapH}, list ${outlineGap.listH})`);

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
