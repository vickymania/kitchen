// The Deals tab (28-10-2026): every current offer that meets one of
// his deal rules. Pure, for the phone and the MCP server.
//
//   - A rule is per item, optionally per product (table deal_rules). An item
//     rule takes the offers the list line would show (its preferred product
//     first, then by name); a product rule the offers on that product, or on
//     its brand with the item's name ("Edet" + "vochtig toiletpapier").
//   - Only Albert Heijn and Dirk, his regular stores, unless the rule says
//     "omweg waard": then every store counts.
//   - "Aanbevolen" when he is probably low on it: the pantry had it and has
//     none or little left, or what is left must go soon; or "need it again"
//     says it is due before the offer ends.
//   - A rule's match_words make more offers candidates ("Minoes eten" is
//     "Felix pouches" in the folder); its require_words must all be in an
//     offer for a full hit ("amandelmelk": only the pink Edet). An offer that
//     names no variant of the brand at all is a "check" hit: shown last,
//     marked "check of het <words> is", never "aanbevolen". An offer that
//     names another variant (BRAND_VARIANTS) is not shown. An offer naming
//     one of its exclude_words is never a hit (tuna for the cat, never
//     "tonijnsalade").
//   - "Omweg waard vanaf 50%" (detour_min_discount_pct): another store than
//     AH and Dirk counts only from that discount.
//   - The deeper the discount, the better: within recommended, plain and
//     check hits, the deepest discount comes first.
//   - cheaperElsewhere(): a list line's product cheaper at the other regular
//     store, for a quiet hint on the list.
//   - Without a rule (29-10-2026): what he buys often (on
//     OFTEN_MIN_PURCHASES days within OFTEN_DAYS) is an implicit "only on
//     offer" rule at AH and Dirk (oftenBought, oftenMatch). Such a hit has
//     `often`; an explicit rule on the item always wins.
//   - Never an excluded thing (public/shared/excluded.js).
import { isExcluded } from "./excluded.js";
import { isHidden } from "./again-scope.js";
import { nameKey } from "./ingredients.js";
import { canonicalName, isGeneric } from "./item-names.js";
import { currentOffers, lineOffers, offerMatches, productOfferMatches, productOfferName, isExcludedOffer, isCoupon } from "./offers.js";
import { resolveProduct, lastPrice, purchasesByProduct } from "./preferences.js";
import { isStoreName, sameStore } from "./stores.js";
import { effectivePrice, meetsRule, ruleChecks, parseSize } from "./deal-math.js";
import { liveRows, sameStuff, rowKey, daysLeft, DUE_DAYS, withUsage, supplyDays, RATE_WARN_DAYS } from "./pantry.js";
import { dueItems, daysBetween } from "./intervals.js";

/** The stores Thomas shops at anyway; other stores only for "omweg waard". */
export const REGULAR_STORES = ["Albert Heijn", "Dirk"];
/** Less than this many packs left is "little". */
export const LOW_AMOUNT = 1;

export const isRegularStore = (store) => REGULAR_STORES.some((s) => sameStore(s, store));

/** The live rules, never one on an excluded thing or on a gone item. */
export function liveRules(view) {
  return Object.values(view.deal_rules ?? {}).filter((r) => {
    if (!r || r.deleted_at) return false;
    const item = view.items?.[r.item_id];
    return item && !item.deleted_at && !isExcluded(item.name);
  });
}

/** Every live rule of an item: the product ones first. */
export function rulesOf(view, itemId) {
  return liveRules(view).filter((r) => r.item_id === itemId).sort((a, b) => Number(Boolean(b.product_id)) - Number(Boolean(a.product_id)));
}

/** The rule of an item and product ('' / null = any product), or null. */
export function ruleFor(view, itemId, productId = "") {
  return liveRules(view).find((r) => r.item_id === itemId && (r.product_id || "") === (productId || "")) ?? null;
}

/**
 * Is the offer about this product? Its own words (productOfferMatches), or
 * the brand with the item's name: Thomas's Edet wipes are "Edet Amandelmelk
 * vochtig toiletpapier", the folder says "Edet vochtig toiletpapier". A store
 * brand counts only in that store's folder.
 */
