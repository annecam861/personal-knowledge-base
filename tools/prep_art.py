"""Trim, square and shrink the Creative Fabrica PNGs into web-ready WebP files.

Usage: python -I prep_art.py <source_dir> <out_dir> <contact_sheet.png>
"""
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

src, out, sheet_path = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
out.mkdir(parents=True, exist_ok=True)
SIZE = 480

def slug(name: str) -> str:
    name = re.sub(r"^\d+\s*", "", name)
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")

files = sorted(p for p in src.rglob("*.png") if "__MACOSX" not in p.parts)
thumbs = []
for p in files:
    pack = p.relative_to(src).parts[0].split("-")[0].lower()  # design / mental / dreamscape
    im = Image.open(p).convert("RGBA")
    bbox = im.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    if bbox:
        im = im.crop(bbox)
    side = int(max(im.size) * 1.06)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
    canvas = canvas.resize((SIZE, SIZE), Image.LANCZOS)
    stem = "07 Cloud Management" if p.stem == "07 File Management" else p.stem  # mislabelled in the pack
    name = f"{pack}-{slug(stem)}.webp"
    canvas.save(out / name, "WEBP", quality=84, method=6)
    thumbs.append((name, canvas))

cols = 6
cell = 200
rows = (len(thumbs) + cols - 1) // cols
sheet = Image.new("RGB", (cols * cell, rows * (cell + 18)), (236, 236, 240))
draw = ImageDraw.Draw(sheet)
for i, (name, im) in enumerate(thumbs):
    x, y = (i % cols) * cell, (i // cols) * (cell + 18)
    t = im.resize((cell - 20, cell - 20), Image.LANCZOS)
    sheet.paste(t, (x + 10, y + 6), t)
    draw.text((x + 6, y + cell - 8), name[:32], fill=(30, 30, 40))
sheet.save(sheet_path)
total = sum(f.stat().st_size for f in out.glob("*.webp"))
print(f"{len(thumbs)} images, {total / 1024:.0f} KB total")
for name, _ in thumbs:
    print(name)
