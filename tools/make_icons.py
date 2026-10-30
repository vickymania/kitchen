# -*- coding: utf-8 -*-
"""Draw the app icons: "R." and "G." in the site's own type, white on ink,
with the red dot of the big titles. Rendered by headless Chrome so the real
Chakra Petch is used, then sized with Pillow.

    py tools/make_icons.py

Writes public/icons/<app>-{180,192,512}.png and <app>-maskable-512.png. The
maskable one keeps the letter inside the middle 80%, so Android can cut the
icon to a circle or a squircle without clipping it.
"""
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS = os.path.join(ROOT, "public", "icons")
FONTS = os.path.join(ROOT, "public", "fonts")
CHROME = next((p for p in (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
) if os.path.exists(p)), None)

PAGE = """<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:C;font-weight:700;src:url("font.woff2")}
html,body{margin:0;width:512px;height:512px;overflow:hidden;background:#0B0D10}
div{width:512px;height:512px;display:flex;align-items:center;justify-content:center}
b{font:700 %(size)dpx/1 C;color:#fff;letter-spacing:-.02em;transform:translateY(%(shift)dpx)}
i{font-style:normal;color:#C8152C}
</style><div><b>%(letter)s<i>.</i></b></div>"""


def render(letter, size, shift, out):
    with tempfile.TemporaryDirectory() as tmp:
        # The font sits next to the page: the workspace path has a space in
        # it, and a font that fails to load gives a serif without any error.
        shutil.copy(os.path.join(FONTS, "chakra-petch-700-latin.woff2"), os.path.join(tmp, "font.woff2"))
        page = os.path.join(tmp, "icon.html")
        with open(page, "w", encoding="utf-8") as f:
            f.write(PAGE % {"size": size, "shift": shift, "letter": letter})
        shot = os.path.join(tmp, "shot.png")
        # Fonts from another file:// folder count as cross-origin; without
        # this flag Chrome silently falls back to a serif.
        subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                        "--allow-file-access-from-files",
                        "--force-device-scale-factor=1", "--window-size=512,512",
                        "--virtual-time-budget=2000", "--screenshot=" + shot, "file:///" + page.replace("\\", "/")],
                       check=True, capture_output=True, timeout=60)
        img = Image.open(shot).convert("RGB").crop((0, 0, 512, 512))
        img.save(out)
        return img


def main():
    if not CHROME:
        print("No Chrome or Edge found")
        return 1
    os.makedirs(ICONS, exist_ok=True)
    for app, letter in (("recipes", "R"), ("groceries", "G")):
        full = render(letter, 330, 8, os.path.join(ICONS, "%s-512.png" % app))
        for size in (192, 180):
            full.resize((size, size), Image.LANCZOS).save(os.path.join(ICONS, "%s-%d.png" % (app, size)))
        render(letter, 230, 6, os.path.join(ICONS, "%s-maskable-512.png" % app))
        print("icons for %s" % app)
    return 0


if __name__ == "__main__":
    sys.exit(main())