export function ruleProductMatches(product, item, offer) {
  if (product?.store_only && !sameStore(product.store, offer.store)) return false;
  // A branded product is never a folder line without that brand: Dirk's own
  // "Vochtig toiletpapier" is not his Edet, however alike the names are.
  if (product?.brand && !isStoreName(product.brand) && !namesWord(offer, nameKey(product.brand))) return false;
  if (productOfferMatches(product, offer)) return true;
  if (!product?.brand || !item?.name) return false;
  if (isStoreName(product.brand)) return sameStore(product.brand, offer.store) && offerMatches(nameKey(item.name), offer);
  return offerMatches(nameKey(`${product.brand} ${item.name}`), offer);
}

/**
 * Known variant words per brand (nameKey). A folder line with one of these
 * that the rule does not require is another variant: "Edet Sensitive" is not
 * his Edet Amandelmelk. Without a list for the brand, a missing word only
 * makes a "check" hit.
 */
export const BRAND_VARIANTS = {
  edet: ["aloe", "aloe vera", "amandelmelk", "baby", "classic", "comfort", "fresh", "kamille", "kids", "kinder", "pure", "sensitive", "zeewier"],
};

const wordsCache = new WeakMap();
function keyWords(offer) {
  let w = wordsCache.get(offer);
  if (!w) wordsCache.set(offer, (w = nameKey(`${offer.brand ?? ""} ${offer.name}`).split(" ").filter(Boolean)));
  return w;
}

/**
 * Does the offer name this word or phrase (a nameKey)? Each word whole; a
 * word of five letters or more also at the start or end of a compound
 * ("kattennatvoer", "felixpouches"), as relevanceTest keeps them. So "tp"
 * or "kat" never match by accident.
 */
export function namesWord(offer, phrase) {
  const ow = keyWords(offer);
  const pw = String(phrase ?? "").split(" ").filter(Boolean);
  if (!pw.length) return false;
  return pw.every((w) => ow.some((o) => o === w || (w.length >= 5 && (o.startsWith(w) || o.endsWith(w)))));
}

/** Does one of the rule's match_words name the offer? */
export const matchWordHit = (rule, offer) => (rule.match_words ?? []).some((w) => namesWord(offer, w));

/** Does one of the rule's exclude_words name the offer ("tonijnsalade", "tonijn pizza")? */
export const excluded = (rule, offer) => (rule.exclude_words ?? []).some((w) => namesWord(offer, w));

/**
 * The rule's require_words against an offer: { missing: null } a full hit (or
 * nothing required), { missing: [words] } a "check" hit (no variant named),
 * { other: true } another variant of the brand, not shown.
 */
export function requireCheck(rule, offer, product = null) {
  const need = rule.require_words ?? [];
  if (!need.length) return { missing: null };
  const missing = need.filter((w) => !namesWord(offer, w));
  if (!missing.length) return { missing: null };
  const brands = Object.keys(BRAND_VARIANTS).filter((b) => namesWord(offer, b) || (product?.brand && nameKey(product.brand) === b));
  const other = brands.some((b) => BRAND_VARIANTS[b].some((v) => !need.includes(v) && namesWord(offer, v)));
  return other ? { other: true } : { missing };
}

/** Two sizes that clearly differ make the last price no "normal price" for this offer. */
function sameSize(a, b) {
  const x = parseSize(a);
  const y = parseSize(b);
  if (!x || !y) return true;
  return (x.grams ?? null) === (y.grams ?? null) && (x.ml ?? null) === (y.ml ?? null) && (x.count ?? null) === (y.count ?? null);
}

/** The product's normal price at the offer's store (else anywhere), when the offer is about it. */
function normalPrice(product, offer, byProduct) {
  if (!product || !sameSize(product.size, offer.size)) return null;
  const p = lastPrice(product, offer.store, byProduct) ?? product.last_price_cents ?? null;
  return p > 0 ? p : null;
}

/**
 * Why he is probably low on the item, or null:
 * { code: "pantry_empty" } the pantry had it, nothing left
 * { code: "pantry_low", amount } less than LOW_AMOUNT packs left
 * { code: "pantry_use_by", use_by } what is left must go within DUE_DAYS
 * { code: "pantry_runs_out", days } counted down at a steady rate, it runs
 *   out before the offer ends plus RATE_WARN_DAYS (amounts: withUsage)
 * { code: "again_due", since, interval } "need it again" says it is due
 * { code: "again_soon", on } due before the offer ends
 */
