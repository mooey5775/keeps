#!/usr/bin/env python3
"""The app's icon: the Keeps mark (keepsgame.com's four ovals, as on the card back) in gold leaf on black, framed by
a thin gold line like the card's border. Drawn here at three times the size and scaled down, so it's the same every
time and needs no image editor. Writes the asset catalogue's icons (light, dark, tinted).

    python3 ios/tools/make-icon.py
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

OUT = Path(__file__).resolve().parents[1] / "App" / "Assets.xcassets" / "AppIcon.appiconset"
SIZE = 1024
SS = 3  # supersampling
N = SIZE * SS

# The mark, measured from keepsgame.com's icon (135 px): ovals 35 wide and 38 tall (the side pair turned), their
# centres 33.5 from the middle; scaled so the mark spans 46% of the icon.
SPAN = 102.0  # the mark's width in the 135 px icon
SCALE = 0.46 * N / SPAN
OVALS = [  # (centre x, centre y, half width, half height), in mark units from the middle
    (0.0, -33.5, 17.5, 19.0),
    (-31.5, 1.0, 19.0, 17.5),
    (31.5, 1.0, 19.0, 17.5),
    (0.0, 33.5, 17.5, 19.0),
]

# Gold leaf: a ramp from a pale highlight to deep amber (the app's gold, d2a94d, in the middle).
RAMP = [
    (0.00, (255, 243, 196)),
    (0.30, (243, 207, 116)),
    (0.55, (210, 169, 77)),
    (0.80, (150, 108, 40)),
    (1.00, (196, 150, 64)),
]


def ramp(t):
    t = np.clip(t, 0, 1)
    out = np.zeros(t.shape + (3,))
    for (a, ca), (b, cb) in zip(RAMP, RAMP[1:]):
        m = (t >= a) & (t <= b)
        f = ((t - a) / (b - a))[m][:, None]
        out[m] = np.array(ca) * (1 - f) + np.array(cb) * f
    return out


def leaf_texture(rng):
    """Gold leaf's crinkle: noise at a few scales (the finest crisp, for the leaf's flakes), around 1."""
    tex = np.zeros((N, N), dtype=np.float32)
    for cells, weight in ((18, 0.35), (70, 0.35), (300, 0.3)):
        small = rng.random((cells, cells))
        layer = np.array(Image.fromarray((small * 255).astype(np.uint8)).resize((N, N), Image.BICUBIC), dtype=np.float32) / 255.0
        tex += weight * layer
    return 0.9 + 0.2 * tex


def main():
    rng = np.random.default_rng(2026)
    y, x = np.mgrid[0:N, 0:N].astype(np.float32)
    cx = cy = N / 2

    # The background: warm black, a little lighter at the middle.
    r = np.hypot(x - cx, y - cy) / (N / 2)
    bg = np.stack([22 - 14 * r, 17 - 12 * r, 13 - 10 * r], axis=-1).clip(4, 255)
    img = bg.copy()

    # The frame: the card's rounded border, thin, in flat gold with a soft sheen.
    inset, radius, width = 0.085 * N, 0.13 * N, 0.011 * N
    qx = np.abs(x - cx) - (cx - inset - radius)
    qy = np.abs(y - cy) - (cy - inset - radius)
    outside = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - radius
    frame = np.clip(1 - np.abs(outside) / (width / 2), 0, 1) ** 0.6
    frame_colour = ramp(0.25 + 0.45 * (x + y) / (2 * N))
    img = img * (1 - frame[..., None]) + frame_colour * frame[..., None]

    # A soft glow under the mark, to lift it off the black.
    mark = np.zeros((N, N), dtype=np.float32)
    for ox, oy, rx, ry in OVALS:
        u = (x - (cx + ox * SCALE)) / (rx * SCALE)
        v = (y - (cy + oy * SCALE)) / (ry * SCALE)
        mark = np.maximum(mark, (u * u + v * v <= 1).astype(np.float32))
    glow = np.array(Image.fromarray((mark * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(N * 0.035))) / 255.0
    img = img + glow[..., None] * np.array([90, 62, 20]) * 0.55

    # The ovals: flat gold leaf. One sheen runs across the whole mark (lighter at the top left, a bright band on the
    # diagonal, darker to the bottom right), each oval has a fine bevel (its top-left edge catching the light, its
    # bottom-right edge in shadow), and the leaf's crinkle shows through.
    texture = leaf_texture(rng)
    half = 0.5 * SPAN * SCALE
    diagonal = ((x - cx) + (y - cy)) / (2 * half)  # -1 at the mark's top left, 1 at its bottom right
    sheen = np.exp(-(((x - cx) + (y - cy)) / (0.35 * half) + 0.15) ** 2)
    base = ramp(0.46 + 0.2 * diagonal - 0.2 * sheen)
    for ox, oy, rx, ry in OVALS:
        u = (x - (cx + ox * SCALE)) / (rx * SCALE)
        v = (y - (cy + oy * SCALE)) / (ry * SCALE)
        d = np.sqrt(u * u + v * v)
        inside = d <= 1
        edge = np.clip((d - 0.9) / 0.1, 0, 1)
        facing = -(u + v) / np.maximum(d, 1e-6) / np.sqrt(2)  # 1 where the edge faces the top left
        bevel = 1 + edge * 0.45 * facing
        colour = base * (texture * bevel)[..., None]
        img[inside] = colour[inside]

    light_icon = Image.fromarray(img.clip(0, 255).astype(np.uint8)).resize((SIZE, SIZE), Image.LANCZOS)

    # Tinted (the system colours it): the mark and frame by brightness, on black.
    grey = np.array(light_icon.convert("L")).astype(np.float32)
    tinted = Image.fromarray(np.clip((grey - 20) * 1.25, 0, 255).astype(np.uint8)).convert("RGB")

    OUT.mkdir(parents=True, exist_ok=True)
    light_icon.save(OUT / "AppIcon.png")
    light_icon.save(OUT / "AppIcon-dark.png")  # already dark
    tinted.save(OUT / "AppIcon-tinted.png")
    image = lambda name, appearance=None: {
        "filename": name,
        "idiom": "universal",
        "platform": "ios",
        "size": "1024x1024",
        **({"appearances": [{"appearance": "luminosity", "value": appearance}]} if appearance else {}),
    }
    contents = {
        "images": [image("AppIcon.png"), image("AppIcon-dark.png", "dark"), image("AppIcon-tinted.png", "tinted")],
        "info": {"author": "xcode", "version": 1},
    }
    (OUT / "Contents.json").write_text(json.dumps(contents, indent=2) + "\n")
    (OUT.parent / "Contents.json").write_text(json.dumps({"info": {"author": "xcode", "version": 1}}, indent=2) + "\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
