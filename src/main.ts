/** Application shell: sidebar (documents / search), reading pane, toolbar. */
import 'katex/dist/katex.min.css';
import './styles/tokens.css';
import './styles/typography.css';
import './styles/app.css';

import { openUrl } from '@tauri-apps/plugin-opener';
import {
  type DocEntry, type SearchHit,
  pickFolder, readDocument, scanFolder, searchDocuments, takePendingOpen,
} from './lib/api';
import { extractHeadings, initHighlighter, renderMarkdown, type Heading } from './lib/render';

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

/**
 * One open document. Tabs hold a rendered snapshot rather than re-reading the
 * file, so switching back to a tab is instant and keeps its scroll position.
 * The outline is not stored: heading ids are derived from the heading text, so
 * re-deriving them from the restored markup reproduces the same list.
 */
interface Tab {
  path: string;
  name: string;
  rel: string;
  /** Rendered, sanitised markup, captured when the tab was last shown. */
  html: string;
  /** Reading position, captured when the tab was last shown. */
  scrollTop: number;
}

const state = {
  root: null as string | null,
  docs: [] as DocEntry[],
  /** Open documents, in strip order. Empty means the welcome screen. */
  tabs: [] as Tab[],
  /** Index into `state.tabs`, or -1 for the welcome screen. */
  active: -1,
  /** Most recently closed tabs, newest last, for reopening. */
  closed: [] as Tab[],
  /** True while the previous session's tabs are being re-opened. */
  restoring: false,
  headings: [] as Heading[],
  view: 'files' as 'files' | 'search',
  sideOpen: true,
  outlineOpen: true,
  docsOpen: true,
};

/** The document in the active tab, when there is one. */
function activeTab(): Tab | null {
  return state.tabs[state.active] ?? null;
}

/* ------------------------------- Boot markup ---------------------------- */
$('#app').innerHTML = `
<div id="bar">
  <button id="open-folder" class="btn" title="Choose a folder">Open folder…</button>
  <button id="toggle-side" class="btn" title="Show or hide the sidebar (Ctrl+B)">Sidebar</button>
  <button id="toggle-docs" class="btn" title="Show or hide the document list (Ctrl+D)">Documents</button>
  <button id="toggle-outline" class="btn" title="Show or hide the outline (Ctrl+O)">Outline</button>
  <div id="crumb" class="crumb">No folder opened</div>
  <span class="spacer"></span>
  <input id="filter" class="filter" type="search" placeholder="Search all files…" spellcheck="false">
  <button id="width-btn" class="btn" title="Reading width">Comfort</button>
  <button id="font-btn" class="btn" title="Text size">M</button>
  <button id="theme-btn" class="btn" title="Light / dark">Dark</button>
</div>
<div id="tabs" role="tablist" aria-label="Open documents"></div>
<div id="main">
  <aside id="side">
    <div id="toc-wrap">
      <button class="side-title" id="toc-title" type="button"
              aria-expanded="true" aria-controls="toc" title="Collapse">
        <span class="chev" aria-hidden="true"></span><span>Outline</span>
      </button>
      <nav id="toc" class="toc"></nav>
    </div>
    <div id="toc-splitter" role="separator" aria-orientation="horizontal"
         aria-label="Resize outline panel" tabindex="0"></div>
    <div id="tree-wrap">
      <button class="side-title" id="side-title-btn" type="button"
              aria-expanded="true" aria-controls="tree" title="Collapse">
        <span class="chev" aria-hidden="true"></span><span id="side-title">Documents</span>
      </button>
      <div id="tree" class="tree"></div>
    </div>
  </aside>
  <div id="scroll">
    <div id="welcome">
      <h1>Markdown Viewer</h1>
      <p>Open a folder to browse and full-text search its Markdown documents.</p>
    </div>
    <article id="content" class="markdown" hidden></article>
    <div id="doc-meta" class="doc-meta" hidden></div>
  </div>
</div>`;

const content = $('#content');
const tree = $('#tree');
const toc = $('#toc');
const scroll = $('#scroll');
const crumb = $('#crumb');
const tabStrip = $('#tabs');
const filter = $<HTMLInputElement>('#filter');