export function lowReason(stored, item, until, today, due) {
  const view = withUsage(stored, today);
  const key = item.name_key ?? nameKey(item.name);
  const ckey = canonicalName(item.name).key;
  // "Vochtig tp" and "Vochtig toiletpapier" are two items of one product
  // (item-names.js SAME): a row or event of either counts.
  const sameItem = (id) => id === item.id || (view.items?.[id] && canonicalName(view.items[id].name).key === ckey);
  const mine = (k) => sameStuff(key, k) || sameStuff(ckey, k) || canonicalName(k).key === ckey;
  const rows = liveRows(view.pantry).filter((r) => sameItem(r.item_id) || mine(rowKey(r, view.items)));
  const had = rows.length > 0 || Object.values(view.pantry_events ?? {}).some((e) => !e.deleted_at && sameItem(e.item_id));
  const total = rows.reduce((n, r) => n + r.amount, 0);
  const keeping = rows.filter((r) => !r.use_by || daysLeft(r, today) > DUE_DAYS);
  if (had && !rows.length) return { code: "pantry_empty" };
  const again = due.find((d) => d.item.id === item.id || canonicalName(d.item.name).key === ckey);
  if (rows.length && !keeping.length) return { code: "pantry_use_by", use_by: rows.map((r) => r.use_by).sort()[0] };
  // Counted down (the cat's pouches): by the days left. A rate a person or
  // Claude set replaces the pack count; the household-goods default only adds.
  const days = supplyDays(rows);
  if (days !== null) {
    if (days < Math.max(0, daysBetween(today, until)) + RATE_WARN_DAYS) return { code: "pantry_runs_out", days: Math.floor(days) };
    if (rows.some((r) => r.per_day > 0 && r.rate_source !== "rule")) return null;
  }
  if (rows.length && total < LOW_AMOUNT) return { code: "pantry_low", amount: total };
  // In the house and keeping: not low, whatever the timer says.
  if (keeping.length) return null;
  if (again?.due) return { code: "again_due", since: again.since, interval: again.interval };
  if (again && !again.in_pantry && again.since + daysBetween(today, until) >= again.interval) {
    return { code: "again_soon", days: again.interval - again.since };
  }
  return null;
}

/** An item bought on this many days within OFTEN_DAYS is "bought often": an implicit deal rule. */
export const OFTEN_MIN_PURCHASES = 3;
export const OFTEN_DAYS = 365;

/**
 * The items bought often, as implicit "only on offer" rules: [{ item,
 * products, count }], most bought first. count: the days within OFTEN_DAYS
 * with a purchase of the item (purchases.item_id, else the item of
 * purchases.product_id); items of one product (canonicalName) count together
 * and the most bought one stands for them. Never an excluded thing, a generic line, an
 * item hidden from "Weer nodig" (items.again 'hide'; a recipe ingredient
 * bought often still counts), one switched off for "Bijna op" (low_off), or
 * one with an explicit rule (that rule wins). products: his products of the
 * item bought within OFTEN_DAYS, the preferred one first.
 */
