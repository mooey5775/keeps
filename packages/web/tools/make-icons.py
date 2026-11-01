#!/usr/bin/env python3
"""The website's icons: the Keeps mark (keepsgame.com's four ovals, as on the card back and the app's icon) in gold on
warm dark. An SVG for browsers' tabs (sharp at any size), a 32-pixel PNG for those that take no SVG, and the
180-pixel touch icon for a phone's home screen (full-bleed: the phone rounds its corners). The mark fills more of the
small icons than of the app's, so it reads at tab size.

    python3 packages/web/tools/make-icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / "public"
# The mark, in units from its middle (measured from keepsgame.com's icon, as the app's): (x, y, half width, half height).
OVALS = [(0.0, -33.5, 17.5, 19.0), (-31.5, 1.0, 19.0, 17.5), (31.5, 1.0, 19.0, 17.5), (0.0, 33.5, 17.5, 19.0)]
SPAN = 102.0  # the mark's width, in those units
DARK_TOP, DARK_BOTTOM = (42, 32, 24), (20, 15, 11)
GOLD_TOP, GOLD_BOTTOM = (243, 210, 122), (201, 154, 69)


def svg(size=64, fill=0.78, radius=14):
    scale = fill * size / SPAN
    c = size / 2
    ovals = "\n".join(
        f'    <ellipse cx="{c + x * scale:.2f}" cy="{c + y * scale:.2f}" rx="{rx * scale:.2f}" ry="{ry * scale:.2f}"/>'
        for x, y, rx, ry in OVALS)
    hexes = lambda rgb: "#%02x%02x%02x" % rgb
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}">
  <defs>
    <linearGradient id="dark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{hexes(DARK_TOP)}"/><stop offset="1" stop-color="{hexes(DARK_BOTTOM)}"/></linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{hexes(GOLD_TOP)}"/><stop offset="1" stop-color="{hexes(GOLD_BOTTOM)}"/></linearGradient>
  </defs>
  <rect width="{size}" height="{size}" rx="{radius}" fill="url(#dark)"/>
  <g fill="url(#gold)">
{ovals}
  </g>
</svg>
'''


def png(size, fill, rounded):
    """The same drawing, at `size` pixels (drawn 8 times larger, then scaled down: smooth edges)."""
    big = size * 8
    def gradient(top, bottom):
        g = Image.new("RGB", (1, big))
        for y in range(big):
            t = y / (big - 1)
            g.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
        return g.resize((big, big))
    img = gradient(DARK_TOP, DARK_BOTTOM).convert("RGBA")
    mask = Image.new("L", (big, big), 0)
    scale, c = fill * big / SPAN, big / 2
    draw = ImageDraw.Draw(mask)
    for x, y, rx, ry in OVALS:
        draw.ellipse([c + (x - rx) * scale, c + (y - ry) * scale, c + (x + rx) * scale, c + (y + ry) * scale], fill=255)
    img.paste(gradient(GOLD_TOP, GOLD_BOTTOM), (0, 0), mask)
    if rounded:
        corners = Image.new("L", (big, big), 0)
        ImageDraw.Draw(corners).rounded_rectangle([0, 0, big - 1, big - 1], radius=big * 14 // 64, fill=255)
        img.putalpha(corners)
    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(exist_ok=True)
    (OUT / "favicon.svg").write_text(svg())
    png(32, 0.78, rounded=True).save(OUT / "favicon-32.png")
    png(180, 0.66, rounded=False).convert("RGB").save(OUT / "apple-touch-icon.png")


if __name__ == "__main__":
    main()
