// Ingredient lines: parsing, scaling, merging and the key that links an
// ingredient to an item on the grocery list.
//
// Shared by the browser, the worker and the To Do migration, so it has no
// imports and touches no DOM. Recipe text is mostly Dutch, so the parser reads
// Dutch and English units; everything it stores is a language-neutral code.

// unit code -> words that mean it (lowercase, without a trailing period)
const UNIT_WORDS = {
  g: ["g", "gr", "gram", "grams", "gramm"],
  kg: ["kg", "kilo", "kilogram"],
  mg: ["mg"],
  ml: ["ml", "milliliter", "millilitre"],
  cl: ["cl"],
  dl: ["dl", "deciliter"],
  l: ["l", "liter", "litre", "liters"],
  tbsp: ["el", "eetl", "eetlepel", "eetlepels", "eetlepeltje", "eetlepeltjes", "tbsp", "tablespoon", "tablespoons", "tbs"],
  tsp: ["tl", "theel", "thl", "theelepel", "theelepels", "theelepeltje", "theelepeltjes", "teelepel", "teelepels",
    "tsp", "teaspoon", "teaspoons"],
  cm: ["cm", "centimeter"],
  clove: ["teen", "tenen", "teentje", "teentjes", "clove", "cloves"],
  can: ["blik", "blikken", "blikje", "blikjes", "can", "cans", "tin", "tins"],
  cube: ["blokje", "blokjes", "cube", "cubes"],
  pinch: ["snufje", "snufjes", "snuf", "mespuntje", "plukje", "plukjes", "pinch", "pinches"],
  packet: ["zakje", "zakjes", "zak", "zakken", "packet", "packets", "sachet", "bag", "bags"],
  pack: ["pak", "pakken", "pakje", "pakjes", "pack", "packs", "package"],
  bunch: ["bos", "bosje", "bosjes", "bossen", "bunch", "bunches"],
  handful: ["handje", "handjes", "handvol", "handful", "handfuls"],
  sprig: ["takje", "takjes", "sprig", "sprigs"],
  dash: ["scheut", "scheutje", "scheutjes", "dash", "splash"],
  slice: ["plak", "plakken", "plakje", "plakjes", "slice", "slices"],
  piece: ["stuk", "stuks", "stukje", "stukjes", "piece", "pieces", "pcs"],
  cup: ["kop", "kopje", "kopjes", "koppen", "cup", "cups"],
  sheet: ["vel", "vellen", "velletje", "sheet", "sheets"],
  jar: ["pot", "potje", "potjes", "potten", "jar", "jars"],
  bottle: ["fles", "flesje", "flessen", "bottle", "bottles"],
  bowl: ["bakje", "bakjes", "tray", "punnet"],
};

const WORD_TO_UNIT = new Map();
for (const [code, words] of Object.entries(UNIT_WORDS)) for (const w of words) WORD_TO_UNIT.set(w, code);

export const UNIT_CODES = Object.keys(UNIT_WORDS);

// Units that convert into each other, as [base unit, factor].
const CONVERT = { g: ["g", 1], kg: ["g", 1000], mg: ["g", 0.001], ml: ["ml", 1], cl: ["ml", 10], dl: ["ml", 100], l: ["ml", 1000] };

const FRACTIONS = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125 };

// A number at the start: 2 | 1,5 | 1.5 | ½ | 1½ | 1/2 | 1 1/2 | 2-3 | 2 à 3
// Longest forms first: "1 1/2" must not stop at "1".
const NUM = String.raw`(?:\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?(?:\s*[½¼¾⅓⅔⅛])?|[½¼¾⅓⅔⅛])`;
const QTY_RE = new RegExp(String.raw`^(${NUM})(?:\s*(?:-|–|tot|à|a|to)\s*(${NUM}))?\s*`, "i");

