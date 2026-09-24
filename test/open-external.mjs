/*
 * End-to-end check of the two external entry points, driven against the REAL
 * built bundle.
 *
 * The Tauri bridge is mocked (there is no Rust process in a plain browser), but
 * the code under test is the production path: the same listeners, the same
 * openExternalDocument flow. The mock implements enough of the event plugin for
 * @tauri-apps/api to register a listener, so the assertions exercise the app's
 * own wiring rather than a stand-in for it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'test-output');
fs.mkdirSync(OUT, { recursive: true });

const CHROME = process.env.MDREADER_CHROME || '';
const launchArgs = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
if (process.env.MDREADER_HEADLESS_OLD === '1') launchArgs.push('--headless=old');

const DOC_PATH = '/mock/docs/guide/intro.md';
const DOC_BODY = '# Opened externally\n\n## Section\n\nthe quick brown fox\n';

const FILES = [
  { path: '/mock/docs/README.md', name: 'README.md', rel: 'README.md', dir: '', size: 100 },
  { path: DOC_PATH, name: 'intro.md', rel: 'guide/intro.md', dir: 'guide', size: 200 },
];

const ctx = await chromium.launchPersistentContext(path.join(ROOT, '.chrome-profile'), {
  viewport: { width: 1280, height: 900 },
  ...(CHROME && fs.existsSync(CHROME) ? { executablePath: CHROME } : {}),
  args: launchArgs,
});
const page = ctx.pages()[0] ?? await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));

await page.addInitScript(({ files, body }) => {
  // --- a small stand-in for the Tauri backend ---------------------------
  const eventListeners = new Map();   // event name -> Set(handler id)
  const callbacks = new Map();        // id -> function
  let nextId = 1;
  const calls = [];

  window.__testState = {
    calls,
    dropPaths: null,
    /** Fire a webview drag-drop event, as the Rust side would. */
    emitDrop(paths) {
      window.__testState.dropPaths = paths;
      const ids = eventListeners.get('tauri://drag-drop') ?? new Set();
      ids.forEach((id) => {
        const cb = callbacks.get(id);
        if (cb) {
          cb({
            event: 'tauri://drag-drop',
            id,
            payload: { paths, position: { x: 0, y: 0 } },
          });
        }
      });
    },
    /** Fire the app's own open-file event, as single-instance would. */
    emitOpenFile(payload) {
      const ids = eventListeners.get('open-file') ?? new Set();
      ids.forEach((id) => {
        const cb = callbacks.get(id);
        if (cb) cb({ event: 'open-file', id, payload });
      });
    },
  };

  const invoke = async (cmd, args) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case 'plugin:event|listen': {
        const name = args.event;
        if (!eventListeners.has(name)) eventListeners.set(name, new Set());
        eventListeners.get(name).add(args.handler);
        return args.handler;
      }
      case 'plugin:event|unlisten': {
        eventListeners.get(args.event)?.delete(args.handler);
        return null;
      }
      case 'pick_folder':
        return '/mock/docs';
      case 'scan_folder':
        return files;
      case 'read_document':
        return body;
      case 'search_documents':
        return { hits: [], truncated: false, files_scanned: files.length };
      case 'take_pending_open':
        return window.__pendingOpen ?? null;
      default:
        return null;
    }
  };

  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback(cb) {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    // @tauri-apps/api reads the current webview/window labels from here when
    // getCurrentWebview() is called; without them it throws while constructing
    // the object, before any command is sent.
    metadata: {
      currentWebview: { label: 'main' },
      currentWindow: { label: 'main' },
    },
  };
}, { files: FILES, body: DOC_BODY });

const load = async () => {
  await page.goto('http://localhost:4173/', { waitUntil: 'load' });
  await page.waitForTimeout(1800);
};

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass, detail });

// --- 1. first launch with a path on the command line ----------------------
// The Rust side stashes it in `PendingOpen`; the front end must take it.
// Simulate the Rust side having stashed a path from argv. This is installed
// with addInitScript so it survives the reload, exactly as the real
// PendingOpen state survives a webview reload.
await page.addInitScript(() => { window.__pendingOpen = '/mock/docs/guide/intro.md'; });
await load();
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(2200);

const boot = await page.evaluate(() => ({
  h1: document.querySelector('#content h1')?.textContent ?? null,
  visible: !document.getElementById('content')?.hidden,
  crumb: document.getElementById('crumb')?.textContent ?? '',
  items: document.querySelectorAll('.tree-item').length,
  active: document.querySelector('.tree-item.active')?.textContent ?? null,
  title: document.title,
  reads: window.__testState.calls.filter((c) => c.cmd === 'read_document').map((c) => c.args.path),
  scans: window.__testState.calls.filter((c) => c.cmd === 'scan_folder').map((c) => c.args.root),
}));
check('startup path opens that document', boot.h1 === 'Opened externally', String(boot.h1));
check('reading pane is shown', boot.visible);
// The window title is how a file-association launch is visible to the user.
check('window title names the opened document',
  typeof boot.title === 'string' && boot.title.includes('intro.md'),
  String(boot.title));
check('it read the requested path', boot.reads.includes('/mock/docs/guide/intro.md'),
  boot.reads.join(','));
check('workspace adopted from the file folder',
  boot.scans.includes('/mock/docs/guide'), `scanned=${JSON.stringify(boot.scans)}`);
check('sidebar lists the folder', boot.items === FILES.length, `${boot.items} items`);
check('opened document is highlighted', (boot.active ?? '').includes('intro.md'),
  String(boot.active));

// --- 2. drag and drop -----------------------------------------------------
const drag = await page.evaluate(async () => {
  // Return to the welcome state so the effect is unambiguous.
  const c = document.getElementById('content');
  c.innerHTML = '';
  c.hidden = true;
  document.getElementById('welcome').hidden = false;
  window.__testState.emitDrop(['/mock/docs/guide/intro.md']);
  await new Promise((r) => setTimeout(r, 800));
  return {
    h1: document.querySelector('#content h1')?.textContent ?? null,
    visible: !document.getElementById('content').hidden,
  };
});
check('drop opens the dropped document', drag.h1 === 'Opened externally', String(drag.h1));
check('reading pane shown after drop', drag.visible);

// A drop of a non-document must be ignored rather than blanking the view.
const ignored = await page.evaluate(async () => {
  const before = document.querySelector('#content h1')?.textContent ?? null;
  window.__testState.emitDrop(['/mock/docs/photo.png']);
  await new Promise((r) => setTimeout(r, 500));
  return { before, after: document.querySelector('#content h1')?.textContent ?? null };
});
check('non-document drop is ignored', ignored.before === ignored.after,
  `${ignored.before} -> ${ignored.after}`);

// --- 3. a later launch forwarded by single-instance -----------------------
const second = await page.evaluate(async () => {
  const c = document.getElementById('content');
  c.innerHTML = '';
  c.hidden = true;
  window.__testState.emitOpenFile({ path: '/mock/docs/guide/intro.md', folder: '/mock/docs/guide' });
  await new Promise((r) => setTimeout(r, 800));
  return { h1: document.querySelector('#content h1')?.textContent ?? null };
});
check('forwarded second launch opens the file', second.h1 === 'Opened externally',
  String(second.h1));

check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));

await page.screenshot({ path: path.join(OUT, '50-open-external.png') });

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  (' + r.detail + ')' : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
await ctx.close();
process.exit(failed ? 1 : 0);