export function oftenBought(view, today) {
  const items = view.items ?? {};
  const groups = new Map();
  for (const p of Object.values(view.purchases ?? {})) {
    if (!p || p.deleted_at || !p.bought_on) continue;
    const age = daysBetween(p.bought_on, today);
    if (age < 0 || age >= OFTEN_DAYS) continue;
    const product = p.product_id ? view.products?.[p.product_id] : null;
    const itemId = p.item_id || product?.item_id;
    const item = itemId ? items[itemId] : null;
    if (!item || item.deleted_at || isExcluded(item.name) || isExcluded(p.title ?? "") || isGeneric(item.name)) continue;
    const key = canonicalName(item.name).key;
    if (!groups.has(key)) groups.set(key, { days: new Set(), items: new Map(), products: new Set() });
    const g = groups.get(key);
    g.days.add(p.bought_on);
    g.items.set(item.id, (g.items.get(item.id) ?? 0) + 1);
    if (product && !product.deleted_at) g.products.add(product);
  }
  const ruled = new Set(liveRules(view).map((r) => canonicalName(items[r.item_id].name).key));
  const out = [];
  for (const [key, g] of groups) {
    if (g.days.size < OFTEN_MIN_PURCHASES || ruled.has(key)) continue;
    const item = [...g.items].sort((a, b) => b[1] - a[1]).map(([id]) => items[id])[0];
    // Every item under this product counts: one switched off or hidden hides them all.
    const siblings = Object.values(items).filter((i) => i && !i.deleted_at && canonicalName(i.name).key === key);
    if (siblings.some((i) => i.low_off)) continue;
    const again = item.again ?? siblings.map((i) => i.again).find(Boolean) ?? null;
    if (isHidden({ again, key, name: item.name, ingredientKeys: [] })) continue;
    const preferred = resolveProduct(view, { item_id: item.id, sources: [] }, null)?.product ?? null;
    const products = [...g.products].filter((p) => p !== preferred);
    if (preferred && !preferred.deleted_at) products.unshift(preferred);
    out.push({ item, products: products.filter((p) => !isExcluded(productOfferName(p))), count: g.days.size });
  }
  return out.sort((a, b) => b.count - a.count || a.item.name.localeCompare(b.item.name));
}

// Size words that say nothing about what an offer is (FILLER below has the rest).
const UNIT_WORDS = new Set(["g", "gr", "gram", "kg", "kilo", "ml", "cl", "l", "liter", "ltr", "st", "stuks", "stuk", "pak", "pakken"]);
const noise = (w) => w.length < 3 || /\d/.test(w) || FILLER.has(w) || UNIT_WORDS.has(w) || isStoreName(w);
const wordsOfKey = (text) => nameKey(text).split(" ").filter(Boolean);

/** One word for another: the same, a plural ("plak"/"plakken"), or one stem ("houdbaar"/"houdbare"). */
function sameWord(a, b) {
  if (a === b) return true;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i >= 4 && i >= Math.min(a.length, b.length) - 2;
}

/** Every brand word of the household's products ("alpro", "melko", "john", "west"), never a store's. */
export function knownBrandWords(view) {
  const out = new Set();
  for (const p of Object.values(view.products ?? {})) {
    if (!p?.brand || p.deleted_at) continue;
    for (const w of wordsOfKey(p.brand)) if (!noise(w)) out.add(w);
  }
  return out;
}

/**
 * Is the offer really this product, for a full "often" hit? Stricter than
 * productOfferMatches (the list line's "your product"), which let "AH
 * Speculaas" match "BitesWeLove crunchy protein cookiebars speculaas" and a
 * brandless "Salami" match "BiFi ... salami" (live data, 29-10-2026):
 *   - a product without a brand is never a full hit;
 *   - a store brand ("AH", "AH Biologisch") only in that store's folder and
 *     only when the offer names the store as its own brand ("AH ...");
 *   - another brand only when the offer names it;
 *   - every word of the product's name besides the brand is in the offer,
 *     whole or at the start or end of a compound ("AH Scharrel kipfilet" is
 *     "AH Scharrelkipfilet"), and the offer has no word of its own besides
 *     sizes, filler and store names.
 */
export function ownProductOffer(product, offer) {
  if (!product?.brand || !product.name || !productOfferMatches(product, offer)) return false;
  const brandWords = wordsOfKey(product.brand);
  const store = isStoreName(product.brand) ? product.brand : brandWords.find((w) => isStoreName(w));
  if (store) {
    if (!sameStore(store, offer.store)) return false;
    if (!keyWords(offer).some((w) => isStoreName(w) && sameStore(w, offer.store))) return false;
  } else if (!namesWord(offer, nameKey(product.brand))) return false;
  const own = new Set(brandWords);
  const words = wordsOfKey(product.name).filter((w) => !own.has(w) && !noise(w));
  const ow = keyWords(offer);
  if (!words.length || !words.every((w) => namesWord(offer, w) || ow.some((o) => sameWord(o, w)))) return false;
  // And the offer adds no kind of its own: "AH Gevuld speculaas met
  // amandelspijs" is not his plain "AH Speculaas" (that is a check at most).
  const holds = (o, w) => sameWord(o, w) || (w.length >= 5 && (o.startsWith(w) || o.endsWith(w)));
  return ow.every((o) => noise(o) || o === "alle" || own.has(o) || words.some((w) => holds(o, w)));
}

