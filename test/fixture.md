# Markdown Viewer

A lightweight desktop viewer for folders of Markdown documents.

## The reading rhythm

Typography is the whole point. The column uses a **fixed 24px line height**
rather than a ratio, so changing the text size scales the entire layout evenly
instead of letting headings and body text drift apart.

Space above a heading is twice the space below it, which binds each heading to
the content underneath. That single asymmetry does more for scannability than
any amount of font tuning.

> A blockquote is an aside: a two-pixel bar and a muted colour, nothing louder.

## Spacing that is deliberate

| Element | Value | Why |
|---|---|---|
| Paragraph gap | 16px | Two thirds of the line height |
| Heading gap | 32 / 16px | Binds heading to content |
| List indent | 18px | Tighter than the 40px default |
| Rule height | 0.5px | A hairline, not a divider |

## Lists and tasks

- The first item carries no top margin of its own
- Later items are separated by a small, deliberate gap
- Nested lists tighten further:

  - Nested item one
  - Nested item two

1. Ordered lists share the same indent
2. Markers are muted so numbers do not compete with text

- [x] Folder browsing with directory grouping
- [x] Full-text search across every document
- [x] Collapsible sidebar and draggable panels
- [ ] Anything that writes to disk

## Code

Inline `const x = 1` sits in the flow. A fenced block gets its own surface and
a copy button:

```javascript
const reader = {
  measure: '52rem',
  baseSize: 16,
  rhythm: { lineHeight: 24, blockGap: 16, headingGap: 32 },
};

export function render(markdown) {
  return reader.parse(markdown, { gfm: true });
}
```

```rust
#[tauri::command]
fn search_documents(root: String, query: String) -> Result<SearchResult, String> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(SearchResult::default());
    }
    // Every filesystem call lives here, never in the webview.
    Ok(walk_and_match(&root, &needle)?)
}
```

## Math

Inline math such as $O(n \log n)$ sits in the flow, and display math gets a
line of its own:

$$
T(n) = 2T\left(\frac{n}{2}\right) + O(n)
$$

## Links

An [external link](https://example.com) stays quiet until hovered, so the page
does not glitter while you read.

---

Trailing text after a horizontal rule, to show the spacing around it.