/* ------------------------------- Utilities ------------------------------ */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* ------------------------------- Documents ------------------------------ */
function renderTree(docs: DocEntry[]): void {
  if (!docs.length) {
    tree.innerHTML = state.root
      ? '<p class="muted">No Markdown documents found here.</p>'
      : '<p class="muted">Open a folder to begin.</p>';
    return;
  }

  // Group by directory so the tree shows structure rather than a flat list.
  const groups = new Map<string, DocEntry[]>();
  for (const d of docs) {
    const key = d.dir || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(d);
  }

  let html = '';
  for (const [dir, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (dir) html += `<div class="tree-dir">${escapeHtml(dir)}</div>`;
    for (const d of items) {
      const active = activeTab()?.path === d.path ? ' active' : '';
      html += `<button class="tree-item${active}" data-path="${escapeHtml(d.path)}" ` +
        `title="${escapeHtml(d.rel)}">` +
        `<span class="tree-name">${escapeHtml(d.name)}</span>` +
        `<span class="tree-size">${formatSize(d.size)}</span></button>`;
    }
  }
  tree.innerHTML = html;
}

/** Refresh just the tree's active row, without rebuilding the list. */
function markActiveInTree(): void {
  const current = activeTab()?.path;
  tree.querySelectorAll<HTMLElement>('.tree-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.path === current);
  });
}

/* --------------------------------- Tabs --------------------------------- */
// Opening a document adds a tab; it never replaces what is already on screen.
// Clicking a file that is already open activates its existing tab instead of
// opening a second copy, so the strip reads as a set of open documents rather
// than as a history of clicks.

/** How many closed tabs stay available to Ctrl+Shift+T. */
const MAX_CLOSED_TABS = 12;

/** Remember what the reading pane currently shows in the active tab. */
function stashActiveTab(): void {
  const tab = activeTab();
  if (!tab) return;
  tab.html = content.innerHTML;
  tab.scrollTop = scroll.scrollTop;
}

function truncateClosed(): void {
  if (state.closed.length > MAX_CLOSED_TABS) {
    state.closed.splice(0, state.closed.length - MAX_CLOSED_TABS);
  }
}

/** Point the reading pane at a tab index; -1 shows the welcome screen. */
function activate(index: number): void {
  if (index === state.active) {
    // Nothing to switch to. The pane and the tab can still have drifted apart,
    // because the reading pane is also addressable from outside this module;
    // when they disagree the tab is the source of truth, so the snapshot is
    // re-installed — never re-captured, which would keep whatever the pane
    // was left holding.
    if (activeTab() && activeTab()!.html !== content.innerHTML) showActiveTab();
    else { renderTabs(); markActiveInTree(); keepActiveTabVisible(); }
    return;
  }
  stashActiveTab();
  state.active = index;
  showActiveTab();
}

/** Install the active tab (or the welcome screen) into the reading pane. */
function showActiveTab(): void {
  const tab = activeTab();
  if (tab) {
    content.innerHTML = tab.html;
    content.hidden = false;
    $('#welcome').hidden = true;
    // Heading ids are derived from the heading text, so re-running this on the
    // restored markup reproduces the same ids the outline links to.
    state.headings = extractHeadings(content);
    enhance();
    crumb.textContent = tab.rel;
    crumb.title = tab.path;
    scroll.scrollTop = tab.scrollTop;
  } else {
    content.innerHTML = '';
    content.hidden = true;
    $('#welcome').hidden = false;
    state.headings = [];
    crumb.textContent = state.root ?? 'No folder opened';
    crumb.title = state.root ?? '';
  }

  // Show which document is open. Tauri v2 does not mirror document.title to
  // the OS window, so the title has to be set explicitly; this is also what
  // makes a file-association launch visibly work.
  const name = tab ? tab.name : '';
  document.title = name ? `${name} — Markdown Viewer` : 'Markdown Viewer';
  void setWindowTitle(document.title);

  renderToc();
  renderTabs();
  markActiveInTree();
  keepActiveTabVisible();
  // Not while restoring: the session is written once, at the end, so a partly
  // rebuilt strip is never what gets remembered.
  if (!state.restoring) saveTabs();
}

/**
 * Open a document in a tab. An already-open path is activated rather than
 * duplicated, which is what makes the tree, search hits, and external opens
 * feel like one document set.
 */
