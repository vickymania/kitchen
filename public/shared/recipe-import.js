// A recipe read from photos or a web page (worker/recipe-import.js) is a
// draft for the editor (public/app/recipe-edit.js). This file holds what both
// sides need: the crop box of the dish photo, checked the same way on the
// worker (Claude's answer) and on the phone (the canvas crop).
//
// A box is { x, y, width, height } as fractions of the photo (0..1), x and y
// its top left corner.

/** A box smaller than this share of the photo on either side is not a dish. */
export const MIN_BOX_SIDE = 0.1;
/** Room around the food, as a share of the box, so a plate is not cut at its rim. */
export const BOX_PAD = 0.04;

const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : NaN);

/**
 * Claude's box, kept inside the photo. Null when it is missing, not numbers,
 * or too small to be the dish once clamped.
 */
export function clampBox(box) {
  if (!box || typeof box !== "object") return null;
  let x = num(box.x);
  let y = num(box.y);
  let w = num(box.width);
  let h = num(box.height);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  // A box that starts outside the photo is cut at its edge.
  const x2 = Math.min(1, x + w);
  const y2 = Math.min(1, y + h);
  x = Math.max(0, x);
  y = Math.max(0, y);
  w = x2 - x;
  h = y2 - y;
  if (w < MIN_BOX_SIDE || h < MIN_BOX_SIDE) return null;
  const r = (v) => Math.round(v * 10000) / 10000;
  return { x: r(x), y: r(y), width: r(w), height: r(h) };
}

/**
 * The pixel rectangle to cut from a photo of `imgW` x `imgH`, with a little
 * room around the box, never outside the photo. Null for a box clampBox refuses.
 */
export function cropRect(box, imgW, imgH, pad = BOX_PAD) {
  const b = clampBox(box);
  if (!b || !(imgW > 0) || !(imgH > 0)) return null;
  const px = b.width * pad;
  const py = b.height * pad;
  const left = Math.max(0, Math.floor((b.x - px) * imgW));
  const top = Math.max(0, Math.floor((b.y - py) * imgH));
  const right = Math.min(imgW, Math.ceil((b.x + b.width + px) * imgW));
  const bottom = Math.min(imgH, Math.ceil((b.y + b.height + py) * imgH));
  return { sx: left, sy: top, sw: right - left, sh: bottom - top };
}
