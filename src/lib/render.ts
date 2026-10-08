/**
 * Markdown rendering pipeline.
 *
 * Ordering matters and is deliberate:
 *   1. Fenced code is lifted out so `$` inside code is never read as math.
 *   2. `$…$` / `$$…$$` are replaced with placeholder tokens and rendered to
 *      KaTeX HTML up front, so emphasis rules cannot eat formula characters.
 *   3. marked parses the remainder.
 *   4. DOMPurify sanitises, with KaTeX's tags and attributes allowed through.
 *   5. The KaTeX HTML is restored into the sanitised output.
 */
import { Marked } from 'marked';
import katex from 'katex';
import DOMPurify from 'dompurify';
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

import githubLight from 'shiki/themes/github-light.mjs';
import githubDark from 'shiki/themes/github-dark.mjs';

import javascript from 'shiki/langs/javascript.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import python from 'shiki/langs/python.mjs';
import bash from 'shiki/langs/bash.mjs';
import json from 'shiki/langs/json.mjs';
import yaml from 'shiki/langs/yaml.mjs';
import html from 'shiki/langs/html.mjs';
import css from 'shiki/langs/css.mjs';
import markdown from 'shiki/langs/markdown.mjs';
import sql from 'shiki/langs/sql.mjs';
import rust from 'shiki/langs/rust.mjs';
import go from 'shiki/langs/go.mjs';
import java from 'shiki/langs/java.mjs';
import c from 'shiki/langs/c.mjs';
import cpp from 'shiki/langs/cpp.mjs';
import diff from 'shiki/langs/diff.mjs';
import xml from 'shiki/langs/xml.mjs';
import toml from 'shiki/langs/toml.mjs';
import ini from 'shiki/langs/ini.mjs';
import dockerfile from 'shiki/langs/dockerfile.mjs';

// Extra languages for files opened directly (scripts, config, source), which
// arrive as a path rather than as a fenced code block with a language tag.
import powershell from 'shiki/langs/powershell.mjs';
import batch from 'shiki/langs/batch.mjs';
import fish from 'shiki/langs/fish.mjs';
import zsh from 'shiki/langs/zsh.mjs';
import nushell from 'shiki/langs/nushell.mjs';
import ruby from 'shiki/langs/ruby.mjs';
import php from 'shiki/langs/php.mjs';
import perl from 'shiki/langs/perl.mjs';
import lua from 'shiki/langs/lua.mjs';
import r from 'shiki/langs/r.mjs';
import kotlin from 'shiki/langs/kotlin.mjs';
import scala from 'shiki/langs/scala.mjs';
import swift from 'shiki/langs/swift.mjs';
import csharp from 'shiki/langs/csharp.mjs';
import dart from 'shiki/langs/dart.mjs';
import elixir from 'shiki/langs/elixir.mjs';
import erlang from 'shiki/langs/erlang.mjs';
import haskell from 'shiki/langs/haskell.mjs';
import clojure from 'shiki/langs/clojure.mjs';
import groovy from 'shiki/langs/groovy.mjs';
import julia from 'shiki/langs/julia.mjs';
import jsx from 'shiki/langs/jsx.mjs';
import tsx from 'shiki/langs/tsx.mjs';
import scss from 'shiki/langs/scss.mjs';
import less from 'shiki/langs/less.mjs';
import sass from 'shiki/langs/sass.mjs';
import jsonc from 'shiki/langs/jsonc.mjs';
import json5 from 'shiki/langs/json5.mjs';
import properties from 'shiki/langs/properties.mjs';
import makefile from 'shiki/langs/makefile.mjs';
import cmake from 'shiki/langs/cmake.mjs';
import dotenv from 'shiki/langs/dotenv.mjs';
import latex from 'shiki/langs/latex.mjs';
import asciidoc from 'shiki/langs/asciidoc.mjs';
import rst from 'shiki/langs/rst.mjs';
import vue from 'shiki/langs/vue.mjs';
import svelte from 'shiki/langs/svelte.mjs';
import astro from 'shiki/langs/astro.mjs';
import csv from 'shiki/langs/csv.mjs';
import protobuf from 'shiki/langs/protobuf.mjs';
import graphql from 'shiki/langs/graphql.mjs';
import nginx from 'shiki/langs/nginx.mjs';

let highlighter: HighlighterCore | null = null;

export async function initHighlighter(): Promise<void> {
  highlighter = await createHighlighterCore({
    themes: [githubLight, githubDark],
    langs: [
      javascript, typescript, python, bash, json, yaml, html, css, markdown,
      sql, rust, go, java, c, cpp, diff, xml, toml, ini, dockerfile,
      powershell, batch, fish, zsh, nushell, ruby, php, perl, lua, r, kotlin,
      scala, swift, csharp, dart, elixir, erlang, haskell, clojure, groovy,
      julia, jsx, tsx, scss, less, sass, jsonc, json5, properties, makefile,
      cmake, dotenv, latex, asciidoc, rst, vue, svelte, astro, csv, protobuf,
      graphql, nginx,
    ],
    engine: createJavaScriptRegexEngine(),
  });
}