async function openDoc(path: string, revealLine?: number): Promise<void> {
  const doc = state.docs.find((d) => d.path === path);
  const existing = state.tabs.findIndex((t) => t.path === path);
  if (existing !== -1) {
    activate(existing);
    if (revealLine !== undefined) void scrollToLine(path, revealLine);
    return;
  }

  let html: string;
  try {
    html = renderMarkdown(await readDocument(path));
  } catch (e) {
    // A failed read is still a tab, so the strip keeps matching reality and
    // the error is attributable to a file rather than replacing the reader.
    html = `<p class="error">${escapeHtml(String(e))}</p>`;
  }

  // The new tab goes next to the active one, which keeps a group of related
  // documents together when moving between them.
  const at = state.active === -1 ? state.tabs.length : state.active + 1;
  state.closed = [];
  const tab: Tab = {
    path,
    name: doc?.name ?? path.split(/[/\\]/).pop() ?? path,
    rel: doc?.rel ?? path,
    html,
    scrollTop: 0,
  };
  state.tabs.splice(at, 0, tab);
  activate(at);
  if (revealLine !== undefined) void scrollToLine(path, revealLine);
}

/** Close a tab, falling back to its neighbour and never to nothing. */
function closeTab(index: number): void {
  const tab = state.tabs[index];
  if (!tab) return;

  const wasActive = index === state.active;
  state.tabs.splice(index, 1);
  state.closed.push(tab);
  truncateClosed();

  if (!state.tabs.length) {
    // The strip is empty, so the reading pane goes back to the welcome screen.
    state.active = -1;
    showActiveTab();
  } else if (wasActive) {
    // The tab that slid into this slot is the natural next document; at the
    // end of the strip that is the previous one.
    state.active = Math.min(index, state.tabs.length - 1);
    showActiveTab();
  } else {
    // Removal shifted the indices; follow the open tab.
    if (state.active > index) state.active -= 1;
    renderTabs();
    markActiveInTree();
    saveTabs();
  }
}

/** Bring back the most recently closed tab, in its old strip position. */
function reopenClosedTab(): void {
  const tab = state.closed.pop();
  if (!tab) return;
  const at = Math.min(Math.max(state.active, 0), state.tabs.length);
  state.tabs.splice(at, 0, tab);
  activate(at);
}

function renderTabs(): void {
  // A single tab is still worth showing: it names the document and carries the
  // close button, and it is the only way to see that more than one can be open.
  tabStrip.hidden = state.tabs.length === 0;

  tabStrip.innerHTML = state.tabs.map((t, i) => {
    const on = i === state.active;
    return `<div class="tab${on ? ' active' : ''}" role="tab" data-index="${i}" ` +
      `tabindex="${on ? 0 : -1}" aria-selected="${on}" title="${escapeHtml(t.path)}">` +
      `<span class="tab-name">${escapeHtml(t.name)}</span>` +
      `<button class="tab-close" type="button" data-close="${i}" ` +
      `title="Close ${escapeHtml(t.name)} (Ctrl+W)" ` +
      `aria-label="Close ${escapeHtml(t.name)}">&times;</button></div>`;
  }).join('');
}

/** Keep the active tab inside the visible part of a scrolled strip. */
function keepActiveTabVisible(): void {
  const el = tabStrip.querySelector<HTMLElement>('.tab.active');
  if (!el) return;
  const box = el.getBoundingClientRect();
  const strip = tabStrip.getBoundingClientRect();
  if (box.left < strip.left) tabStrip.scrollLeft -= strip.left - box.left;
  else if (box.right > strip.right) tabStrip.scrollLeft += box.right - strip.right;
}

/* --------------------------- Tab session -------------------------------- */
// Like the theme and the sidebar, the set of open documents survives a restart:
// reopening the viewer should return you to what you were reading. Only the
// paths are stored — the bodies are re-read, so a tab never shows stale text.

const TABS_KEY = 'mdviewer.tabs';

function saveTabs(): void {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify({
      paths: state.tabs.map((t) => t.path),
      active: state.active,
    }));
  } catch { /* storage full or unavailable: the session is not worth failing over */ }
}

