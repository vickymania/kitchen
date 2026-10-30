// "Laatst gekocht" (30-10-2026): every purchase newest first, one
// shopping trip at a time (a receipt, else a store on a day), each line the
// exact product with what was paid; and per item "beste koop": of the
// products the household rated, the one with the most stars per euro (per
// kg, l or piece when every pack says its size; public/shared/deal-math.js
// parseSize). Never an excluded thing (public/shared/excluded.js). The old To Do history
// (source "history": only a title and a day) is no shopping trip and is left
// out. Pure: the tab (public/app/recent.js) and the tests read the same.
import { isExcluded } from "./excluded.js";
import { canonicalStore, sameStore } from "./stores.js";
import { parseSize } from "./deal-math.js";

/** Trips shown per page of the tab. */
export const TRIPS_PAGE = 15;

const live = (rows) => Object.values(rows ?? {}).filter((r) => r && !r.deleted_at);

/** Anything about this purchase or its product names an excluded thing. */
function excludedPurchase(purchase, product, item) {
  return isExcluded(purchase.title ?? "") || isExcluded(item?.name ?? "")
    || (product && (isExcluded(product.name ?? "") || isExcluded(`${product.brand ?? ""} ${product.name ?? ""}`)));
}

/** What one of a line cost: the line's price over its quantity when that is more than one. */
export function unitCents(purchase) {
  const p = purchase.price_cents;
  if (p === null || p === undefined) return null;
  return purchase.qty > 1 ? Math.round(p / purchase.qty) : p;
}

/**
 * The trips, newest first: [{ key, store, day, receipt_id, total_cents,
 * lines: [{ purchase, product, item, unit_cents }] }]. A trip is a receipt,
 * else the purchases of one store on one day. store: only that store's trips
 * (sameStore), or null for all. total_cents adds up the shown lines' prices
 * (never the receipt's own total: that would count what is not shown).
 */
export function recentTrips(view, { store = null } = {}) {
  const trips = new Map();
  for (const p of live(view?.purchases)) {
    if (p.source === "history") continue;
    const product = p.product_id ? view.products?.[p.product_id] ?? null : null;
    const item = p.item_id ? view.items?.[p.item_id] ?? null : null;
    if (excludedPurchase(p, product, item)) continue;
    const shop = canonicalStore(p.store || product?.store || "");
    if (store && !sameStore(shop, store)) continue;
    const key = p.receipt_id ? `r:${p.receipt_id}` : `d:${shop}|${p.bought_on}`;
    let trip = trips.get(key);
    if (!trip) {
      trip = { key, store: shop, day: p.bought_on, receipt_id: p.receipt_id ?? null, total_cents: 0, lines: [] };
      trips.set(key, trip);
    }
    trip.lines.push({ purchase: p, product, item, unit_cents: unitCents(p) });
    if (Number.isFinite(p.price_cents)) trip.total_cents += p.price_cents;
  }
  for (const trip of trips.values()) trip.lines.sort((a, b) => (a.purchase.title ?? "").localeCompare(b.purchase.title ?? "", "nl"));
  return [...trips.values()].sort((a, b) => b.day.localeCompare(a.day) || a.store.localeCompare(b.store) || a.key.localeCompare(b.key));
}

/** The stores of the trips, most trips first. */
export function tripStores(trips) {
  const count = new Map();
  for (const t of trips) if (t.store) count.set(t.store, (count.get(t.store) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
}

/** The household's average stars per product: Map product_id -> { average, count }. */
export function productStars(ratings) {
  const sum = new Map();
  for (const r of live(ratings)) {
    if (!Number.isInteger(r.stars)) continue;
    const cur = sum.get(r.product_id) ?? { total: 0, count: 0 };
    cur.total += r.stars;
    cur.count += 1;
    sum.set(r.product_id, cur);
  }
  return new Map([...sum].map(([id, v]) => [id, { average: v.total / v.count, count: v.count }]));
}

/**
 * The measure every candidate can be priced by: "kg", "l", "piece", or
 * "pack" when one of them does not say its size in the same terms.
 */
function commonMeasure(sizes) {
  if (sizes.every((s) => s?.grams)) return "kg";
  if (sizes.every((s) => s?.ml)) return "l";
  if (sizes.every((s) => s?.count)) return "piece";
  return "pack";
}

function perMeasure(cents, size, measure) {
  if (measure === "kg") return (cents * 1000) / size.grams;
  if (measure === "l") return (cents * 1000) / size.ml;
  if (measure === "piece") return cents / size.count;
  return cents;
}

/**
 * "Beste koop" per item: of its products with stars and a price, the one
 * that gives the most stars per euro. Only for items with two or more such
 * products. Returns Map item_id -> { item, product, stars, cents, measure,
 * candidates } (cents: per kg / l / piece, or per pack; rounded).
 */
export function bestBuys(view) {
  const stars = productStars(view?.ratings);
  const byItem = new Map();
  for (const p of live(view?.products)) {
    if (!p.item_id || !stars.has(p.id) || !(p.last_price_cents > 0)) continue;
    const item = view.items?.[p.item_id];
    if (!item || item.deleted_at || isExcluded(item.name ?? "") || isExcluded(p.name ?? "") || isExcluded(`${p.brand ?? ""} ${p.name ?? ""}`)) continue;
    if (!byItem.has(item.id)) byItem.set(item.id, { item, products: [] });
    byItem.get(item.id).products.push(p);
  }
  const out = new Map();
  for (const { item, products } of byItem.values()) {
    if (products.length < 2) continue;
    const sizes = products.map((p) => parseSize(p.size, p.name));
    const measure = commonMeasure(sizes);
    const scored = products.map((p, i) => {
      const cents = perMeasure(p.last_price_cents, sizes[i], measure);
      const avg = stars.get(p.id).average;
      return { product: p, stars: Math.round(avg * 10) / 10, cents: Math.round(cents), value: avg / (cents / 100) };
    }).sort((a, b) => b.value - a.value || b.stars - a.stars || a.cents - b.cents || a.product.id.localeCompare(b.product.id));
    const best = scored[0];
    out.set(item.id, { item, product: best.product, stars: best.stars, cents: best.cents, measure, candidates: scored.length });
  }
  return out;
}
