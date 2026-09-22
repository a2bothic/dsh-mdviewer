# Typography

The reading column follows a fixed pixel rhythm so that changing the text size
scales everything together.

| Token | Value | Reason |
|---|---|---|
| Line height | 24px | Fixed, not a ratio |
| Paragraph gap | 16px | Two thirds of the line height |
| Heading gap | 32 / 16px | Binds a heading to what follows |
| List indent | 18px | Tighter than the default |

## The rhythm in practice

Paragraphs sit closer to each other than to the headings above them, which is
what makes a document scannable. A heading with equal space above and below
reads as floating rather than belonging.

> A blockquote is an aside: a two-pixel bar and a muted colour, nothing more.

### Code

```python
def rhythm(line_height=24, block_gap=16):
    """Spacing is deliberate, not incidental."""
    return line_height + block_gap
```

### Math

Inline math like $O(n \log n)$ sits in the flow, and display math gets its own
line:

$$
T(n) = 2T\left(\frac{n}{2}\right) + O(n)
$$