/**
 * Restore the previous session. Each path is re-opened in order; the active
 * index is only moved once they all exist, so a tab that has since been
 * deleted cannot leave the strip pointing at the wrong document.
 */
async function restoreTabs(folder: string): Promise<void> {
  let saved: { paths?: string[]; active?: number };
  try {
    saved = JSON.parse(localStorage.getItem(TABS_KEY) ?? '{}');
  } catch { return; }

  const paths = (saved.paths ?? []).filter((p) => typeof p === 'string');
  if (!paths.length) return;
  state.restoring = true;
  try {
    for (const path of paths) {
      try {
        await openDoc(path);
      } catch { /* a path that no longer exists is simply skipped */ }
    }
  } finally {
    state.restoring = false;
  }
  const at = typeof saved.active === 'number' ? saved.active : -1;
  if (at >= 0 && at < state.tabs.length) activate(at);
  saveTabs();
}

/* Mousedown, not click: activating on press is what every tabbed app does,
   and it keeps the close button from being swallowed by a drag. Nothing is
   cancelled here beyond the default that press would start. */
tabStrip.addEventListener('mousedown', (e) => {
  const target = e.target as HTMLElement;
  const close = target.closest<HTMLElement>('[data-close]');
  if (close) {
    e.preventDefault();
    closeTab(Number(close.dataset.close));
    return;
  }
  const tab = target.closest<HTMLElement>('.tab');
  if (tab) {
    e.preventDefault();
    activate(Number(tab.dataset.index));
  }
});

// The activation already happened on mousedown, so the click that follows must
// not do anything else. It is not cancelled: the strip is a scrolling element,
// and swallowing the click would also swallow the middle-button gestures.
tabStrip.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('.tab')) e.preventDefault();
});

/** Middle-click closes a tab, as it does in a browser. */
tabStrip.addEventListener('auxclick', (e) => {
  if (e.button !== 1) return;
  const tab = (e.target as HTMLElement).closest<HTMLElement>('.tab');
  if (tab) {
    e.preventDefault();
    closeTab(Number(tab.dataset.index));
  }
});

/** Left/right arrows move between tabs, as in the ARIA tabs pattern. */
tabStrip.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (!state.tabs.length) return;
  e.preventDefault();
  const step = e.key === 'ArrowLeft' ? -1 : 1;
  const next = (state.active + step + state.tabs.length) % state.tabs.length;
  activate(next);
  tabStrip.querySelector<HTMLElement>('.tab.active')?.focus();
});

/**
 * Scroll to the source of a search hit. Rendering does not preserve source
 * lines, so the number of source lines that precede the hit is scaled onto the
 * rendered blocks: both are proportional to how far into the document the hit
 * sits. The target is outlined briefly so the jump is visible even when the
 * reader is already looking at that part of the page.
 */
async function scrollToLine(path: string, line: number): Promise<void> {
  const totalLines = await countLines(path);
  const blocks = [...content.children] as HTMLElement[];
  if (!blocks.length) return;
  const share = totalLines > 1 ? (line - 1) / (totalLines - 1) : 0;
  const block = blocks[Math.min(blocks.length - 1, Math.max(0, Math.round(share * (blocks.length - 1))))]!;
  block.scrollIntoView({ block: 'start' });
  block.classList.add('hit-flash');
  setTimeout(() => block.classList.remove('hit-flash'), 1400);
}

/** Source line count, needed to place a hit; cached per path. */
const lineCounts = new Map<string, number>();

async function countLines(path: string): Promise<number> {
  const cached = lineCounts.get(path);
  if (cached !== undefined) return cached;
  let n = 1;
  try {
    n = (await readDocument(path)).split('\n').length;
  } catch { /* unreadable: fall back to a single line */ }
  lineCounts.set(path, n);
  return n;
}

/** Wire copy buttons and external links inside freshly rendered content. */
function enhance(): void {
  content.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const code = btn.parentElement?.querySelector('code');
      navigator.clipboard.writeText(code?.innerText ?? '').then(() => {
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
      });
    });
  });

  content.querySelectorAll<HTMLAnchorElement>('a[href^="http"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      void openUrl(a.href);
    });
  });
}