const MATH_OPEN = '%%MDMATH';
const MATH_CLOSE = 'MDMATH%%';
const MATH_RE = /%%MDMATH(\d+)MDMATH%%/g;

let mathStore: string[] = [];

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function protectMath(src: string): string {
  mathStore = [];
  const stash = (tex: string, display: boolean): string => {
    let html: string;
    try {
      html = katex.renderToString(tex, {
        displayMode: display, throwOnError: false, strict: false, trust: false,
      });
    } catch {
      html = `<code>${escapeHtml(tex)}</code>`;
    }
    mathStore.push(html);
    return `${MATH_OPEN}${mathStore.length - 1}${MATH_CLOSE}`;
  };

  // Lift fenced code out first so its `$` characters are left alone.
  const fences: string[] = [];
  src = src.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (m) => {
    fences.push(m);
    return `\u0001FENCE${fences.length - 1}\u0001`;
  });

  src = src.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => stash(tex, true));
  src = src.replace(/(^|[^\\$])\$([^\n$]+?)\$/g, (_m, pre: string, tex: string) =>
    pre + stash(tex, false));

  src = src.replace(/\u0001FENCE(\d+)\u0001/g, (_m, i: string) => fences[Number(i)]!);
  return src;
}

function restoreMath(html: string): string {
  return html.replace(MATH_RE, (_m, i: string) => mathStore[Number(i)] ?? '');
}

// KaTeX emits MathML plus styled spans; everything else keeps DOMPurify defaults.
const KATEX_TAGS = [
  'math', 'semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub',
  'msubsup', 'mfrac', 'msqrt', 'mroot', 'mtext', 'mspace', 'mover', 'munder',
  'munderover', 'mtable', 'mtr', 'mtd', 'mstyle', 'mpadded', 'mphantom',
  'menclose', 'line', 'svg', 'path', 'g', 'defs', 'use',
];
const KATEX_ATTR = [
  'xmlns', 'encoding', 'mathvariant', 'stretchy', 'fence', 'separator',
  'lspace', 'rspace', 'display', 'width', 'height', 'viewBox',
  'preserveAspectRatio', 'd', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'fill',
  'stroke', 'aria-hidden', 'style', 'class',
];

const marked = new Marked({ gfm: true, breaks: false });

marked.use({
  renderer: {
    // marked passes a token object to custom renderers.
    code({ text, lang }: { text: string; lang?: string }) {
      const language = (lang ?? '').trim().split(/\s+/)[0] ?? '';
      let body: string;

      const loaded = highlighter?.getLoadedLanguages() ?? [];
      if (highlighter && language && loaded.includes(language)) {
        try {
          const html = highlighter.codeToHtml(text, {
            lang: language,
            themes: { light: 'github-light', dark: 'github-dark' },
          });
          // Take only the inner markup so our own wrapper is not nested.
          const inner = html.match(/<code[^>]*>([\s\S]*)<\/code>/);
          body = inner ? inner[1]! : escapeHtml(text);
        } catch {
          body = escapeHtml(text);
        }
      } else {
        body = escapeHtml(text);
      }

      const label = language
        ? `<span class="code-lang">${escapeHtml(language)}</span>` : '';
      return `<div class="code-block">${label}` +
        `<button class="copy-btn" type="button" data-copy>Copy</button>` +
        `<pre><code>${body}</code></pre></div>`;
    },
  },
});

export function renderMarkdown(md: string): string {
  const raw = marked.parse(protectMath(md)) as string;
  const clean = DOMPurify.sanitize(raw, {
    ADD_TAGS: KATEX_TAGS,
    ADD_ATTR: KATEX_ATTR,
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form'],
    ALLOW_ARIA_ATTR: true,
  });
  return restoreMath(clean);
}

/* --------------------------- Non-Markdown files -------------------------- */

/** Extensions that really are Markdown and should be parsed as prose. */
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx']);

/**
 * Extension to Shiki language id, for the files that are shown as source
 * rather than parsed as Markdown. Only ids present in the highlighter's loaded
 * set are useful here; an unknown extension falls back to plain text, which is
 * still readable, just not coloured.
 */
