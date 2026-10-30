// How fast a household goes through common non-food things (Thomas,
// 28-10-2026: "een algemene schatting hoe lang iets meegaat, bijvoorbeeld een
// toiletblok ~3 weken, tandpasta ~6 weken, deo ~6 weken; ik kan het aanpassen").
// Used only when the item has no rate of its own (items.use_per_day NULL); the
// pantry then counts it down with source "rule" (public/shared/pantry.js,
// rowRate). A person's rate, or a person's 0 ("no countdown"), always wins.
//
// Conservative on purpose: every number is on the slow side, so the app never
// says something is gone while it is still in the cupboard. Running low a bit
// later than real costs one correction; a false "op" costs trust.
//
// NEVER FOOD. The table holds household goods only, and a name the shelf-life
// table (public/shared/shelf-life.js) knows as food, or an excluded thing, never gets a
// rule here. Cat food and the cat's tuna are set per item by a person.
//
// RATES is read top to bottom, the first match wins ("vochtig toiletpapier"
// above "toiletpapier"). A pattern is tested against nameKey(name). To add a
// kind: one line here and one case in tests/usage-rates.test.mjs.
//   days      how long one pack (one row-amount unit) lasts when the pack size
//             says nothing
//   perPiece  how long one piece lasts, used when the pack size names a count
//             ("20 stuks", "8 rollen", "2 st"): a pack lasts count x perPiece
import { nameKey } from "./ingredients.js";
import { shelfLife } from "./shelf-life.js";
import { isExcluded } from "./excluded.js";

/** [pattern on nameKey, { days, perPiece }, kind]. */
export const RATES = [
  [/\bvochtig (toilet ?papier|tp)\b|\bvochtige doekjes/, { days: 14 }, "wet wipes"],
  [/\b(toilet ?papier|wc ?papier|wc ?rollen|toiletrollen)\b/, { days: 28, perPiece: 4 }, "toilet paper"],
  [/\b(keuken ?papier|keuken ?rollen?)\b/, { days: 14, perPiece: 7 }, "kitchen roll"],
  [/\b(toilet ?blok(ken|je|jes)?|wc ?blok(ken|je|jes)?)\b/, { days: 21, perPiece: 21 }, "toilet block"],
  [/\btandpasta\b/, { days: 42, perPiece: 42 }, "toothpaste"],
  [/\b(deo|deodorant|deoroller|deospray)\b/, { days: 42, perPiece: 42 }, "deodorant"],
  [/\b(douche ?gel|showergel|douche ?schuim)\b/, { days: 28, perPiece: 28 }, "shower gel"],
  [/\bshampoo\b/, { days: 42, perPiece: 42 }, "shampoo"],
  [/\b(handzeep|vloeibare zeep)\b/, { days: 42, perPiece: 42 }, "hand soap"],
  [/\bafwasmiddel\b/, { days: 42, perPiece: 42 }, "washing-up liquid"],
  [/\b(vaatwas ?tabletten|vaatwas ?blokjes|vaatwas ?tabs|vaatwasmiddel)\b/, { days: 30, perPiece: 1.5 }, "dishwasher tablets"],
  [/\b(was ?pods|wascapsules|pods)\b|\bwasmiddel\b/, { days: 40, perPiece: 2 }, "laundry pods and detergent"],
  [/\b(kattenbakvulling|kattengrind|kattenbak ?korrels)\b/, { days: 21 }, "cat litter"],
  [/\b(water ?filter|filter ?patroon|fontein ?filter)/, { days: 30, perPiece: 30 }, "water filter"],
];

// A count in a pack size: "20 stuks", "8 rollen", "30 tabletten", "12 pods".
const COUNT_RE = /^\s*(?:\d+\s*x\s*)?(\d+(?:[.,]\d+)?)\s*(st|stuk|stuks|rol|rollen|tabletten|tabs|pods?|capsules?|blokken|blokjes|filters|x)?\s*$/i;

/** The number of pieces a pack size names, or null. A bare number counts too ("2"). */
export function piecesIn(packSize) {
  const m = COUNT_RE.exec(String(packSize ?? ""));
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return n >= 1 && n <= 500 ? n : null;
}

/**
 * The one food exception (29-10-2026: "kunnen we voor snacks, koekjes,
 * snoep, chocola en chips een gemiddelde opmaaktijd van een week zetten"):
 * snacks are eaten at a steady pace, not by recipes, so one pack lasts a week.
 */
export const SNACK_RATES = [
  [/\b(chips|doritos|pringles|crispys|nachos?)\b|chips\b/, { days: 7 }, "snack: chips"],
  [/\b(koek|koekjes?|koeken|stroopwafels?|krakelingen?|biscuits?|cookies?|speculaas|kaneelkrakelingen)\b/, { days: 7 }, "snack: biscuits"],
  [/\b(snoep|drop|gums|yoghurtgums|winegums|marshmallows?)\b|gums\b/, { days: 7 }, "snack: sweets"],
  [/\b(chocola|chocolade|chocoladereep|bonbons?|milka|twix|snickers|mars|m ?m s)\b/, { days: 7 }, "snack: chocolate"],
  [/\b(nootjes|noten|notenmix|borrelnootjes|pinda s|chips en noten)\b/, { days: 7 }, "snack: nuts"],
];

// Bought for a recipe (the nachos lasagne), not snacked: no weekly countdown.
const NOT_A_SNACK = /\btortilla ?chips\b|\btortillachips\b/;

/** { days, perPiece, kind } of the first rule for any of the names, or null. Never an excluded thing; food only for snacks. */
export function rateRule(...names) {
  for (const name of names) {
    if (!name || isExcluded(name)) continue;
    const snackKey = nameKey(name);
    if (!snackKey || NOT_A_SNACK.test(snackKey)) continue;
    for (const [pattern, rate, kind] of SNACK_RATES) if (pattern.test(snackKey)) return { ...rate, kind };
  }
  for (const name of names) {
    if (!name || isExcluded(name) || shelfLife(name).days !== null) continue;
    const key = nameKey(name);
    if (!key) continue;
    for (const [pattern, rate, kind] of RATES) if (pattern.test(key)) return { ...rate, kind };
  }
  return null;
}

/**
 * Row-amount units used per day by the rule for these names, or null. With a
 * count in the pack size and a perPiece, a pack lasts count x perPiece days.
 */
export function ruleRate(names, packSize = "") {
  const list = Array.isArray(names) ? names : [names];
  if (list.some((n) => n && isExcluded(n))) return null;
  const rule = rateRule(...list);
  if (!rule) return null;
  const count = rule.perPiece ? piecesIn(packSize) : null;
  const days = count ? count * rule.perPiece : rule.days;
  return days > 0 ? 1 / days : null;
}