/* --------------------------------- TOC ---------------------------------- */
function renderToc(): void {
  if (!state.headings.length) {
    toc.innerHTML = '<p class="muted">No headings</p>';
    return;
  }
  toc.innerHTML = state.headings.map((h) =>
    `<a class="toc-l${h.level}" href="#${escapeHtml(h.id)}" data-target="${escapeHtml(h.id)}">` +
    `${escapeHtml(h.text)}</a>`).join('');
}

toc.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest('a[data-target]');
  if (!a) return;
  e.preventDefault();
  const id = a.getAttribute('data-target')!;
  content.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: 'start' });
});

/* -------------------------------- Search -------------------------------- */
let searchTimer: number | undefined;

async function runSearch(query: string): Promise<void> {
  if (!state.root) {
    tree.innerHTML = '<p class="muted">Open a folder first.</p>';
    return;
  }
  const q = query.trim();
  if (!q) {
    state.view = 'files';
    $('#side-title').textContent = 'Documents';
    renderTree(state.docs);
    return;
  }

  state.view = 'search';
  tree.innerHTML = '<p class="muted">Searching…</p>';
  try {
    const res = await searchDocuments(state.root, q, 400);
    if (!res.hits.length) {
      tree.innerHTML = `<p class="muted">No matches in ${res.files_scanned} files.</p>`;
      $('#side-title').textContent = `Search: ${q}`;
      return;
    }
    $('#side-title').textContent =
      `Search: ${q} — ${res.hits.length}${res.truncated ? '+' : ''} hits`;
    tree.innerHTML = res.hits.map((h: SearchHit) => {
      const before = escapeHtml(h.text.slice(0, h.start));
      const mid = escapeHtml(h.text.slice(h.start, h.end));
      const after = escapeHtml(h.text.slice(h.end));
      return `<button class="hit" data-path="${escapeHtml(h.path)}" data-line="${h.line}">` +
        `<span class="hit-loc">${escapeHtml(h.rel)}:${h.line}</span>` +
        `<span class="hit-text">${before}<mark>${mid}</mark>${after}</span></button>`;
    }).join('');
  } catch (e) {
    tree.innerHTML = `<p class="error">${escapeHtml(String(e))}</p>`;
  }
}

filter.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => { void runSearch(filter.value); }, 180);
});

/* --------------------- Tree clicks and search hits ---------------------- */
// One handler for both: the sidebar renders either the document list or the
// search results, and each row carries the path it opens. A search row also
// carries the source line to jump to.
tree.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-path]');
  if (!el) return;
  const line = el.dataset.line ? Number(el.dataset.line) : undefined;
  void openDoc(el.dataset.path!, line);
});

/* ------------------------------- Toolbar -------------------------------- */
/** Load a folder as the workspace and list its documents. */
async function openFolder(folder: string): Promise<void> {
  state.root = folder;
  try { localStorage.setItem('mdviewer.root', folder); } catch { /* ignore */ }
  tree.innerHTML = '<p class="muted">Scanning…</p>';
  try {
    state.docs = await scanFolder(folder);
    renderTree(state.docs);
  } catch (err) {
    tree.innerHTML = `<p class="error">${escapeHtml(String(err))}</p>`;
  }
  // The breadcrumb shows the active document; with no tabs it shows the folder.
  if (!activeTab()) {
    crumb.textContent = folder;
    crumb.title = folder;
  }
}

$('#open-folder').addEventListener('click', async () => {
  const picked = await pickFolder();
  if (picked) await openFolder(picked);
});

/* --------------------- Opening a file from outside ---------------------- */
// Two ways a document can arrive without the user browsing for it:
//   * the app was launched with the path (file association, or `app.exe x.md`)
//   * a file was dropped onto the window, or a second launch was forwarded
//     by the single-instance plugin
// Both end up here, and both adopt the file's folder as the workspace so the
// sidebar stays usable rather than showing a single orphaned document.
async function openExternalDocument(path: string, folder?: string | null): Promise<void> {
  if (folder && folder !== state.root) {
    await openFolder(folder);
  } else if (!state.docs.length && state.root) {
    // Already pointed at the right folder but the listing is empty; refresh so
    // the opened document is highlighted in the tree.
    state.docs = await scanFolder(state.root);
    renderTree(state.docs);
  }
  await openDoc(path);
}

