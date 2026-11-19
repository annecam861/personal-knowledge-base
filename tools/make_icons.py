"""Make the app/home-screen icons from a transparent PNG (the orbiting brain art).

Usage: python -I tools/make_icons.py <source.png> <out_dir>
Writes icon-192.png, icon-512.png, maskable-512.png and apple-touch-icon.png.
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

src, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)

art = Image.open(src).convert("RGBA")
bbox = art.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
if bbox:
    art = art.crop(bbox)


def background(size: int) -> Image.Image:
    """Plum diagonal gradient with a soft lavender glow, matching the app hero."""
    bg = Image.new("RGB", (size, size))
    top, bottom = (0x3B, 0x2A, 0x86), (0x1D, 0x16, 0x40)
    px = bg.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    glow = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(glow)
    r = int(size * 0.42)
    c = size // 2
    d.ellipse((c - r, c - r, c + r, c + r), fill=110)
    from PIL import ImageFilter
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.12))
    lav = Image.new("RGB", (size, size), (0xB9, 0xA6, 0xFF))
    return Image.composite(lav, bg, glow)


def make(size: int, art_scale: float, rounded: bool) -> Image.Image:
    bg = background(size).convert("RGBA")
    target = int(size * art_scale)
    a = art.copy()
    a.thumbnail((target, target), Image.LANCZOS)
    bg.alpha_composite(a, ((size - a.width) // 2, (size - a.height) // 2))
    if rounded:
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=int(size * 0.22), fill=255)
        bg.putalpha(mask)
    return bg


make(192, 0.78, True).save(out / "icon-192.png", optimize=True)
make(512, 0.78, True).save(out / "icon-512.png", optimize=True)
make(512, 0.62, False).save(out / "maskable-512.png", optimize=True)        # safe zone for Android masks
make(180, 0.74, False).convert("RGB").save(out / "apple-touch-icon.png", optimize=True)  # iOS adds its own corners
print("icons written to", out)