/** The words of an item and its products that an offer about them must contain (no store names, filler or numbers). */
function oftenTokens(item, products) {
  const out = new Set();
  for (const text of [item.name, ...products.map((p) => productOfferName(p))]) {
    for (const w of wordsOfKey(text)) if (w.length >= 2 && !/^\d+$/.test(w) && !FILLER.has(w) && !isStoreName(w)) out.add(w);
  }
  return [...out];
}

/** The offer's words written with a capital (nameKey), after its first: "Alle Alpro en Melko" → alpro, melko. */
const capitals = (offer) => new Set(String(offer.name ?? "").split(/\s+/).slice(1).filter((w) => /^\p{Lu}/u.test(w)).flatMap((w) => wordsOfKey(w)));

/** A product with its brand once: "AH Beenham", "Melko Romige kwark perzik". */
const productText = (p) => (p.brand && !nameKey(p.name).startsWith(nameKey(p.brand)) ? `${p.brand} ${p.name}` : p.name);

const RANGE = /(\d+(?:[.,]\d+)?)\s*(?:-|t\/m|tot)\s*(\d+(?:[.,]\d+)?)\s*(kilo|kg|gram|gr|g|ml|cl|liter|ltr|l)\b/i;
const UNIT_FACTOR = { kilo: 1000, kg: 1000, gram: 1, gr: 1, g: 1, ml: 1, cl: 10, liter: 1000, ltr: 1000, l: 1000 };

/**
 * Does the product's pack fall in the offer's size range? true, false, or
 * null (unknown: no range, or no pack size). "Alle Chio chips 70-150 gram":
 * his 150 g bag yes, the 170 g partypack no.
 */
export function sizeFits(product, offer) {
  const own = parseSize(product?.size);
  const mine = own && !own.count ? own.grams ?? own.ml ?? null : null;
  if (mine === null) return null;
  const m = `${offer.name ?? ""} ${offer.size ?? ""}`.match(RANGE);
  if (!m) return null;
  const f = UNIT_FACTOR[m[3].toLowerCase()];
  return mine >= Number(m[1].replace(",", ".")) * f && mine <= Number(m[2].replace(",", ".")) * f;
}

/**
 * Is a current offer about something he buys often? (29-10-2026: the
 * folders say "Alle Alpro en Melko" and "Houdbaar melk", not his product.)
 * { product, sure: true, label } his very product (productOfferMatches), or
 * { product, sure: false, label } a "check" hit (label: what to check it is):
 *   - a brand group of his: the offer names the brand of one of his products
 *     (never a store brand) and either a word of that kind of thing (the
 *     product's name or the item's: "Alle Chio chips" for his Chio Red
 *     paprika under "Chips"), or nothing but brands ("Alle Alpro en Melko").
 *     A size range must hold his pack. "Alle <brand> <kind>" with his pack
 *     in the range is his product (sure).
 *   - a generic store name: every word of the item is a whole word of the
 *     offer ("Houdbaar melk" for "Melk"; never "Geelvintonijn" for "Tonijn",
 *     "Kaasfondue" for "Kaas"), and every other word of the offer is a word
 *     of the item or of his products ("houdbaar" from "AH Houdbare volle
 *     melk", "plakken" from "Goudse belegen plakken"), so "Kaas croissants"
 *     is not his cheese.
 * Else null. brands: knownBrandWords(), the other brands of a group.
 */