/** Wire the two external entry points once the webview is ready. */
async function listenForExternalOpen(): Promise<void> {
  // Drag and drop. With `dragDropEnabled` in the window config Tauri owns the
  // drop and reports it as an event; the DOM never sees a `drop`.
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  await getCurrentWebview().onDragDropEvent(async (event) => {
    if (event.payload.type !== 'drop') return;
    const paths = event.payload.paths ?? [];
    const doc = paths.find((p) => /\.(md|markdown|mdown|mkd|mdx|txt)$/i.test(p));
    if (doc) {
      await openExternalDocument(doc, parentOf(doc));
    }
  });

  // A later launch forwarded by the single-instance plugin.
  const { listen } = await import('@tauri-apps/api/event');
  await listen<{ path: string; folder: string | null }>('open-file', async (e) => {
    await openExternalDocument(e.payload.path, e.payload.folder);
  });

  // A path given on the command line at first launch, stashed by the Rust side
  // because setup runs before this listener exists.
  const pending = await takePendingOpen();
  if (pending) await openExternalDocument(pending, parentOf(pending));
}

/**
 * Set the OS window title. Fails silently outside Tauri (the browser preview
 * used by the tests), where `document.title` is all there is.
 */
async function setWindowTitle(title: string): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setTitle(title);
  } catch { /* not running under Tauri */ }
}

/** Directory portion of a path, handling both separators. */
function parentOf(p: string): string | null {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : null;
}

/* ------------------------- Sidebar collapse ----------------------------- */
// Hiding the whole sidebar (not just Contents) is what lets the reading pane
// use the full window width and centre itself in it.
function setSidebarOpen(open: boolean, persist = true): void {
  state.sideOpen = open;
  document.body.classList.toggle('side-collapsed', !open);
  const btn = $('#toggle-side');
  btn.classList.toggle('active', !open);
  btn.setAttribute('aria-pressed', String(!open));
  if (persist) {
    try { localStorage.setItem('mdviewer.sidebarOpen', open ? '1' : '0'); } catch { /* ignore */ }
  }
  // The splitter clamps against the sidebar height, which is zero while hidden.
  if (open && tocWrap.style.height) {
    requestAnimationFrame(clampSplit);
  }
}

$('#toggle-side').addEventListener('click', () => setSidebarOpen(!state.sideOpen));

// Ctrl/Cmd+B is the conventional shortcut for this panel. The tab shortcuts
// (Ctrl+W, Ctrl+Tab, Ctrl+Shift+T) are the browser ones, since the strip is
// meant to read like a browser's.
window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === 'b') {
    e.preventDefault();
    setSidebarOpen(!state.sideOpen);
  } else if (k === 'w') {
    e.preventDefault();
    if (state.active !== -1) closeTab(state.active);
  } else if (k === 't' && e.shiftKey) {
    e.preventDefault();
    reopenClosedTab();
  } else if (e.key === 'Tab' && state.tabs.length > 1) {
    // Ctrl+Tab / Ctrl+Shift+Tab cycle the strip, wrapping at both ends.
    e.preventDefault();
    const step = e.shiftKey ? -1 : 1;
    activate((state.active + step + state.tabs.length) % state.tabs.length);
  } else if (k === 'd') {
    e.preventDefault();
    setDocsVisible(!state.docsOpen);
  } else if (k === 'o') {
    e.preventDefault();
    setOutlineVisible(!state.outlineOpen);
  }
});

// Sidebar element handles, looked up once and reused by the splitter and the
// section toggles below.
const tocWrap = $('#toc-wrap');
const splitter = $('#toc-splitter');
const treeWrap = $('#tree-wrap');
const tocTitle = $('#toc-title');
const treeTitle = $('#side-title-btn');
const side = $('#side');