function readNumber(text) {
  const t = text.trim().replace(",", ".");
  let m = t.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = t.match(/^(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) / Number(m[2]);
  m = t.match(/^(\d+(?:\.\d+)?)?\s*([½¼¾⅓⅔⅛])?$/);
  if (m && (m[1] || m[2])) return (m[1] ? Number(m[1]) : 0) + (m[2] ? FRACTIONS[m[2]] : 0);
  return null;
}

const PREP_AFTER_COMMA = new RegExp(String.raw`^([^,]+),\s*(` + [
  String.raw`(?:fijn|grof)?ge[a-z]+[dt]\b.*`, "in .+", "zonder .+", "met .+", "zaden .+", "op gevoel", "naar smaak",
  "scheut(je)?", "om .+", "uitgeperst", "voor .+", "finely .+", "chopped", "diced", "sliced", "grated", "drained", "to taste",
].join("|") + ")$", "i");

/** "optioneel: maïzena", "(Geraspte kaas)" and friends are optional. */
const OPTIONAL_RE = /^(?:optioneel|optional|evt\.?|eventueel)\s*[:\-]?\s*/i;

/**
 * Parse one ingredient line into
 *   { qty, qty_max, unit, name, note, optional, raw }
 * qty and unit are null when the line has none ("verse peterselie").
 */
export function parseIngredient(line) {
  const raw = String(line ?? "").replace(/^[\s▢☐□•·\-*]+/, "").replace(/\s+/g, " ").trim();
  let rest = raw;
  let optional = false;

  if (OPTIONAL_RE.test(rest)) {
    optional = true;
    rest = rest.replace(OPTIONAL_RE, "");
  }
  // A whole line in brackets is a serving suggestion: "(Geraspte kaas)".
  if (/^\(.*\)$/.test(rest)) {
    optional = true;
    rest = rest.slice(1, -1).trim();
  }

  let qty = null;
  let qtyMax = null;
  const q = rest.match(QTY_RE);
  if (q) {
    qty = readNumber(q[1]);
    qtyMax = q[2] ? readNumber(q[2]) : null;
    if (qty !== null) rest = rest.slice(q[0].length);
    else qtyMax = null;
  }

  let unit = null;
  // "200ml" was glued to the number and is now "ml water"; "2 eetlepels kerrie".
  const u = rest.match(/^([a-zA-Zéëè]+)\.?(?:\s+|$)/);
  if (u && WORD_TO_UNIT.has(u[1].toLowerCase())) {
    const word = u[1].toLowerCase();
    // "l" and "g" alone are units only right after a number: "l" could start a name.
    if (qty !== null || word.length > 2) {
      unit = WORD_TO_UNIT.get(word);
      rest = rest.slice(u[0].length);
    }
  }
  // "snufje komijn" has a unit without a number: it means one.
  if (unit && qty === null) qty = 1;

  // Text in brackets is a note: "kippenbouillon (Maggi)", "blik tomaten (400 gram)".
  const notes = [];
  let name = rest.replace(/\(([^)]*)\)/g, (_, inner) => {
    if (inner.trim()) notes.push(inner.trim());
    return " ";
  });
  // How to prepare it is a note, not part of the name: "uien, gepeld",
  // "knoflook, uitgeperst", "paneermeel, op gevoel", "ui gesnipperd".
  const comma = name.match(PREP_AFTER_COMMA);
  if (comma) {
    name = comma[1];
    notes.unshift(comma[2].trim());
  }
  const trailing = name.trim().match(/^(.+?)\s+((?:fijn|grof)?ge[a-z]{3,}[dt])$/i);
  if (trailing && trailing[2].toLowerCase() !== "gehakt") {
    name = trailing[1];
    notes.unshift(trailing[2]);
  }
  name = name.replace(/\s+/g, " ").trim().replace(/^[:\-,]\s*/, "").replace(/[\s.]+$/, "");

  return {
    qty,
    qty_max: qtyMax,
    unit,
    name,
    note: notes.join("; "),
    optional,
    raw,
  };
}

// nameKey is pure and called for the same names thousands of times per render
// (the Deals tab weighs every offer against every product he buys often).
const KEY_CACHE = new Map();
const KEY_CACHE_MAX = 20000;

/** The key that makes "Ui", "ui " and "uien (rood)" find the same item. */
export function nameKey(name) {
  const text = String(name ?? "");
  let key = KEY_CACHE.get(text);
  if (key === undefined) {
    if (KEY_CACHE.size >= KEY_CACHE_MAX) KEY_CACHE.clear();
    KEY_CACHE.set(text, (key = computeKey(text)));
  }
  return key;
}

