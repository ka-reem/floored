#!/usr/bin/env python3
"""Regenerate public/fonts/sign/*.woff2 (see app/fonts.css).

Zen Kaku Gothic New is fetched as a glyph subset of every CJK/kana character
found in the app source (plus ASCII + JP punctuation) via Google Fonts'
`text=` parameter; Overpass comes down as its latin / latin-ext slices.
Run from anywhere after adding new Japanese strings.
"""
import glob, os, re, subprocess, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "fonts", "sign")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"

def source_glyphs():
    chars = set()
    for pat in ("components/**/*.tsx", "app/**/*.tsx", "app/**/*.css", "game/**/*.ts"):
        for f in glob.glob(os.path.join(ROOT, pat), recursive=True):
            for ch in open(f, encoding="utf8").read():
                o = ord(ch)
                if 0x3000 <= o <= 0x30FF or 0x4E00 <= o <= 0x9FFF or 0xFF00 <= o <= 0xFFEF:
                    chars.add(ch)
    return "".join(sorted(chars))

def css(url):
    return subprocess.run(["curl", "-sS", "-m", "60", "-A", UA, url], capture_output=True, text=True, check=True).stdout

def get(url, fn):
    subprocess.run(["curl", "-sS", "-m", "120", "-o", os.path.join(OUT, fn), url], check=True)
    print(fn, os.path.getsize(os.path.join(OUT, fn)), "bytes")

os.makedirs(OUT, exist_ok=True)
text = "".join(chr(i) for i in range(0x20, 0x7F)) + "、。「」〜・ー→←↑↓↗↖↘↙×°…‐–—’“”" + source_glyphs()
for face in re.findall(r"@font-face \{(.*?)\}", css(
        "https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@700;900&display=swap&text=" + urllib.parse.quote(text)), re.S):
    w = re.search(r"font-weight: (\d+)", face).group(1)
    get(re.search(r"url\((https://[^)]+)\)", face).group(1), f"zen-kaku-gothic-new-{w}.woff2")
for name, face in re.findall(r"/\* ([a-z-]+) \*/\s*@font-face \{(.*?)\}", css(
        "https://fonts.googleapis.com/css2?family=Overpass:wght@900&display=swap"), re.S):
    if name in ("latin", "latin-ext"):
        get(re.search(r"url\((https://[^)]+)\)", face).group(1), f"overpass-{name}.woff2")
        print("  unicode-range:", re.search(r"unicode-range: ([^;]+)", face).group(1), "(keep app/fonts.css in sync)")
