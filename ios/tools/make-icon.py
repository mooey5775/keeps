#!/usr/bin/env python3
"""The app's icon: the Keeps mark (keepsgame.com's four ovals, as on the card back) in glassy gold on dark, in the
manner of the system's own icons: translucent material lit from above (a gloss on top, a bright rim where the light
catches, a glow where it comes through at the bottom), no texture, and no border (the system's rounded shape frames
it; a line of another radius would compete with it). Drawn here
at three times the size and scaled down, so it's the same every time and needs no image editor. Writes the asset catalogue's icons (light, dark, tinted).

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
# centres 33.5 from the middle; scaled so the mark spans 64% of the icon.
SPAN = 102.0  # the mark's width in the 135 px icon
SCALE = 0.64 * N / SPAN
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


def main():
    y, x = np.mgrid[0:N, 0:N].astype(np.float32)
    cx = cy = N / 2

    # The background: a smooth dark gradient, warmer and a little lighter at the top.
    t = y / N
    bg = np.stack([28 - 18 * t, 22 - 15 * t, 17 - 12 * t], axis=-1)
    r = np.hypot(x - cx, y - cy) / (N / 2)
    img = bg * (1 - 0.25 * np.clip(r - 0.6, 0, 1))[..., None]

    def blurred(mask, radius):
        return np.array(Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32) / 255.0

    # The mark's shape, for its shadow and glow.
    mark = np.zeros((N, N), dtype=np.float32)
    for ox, oy, rx, ry in OVALS:
        u = (x - (cx + ox * SCALE)) / (rx * SCALE)
        v = (y - (cy + oy * SCALE)) / (ry * SCALE)
        mark = np.maximum(mark, (u * u + v * v <= 1).astype(np.float32))
    # A soft shadow below, then a warm glow around: the glass sits a little above the dark.
    shadow = np.roll(blurred(mark, N * 0.02), int(N * 0.018), axis=0)
    img = img * (1 - 0.55 * shadow)[..., None]
    glow = blurred(mark, N * 0.045)
    img = img + glow[..., None] * np.array([120, 84, 26]) * 0.45

    # The ovals: translucent gold, lighter at the top, deeper at the bottom; a gloss over the upper part; a bright rim
    # where the light catches the top-left edge; a warm glow inside the bottom edge, where light comes through.
    top, bottom = np.array([255, 222, 140]), np.array([200, 138, 42])
    for ox, oy, rx, ry in OVALS:
        u = (x - (cx + ox * SCALE)) / (rx * SCALE)
        v = (y - (cy + oy * SCALE)) / (ry * SCALE)
        d = np.sqrt(u * u + v * v)
        inside = d <= 1
        f = np.clip((v + 1) / 2, 0, 1)[..., None]
        colour = top * (1 - f) + bottom * f
        # Translucent: a little of what's behind shows through.
        colour = 0.88 * colour + 0.12 * img
        # The glow inside the bottom edge.
        caustic = np.clip((d - 0.62) / 0.38, 0, 1) ** 2 * np.clip(v, 0, 1)
        colour = colour + caustic[..., None] * np.array([255, 214, 120]) * 0.35
        # The gloss: a soft lens of light over the upper part.
        gu, gv = u / 0.72, (v + 0.42) / 0.36
        gloss = np.clip(1 - (gu * gu + gv * gv), 0, 1) ** 1.5
        colour = colour * (1 - 0.32 * gloss[..., None]) + np.array([255, 250, 232]) * (0.32 * gloss[..., None])
        # The rim: a thin bright line, strongest where the edge faces the top left, gone at the bottom right.
        facing = np.clip(-(0.55 * u + 0.83 * v) / np.maximum(d, 1e-6), 0, 1)
        rim = np.clip(1 - np.abs(d - 0.965) / 0.03, 0, 1) * facing
        colour = colour * (1 - 0.75 * rim[..., None]) + np.array([255, 252, 238]) * (0.75 * rim[..., None])
        # The edge: slightly darker, so the shape reads against the glow.
        edge = np.clip((d - 0.985) / 0.015, 0, 1) * (1 - facing)
        colour = colour * (1 - 0.25 * edge[..., None])
        img[inside] = colour[inside]

    light_icon = Image.fromarray(img.clip(0, 255).astype(np.uint8)).resize((SIZE, SIZE), Image.LANCZOS)

    # Tinted (the system colours it): the mark by brightness, on black.
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
