// Shelf prices of other stores (30-10-2026: "go"), from Checkjebon
// (github.com/supermarkt/checkjebon, MIT; its data may be reused). The home
// server fetches data/supermarkets.json once a day (fetcher/prices.mjs) and
// sends one `prices.sync` op per store; the op engine keeps only the prices
// of HIS products (matchStorePrices), one row per product and store in
// `store_prices`. The phones show them on a list line, the product screen
// and "Laatst gekocht": "AH €2,19 · Dirk €1,89 · Jumbo €2,05".
//
// The file (seen 30-10-2026, ~10 MB): [{ n: "ah", c: "AH", u, i, d: [{ n: name,
// l: link, p: price in euros, s: size }] }, ...]. No brand field (the brand is
// the start of the name), no unit price, no date per product. Never
// Supermarktscanner (its terms forbid reuse). Lidl in the file comes from a
// third party (boodschaapje.nl) and is not used. Never an excluded thing.
import { nameKey } from "./ingredients.js";
import { isExcluded } from "./excluded.js";
import { canonicalStore, isStoreName, sameStore } from "./stores.js";
import { parseSize } from "./deal-math.js";

export const CHECKJEBON_URL = "https://raw.githubusercontent.com/supermarkt/checkjebon/main/data/supermarkets.json";
/** The date of the file's last commit: the day the prices are of. */
export const CHECKJEBON_COMMITS = "https://api.github.com/repos/supermarkt/checkjebon/commits?path=data/supermarkets.json&per_page=1";

/**
 * Checkjebon's slug -> the store's one name. Only stores within reach of home
 * (fetcher/sources.mjs DEFAULT_SHOPS) plus AH; Coop, Vomar, DekaMarkt and
 * Poiesz have no shop near. ALDI's list was empty on 30-10-2026.
 */
export const PRICE_STORES = {
  ah: "Albert Heijn", dirk: "Dirk", jumbo: "Jumbo", plus: "PLUS", aldi: "ALDI", hoogvliet: "Hoogvliet", spar: "SPAR",
};
export const PRICE_STORE_NAMES = Object.values(PRICE_STORES);

/** At most this many rows in one op (Jumbo had 17,081). */
export const MAX_PRICE_ROWS = 30000;
/** A store with fewer rows is a broken or partial list: not sent, its old prices stay. */
export const MIN_STORE_ROWS = 200;
/** At most this many rows written by one op (D1's statements per request). */
export const MAX_PRICE_WRITES = 800;
/** A price older than this is not shown. */
export const PRICE_MAX_AGE_DAYS = 14;
/** A price older than this shows its date. */
export const PRICE_OLD_DAYS = 2;