/* -------------------- Collapsible sidebar sections ---------------------- */
// Each section header toggles its own panel, so collapsing Documents leaves
// the outline visible (and vice versa). Hiding both is the sidebar button's
// job; these are per-section.
// Hiding the document list is the same kind of action as the Sidebar button:
// the whole pane leaves and the outline takes the full column. It is not a
// content collapse — the header goes too.
function setDocsVisible(visible: boolean, persist = true): void {
  state.docsOpen = visible;
  document.body.classList.toggle('docs-hidden', !visible);
  treeTitle.setAttribute('aria-expanded', String(visible));
  treeTitle.title = visible ? 'Hide the document list' : 'Show the document list';
  const btn = $('#toggle-docs');
  btn.classList.toggle('active', !visible);
  btn.setAttribute('aria-pressed', String(!visible));
  if (persist) {
    try { localStorage.setItem('mdviewer.docsOpen', visible ? '1' : '0'); } catch { /* ignore */ }
  }
  // With the list hidden the outline fills the column, so the inline share
  // (which would win over the stylesheet) has to be cleared; showing it again
  // re-applies the remembered split.
  if (visible) clampSplit();
  else tocWrap.style.height = '';
}

function setOutlineVisible(visible: boolean, persist = true): void {
  state.outlineOpen = visible;
  document.body.classList.toggle('outline-hidden', !visible);
  tocTitle.setAttribute('aria-expanded', String(visible));
  tocTitle.title = visible ? 'Hide the outline' : 'Show the outline';
  const btn = $('#toggle-outline');
  btn.classList.toggle('active', !visible);
  btn.setAttribute('aria-pressed', String(!visible));
  if (persist) {
    try { localStorage.setItem('mdviewer.outlineOpen', visible ? '1' : '0'); } catch { /* ignore */ }
  }
  if (visible) clampSplit();
}

tocTitle.addEventListener('click', () => setOutlineVisible(!state.outlineOpen));
treeTitle.addEventListener('click', () => setDocsVisible(!state.docsOpen));
// The header disappears with its pane, so the toolbar button is what brings
// the list back.
$('#toggle-docs').addEventListener('click', () => setDocsVisible(!state.docsOpen));
$('#toggle-outline').addEventListener('click', () => setOutlineVisible(!state.outlineOpen));

/* --------------------- Outline / Documents splitter --------------------- */
// The sidebar is one fixed-height column and the divider simply moves the
// boundary between its two panes, so together they always fill it exactly.
// Sizes are independent of content; a short list scrolls inside its share.
const OUTLINE_MIN = 80;   // keep both headers usable
const OUTLINE_DEFAULT = 45; // percent

function setOutlineShare(percent: number, persist = true): void {
  if (!state.docsOpen) return;
  const total = side.clientHeight;
  const minPct = (OUTLINE_MIN / total) * 100;
  const pct = Math.min(Math.max(percent, minPct), 100 - minPct);
  tocWrap.style.height = `${pct}%`;
  splitter.setAttribute('aria-valuenow', String(Math.round(pct)));
  if (persist) {
    try { localStorage.setItem('mdviewer.outlineShare', String(pct)); } catch { /* ignore */ }
  }
}

/** Keep the current share valid after a resize or a pane reappearing. */
function clampSplit(): void {
  if (!state.docsOpen) return;
  const raw = parseFloat(localStorage.getItem('mdviewer.outlineShare') ?? '');
  setOutlineShare(Number.isFinite(raw) && raw > 0 ? raw : OUTLINE_DEFAULT, false);
}

let dragging = false;

splitter.addEventListener('pointerdown', (e: PointerEvent) => {
  dragging = true;
  splitter.classList.add('dragging');
  splitter.setPointerCapture(e.pointerId);
  e.preventDefault();
});

splitter.addEventListener('pointermove', (e: PointerEvent) => {
  if (!dragging) return;
  const box = side.getBoundingClientRect();
  // The divider position as a share of the column is exactly what the pane
  // above it should occupy.
  setOutlineShare(((e.clientY - box.top) / box.height) * 100);
});

function endDrag(e: PointerEvent): void {
  if (!dragging) return;
  dragging = false;
  splitter.classList.remove('dragging');
  if (splitter.hasPointerCapture(e.pointerId)) splitter.releasePointerCapture(e.pointerId);
}
splitter.addEventListener('pointerup', endDrag);
splitter.addEventListener('pointercancel', endDrag);

