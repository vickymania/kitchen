// Deal maths (28-10-2026): what an offer really costs, per piece and
// per kg / l / piece in the pack, and whether it meets a deal rule. Pure, for
// the phone, the MCP server and the tests alike.
//
// The wordings are the ones the synced offers carry: the AH bonus ("2 voor
// 1.99", "1+1 gratis", "2e halve prijs", "25% korting", "voor 3.79", "per 100
// GRAM voor €1.89", "€1.00 euro korting", "2 stuks 40%") and allefolders
// ("-50%" with the price after the discount, or no deal and only a price).
// price_cents is the price of one after the discount, except with "N voor X"
// and "N+M gratis" / "2e halve prijs", where AH sends none.
//
// Rule: when unsure, null. A price is never guessed.

/** A rule's unit for the price per amount. */
export const UNITS = ["kg", "l", "piece"];

const num = (s) => Number(String(s).replace(",", "."));
// "2,40", "2.40", "5,-", "€ 1,99"
const EURO = String.raw`€?\s*(\d+(?:[.,]\d{1,2})?|\d+[.,]-)`;
const cents = (s) => Math.round(num(String(s).replace(/[.,]-$/, "")) * 100);

/**
 * The deal text as a mechanism, or null when it says nothing usable:
 * { kind: "price", cents }            "voor 3.79", "nu 2,49"
 * { kind: "multi", count, cents }     "2 voor 2,40", "3 voor 5,-"
 * { kind: "free", buy, free }         "1+1 gratis", "2+3 gratis", "2e gratis"
 * { kind: "nth", nth, pct }           "2e halve prijs" (the nth at pct off)
 * { kind: "pct", pct, min }           "25% korting", "-50%", "2 stuks 40%"
 * { kind: "off", cents }              "€1.00 euro korting", "1 euro korting"
 * { kind: "weight", grams, cents }    "per 100 GRAM voor €1.89", "per kilo 4,99"
 * { kind: "folder" }                  no deal ("BONUS", null): a folder price
 */
export function parseDeal(deal) {
  if (deal === null || deal === undefined) return { kind: "folder" };
  const d = String(deal).toLowerCase().replace(/\s+/g, " ").trim();
  if (!d || /^(bonus|aanbieding|actie|op=op)$/.test(d)) return { kind: "folder" };
  let m;
  if ((m = d.match(/^per (\d+(?:[.,]\d+)?) ?(gram|gr|g|kilo|kg)\b(?: voor)? ?(?:€\s*)?(\d+(?:[.,]\d{1,2})?)?$/))) {
    const grams = num(m[1]) * (/^k/.test(m[2]) ? 1000 : 1);
    return grams > 0 ? { kind: "weight", grams, cents: m[3] ? cents(m[3]) : null } : null;
  }
  if ((m = d.match(/^per (kilo|kg)$/))) return { kind: "weight", grams: 1000, cents: null };
  if ((m = d.match(/^(\d+) ?\+ ?(\d+)(?: gratis)?$/))) {
    const buy = Number(m[1]);
    const free = Number(m[2]);
    return buy > 0 && free > 0 ? { kind: "free", buy, free } : null;
  }
  if ((m = d.match(/^(\d+)e gratis$/))) return Number(m[1]) >= 2 ? { kind: "free", buy: Number(m[1]) - 1, free: 1 } : null;
  if ((m = d.match(/^(\d+)e (halve prijs|half price)$/))) return Number(m[1]) >= 2 ? { kind: "nth", nth: Number(m[1]), pct: 50 } : null;
  if ((m = d.match(new RegExp(`^(\\d+) (?:voor|for|halen voor) ${EURO}$`)))) {
    const count = Number(m[1]);
    return count >= 1 ? { kind: "multi", count, cents: cents(m[2]) } : null;
  }
  if ((m = d.match(/^-? ?(\d+(?:[.,]\d+)?) ?% ?(?:korting|off)?$/))) return pct(num(m[1]), 1);
  if ((m = d.match(/^(\d+) (?:stuks|st) (\d+(?:[.,]\d+)?) ?%(?: korting)?$/))) return pct(num(m[2]), Number(m[1]));
  if ((m = d.match(new RegExp(`^${EURO} ?(?:euro )?korting$`)))) return { kind: "off", cents: cents(m[1]) };
  if ((m = d.match(new RegExp(`^(?:voor|nu|now|for) ${EURO}$`)))) return { kind: "price", cents: cents(m[1]) };
  return null;
}

