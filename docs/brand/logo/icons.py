"""Writes the desktop app icons (window, taskbar, tray, installer) from the logo geometry.

Run from the repo root: python docs/brand/logo/icons.py
Needs Pillow. The mark is drawn straight from build.py's geometry at 16x and downsampled, so
every size is a clean render rather than a scaled bitmap. No tile: the aqua mark sits on
transparency, cropped close so it fills the taskbar slot.
"""
import math
import pathlib

from PIL import Image, ImageDraw

from build import AQUA, GEOMETRY, GEOMETRY_SMALL

ROOT = pathlib.Path(__file__).resolve().parents[3]
ICONS = ROOT / "apps/desktop/src-tauri/icons"
PUBLIC = ROOT / "apps/desktop/public"

SUPERSAMPLE = 16
PADDING = 0.04  # of the icon's side, on each edge
SMALL_UP_TO = 48  # the small cut keeps the eye open up to here
# Windows asks for 20/30/40/60/80 px at 125-250 % display scaling; without them it rescales.
ICO_SIZES = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256]


def render(size, geometry, colour=AQUA):
    cx, cy, r, tip, eye, eye_r = geometry
    dx, dy = tip[0] - cx, tip[1] - cy
    a, b = math.atan2(dy, dx), math.acos(r / math.hypot(dx, dy))
    t1 = (cx + r * math.cos(a - b), cy + r * math.sin(a - b))
    t2 = (cx + r * math.cos(a + b), cy + r * math.sin(a + b))

    # A square box around the mark's own bounds, centred on them.
    left, right, top, bottom = cx - r, tip[0], cy - r, cy + r
    side = max(right - left, bottom - top) / (1 - 2 * PADDING)
    ox, oy = (left + right - side) / 2, (top + bottom - side) / 2

    big = size * SUPERSAMPLE
    k = big / side
    at = lambda p: ((p[0] - ox) * k, (p[1] - oy) * k)
    disc = lambda c, rad: [at((c[0] - rad, c[1] - rad)), at((c[0] + rad, c[1] + rad))]

    mask = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse(disc((cx, cy), r), fill=255)
    draw.polygon([at(t1), at(tip), at(t2), at((cx, cy))], fill=255)
    draw.ellipse(disc(eye, eye_r), fill=0)

    icon = Image.new("RGBA", (size, size), colour)
    icon.putalpha(mask.resize((size, size), Image.LANCZOS))
    return icon


def icon(size):
    return render(size, GEOMETRY_SMALL if size <= SMALL_UP_TO else GEOMETRY)


def menu_bar_template(size):
    """The macOS menu bar icon. A template image: macOS reads only its alpha and colours it
    for the menu bar, so the mark is plain black. The menu bar draws it 18 pt tall, so 36 px
    is sharp at 2x. Always the small cut: it is never shown larger than 18 pt."""
    return render(size, GEOMETRY_SMALL, colour="#000000")


def main():
    icon(32).save(ICONS / "32x32.png")  # also the tray icon's base
    icon(128).save(ICONS / "128x128.png")
    icon(256).save(ICONS / "128x128@2x.png")
    icon(512).save(ICONS / "icon.png")
    icon(1024).save(ICONS / "icon.icns")
    frames = [icon(n) for n in ICO_SIZES]
    frames[-1].save(ICONS / "icon.ico", sizes=[f.size for f in frames], append_images=frames[:-1])
    icon(32).save(PUBLIC / "favicon.png")
    (ICONS / "tray").mkdir(exist_ok=True)
    menu_bar_template(36).save(ICONS / "tray/macos-template.png")
    print("wrote app icons to", ICONS)


if __name__ == "__main__":
    main()