export function oftenMatch(item, products, offer, brands = new Set()) {
  for (const p of products) if (ownProductOffer(p, offer)) return { product: p, sure: true, label: productText(p) };
  const ow = keyWords(offer);
  // "AH ..." in Dirk's folder is a mistake or a comparison, never his product there.
  if (ow.some((w) => isStoreName(w) && !sameStore(w, offer.store))) return null;
  const itemWords = wordsOfKey(item.name).filter((w) => !FILLER.has(w));
  const isGroup = ow[0] === "alle";
  for (const p of products) {
    if (!p.brand || isStoreName(p.brand) || wordsOfKey(p.brand).some((w) => isStoreName(w))) continue;
    if (!namesWord(offer, nameKey(p.brand))) continue;
    const fits = sizeFits(p, offer);
    if (fits === false) continue;
    const brandWords = new Set(wordsOfKey(p.brand));
    const kindWords = [...wordsOfKey(p.name), ...itemWords].filter((w) => !brandWords.has(w) && !noise(w));
    const rest = ow.filter((w) => !noise(w) && w !== "alle" && !brandWords.has(w) && !brands.has(w));
    const kind = rest.some((w) => w.length >= 4 && kindWords.some((k) => sameWord(w, k) || (k.length >= 4 && (k.startsWith(w) || w.startsWith(k)))));
    if (kind) return { product: p, sure: isGroup && fits === true, label: productText(p) };
    // "Alle Alpro en Melko": the folder writes brands with a capital, kinds without.
    if (isGroup && rest.every((w) => brands.has(w) || capitals(offer).has(w))) return { product: p, sure: false, label: productText(p) };
  }
  if (!itemWords.length || !itemWords.every((w) => ow.some((o) => o === w || o === `${w}s` || o === `${w}en` || o === `${w}n`))) return null;
  const vocabulary = [...itemWords, ...products.flatMap((p) => wordsOfKey(productOfferName(p)))];
  if (!ow.every((w) => noise(w) || w === "alle" || vocabulary.some((v) => sameWord(w, v)))) return null;
  return { product: products[0] ?? null, sure: false, label: products[0] ? productText(products[0]) : item.name };
}

const saving = (eff) => (eff?.was_cents && eff.piece_cents !== null ? eff.was_cents - eff.piece_cents : null);

/**
 * Every current offer that meets a rule, best first: full hits before
 * "check" hits, recommended first, then the deepest discount, the biggest
 * saving per piece, the cheapest.
 * Returns [{ rule, item, product, offer, eff, checks, saving_cents, low, check }]
 * (product: the rule's product, else the item's preferred one; low: a
 * lowReason or null; check: the require_words the offer does not name, or
 * null for a full hit; detour: the store is not AH or Dirk). One row per offer: a product rule wins over the
 * item's rule for the same offer. "Check" hits come after every full hit
 * and are never recommended.
 */
