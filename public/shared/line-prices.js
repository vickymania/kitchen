// Prices on the list (30-10-2026: "Ik zie de prijzen nog steeds niet
// in mijn lijstje"). Pure, for the phone and the tests: per list line the
// price at each store (his product's exact price, else another of his
// products of the item there, else the comparable product of
// public/shared/comparable-prices.js, marked comparable), the one price the
// line shows, and the totals per store.
//
// The line's price, in this order: the store chosen in "Ik ben bij…" (no
// price there: nothing); else the store of the product he prefers or last
// bought; else the cheapest store known. A line of "3" (pieces, packs, tins)
// counts three packs; anything else counts one.
import { isExcluded } from "./excluded.js";
import { canonicalStore, sameStore } from "./stores.js";
import { DAY, ageDays, PRICE_MAX_AGE_DAYS } from "./store-prices.js";
import { resolveProduct } from "./preferences.js";
import { referenceProduct, productsOfItem } from "./comparable-prices.js";

const indexes = new WeakMap();

/** The live price rows by product (exact) and by item (comparable), once per store_prices object. */
function indexOf(storePrices) {
  const key = storePrices ?? {};
  let idx = indexes.get(key);
  if (!idx) {
    idx = { exact: new Map(), comparable: new Map() };
    for (const r of Object.values(key)) {
      if (!r || r.deleted_at) continue;
      const [map, id] = r.comparable ? [idx.comparable, r.item_id] : [idx.exact, r.product_id];
      if (!id) continue;
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(r);
    }
    if (storePrices) indexes.set(storePrices, idx);
  }
  return idx;
}

const usable = (r, today) => DAY.test(r.price_on ?? "") && ageDays(r.price_on, today) <= PRICE_MAX_AGE_DAYS && !isExcluded(r.name ?? "");
const shown = (r, comparable) => ({ store: canonicalStore(r.store), cents: r.price_cents, name: r.name, size: r.size ?? "", on: r.price_on, comparable });
const sorted = (map) => [...map.values()].sort((a, b) => a.cents - b.cents || a.store.localeCompare(b.store));

/**
 * The prices of one product per store, cheapest first: [{ store, cents, name,
 * size, on, comparable }]. Its exact price where a store sells it; elsewhere
 * the comparable product of its item, when that was compared with this very
 * product (or the item has no product of his). For the product screen and
 * "Laatst gekocht".
 */
export function productPrices(view, product, today) {
  if (!product || product.deleted_at || isExcluded(`${product.brand ?? ""} ${product.name ?? ""}`)) return [];
  const idx = indexOf(view.store_prices);
  const out = new Map();
  for (const r of idx.exact.get(product.id) ?? []) if (usable(r, today)) out.set(canonicalStore(r.store), shown(r, false));
  for (const r of product.item_id ? idx.comparable.get(product.item_id) ?? [] : []) {
    const s = canonicalStore(r.store);
    if (out.has(s) || !usable(r, today) || (r.product_id && r.product_id !== product.id)) continue;
    out.set(s, shown(r, true));
  }
  return sorted(out);
}

/**
 * The prices of a list line per store, cheapest first: [{ store, cents,
 * name, size, on, comparable }]. At a store: the product he buys there
 * (resolveProduct with that store), else the line's product, else another of
 * his products of the item sold there (the cheapest), else the item's
 * comparable product. Nothing for a line without an item or an excluded one.
 */
export function linePrices(view, entry, today) {
  if (!entry?.item_id || entry.deleted_at || isExcluded(entry.title ?? "")) return [];
  const idx = indexOf(view.store_prices);
  const fallback = resolveProduct(view, entry, null)?.product ?? referenceProduct(view, entry.item_id);
  const own = productsOfItem(view, entry.item_id);
  const exactAt = new Map(); // store -> rows of his products there
  for (const p of own) {
    for (const r of idx.exact.get(p.id) ?? []) {
      if (!usable(r, today)) continue;
      const s = canonicalStore(r.store);
      if (!exactAt.has(s)) exactAt.set(s, []);
      exactAt.get(s).push(r);
    }
  }
  const out = new Map();
  for (const [s, rows] of exactAt) {
    const here = resolveProduct(view, entry, s)?.product;
    const pick = rows.find((r) => r.product_id === here?.id) ?? rows.find((r) => r.product_id === fallback?.id)
      ?? [...rows].sort((a, b) => a.price_cents - b.price_cents)[0];
    out.set(s, shown(pick, false));
  }
  for (const r of idx.comparable.get(entry.item_id) ?? []) {
    const s = canonicalStore(r.store);
    if (!out.has(s) && usable(r, today)) out.set(s, shown(r, true));
  }
  return sorted(out);
}

