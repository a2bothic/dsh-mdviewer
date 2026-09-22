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

let highlighter: HighlighterCore | null = null;

export async function initHighlighter(): Promise<void> {
  highlighter = await createHighlighterCore({
    themes: [githubLight, githubDark],
    langs: [
      javascript, typescript, python, bash, json, yaml, html, css, markdown,
      sql, rust, go, java, c, cpp, diff, xml, toml, ini, dockerfile,
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
