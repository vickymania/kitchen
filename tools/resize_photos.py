# -*- coding: utf-8 -*-
"""Shrink the exported To Do photos for upload.

Phone photos are several MB and can carry GPS location in their EXIF data.
This writes a copy of each at most 1600 px on the long side, as JPEG, with the
rotation applied and all metadata left out, to migration/export/photos-small/.

    py tools/resize_photos.py
"""
import os
import sys

from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "migration", "export", "photos")
DST = os.path.join(ROOT, "migration", "export", "photos-small")
LONG_EDGE = 1600


def main():
    os.makedirs(DST, exist_ok=True)
    before = after = 0
    for name in sorted(os.listdir(SRC)):
        src = os.path.join(SRC, name)
        try:
            img = Image.open(src)
        except Exception as e:  # not an image: say so, do not stop the rest
            print("skipped %s (%s)" % (name, e))
            continue
        img = ImageOps.exif_transpose(img).convert("RGB")
        img.thumbnail((LONG_EDGE, LONG_EDGE), Image.LANCZOS)
        dst = os.path.join(DST, os.path.splitext(name)[0] + ".jpg")
        # No exif= argument: Pillow writes no metadata at all.
        img.save(dst, "JPEG", quality=82, optimize=True, progressive=True)
        before += os.path.getsize(src)
        after += os.path.getsize(dst)
    print("%.1f MB -> %.1f MB in %s" % (before / 1e6, after / 1e6, os.path.relpath(DST, ROOT)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