function pct(p, min) {
  return p > 0 && p < 100 ? { kind: "pct", pct: p, min: Math.max(1, min) } : null;
}

const WEIGHT = { g: 1, gr: 1, gram: 1, kg: 1000, kilo: 1000 };
const VOLUME = { ml: 1, cl: 10, l: 1000, ltr: 1000, liter: 1000 };
const COUNT = new Set(["stuks", "stuk", "st", "rollen", "rol", "wasbeurten", "zakjes", "pouches", "blikjes", "tabletten", "capsules", "pods"]);
const SIZE_RE = /(\d+(?:[.,]\d+)?)\s*(?:x\s*(\d+(?:[.,]\d+)?)\s*)?(kilo|kg|gram|gr|g|ml|cl|liter|ltr|l|stuks|stuk|st|rollen|rol|wasbeurten|zakjes|pouches|blikjes|tabletten|capsules|pods)\b/i;
// "400-500 gram", "6 t/m 8 rollen", "70-150 gram": a range is no size.
const RANGE_RE = /\d+\s*(?:-|t\/m|tot)\s*\d+\s*(?:kilo|kg|gram|gr|g|ml|cl|liter|ltr|l|stuks|st|rollen|wasbeurten)\b/i;

/**
 * What one pack holds: { count, grams, ml } (any may be null), from the
 * offer's size, else its name. "6 x 85 g" is 6 pieces and 510 g; "42 stuks"
 * 42 pieces; "1 kilo" 1000 g and no count (a bag is not a piece). Null when it says nothing usable
 * or names a range ("Alle Chio chips 70-150 gram").
 */
export function parseSize(size, name = "") {
  if (RANGE_RE.test(`${size ?? ""} ${name ?? ""}`)) return null;
  for (const text of [size, name]) {
    const m = typeof text === "string" ? text.match(SIZE_RE) : null;
    if (!m) continue;
    const a = num(m[1]);
    const each = m[2] ? num(m[2]) : null;
    const unit = m[3].toLowerCase();
    if (!(a > 0) || (each !== null && !(each > 0))) return null;
    if (WEIGHT[unit]) return each ? { count: a, grams: a * each * WEIGHT[unit], ml: null } : { count: null, grams: a * WEIGHT[unit], ml: null };
    if (VOLUME[unit]) return each ? { count: a, grams: null, ml: a * each * VOLUME[unit] } : { count: null, grams: null, ml: a * VOLUME[unit] };
    if (COUNT.has(unit)) return { count: each ? a * each : a, grams: null, ml: null };
  }
  return null;
}

const round = (n) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

/**
 * What the offer costs. normalCents: the normal price of one (the product's
 * last price, when the offer is about that product), or null.
 * Returns null when nothing is sure, else:
 * { piece_cents   price of one after the deal (multi-buy: per piece), or null
 *   was_cents     price of one without it, or null
 *   discount_pct  0..100, or null when unknown (a folder price, no normal price)
 *   is_discount   true, false (not cheaper than normal), or null (only in a folder)
 *   min_qty       how many to buy to get it
 *   per: { kg, l, piece }  cents per kg / l / piece in the pack, each or null }
 */