// Keyboard access: arrows nudge, Home/End jump to the extremes.
splitter.addEventListener('keydown', (e: KeyboardEvent) => {
  const cur = parseFloat(tocWrap.style.height) || OUTLINE_DEFAULT;
  const step = e.shiftKey ? 10 : 2;
  if (e.key === 'ArrowUp') { setOutlineShare(cur - step); e.preventDefault(); }
  else if (e.key === 'ArrowDown') { setOutlineShare(cur + step); e.preventDefault(); }
  else if (e.key === 'Home') { setOutlineShare(0); e.preventDefault(); }
  else if (e.key === 'End') { setOutlineShare(100); e.preventDefault(); }
});

// Double-click restores the default split.
splitter.addEventListener('dblclick', () => setOutlineShare(OUTLINE_DEFAULT));

// Re-clamp on resize so neither pane can be squeezed out.
window.addEventListener('resize', clampSplit);

const WIDTHS: Array<[string, string]> = [
  ['Narrow', '34rem'], ['Comfort', '42rem'], ['Wide', '52rem'], ['Full', '100%'],
];
const FONTS: Array<[string, string]> = [
  ['S', '15px'], ['M', '16px'], ['L', '17.5px'], ['XL', '19px'],
];
// Defaults: Wide column, Medium text.
let wIdx = 2;
let fIdx = 1;

const root = document.documentElement;
const applyWidth = (): void => {
  root.style.setProperty('--measure', WIDTHS[wIdx]![1]);
  $('#width-btn').textContent = WIDTHS[wIdx]![0];
};
const applyFont = (): void => {
  root.style.setProperty('--base-size', FONTS[fIdx]![1]);
  $('#font-btn').textContent = FONTS[fIdx]![0];
};

$('#width-btn').addEventListener('click', () => {
  wIdx = (wIdx + 1) % WIDTHS.length; applyWidth();
});
$('#font-btn').addEventListener('click', () => {
  fIdx = (fIdx + 1) % FONTS.length; applyFont();
});

function applyTheme(dark: boolean): void {
  root.classList.toggle('theme-dark', dark);
  $('#theme-btn').textContent = dark ? 'Light' : 'Dark';
  try { localStorage.setItem('mdviewer.theme', dark ? 'dark' : 'light'); } catch { /* ignore */ }
}
$('#theme-btn').addEventListener('click', () => {
  applyTheme(!root.classList.contains('theme-dark'));
});

/* --------------------------------- Boot --------------------------------- */
try {
  const saved = localStorage.getItem('mdviewer.theme');
  applyTheme(saved ? saved === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches);
} catch { applyTheme(false); }
applyWidth();
applyFont();

// Restore the collapsed state before the first paint so the layout does not
// visibly jump on startup.
try {
  setSidebarOpen(localStorage.getItem('mdviewer.sidebarOpen') !== '0', false);
} catch { setSidebarOpen(true, false); }

// Same for the two sidebar sections.
try {
  setOutlineVisible(localStorage.getItem('mdviewer.outlineOpen') !== '0', false);
  setDocsVisible(localStorage.getItem('mdviewer.docsOpen') !== '0', false);
} catch { /* ignore */ }

// Restore the saved split once the sidebar has a measured height.
requestAnimationFrame(clampSplit);

renderTree([]);
renderToc();
renderTabs();

void initHighlighter().catch(() => { /* highlighting is best-effort */ });

// Bring back the documents that were open last time, then let an external open
// (a file association or a drag-drop at launch) take precedence over them. The
// saved workspace folder is what makes the restored tabs meaningful in the
// sidebar; without it the tabs still open, just unlisted.
//
// Both run in one chain because they touch the same strip: restoring after an
// external open would re-activate a stale tab, and running them concurrently
// would interleave their inserts.
async function bootSession(carryOn: () => Promise<void>): Promise<void> {
  try {
    const folder = localStorage.getItem('mdviewer.root');
    if (folder) await openFolder(folder);
    await restoreTabs(folder ?? '');
  } catch (e) {
    console.error('[mdviewer] session restore failed:', e);
  }
  await carryOn();
}

// External opens (association, drag-drop, second launch) are wired after the
// shell exists so they can render into it.
void bootSession(() => listenForExternalOpen()).catch((e) => {
  // Not fatal: the viewer still works by browsing. But log it, because a
  // silent failure here means association and drag-drop quietly do nothing.
  console.error('[mdviewer] external open unavailable:', e);
});
