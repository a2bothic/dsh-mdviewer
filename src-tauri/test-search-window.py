#!/usr/bin/env python3
"""Faithful port of the Rust search-window logic, to verify char offsets.

The front end highlights `text[start:end]`, so the offsets must be character
indices into the returned display string. Getting these wrong silently
mis-highlights results.
"""
import sys


def window(line: str, match_start_chars: int, match_len: int, pad: int = 40):
    chars = list(line)
    win_start = max(0, match_start_chars - pad)
    win_end = min(len(chars), match_start_chars + match_len + pad)

    display = ''.join(chars[win_start:win_end])
    start = match_start_chars - win_start
    if win_start > 0:
        display = '…' + display
        start += 1
    if win_end < len(chars):
        display += '…'
    end = min(start + match_len, len(display))
    return display, start, end


def check(line, needle, label):
    lower = line.lower()
    pos = lower.find(needle.lower())
    if pos < 0:
        print(f"SKIP  {label}: not found")
        return True
    ms = len(line[:pos])
    display, start, end = window(line, ms, len(needle))
    highlighted = display[start:end]
    ok = highlighted.lower() == needle.lower()
    print(f"{'PASS' if ok else 'FAIL'}  {label}")
    print(f"      display={display!r}")
    print(f"      highlight={highlighted!r} (expected {needle!r})")
    return ok


cases = [
    ("short line with TODO marker", "TODO", "short match"),
    ("x" * 100 + "NEEDLE" + "y" * 100, "NEEDLE", "long line, truncate both sides"),
    ("NEEDLE at the very start", "NEEDLE", "match at start"),
    ("ends with NEEDLE", "NEEDLE", "match at end"),
    ("中文内容包含 关键词 的段落", "关键词", "CJK match"),
    ("mixed 中文 and English KEYWORD here", "KEYWORD", "mixed script"),
    ("a" * 39 + "HIT" + "b" * 100, "HIT", "match just inside left pad"),
    ("a" * 41 + "HIT" + "b" * 100, "HIT", "match just inside right pad"),
]

failures = 0
for line, needle, label in cases:
    if not check(line, needle, label):
        failures += 1

print(f"\n{len(cases)-failures}/{len(cases)} passed")
sys.exit(1 if failures else 0)