export function dealsFor(stored, today) {
  const view = withUsage(stored, today);
  const rules = liveRules(view);
  const often = oftenBought(view, today);
  if (!rules.length && !often.length) return [];
  const current = currentOffers(view.offers, today);
  const byProduct = purchasesByProduct(view.purchases);
  const due = dueItems(view, today);
  const hits = new Map();
  // Product rules first, so they keep an offer an item rule also finds.
  for (const rule of [...rules].sort((a, b) => Number(Boolean(b.product_id)) - Number(Boolean(a.product_id)))) {
    const item = view.items[rule.item_id];
    const own = rule.product_id ? view.products?.[rule.product_id] : null;
    if (rule.product_id && (!own || own.deleted_at)) continue;
    const product = own ?? resolveProduct(view, { item_id: item.id, sources: [] }, null)?.product ?? null;
    // A store_only product is bought at its own store anyway: only that
    // store's offers count, and going there is no detour.
    const only = product?.store_only && product.store ? product.store : null;
    const here = only ? current.filter((o) => sameStore(o.store, only))
      : rule.detour ? current : current.filter((o) => isRegularStore(o.store));
    let found;
    if (own) {
      found = here.filter((o) => ruleProductMatches(own, item, o)).map((o) => [o, true]);
    } else {
      const { mine, named } = lineOffers(item.name, product, here);
      found = [...mine.map((o) => [o, true]), ...named.map((o) => [o, false])];
    }
    if (rule.match_words?.length) {
      const seen = new Set(found.map(([o]) => o));
      for (const o of here) if (!seen.has(o) && matchWordHit(rule, o)) found.push([o, false]);
    }
    for (const [offer, aboutProduct] of found) {
      if (hits.has(offer.id ?? offer) || isExcludedOffer(offer) || excluded(rule, offer)) continue;
      const req = requireCheck(rule, offer, own);
      if (req.other) continue;
      // A "check" hit may be another pack: its normal price is not his product's.
      const sure = aboutProduct && !req.missing;
      const eff = effectivePrice(offer, sure ? normalPrice(product, offer, byProduct) : null);
      if (!eff || !meetsRule(rule, eff)) continue;
      const detour = !only && !isRegularStore(offer.store);
      const checks = ruleChecks(rule, eff);
      if (detour && rule.detour_min_discount_pct) {
        const d = eff.discount_pct;
        const ok = d !== null && d >= rule.detour_min_discount_pct;
        if (!ok) continue;
        checks.push({ check: "detour_min_discount", ok, value: d });
      }
      hits.set(offer.id ?? offer, {
        rule, item, product: aboutProduct ? product : null, offer, eff,
        checks, saving_cents: saving(eff), low: null, check: req.missing, detour,
      });
    }
  }
  // What he buys often, without a rule: only on offer, only at AH and Dirk.
  const regular = current.filter((o) => isRegularStore(o.store));
  const brands = knownBrandWords(view);
  for (const o of often) {
    const rule = { id: null, item_id: o.item.id, product_id: "", offer_only: 1, implicit: true };
    const tokens = oftenTokens(o.item, o.products);
    for (const offer of regular) {
      if (hits.has(offer.id ?? offer)) continue;
      // Every way to match needs a word of the item or a product in the offer: a cheap test first.
      if (!keyWords(offer).some((w) => tokens.some((t) => w.includes(t)))) continue;
      const m = oftenMatch(o.item, o.products, offer, brands);
      if (!m) continue;
      const eff = effectivePrice(offer, m.sure ? normalPrice(m.product, offer, byProduct) : null);
      if (!eff || !meetsRule(rule, eff)) continue;
      hits.set(offer.id ?? offer, {
        rule, item: o.item, product: m.sure ? m.product : null, offer, eff, checks: ruleChecks(rule, eff),
        saving_cents: saving(eff), low: null, check: m.sure ? null : [m.label], detour: false, often: true, bought: o.count,
      });
    }
  }
  const out = [...hits.values()];
  for (const h of out) h.low = h.check ? null : lowReason(view, h.item, h.offer.valid_until, today, due);
  const n = (v) => (v === null || v === undefined ? -Infinity : v);
  return out.sort((a, b) => Number(Boolean(a.check)) - Number(Boolean(b.check))
    || Number(Boolean(b.low)) - Number(Boolean(a.low))
    || n(b.eff.discount_pct) - n(a.eff.discount_pct)
    || n(b.saving_cents) - n(a.saving_cents)
    || (a.eff.piece_cents ?? Infinity) - (b.eff.piece_cents ?? Infinity)
    || a.offer.valid_until.localeCompare(b.offer.valid_until));
}

/** The note an offer puts on the list line, in Dutch like the list: "Dirk · -55% t/m 3 nov". */
export function dealNote(offer) {
  const day = new Date(`${offer.valid_until}T12:00:00Z`).toLocaleDateString("nl-NL", { day: "numeric", month: "short", timeZone: "UTC" });
  return `${[offer.store, isCoupon(offer) ? "Lidl Plus-coupon (activeer in de app)" : null, offer.deal].filter(Boolean).join(" · ")} t/m ${day}`;
}

/**
 * The offers on a list line, computed on every render (30-10-2026:
 * "ja graag dynamisch"), never a stored note: lineOffers, plus what the
 * Deals tab found for the line's item (a rule's match words, a "koop je
 * vaak" hit). An ended offer is in neither `current` nor `hits`, so it is
 * gone by itself; a new one shows by itself. With a store chosen ("Ik ben
 * bij…") only that store's, for a store_only product only its own store's.
 * hits: dealsFor() of the same day, once per render.
 */
export function liveLineOffers(entry, product, current, hits = [], store = null) {
  const { mine, named } = lineOffers(entry.title, product, current, store);
  const shop = product?.store_only && product.store ? product.store : store;
  const idOf = (o) => o.id ?? `${o.store}|${o.name}|${o.valid_until}`;
  const seen = new Set([...mine, ...named].map(idOf));
  const key = canonicalName(entry.title ?? "").key;
  for (const hit of hits) {
    const o = hit.offer;
    if (seen.has(idOf(o)) || (shop && !sameStore(o.store, shop))) continue;
    if (hit.item.id !== entry.item_id && canonicalName(hit.item.name).key !== key) continue;
    seen.add(idOf(o));
    (hit.product && !hit.check ? mine : named).push(o);
  }
  return { mine, named };
}