export function effectivePrice(offer, normalCents = null) {
  if (!offer) return null;
  const deal = parseDeal(offer.deal);
  if (!deal) return null;
  const normal = Number.isFinite(normalCents) && normalCents > 0 ? normalCents : null;
  const price = Number.isFinite(offer.price_cents) && offer.price_cents > 0 ? offer.price_cents : null;
  let piece = null;
  let was = null;
  let pctOff = null;
  let minQty = 1;
  let perKg = null;
  switch (deal.kind) {
    case "folder":
      piece = price;
      break;
    case "price":
      piece = deal.cents;
      break;
    case "multi":
      piece = deal.cents / deal.count;
      minQty = deal.count;
      break;
    case "free":
    case "nth": {
      const n = deal.kind === "free" ? deal.buy + deal.free : deal.nth;
      const paid = deal.kind === "free" ? deal.buy : n - deal.pct / 100;
      pctOff = (1 - paid / n) * 100;
      minQty = n;
      // AH sends no price with these; a folder's price is the one of one.
      const base = normal ?? price;
      if (base) {
        was = base;
        piece = (base * paid) / n;
      }
      break;
    }
    case "pct":
      pctOff = deal.pct;
      minQty = deal.min;
      if (price) {
        piece = price;
        was = price / (1 - deal.pct / 100);
      } else if (normal) {
        was = normal;
        piece = normal * (1 - deal.pct / 100);
      }
      break;
    case "off":
      if (price) {
        piece = price;
        was = price + deal.cents;
      } else if (normal && normal > deal.cents) {
        was = normal;
        piece = normal - deal.cents;
      }
      if (piece && was) pctOff = (1 - piece / was) * 100;
      break;
    case "weight":
      perKg = ((deal.cents ?? price) ?? NaN) * (1000 / deal.grams);
      if (!Number.isFinite(perKg)) return null;
      break;
    default:
      return null;
  }
  // A normal price we know says more than "it is in a folder".
  if (was === null && normal && piece !== null) was = normal;
  if (pctOff === null && was && piece !== null) pctOff = (1 - piece / was) * 100;
  const size = parseSize(offer.size, offer.name);
  const per = { kg: perKg, l: null, piece: null };
  if (piece !== null && size) {
    if (size.grams && per.kg === null) per.kg = piece / (size.grams / 1000);
    if (size.ml) per.l = piece / (size.ml / 1000);
    if (size.count) per.piece = piece / size.count;
  }
  if (piece === null && per.kg === null && pctOff === null) return null;
  return {
    piece_cents: round(piece),
    was_cents: round(was),
    discount_pct: pctOff === null ? null : round(pctOff),
    is_discount: pctOff === null ? null : pctOff > 0.5,
    min_qty: minQty,
    per: { kg: round(per.kg), l: round(per.l), piece: round(per.piece) },
  };
}

/** A rule's conditions, each checked: [{ check, ok, value }]. value: the number compared, or null when unknown. */
export function ruleChecks(rule, eff) {
  const out = [];
  if (rule.max_price_cents !== null && rule.max_price_cents !== undefined) {
    const v = eff?.piece_cents ?? null;
    out.push({ check: "max_price", ok: v !== null && v <= rule.max_price_cents, value: v });
  }
  if (rule.offer_only || rule.min_discount_pct) {
    // Only in a folder, no normal price known: trusted as an offer, but a
    // minimum discount needs a number.
    const d = eff?.discount_pct ?? null;
    const isOffer = eff ? eff.is_discount !== false : false;
    out.push({ check: "offer_only", ok: isOffer, value: d });
    if (rule.min_discount_pct) out.push({ check: "min_discount", ok: d !== null && d >= rule.min_discount_pct, value: d });
  }
  if (rule.max_unit_price_cents !== null && rule.max_unit_price_cents !== undefined && UNITS.includes(rule.unit)) {
    const v = eff?.per?.[rule.unit] ?? null;
    out.push({ check: "max_unit_price", ok: v !== null && v <= rule.max_unit_price_cents, value: v });
  }
  return out;
}

/** Does the offer (its effectivePrice) meet every condition of the rule? A rule with none (only "omweg waard") takes any offer. */
export const meetsRule = (rule, eff) => ruleChecks(rule, eff).every((c) => c.ok);