function computeKey(text) {
  return text
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Round to what a cook would weigh or count. */
export function roundQty(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  if (n >= 100) return Math.round(n / 5) * 5;
  if (n >= 10) return Math.round(n);
  // One decimal, but land on a quarter when it is that close: 1.5 onions, 1.3 kg.
  const quarter = Math.round(n * 4) / 4;
  if (Math.abs(n - quarter) < 0.05) return quarter;
  return n >= 1 ? Math.round(n * 10) / 10 : Math.round(n * 100) / 100;
}

/** An ingredient for `servings` people when the recipe is written for `base`. */
export function scaleIngredient(ing, base, servings) {
  if (!base || !servings || base === servings || ing.qty === null || ing.qty === undefined) return { ...ing };
  const f = servings / base;
  // A pinch stays a pinch.
  if (ing.unit === "pinch" || ing.unit === "dash") return { ...ing };
  return { ...ing, qty: roundQty(ing.qty * f), qty_max: ing.qty_max ? roundQty(ing.qty_max * f) : null };
}

/** An amount is { qty, unit } or { text } for anything a person typed freely. */
export function amountOf(ing) {
  if (ing.qty === null || ing.qty === undefined) return null;
  return { qty: ing.qty, unit: ing.unit ?? null };
}

/**
 * Add amounts together where they can be: 400 g + 0,2 kg = 600 g, 2 + 1 = 3.
 * Different units stay side by side: [600 g, 2 tbsp].
 */
export function mergeAmounts(a = [], b = []) {
  const out = a.map((x) => ({ ...x }));
  for (const add of b) {
    if (!add) continue;
    if (add.text !== undefined) {
      if (!out.some((x) => x.text === add.text)) out.push({ text: add.text });
      continue;
    }
    const [baseAdd, fAdd] = CONVERT[add.unit] ?? [add.unit ?? null, 1];
    const hit = out.find((x) => x.text === undefined && (CONVERT[x.unit]?.[0] ?? x.unit ?? null) === baseAdd);
    if (!hit) {
      out.push({ qty: add.qty, unit: add.unit ?? null });
      continue;
    }
    const [, fHit] = CONVERT[hit.unit] ?? [hit.unit, 1];
    const total = hit.qty * fHit + add.qty * fAdd;
    // Keep the larger unit when the total fills it: 1500 g reads as 1,5 kg.
    if (baseAdd === "g" && total >= 1000) Object.assign(hit, { qty: roundQty(total / 1000), unit: "kg" });
    else if (baseAdd === "ml" && total >= 1000) Object.assign(hit, { qty: roundQty(total / 1000), unit: "l" });
    else Object.assign(hit, { qty: roundQty(total / (CONVERT[hit.unit]?.[1] ?? 1)) });
  }
  return out;
}

/**
 * What someone types in the add box of the list: "2 ui", "500 gr gehakt".
 * A big bare number is part of the name: "305 printer inkt" is ink.
 */
export function parseListInput(text) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  const p = parseIngredient(raw);
  if (p.qty !== null && p.name && !p.optional && (p.unit || p.qty < 20)) {
    return { title: p.name, amounts: [{ qty: p.qty, unit: p.unit }], note: p.note };
  }
  return { title: raw, amounts: [], note: "" };
}

/** Turn what someone typed in the amount field into amounts. */
export function parseAmount(text) {
  const t = String(text ?? "").trim();
  if (!t) return [];
  const p = parseIngredient(t);
  if (p.qty !== null && !p.name) return [{ qty: p.qty, unit: p.unit }];
  return [{ text: t }];
}

/** Format a number the Dutch or English way, with ½ and ¼ where they fit. */
export function formatQty(n, locale = "nl") {
  if (n === null || n === undefined) return "";
  const whole = Math.floor(n);
  const frac = Math.round((n - whole) * 100) / 100;
  const glyph = { 0.25: "¼", 0.5: "½", 0.75: "¾", 0.33: "⅓", 0.67: "⅔" }[frac];
  if (glyph && n < 10) return (whole ? String(whole) : "") + glyph;
  return n.toLocaleString(locale === "nl" ? "nl-NL" : "en-GB", { maximumFractionDigits: 2 });
}