/** "Bij Dirk" is worth saying when a store is chosen only from this gap: 10% or €0,30. */
export const SWITCH_MIN_PCT = 10;
export const SWITCH_MIN_CENTS = 30;

// Words a folder line may have that say nothing about which product it is.
const FILLER = new Set(["alle", "per", "voor", "met", "van", "en", "in", "of", "de", "het", "stuks", "stuk", "gram", "kilo", "liter", "ml"]);

/**
 * Is the offer this very product, for a price comparison? Every word of the
 * product is in it (productOfferMatches) and it adds no word of its own
 * besides store names, sizes and filler: "Edet Sensitive vochtig
 * toiletpapier" is not Dirk's own "Vochtig toiletpapier", and a "maxi pack"
 * is not the 42-pack. Stricter than the list line's "your product on offer".
 */
export function sameProductOffer(product, offer) {
  if (!productOfferMatches(product, offer)) return false;
  const own = new Set(nameKey(`${product.brand ?? ""} ${product.name}`).split(" "));
  return keyWords(offer).every((w) => own.has(w) || w.length < 3 || /\d/.test(w) || FILLER.has(w) || isStoreName(w)
    || [...own].some((o) => o.length >= 4 && (w.startsWith(o) || o.startsWith(w))));
}

/**
 * What the list line's product costs at one regular store: { store, cents,
 * offer, product }, the cheapest current offer on that product there
 * (deal-math), else its last price there; null when either is unknown.
 */
export function priceAt(view, entry, store, current, byProduct) {
  const product = resolveProduct(view, entry, store)?.product ?? null;
  if (!product || product.deleted_at) return null;
  const normal = lastPrice(product, store, byProduct);
  let best = null;
  for (const o of current) {
    if (!sameStore(o.store, store) || !sameProductOffer(product, o)) continue;
    const cents = effectivePrice(o, sameSize(product.size, o.size) ? normal : null)?.piece_cents ?? null;
    if (cents !== null && (!best || cents < best.cents)) best = { store, cents: Math.round(cents), offer: o, product };
  }
  if (best) return best;
  return normal ? { store, cents: normal, offer: null, product } : null;
}

/**
 * Thomas (28-10-2026): "liever één winkel, maar is de andere goedkoper, dan
 * wil ik het wel weten". { cheap, dear } when the line's product is cheaper
 * at the other of AH and Dirk, else null. Both prices must be known and the
 * packs must not clearly differ: never a guess. With a store chosen ("Ik ben
 * bij..."), only when that store is the dearer one by SWITCH_MIN_PCT or
 * SWITCH_MIN_CENTS. Never an excluded thing.
 */
export function cheaperElsewhere(view, entry, current, chosen = null, byProduct = purchasesByProduct(view.purchases)) {
  if (isExcluded(entry.title ?? "")) return null;
  if (chosen && !isRegularStore(chosen)) return null;
  // A product sold at one store only has no price at the other (28-10-2026).
  if (resolveProduct(view, entry, chosen)?.product?.store_only) return null;
  const [a, b] = REGULAR_STORES.map((s) => priceAt(view, entry, s, current, byProduct));
  if (!a || !b || a.cents === b.cents || a.product.store_only || b.product.store_only) return null;
  if (isExcluded(`${a.product.brand ?? ""} ${a.product.name}`) || isExcluded(`${b.product.brand ?? ""} ${b.product.name}`)) return null;
  if (!sameSize(a.product.size, b.product.size)) return null;
  const [cheap, dear] = a.cents < b.cents ? [a, b] : [b, a];
  if (chosen) {
    if (!sameStore(dear.store, chosen)) return null;
    const gap = dear.cents - cheap.cents;
    if (gap < SWITCH_MIN_CENTS && (gap / dear.cents) * 100 < SWITCH_MIN_PCT) return null;
  }
  return { cheap, dear };
}