export const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** "Crispy's" and "Crispys" are one word; "Dr. Oetker" is "dr oetker". */
export const keyWords = (text) => nameKey(String(text ?? "").replace(/['’`´]/g, "")).split(" ").filter(Boolean);

/**
 * The rows per store of the Checkjebon file: { slug: [[name, size, cents,
 * ref], ...] }, only PRICE_STORES, never an excluded thing. ref: AH's own product number
 * ("wi62760/..." -> "62760"), else "".
 */
export function parseCheckjebon(data) {
  const out = {};
  if (!Array.isArray(data)) return out;
  for (const shop of data) {
    const slug = typeof shop?.n === "string" ? shop.n : "";
    if (!Object.hasOwn(PRICE_STORES, slug) || !Array.isArray(shop.d)) continue;
    const rows = [];
    for (const p of shop.d) {
      const name = typeof p?.n === "string" ? p.n.replace(/\s+/g, " ").trim().slice(0, 160) : "";
      const price = typeof p?.p === "number" ? Math.round(p.p * 100) : NaN;
      if (!name || !Number.isInteger(price) || price <= 0 || price >= 100_000 || isExcluded(name)) continue;
      const size = typeof p.s === "string" ? p.s.replace(/\s+/g, " ").trim().slice(0, 40) : "";
      const ref = slug === "ah" && typeof p.l === "string" ? p.l.match(/^wi(\d+)\//)?.[1] ?? "" : "";
      rows.push([name, size, price, ref]);
    }
    out[slug] = rows;
  }
  return out;
}

/** The rows of a prices.sync op, checked; throws a plain Error on a bad one. */
export function checkPriceRows(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_PRICE_ROWS) throw new Error("rows");
  return rows.map((r) => {
    if (!Array.isArray(r)) throw new Error("row");
    const [name, size, cents, ref] = r;
    if (typeof name !== "string" || !name.trim() || name.length > 160) throw new Error("row.name");
    if (size !== undefined && size !== null && (typeof size !== "string" || size.length > 40)) throw new Error("row.size");
    if (!Number.isInteger(cents) || cents <= 0 || cents >= 100_000) throw new Error("row.cents");
    if (ref !== undefined && ref !== null && ref !== "" && (typeof ref !== "string" || !/^\d{1,12}$/.test(ref))) throw new Error("row.ref");
    return [name.trim(), size ?? "", cents, ref ?? ""];
  });
}

// ------------------------------------------------------------- sizes

/** What one pack holds ({ count, grams, ml }) from Checkjebon's many ways of writing it. */
export function packSize(size, name = "") {
  const clean = (t) => String(t ?? "")
    .replace(/^\s*per\s+stuk\s*$/i, "1 stuk")
    .replace(/\bper\b/gi, " ")
    .replace(/\bgrm\b/gi, "g")
    .replace(/milliliter/gi, "ml")
    .replace(/kilogram/gi, "kg")
    .replace(/\bca\.?\s*/gi, "");
  return parseSize(clean(size), clean(name));
}

const near = (a, b) => (a ?? null) === (b ?? null) || (a > 0 && b > 0 && Math.abs(a - b) <= Math.max(a, b) * 0.01);

/** The same pack: both sizes known and equal (count, weight and volume). */
export function samePack(a, b) {
  if (!a || !b) return false;
  return near(a.count, b.count) && near(a.grams, b.grams) && near(a.ml, b.ml);
}

// ------------------------------------------------------------ matching

// Words that say nothing about which product it is: sizes, packs, filler.
export const FILLER = new Set(["en", "met", "van", "de", "het", "in", "of", "voor", "per", "x", "ca", "stuks", "stuk", "st", "stk",
  "gram", "gr", "g", "kg", "kilo", "ml", "cl", "l", "liter", "ltr", "zak", "zakje", "zakjes", "pak", "pakje", "doos", "tray",
  "fles", "blik", "pot", "beker", "bak", "bakje", "set"]);
// A product's default kind: "Crispy's Hamka's original" is Dirk's "Crispy's Hamka's".
export const DEFAULT_WORDS = new Set(["original", "originals", "origineel", "naturel", "classic", "klassiek", "regular"]);
export const noise = (w) => FILLER.has(w) || /\d/.test(w) || isStoreName(w);

/**
 * One word for another: a plural ("american"/"americans", one the start of
 * the other plus at most two letters) or a stem of five letters or more
 * ("houdbaar"/"houdbare"). Never two short words a letter apart ("dinga"/"dingb").
 */
export function sameWord(a, b) {
  if (a === b) return true;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i >= 4 && i === Math.min(a.length, b.length)) return Math.abs(a.length - b.length) <= 2;
  return i >= 5 && i >= Math.max(a.length, b.length) - 2;
}
export const holds = (o, w) => sameWord(o, w) || (w.length >= 5 && (o.startsWith(w) || o.endsWith(w)));

/** The store a product belongs to, or "" when its brand is sold everywhere. */
function ownStore(p) {
  if (p.store_only && p.store) return canonicalStore(p.store);
  if (isStoreName(p.brand)) return canonicalStore(p.brand);
  const w = keyWords(p.brand).find((x) => isStoreName(x));
  return w ? canonicalStore(w) : "";
}

/** What matching needs of one product, or null when it can never have a price. */
function prepare(p, itemName) {
  if (!p?.id || p.deleted_at || !p.name) return null;
  if (isExcluded(p.name) || isExcluded(`${p.brand ?? ""} ${p.name}`) || isExcluded(itemName ?? "")) return null;
  const ahId = String(p.id).match(/^ah-product-(\d+)$/)?.[1] ?? "";
  const brand = keyWords(p.brand);
  const size = packSize(p.size);
  let name = keyWords(p.name);
  if (brand.length && brand.every((w, i) => name[i] === w)) name = name.slice(brand.length);
  const item = new Set(keyWords(itemName).filter((w) => !noise(w)));
  const own = name.filter((w) => !noise(w));
  let required = own.filter((w) => !DEFAULT_WORDS.has(w) && !item.has(w));
  if (!required.length) required = own;
  // A number in the name is a kind, not a size: Whiskas "7+" is the senior food, "48+" a cheese.
  required = [...required, ...name.filter((w) => /^\d+$/.test(w))];
  return { p, ahId, brand, brandSet: new Set(brand), size, words: own, required, item, store: ownStore(p) };
}

/**
 * Is this row (its key words) the prepared product? The row starts with the
 * brand, has every required word of the name (also as a stem or inside a
 * compound), adds no word of its own besides sizes, packs, filler, the
 * item's words and default words, and holds the same pack. Returns the
 * number of extra words (lower is a closer match), or -1.
 */
function rowFits(pp, rw, rowSize) {
  if (!pp.brand.length || !pp.size || !samePack(pp.size, rowSize)) return -1;
  for (let i = 0; i < pp.brand.length; i++) if (rw[i] !== pp.brand[i]) return -1;
  const rest = rw.slice(pp.brand.length).filter((w) => !pp.brandSet.has(w));
  if (!pp.required.every((w) => rest.some((o) => holds(o, w)))) return -1;
  let extra = 0;
  for (const o of rest) {
    if (pp.words.some((w) => holds(o, w))) continue;
    if (noise(o) || pp.item.has(o) || DEFAULT_WORDS.has(o)) {
      extra++;
      continue;
    }
    return -1;
  }
  return extra;
}

/**
 * The price of each of his products in one store's rows: Map product_id ->
 * { name, size, cents }. A product AH sells (id "ah-product-<n>") is found at
 * AH by its own number, never by name. Otherwise a product needs a brand and
 * a size; a store brand ("AH …", "Dirk …") or a store_only product only in
 * its own store. Two rows that fit equally well with different prices: no
 * price (unsure is nothing). Never an excluded thing.
 * products: rows of `products`; items: { id: item } for the item names.
 */
export function matchStorePrices(products, items, rows, store) {
  const shop = canonicalStore(store);
  const isAh = sameStore(shop, "Albert Heijn");
  const byFirst = new Map();
  const byAhId = new Map();
  for (const p of products) {
    const pp = prepare(p, items?.[p?.item_id]?.name ?? "");
    if (!pp) continue;
    if (pp.store && !sameStore(pp.store, shop)) continue;
    if (isAh && pp.ahId) {
      byAhId.set(pp.ahId, pp);
      continue;
    }
    if (!pp.brand.length || !pp.size) continue;
    if (!byFirst.has(pp.brand[0])) byFirst.set(pp.brand[0], []);
    byFirst.get(pp.brand[0]).push(pp);
  }
  const best = new Map(); // product id -> { extra, row, tie }
  for (const row of rows) {
    const [name, size, cents, ref] = row;
    if (isExcluded(name)) continue;
    if (isAh && ref && byAhId.has(ref)) {
      best.set(byAhId.get(ref).p.id, { extra: -1, row, tie: false });
      continue;
    }
    const rw = keyWords(name);
    const candidates = byFirst.get(rw[0]);
    if (!candidates) continue;
    const rowSize = packSize(size, name);
    for (const pp of candidates) {
      const extra = rowFits(pp, rw, rowSize);
      if (extra < 0) continue;
      const had = best.get(pp.p.id);
      if (!had || extra < had.extra) best.set(pp.p.id, { extra, row, tie: false });
      else if (extra === had.extra && had.row[2] !== cents) had.tie = true;
    }
  }
  const out = new Map();
  for (const [id, b] of best) {
    if (b.tie) continue;
    out.set(id, { name: b.row[0], size: b.row[1] || "", cents: b.row[2] });
  }
  return out;
}

/** The id of the row of one product's price in one store. */
export const storePriceId = (store, productId) => `sp-${nameKey(canonicalStore(store)).replace(/ /g, "-")}-${productId}`;

// ------------------------------------------------------------- showing

export const ageDays = (day, today) => Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86_400_000);

/**
 * The shelf prices of one product, cheapest first: [{ store, cents, name,
 * size, on, cheapest }]. With `store` ("Ik ben bij…") only that store's.
 * Never older than PRICE_MAX_AGE_DAYS, never an excluded thing. `cheapest` marks the
 * lowest price when another store asks more. Only exact rows: a comparable
 * product (public/shared/comparable-prices.js) is another product.
 */
export function pricesOf(storePrices, product, today, { store = null } = {}) {
  if (!product || product.deleted_at || isExcluded(`${product.brand ?? ""} ${product.name ?? ""}`)) return [];
  const list = Object.values(storePrices ?? {})
    .filter((r) => r && !r.deleted_at && !r.comparable && r.product_id === product.id && DAY.test(r.price_on ?? "")
      && ageDays(r.price_on, today) <= PRICE_MAX_AGE_DAYS && (!store || sameStore(r.store, store)))
    .map((r) => ({ store: canonicalStore(r.store), cents: r.price_cents, name: r.name, size: r.size, on: r.price_on, cheapest: false }))
    .sort((a, b) => a.cents - b.cents || a.store.localeCompare(b.store));
  // Every store the same price: nothing is cheaper, so nothing is marked.
  if (list.length > 1 && list[0].cents < list[list.length - 1].cents) for (const x of list) x.cheapest = x.cents === list[0].cents;
  return list;
}

/** The day of the oldest shown price when it is older than PRICE_OLD_DAYS, else null. */
export function oldPricesDay(list, today) {
  const days = list.map((x) => x.on).sort();
  return days.length && ageDays(days[0], today) > PRICE_OLD_DAYS ? days[0] : null;
}

/** "AH" for Albert Heijn, the rest as they are. */
export const shortStore = (s) => (sameStore(s, "Albert Heijn") ? "AH" : s);

/** A list line's note that is only an offer Deals wrote ("Dirk · -37% t/m 3 nov"): not the person's own. */
export function isDealNote(note) {
  if (typeof note !== "string") return false;
  const m = note.trim().match(/^(.+?)(?: · .*)? t\/m \d{1,2} (?:jan|feb|mrt|apr|mei|jun|jul|aug|sep|okt|nov|dec)\.?$/);
  return Boolean(m && isStoreName(m[1]));
}
