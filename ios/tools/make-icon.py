#!/usr/bin/env python3
"""The app's icon: the Keeps mark (keepsgame.com's four ovals, as on the card back) as flat panes of frosted gold
glass on dark, in the manner of the system's own icons: translucent, evenly lit (a little lighter at the top), a fine
bright edge where the light catches, a hairline of shade at the bottom; no texture, no dome, and no border (the
system's rounded shape frames it; a line of another radius would compete with it). Drawn here
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
    shadow = np.roll(blurred(mark, N * 0.025), int(N * 0.014), axis=0)
    img = img * (1 - 0.45 * shadow)[..., None]
    glow = blurred(mark, N * 0.045)
    img = img + glow[..., None] * np.array([120, 84, 26]) * 0.35

    # The ovals: flat panes of frosted gold glass. Translucent (the glow behind shows a little through), a gentle
    # gradient from top to bottom, a fine bright edge strongest at the top, a hairline of shade along the bottom.
    top, bottom = np.array([246, 210, 122]), np.array([214, 166, 74])
    for ox, oy, rx, ry in OVALS:
        u = (x - (cx + ox * SCALE)) / (rx * SCALE)
        v = (y - (cy + oy * SCALE)) / (ry * SCALE)
        d = np.sqrt(u * u + v * v)
        inside = d <= 1
        f = np.clip((v + 1) / 2, 0, 1)[..., None]
        pane = top * (1 - f) + bottom * f
        colour = 0.86 * pane + 0.14 * (img + np.array([40, 30, 10]))
        # The edge, measured in pixels from the outline so it's even all round.
        px = (1 - d) * min(rx, ry) * SCALE
        band = np.clip(1 - px / (0.012 * N), 0, 1)
        up = np.clip(-v / np.maximum(d, 1e-6), 0, 1)  # 1 at the top of the oval, 0 from its middle down
        down = np.clip(v / np.maximum(d, 1e-6), 0, 1)
        light = band * (0.25 + 0.6 * up)
        colour = colour * (1 - light[..., None]) + np.array([255, 248, 226]) * light[..., None]
        shade = np.clip(1 - px / (0.006 * N), 0, 1) * down
        colour = colour * (1 - 0.22 * shade[..., None])
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
