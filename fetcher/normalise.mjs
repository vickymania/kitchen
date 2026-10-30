// From what AH and allefolders answer to the one offer shape of
// public/shared/offers.js. Pure functions, so the tests run them as they are.
import { cleanOffer, isExcludedOffer, offerKey } from "../public/shared/offers.js";

export const AH_STORE = "Albert Heijn";

/** A moment ("2026-10-31T22:59:00Z") or a day as the day it is in the Netherlands. */
export function dutchDay(value) {
  if (typeof value !== "string" || !value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" }) : null;
}

/** Euros as a number to cents, or null. */
export function cents(euros) {
  return typeof euros === "number" && Number.isFinite(euros) && euros > 0 ? Math.round(euros * 100) : null;
}

const SIZE = /\b(\d+(?:[.,]\d+)?\s?(?:x\s?\d+(?:[.,]\d+)?\s?)?(?:kilo|kg|gram|gr|g|ml|cl|liter|ltr|l|stuks|stuk|st|rollen|rol|wasbeurten)\.?)(?=\s|$|[,;)])/i;

/** "500 gram", "6 x 33 cl" from a name or description, or null. */
export function sizeFrom(...texts) {
  for (const text of texts) {
    const m = typeof text === "string" ? text.match(SIZE) : null;
    if (m) return m[1].replace(/\s+/g, " ").replace(/\.$/, "");
  }
  return null;
}

// Words that make a folder description a deal worth showing ("1+1 gratis",
// "2e halve prijs", "3 voor 5,00", "25% korting").
const DEAL_WORDS = /gratis|korting|halve prijs|\d+\s*\+\s*\d+|\d+\s*(?:voor|halen)\b|\d+\s*%|op=op|actie/i;

function shortText(text, max = 60) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  const first = s.split(/(?<=[.!])\s/)[0];
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

/**
 * One item of the AH bonus page (a product or a group such as "Alle Hak
 * groenten"). period: { bonusStartDate, bonusEndDate }.
 */
export function fromAhBonus(item, period = {}) {
  return {
    store: AH_STORE,
    name: item.title,
    brand: null,
    size: item.size || sizeFrom(item.title),
    deal: item.mechanism || "bonus",
    price_cents: cents(item.price),
    valid_from: dutchDay(item.start ?? period.bonusStartDate),
    valid_until: dutchDay(item.end ?? period.bonusEndDate),
    category: item.category || null,
  };
}

/** One offer from the allefolders.nl GraphQL API. */
export function fromFolder(offer) {
  const pct = typeof offer.discountPercent === "number" && offer.discountPercent > 0
    ? `-${Math.round(offer.discountPercent)}%` : null;
  const desc = shortText(offer.description);
  return {
    store: offer.shop?.name ?? offer.shop?.slug ?? "",
    name: offer.name,
    brand: offer.brandName || null,
    size: sizeFrom(offer.description, offer.name),
    deal: pct ?? (desc && DEAL_WORDS.test(desc) ? desc : null),
    price_cents: cents(offer.priceAfterDiscount),
    valid_from: dutchDay(offer.activeFrom),
    valid_until: dutchDay(offer.expireAfter),
    category: null,
  };
}

/**
 * Clean, drop excluded things and duplicates (the same product on two folder pages),
 * keep what holds today or later. Returns { offers, dropped }.
 */
export function prepare(raw, today) {
  const dropped = { excluded: 0, invalid: 0, expired: 0, duplicate: 0 };
  const seen = new Set();
  const offers = [];
  for (const r of raw) {
    if (isExcludedOffer(r)) {
      dropped.excluded++;
      continue;
    }
    const o = cleanOffer(r);
    if (!o) {
      dropped.invalid++;
      continue;
    }
    if (o.valid_until < today) {
      dropped.expired++;
      continue;
    }
    const key = offerKey(o);
    if (seen.has(key)) {
      dropped.duplicate++;
      continue;
    }
    seen.add(key);
    offers.push(o);
  }
  return { offers, dropped };
}

/** { store: count } for the dry run and the log. */
export function countByStore(offers) {
  const out = {};
  for (const o of offers) out[o.store] = (out[o.store] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}
