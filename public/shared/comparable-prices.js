// Comparable products at other stores (30-10-2026: "als ik naar de
// verschillende winkels kijk ontbreekt bij bijna alles nog steeds de prijs per
// item"). Most of what he buys is an AH store brand ("AH Eieren"), which no
// other store sells, so an exact price (public/shared/store-prices.js) exists
// only at AH. For an ITEM he buys or has on the list, this finds the
// comparable product in one store's Checkjebon rows: the same kind of thing
// (the words of his product's name without its brand, the item's words, the
// same product kind) in a similar pack (within PACK_TOLERANCE, compared per
// kg, l or piece), the cheapest per unit of the close matches. The op
// prices.sync keeps one such row per item and store ("spc-<store>-<item>",
// comparable = 1) only where that store has no exact price of the item. The
// screens mark it "vergelijkbaar". Never an excluded thing; a private item's
// row carries its item_id, so worker/privacy.js hides it from the others.
//
// Unsure is nothing: a word in the row that is not his (beyond a brand of at
// most MAX_BRAND_WORDS words in front), a variant he does not buy (bio,
// lactosevrij, light...), another kind (chocolate eggs for eggs), a pack
// twice the size: no comparable.
import { isExcluded } from "./excluded.js";
import { nameKey } from "./ingredients.js";
import { canonicalStore } from "./stores.js";
import { keyWords, packSize, noise, holds, sameWord, DEFAULT_WORDS } from "./store-prices.js";
import { productKind, kindFromName, kindFits } from "./product-kinds.js";
import { preferenceAt } from "./preferences.js";

/** A comparable pack holds at most this many times more (or less) than his. */
export const PACK_TOLERANCE = 1.5;
/** Words in front of the matched ones that may be the row's brand ("Campina", "Dr. Oetker"). */
export const MAX_BRAND_WORDS = 2;
/** A store's own sub-brands: they say nothing about what the product is. */
export const SUB_BRANDS = new Set(["excellent", "basic", "basis", "terra", "gwoon", "beste", "huismerk", "premium", "selection", "kies", "smaakt", "jouw"]);
/** Variants that make another product: only comparable when his product is that variant too. */
export const VARIANTS = new Set(["bio", "biologisch", "biologische", "lactosevrij", "lactosevrije", "glutenvrij", "glutenvrije", "light", "lite",
  "zero", "vegan", "vegetarisch", "vegetarische", "plantaardig", "plantaardige", "halal", "kids", "mini", "minis", "suikervrij", "suikervrije",
  "ongezouten", "zoutarm", "proteine", "protein", "eiwit", "eiwitrijk", "decafe", "cafeinevrij"]);

const isVariant = (w) => [...VARIANTS].some((v) => w === v || (v.length >= 5 && sameWord(w, v)));
/** What a product is comes before what it is in or with: "kipfilet met eieren" is kipfilet. */
const headOf = (name) => String(name ?? "").split(/\s+(?:met|in|op|uit|voor|zonder)\s+/i)[0];
const contentWords = (words) => words.filter((w) => w.length > 1 && !noise(w));

// ------------------------------------------------------------- unit prices

/** The price per kg, l or piece of a pack ({ count, grams, ml }): { per, cents } or null. */
export function unitPrice(cents, size) {
  if (!size || !(cents > 0)) return null;
  if (size.grams > 0) return { per: "kg", cents: Math.round((cents * 1000) / size.grams) };
  if (size.ml > 0) return { per: "l", cents: Math.round((cents * 1000) / size.ml) };
  if (size.count > 0) return { per: "piece", cents: Math.round(cents / size.count) };
  return null;
}

/** The measure two packs share ("grams", "ml" or "count"), weight first; null when none. */
export function sharedMeasure(a, b) {
  if (!a || !b) return null;
  for (const k of ["grams", "ml", "count"]) if (a[k] > 0 && b[k] > 0) return k;
  return null;
}