/** Units that count packs: "3", "3 stuks", "2 pakken", "4 blikken". */
const PACK_UNITS = new Set(["piece", "pack", "packet", "can", "jar", "bottle", "bowl"]);

/** How many packs a line asks for: its count of 2 to 24 pieces, packs or tins, else 1. */
export function lineQty(entry) {
  const a = entry?.amounts;
  if (!Array.isArray(a) || a.length !== 1 || !a[0]) return 1;
  const { qty, unit, qty_max: max } = a[0];
  if (max || (unit && !PACK_UNITS.has(unit)) || !Number.isInteger(qty) || qty < 2 || qty > 24) return 1;
  return qty;
}

/** The store a line is usually bought at: the store of the product he prefers or last bought, or null. */
export function homeStore(view, entry, byProduct = null) {
  const resolved = resolveProduct(view, entry, null);
  if (resolved) return resolved.onlyAt ?? resolved.why.store ?? byProduct?.get(resolved.product.id)?.[0]?.store ?? resolved.product.store ?? null;
  const ref = entry?.item_id ? referenceProduct(view, entry.item_id) : null;
  return ref ? byProduct?.get(ref.id)?.[0]?.store ?? ref.store ?? null : null;
}

/**
 * The one price a line shows: { store, cents (one pack), qty, total,
 * comparable, name, size, on, home (no store chosen and it is his usual
 * store's price) } or null. prices: linePrices of the line.
 */
export function pickLinePrice(view, entry, prices, { store = null, byProduct = null } = {}) {
  if (!prices?.length) return null;
  const qty = lineQty(entry);
  const at = (s) => (s ? prices.find((x) => sameStore(x.store, s)) : null);
  if (store) {
    const here = at(store);
    return here ? { ...here, qty, total: here.cents * qty, home: false } : null;
  }
  const home = at(homeStore(view, entry, byProduct));
  const pick = home ?? prices[0];
  return { ...pick, qty, total: pick.cents * qty, home: Boolean(home) };
}

/**
 * The prices of every line, once per render: Map entry id -> linePrices.
 * entries: the lines to count (open and in the basket).
 */
export function listPrices(view, entries, today) {
  const out = new Map();
  for (const e of entries) if (!e.deleted_at) out.set(e.id, linePrices(view, e, today));
  return out;
}

/**
 * "Ik ben bij <store>": the total of the lines that store has a price for
 * (exact or comparable, times the line's packs) and how many have none:
 * { store, cents, priced, missing }.
 */
export function storeTotal(entries, prices, store) {
  let cents = 0;
  let priced = 0;
  for (const e of entries) {
    const x = (prices.get(e.id) ?? []).find((p) => sameStore(p.store, store));
    if (x) {
      cents += x.cents * lineQty(e);
      priced++;
    }
  }
  return { store: canonicalStore(store), cents, priced, missing: entries.length - priced };
}

const linesWithPrice = (entries, prices) => entries.filter((e) => prices.get(e.id)?.length).length;

/** At most this many stores in the comparison row (it must fit one line at 375 px). */
export const COMPARE_STORES = 3;

/**
 * No store chosen: where the list is cheapest. The stores that have a price
 * for the most lines, as long as they share a price for at least half of the
 * lines that have a price anywhere (and two); the totals over exactly those shared lines, so they
 * compare. { stores: [{ store, cents, cheapest }], lines, of } or null when
 * fewer than two stores share enough.
 */
export function compareStores(entries, prices) {
  const n = entries.length;
  if (n < 2) return null;
  const linesAt = new Map(); // store -> Set of entry ids
  for (const e of entries) {
    for (const x of prices.get(e.id) ?? []) {
      if (!linesAt.has(x.store)) linesAt.set(x.store, new Set());
      linesAt.get(x.store).add(e.id);
    }
  }
  const order = [...linesAt].sort(([a, x], [b, y]) => y.size - x.size || a.localeCompare(b));
  const need = Math.max(2, Math.ceil(linesWithPrice(entries, prices) / 2));
  const chosen = [];
  let common = null;
  for (const [store, ids] of order) {
    if (chosen.length === COMPARE_STORES) break;
    const next = common ? new Set([...common].filter((id) => ids.has(id))) : new Set(ids);
    if (next.size < need) continue;
    chosen.push(store);
    common = next;
  }
  if (chosen.length < 2) return null;
  const stores = chosen.map((store) => ({
    store,
    cents: entries.filter((e) => common.has(e.id)).reduce((sum, e) => sum + prices.get(e.id).find((x) => x.store === store).cents * lineQty(e), 0),
    cheapest: false,
  }));
  const low = Math.min(...stores.map((s) => s.cents));
  if (stores.some((s) => s.cents > low)) for (const s of stores) s.cheapest = s.cents === low;
  return { stores, lines: common.size, of: n };
}