const EXTENSION_LANGUAGES: Record<string, string> = {
  sh: 'bash', bash: 'bash', zsh: 'zsh', fish: 'fish', ksh: 'bash',
  ps1: 'powershell', psm1: 'powershell', bat: 'batch', cmd: 'batch', nu: 'nushell',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  py: 'python', pyw: 'python', rb: 'ruby', php: 'php', pl: 'perl', pm: 'perl',
  lua: 'lua', r: 'r', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
  kts: 'kotlin', scala: 'scala', swift: 'swift', cs: 'csharp', vb: 'vb',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  hxx: 'cpp', m: 'objective-c', mm: 'objective-cpp', dart: 'dart',
  ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell', clj: 'clojure',
  cljs: 'clojure', groovy: 'groovy', jl: 'julia', sql: 'sql',
  vue: 'vue', svelte: 'svelte', astro: 'astro',
  html: 'html', htm: 'html', xhtml: 'html', css: 'css', scss: 'scss',
  sass: 'sass', less: 'less', xml: 'xml', svg: 'xml',
  json: 'json', jsonc: 'jsonc', json5: 'json5', yaml: 'yaml', yml: 'yaml',
  toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'properties',
  env: 'dotenv', gradle: 'groovy', mk: 'makefile', makefile: 'makefile',
  dockerfile: 'dockerfile', diff: 'diff', patch: 'diff', tex: 'latex',
  rst: 'rst', adoc: 'asciidoc', csv: 'csv', tsv: 'csv', log: 'log',
  proto: 'protobuf', graphql: 'graphql', gql: 'graphql',
};

/** The lower-case extension of a path, or an empty string when it has none. */
function extensionOf(path: string): string {
  const name = path.split(/[/\\]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * True when the file should be parsed as Markdown. Everything the viewer
 * accepts that is not Markdown is shown as highlighted source instead, so a
 * `.sh` or `.py` file is not mangled by Markdown's emphasis and list rules.
 */
export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extensionOf(path));
}

/**
 * Highlight a whole file as source. Returns sanitised markup.
 *
 * Shiki's own output separates each `span.line` with a literal newline text
 * node. That is right for a `<pre>` in its default mode, but this view wraps
 * long lines, so the newlines would stack on top of the wrapped text and
 * double every blank line. Each line is therefore emitted as a self-contained
 * block with no newlines between them, and the CSS gives it its own row.
 */
export function renderCode(text: string, language: string): string {
  const loaded = highlighter?.getLoadedLanguages() ?? [];
  let body: string;

  const plain = (): string => text
    .replace(/\n$/, '')
    .split('\n')
    // Left genuinely empty: the CSS gives an empty line its own height, and
    // injecting a placeholder would make it indistinguishable from real text.
    .map((line) => `<span class="line">${line ? escapeHtml(line) : ''}</span>`)
    .join('');

  if (highlighter && language && loaded.includes(language)) {
    try {
      const html = highlighter.codeToHtml(text, {
        lang: language,
        themes: { light: 'github-light', dark: 'github-dark' },
      });
      const inner = html.match(/<code[^>]*>([\s\S]*)<\/code>/)?.[1];
      // Drop only the whitespace BETWEEN line spans, never inside one: a line's
      // own leading indentation is part of its content.
      body = inner
        ? inner.replace(/<\/span>\s*?\n\s*(?=<span class="line")/g, '</span>')
        : plain();
    } catch { body = plain(); }
  } else {
    body = plain();
  }

  const raw = `<div class="code-block source-view">` +
    `<span class="code-lang">${escapeHtml(language || 'text')}</span>` +
    `<button class="copy-btn" type="button" data-copy>Copy</button>` +
    `<pre><code>${body}</code></pre></div>`;

  return DOMPurify.sanitize(raw, {
    ADD_ATTR: ['style', 'class'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
    ALLOW_ARIA_ATTR: true,
  });
}

/**
 * Render a document from its path, choosing the pipeline by file type. This is
 * the entry point the shell uses; `renderMarkdown` stays available for callers
 * that already know the text is Markdown.
 */
export function renderDocument(path: string, text: string): string {
  if (isMarkdownPath(path)) return renderMarkdown(text);
  return renderCode(text, EXTENSION_LANGUAGES[extensionOf(path)] ?? '');
}

export interface Heading { id: string; text: string; level: number; }

/** Assign ids to headings and return them for the table of contents. */
export function extractHeadings(root: HTMLElement): Heading[] {
  const used = new Map<string, number>();
  const out: Heading[] = [];

  root.querySelectorAll('h1, h2, h3, h4').forEach((h) => {
    const text = (h.textContent ?? '').trim();
    let id = text.toLowerCase().replace(/[^\w\u4e00-\u9fff\s-]/g, '')
      .trim().replace(/\s+/g, '-').slice(0, 80) || 'section';
    const n = used.get(id);
    if (n !== undefined) { used.set(id, n + 1); id = `${id}-${n + 1}`; }
    else { used.set(id, 0); }
    h.id = id;
    out.push({ id, text, level: Number(h.tagName[1]) });
  });

  return out;
}