/** How many times bigger the bigger pack is (1 = the same); Infinity when they share no measure. */
export function packRatio(a, b) {
  const k = sharedMeasure(a, b);
  return k ? Math.max(a[k], b[k]) / Math.min(a[k], b[k]) : Infinity;
}

// --------------------------------------------------------- what to compare

const byItemCache = new WeakMap();
/** Live products per item, newest first (built once per products object). */
function productsByItem(products) {
  const key = products ?? {};
  let map = byItemCache.get(key);
  if (!map) {
    map = new Map();
    for (const p of Object.values(key)) {
      if (!p?.item_id || p.deleted_at) continue;
      if (!map.has(p.item_id)) map.set(p.item_id, []);
      map.get(p.item_id).push(p);
    }
    for (const list of map.values()) list.sort((a, b) => String(b.updated_at ?? b.created_at ?? "").localeCompare(String(a.updated_at ?? a.created_at ?? "")));
    if (products) byItemCache.set(products, map);
  }
  return map;
}

/** The live products of an item, newest first. */
export const productsOfItem = (data, itemId) => productsByItem(data.products).get(itemId) ?? [];

/**
 * The product a comparable is compared with: the item's preference for any
 * store and recipe, else items.preferred_product_id, else his newest product
 * of the item; null when he has none (then only the item's name counts).
 */
export function referenceProduct(data, itemId) {
  const live = (id) => {
    const p = id ? data.products?.[id] : null;
    return p && !p.deleted_at ? p : null;
  };
  return live(preferenceAt(data.preferences ?? {}, itemId, "", "")?.product_id)
    ?? live(data.items?.[itemId]?.preferred_product_id)
    ?? productsOfItem(data, itemId)[0]
    ?? null;
}

/**
 * What a comparable must be for one item: { item_id, product_id, words,
 * required, itemWords, needItem, size, kind, variants }, or null when the item
 * can never have one (gone, merged, excluded, no words).
 */
export function comparableTarget(item, product) {
  if (!item?.id || item.deleted_at || item.merged_into || !item.name || isExcluded(item.name)) return null;
  if (product && (isExcluded(product.name ?? "") || isExcluded(`${product.brand ?? ""} ${product.name ?? ""}`))) return null;
  const itemWords = contentWords(keyWords(item.name));
  let words = [];
  let size = null;
  let kind = kindFromName(item.name);
  if (product?.name && !product.deleted_at) {
    const brand = keyWords(product.brand);
    let name = keyWords(headOf(product.name));
    if (brand.length && brand.every((w, i) => name[i] === w)) name = name.slice(brand.length);
    words = contentWords(name).filter((w) => !DEFAULT_WORDS.has(w) && !SUB_BRANDS.has(w));
    size = packSize(product.size, product.name);
    kind = productKind(product) ?? kind;
  }
  if (!words.length) {
    words = itemWords;
    size = null;
  }
  if (!words.length) return null;
  // The item's words say what kind of thing it is; the rest of the name which one.
  let required = words.filter((w) => !itemWords.some((i) => sameWord(i, w)));
  // "AH Scharrel eieren": scharrel alone is not enough, eieren must be in the row too.
  const needItem = required.length === 1 && required.length < words.length;
  if (!required.length) required = words;
  return {
    item_id: item.id, product_id: product?.id ?? "", words, required, itemWords, needItem, size, kind,
    variants: words.filter(isVariant),
  };
}

/**
 * The items that get comparables: every live item he has a product of (he
 * buys it) and every item on the list. targets: comparableTarget per item.
 */
export function comparableTargets(state) {
  const wanted = new Set();
  for (const p of Object.values(state.products ?? {})) if (p?.item_id && !p.deleted_at) wanted.add(p.item_id);
  for (const e of Object.values(state.entries ?? {})) if (e?.item_id && !e.deleted_at && !e.checked_at) wanted.add(e.item_id);
  const out = [];
  for (const id of wanted) {
    const item = state.items?.[id];
    const t = item ? comparableTarget(item, referenceProduct(state, id)) : null;
    if (t) out.push(t);
  }
  return out;
}

