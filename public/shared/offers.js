// Deals (phase 3, 28-10-2026): this week's AH bonus and the folders of
// other stores, fetched once a day on the home server (fetcher/) and
// synced to the phones like any other row. This file decides what an offer
// is, how it is keyed, when it counts and which list line it is about, for
// the fetcher, the worker and the phone alike.
//
// An offer: { store, name, brand, size, deal, price_cents, valid_from,
// valid_until, category, source }. Days are "YYYY-MM-DD" in Dutch time; valid_until
// is the last day it holds. Never an excluded thing (public/shared/excluded.js).
import { nameKey } from "./ingredients.js";
import { isExcluded } from "./excluded.js";
import { canonicalName, isGeneric } from "./item-names.js";
import { canonicalStore, isStoreName, sameStore } from "./stores.js";

export const OFFER_FIELDS = ["store", "name", "brand", "size", "deal", "price_cents", "valid_from", "valid_until", "category", "source"];

/**
 * Where an offer comes from besides the folders (null: the AH bonus and the
 * allefolders folders, fetcher/fetch.mjs). "lidl_plus": one of Thomas's own
 * Lidl Plus coupons (fetcher/lidl_import.mjs), which he must activate in the
 * Lidl Plus app. /api/offers/sync replaces one source's set at a time.
 */
export const LIDL_PLUS = "lidl_plus";
export const OFFER_SOURCES = [LIDL_PLUS];

/** A coupon he must activate in the Lidl Plus app before it counts at the till. */
export const isCoupon = (o) => o?.source === LIDL_PLUS;

const TEXT_LIMITS = { store: 40, name: 160, brand: 80, size: 40, deal: 120, category: 80 };
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Name, brand and category are each checked: the word list may name a brand or a category. */
export function isExcludedOffer(offer) {
  const parts = [offer?.name, offer?.brand, offer?.category, `${offer?.brand ?? ""} ${offer?.name ?? ""}`];
  return parts.some((s) => s && isExcluded(s));
}

/** A clean offer, or null when it is unusable or about an excluded thing. */
export function cleanOffer(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const f of Object.keys(TEXT_LIMITS)) {
    const v = typeof raw[f] === "string" ? raw[f].replace(/\s+/g, " ").trim().slice(0, TEXT_LIMITS[f]) : "";
    out[f] = v || null;
  }
  if (!out.store || !out.name) return null;
  const price = raw.price_cents;
  out.price_cents = Number.isInteger(price) && price >= 0 && price < 1_000_000 ? price : null;
  for (const f of ["valid_from", "valid_until"]) out[f] = typeof raw[f] === "string" && DAY.test(raw[f]) ? raw[f] : null;
  // Without an end it would never expire.
  if (!out.valid_until) return null;
  if (out.valid_from && out.valid_from > out.valid_until) return null;
  out.source = OFFER_SOURCES.includes(raw.source) ? raw.source : null;
  if (isExcludedOffer(out)) return null;
  return out;
}

/**
 * One row per store and product: next week's deal on the same product
 * updates that row instead of adding one and tombstoning another.
 */
export const offerKey = (o) => [o.store, o.name, o.brand ?? "", o.size ?? ""].map((s) => nameKey(s)).join("|");

/** Shown and weighed only from its first to its last day. */
export const isCurrent = (o, today) => !o.deleted_at && (!o.valid_from || o.valid_from <= today) && o.valid_until >= today;

/** The synced offers that count today, never an excluded thing. */
export function currentOffers(offers, today) {
  return Object.values(offers ?? {}).filter((o) => o && isCurrent(o, today) && !isExcludedOffer(o));
}

/** What the wizard weighs: [{ name, category, until }]. */
export function wizardBonus(offers, today) {
  return currentOffers(offers, today).map((o) => ({ name: o.name, category: o.category, until: o.valid_until }));
}

const words = (key) => key.split(" ").filter(Boolean);
const offerWords = new WeakMap();

function wordsOf(offer) {
  let w = offerWords.get(offer);
  if (!w) offerWords.set(offer, (w = words(nameKey(`${offer.brand ?? ""} ${offer.name}`))));
  return w;
}

/**
 * Does the offer name this list line (a nameKey)? Each word of the line of
 * three letters or more must be a word of the offer, or the start of one
 * ("kip" → "kipfilet"), or for four letters or more its end ("kaas" →
 * "geitenkaas"). A one-word line shorter than that must be a whole word.
 */
export function offerMatches(lineKey, offer) {
  const lw = words(lineKey ?? "");
  const ow = wordsOf(offer);
  if (lw.length === 1 && lw[0].length < 3) return ow.includes(lw[0]);
  const long = lw.filter((w) => w.length >= 3);
  if (!long.length) return false;
  return long.every((w) => ow.some((o) => o === w || o.startsWith(w) || (w.length >= 4 && o.endsWith(w))));
}

