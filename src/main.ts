/** Application shell: sidebar (documents / search), reading pane, toolbar. */
import 'katex/dist/katex.min.css';
import './styles/tokens.css';
import './styles/typography.css';
import './styles/app.css';

import { openUrl } from '@tauri-apps/plugin-opener';
import {
  type DocEntry, type SearchHit,
  pickFolder, readDocument, scanFolder, searchDocuments,
} from './lib/api';
import { extractHeadings, initHighlighter, renderMarkdown, type Heading } from './lib/render';

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

const state = {
  root: null as string | null,
  docs: [] as DocEntry[],
  current: null as DocEntry | null,
  headings: [] as Heading[],
  view: 'files' as 'files' | 'search',
  sideOpen: true,
  outlineOpen: true,
  docsOpen: true,
};

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
      const active = state.current?.path === d.path ? ' active' : '';
      html += `<button class="tree-item${active}" data-path="${escapeHtml(d.path)}" ` +
        `title="${escapeHtml(d.rel)}">` +
        `<span class="tree-name">${escapeHtml(d.name)}</span>` +
        `<span class="tree-size">${formatSize(d.size)}</span></button>`;
    }
  }
  tree.innerHTML = html;
}

async function openDoc(path: string): Promise<void> {
  const doc = state.docs.find((d) => d.path === path);
  try {
    const text = await readDocument(path);
    content.innerHTML = renderMarkdown(text);
    content.hidden = false;
    $('#welcome').hidden = true;
    state.current = doc ?? null;
    state.headings = extractHeadings(content);
    renderToc();
    enhance();
    crumb.textContent = doc ? doc.rel : path;
    crumb.title = path;
    scroll.scrollTop = 0;
    renderTree(state.docs);
  } catch (e) {
    content.hidden = false;
    content.innerHTML = `<p class="error">${escapeHtml(String(e))}</p>`;
  }
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

/* ------------------------------ Tree clicks ----------------------------- */
tree.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-path]');
  if (!el) return;
  void openDoc(el.dataset.path!);
});

/* ------------------------------- Toolbar -------------------------------- */
$('#open-folder').addEventListener('click', async () => {
  const picked = await pickFolder();
  if (!picked) return;
  state.root = picked;
  crumb.textContent = picked;
  crumb.title = picked;
  tree.innerHTML = '<p class="muted">Scanning…</p>';
  try {
    state.docs = await scanFolder(picked);
    renderTree(state.docs);
  } catch (err) {
    tree.innerHTML = `<p class="error">${escapeHtml(String(err))}</p>`;
  }
});

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

// Ctrl/Cmd+B is the conventional shortcut for this panel.
window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === 'b') {
    e.preventDefault();
    setSidebarOpen(!state.sideOpen);
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

void initHighlighter().catch(() => { /* highlighting is best-effort */ });