// ------------------------------------------------------------- matching

/** Is this row (its name) the same kind of thing as the target? */
export function rowComparable(t, name) {
  if (!t || isExcluded(name)) return false;
  const words = contentWords(keyWords(headOf(name)));
  const known = (o) => t.words.some((w) => holds(o, w)) || t.itemWords.some((w) => holds(o, w));
  const first = words.findIndex(known);
  if (first < 0 || first > MAX_BRAND_WORDS) return false;
  for (const o of words.slice(first)) if (!known(o) && !DEFAULT_WORDS.has(o) && !SUB_BRANDS.has(o)) return false;
  if (!t.required.every((w) => words.some((o) => holds(o, w)))) return false;
  if (t.needItem && !t.itemWords.some((w) => words.some((o) => holds(o, w)))) return false;
  // A variant in the row that his product is not (bio, lactosevrij...): another product.
  for (const o of words) if (isVariant(o) && !t.variants.some((v) => holds(o, v) || holds(v, o))) return false;
  const kind = kindFromName(headOf(name));
  return kindFits(t.kind, kind) && kindFits(kind, t.kind);
}

/** Keys under which a target is found: its longest required word, also one or two letters shorter. */
function anchorKeys(w) {
  const out = [w];
  if (w.length >= 5) out.push(w.slice(0, -1));
  if (w.length >= 6) out.push(w.slice(0, -2));
  return out;
}
/** Keys a row word looks under: itself, its starts (4+ letters) and ends (5+ letters, compounds). */
function lookupKeys(o) {
  const out = new Set([o]);
  for (let i = 4; i < o.length; i++) out.add(o.slice(0, i));
  for (let i = 1; i <= o.length - 5; i++) out.add(o.slice(i));
  return out;
}

/**
 * The comparable product of each target in one store's rows ([name, size,
 * cents, ref]): Map item_id -> { product_id, name, size, cents }. With his
 * pack size known, only packs within PACK_TOLERANCE, the cheapest per kg / l
 * / piece; without one (an item he has no product of), the cheapest pack.
 */
export function matchComparables(targets, rows) {
  const index = new Map();
  for (const t of targets) {
    const anchor = [...t.required].sort((a, b) => b.length - a.length)[0];
    for (const k of anchorKeys(anchor)) {
      if (!index.has(k)) index.set(k, []);
      index.get(k).push(t);
    }
  }
  const best = new Map(); // item_id -> { score, cents, row }
  for (const row of rows ?? []) {
    const [name, size, cents] = row;
    const cands = new Set();
    for (const o of keyWords(headOf(name))) for (const k of lookupKeys(o)) for (const t of index.get(k) ?? []) cands.add(t);
    if (!cands.size) continue;
    let rowSize;
    for (const t of cands) {
      if (!rowComparable(t, name)) continue;
      let score = cents;
      if (t.size) {
        rowSize ??= packSize(size, name);
        const k = sharedMeasure(t.size, rowSize);
        if (!k || packRatio(t.size, rowSize) > PACK_TOLERANCE) continue;
        score = cents / rowSize[k];
      }
      const had = best.get(t.item_id);
      if (!had || score < had.score || (score === had.score && cents < had.cents)) best.set(t.item_id, { score, cents, row, t });
    }
  }
  const out = new Map();
  for (const [itemId, b] of best) out.set(itemId, { product_id: b.t.product_id, name: b.row[0], size: b.row[1] || "", cents: b.row[2] });
  return out;
}

/** The id of the row of one item's comparable product in one store. */
export const comparablePriceId = (store, itemId) => `spc-${nameKey(canonicalStore(store)).replace(/ /g, "-")}-${itemId}`;