/**
 * A test "does any of these names have this offer" for thousands of offers
 * at once, by the same rule as offerMatches(). The worker keeps only offers
 * that something the household buys or cooks could match: the folders are
 * mostly clothes, toys and tools, and every stored row costs every phone.
 * names: item names and recipe ingredient names.
 */
export function relevanceTest(names) {
  const byFirst = new Map();
  const short = new Set();
  for (const name of names) {
    if (!name || isGeneric(name)) continue;
    for (const key of new Set([nameKey(name), canonicalName(name).key])) {
      const lw = words(key);
      if (lw.length === 1 && lw[0].length < 3) {
        short.add(lw[0]);
        continue;
      }
      const long = lw.filter((w) => w.length >= 3);
      if (!long.length) continue;
      if (!byFirst.has(long[0])) byFirst.set(long[0], []);
      byFirst.get(long[0]).push(long);
    }
  }
  return (offer) => {
    const ow = wordsOf(offer);
    if (ow.some((o) => short.has(o))) return true;
    // Every piece a line word may be: the word, its starts (3+), its ends (4+).
    const parts = new Set();
    for (const o of ow) {
      for (let i = 3; i <= o.length; i++) parts.add(o.slice(0, i));
      for (let i = 0; i <= o.length - 4; i++) parts.add(o.slice(i));
      parts.add(o);
    }
    for (const p of parts) {
      for (const long of byFirst.get(p) ?? []) if (long.every((w) => parts.has(w))) return true;
    }
    return false;
  };
}

/**
 * The current offers for one list line, best first: an offer named exactly
 * like the line, then the one that ends soonest. `current` comes from
 * currentOffers(), once per render.
 */
export function offersFor(title, current) {
  if (!title || isGeneric(title)) return [];
  const keys = [...new Set([nameKey(title), canonicalName(title).key])].filter(Boolean);
  const exact = (o) => (keys.includes(nameKey(o.name)) ? 0 : 1);
  return current
    .filter((o) => keys.some((k) => offerMatches(k, o)))
    .sort((a, b) => exact(a) - exact(b) || a.valid_until.localeCompare(b.valid_until) || a.store.localeCompare(b.store));
}

/**
 * A product's name with its brand once: the AH import keeps the brand in the
 * name ("Crispy's Hamka's original" of brand "Crispy's"), so "Crispy's Crispy's …" is never shown.
 */
export function brandedName(p) {
  if (!p?.name) return p?.brand ?? "";
  if (!p.brand || nameKey(p.name).startsWith(`${nameKey(p.brand)} `) || nameKey(p.name) === nameKey(p.brand)) return p.name;
  return `${p.brand} ${p.name}`;
}

/** The words an offer must have to be about this product: brand and name. */
export const productOfferName = (p) => [p?.brand, p?.name].filter(Boolean).join(" ");

/**
 * Is the offer about this very product (28-10-2026: his product in
 * the folder, not just anything called "chips")? Every word of brand and name
 * must be in the offer (offerMatches), and a product of one store (a store
 * brand like "AH" or "Dirk", or one without a brand bought there) only counts
 * in that store's folder. Doritos last bought at Dirk is still Doritos at AH.
 */
export function productOfferMatches(product, offer) {
  if (!product?.name || !offer) return false;
  // A real brand is sold everywhere: its `store` is only where it was last
  // bought. A store brand, or a product without a brand, is that store's own.
  // A store_only product ("alleen bij deze winkel") is that store's too.
  const storeBrand = isStoreName(product.brand);
  const shop = product.store_only && product.store ? product.store
    : storeBrand ? canonicalStore(product.brand) : product.brand ? "" : product.store;
  if (shop && !sameStore(shop, offer.store)) return false;
  // Dirk's folder calls its own chips "Tortilla chips": the store check above
  // stands in for a store brand's name.
  return offerMatches(nameKey(storeBrand ? product.name : productOfferName(product)), offer);
}

/**
 * The offers for one list line: `mine` match the resolved preferred product
 * ("jouw product in de aanbieding"), `named` only the line's name (shown more
 * quietly). With a store chosen, only that store's folder counts; for a
 * store_only product only its own store's folder, whatever store is chosen.
 */
export function lineOffers(title, product, current, store = null) {
  const shop = product?.store_only && product.store ? product.store : store;
  const here = shop ? current.filter((o) => sameStore(o.store, shop)) : current;
  const mine = product
    ? here.filter((o) => productOfferMatches(product, o)).sort((a, b) => a.valid_until.localeCompare(b.valid_until) || a.store.localeCompare(b.store))
    : [];
  const taken = new Set(mine);
  return { mine, named: offersFor(title, here).filter((o) => !taken.has(o)) };
}
