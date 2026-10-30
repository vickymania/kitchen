// The pantry ("voorraad", phase 4): what is in the house, how much, and until
// when it keeps. Pure functions only, shared by the op engine, the screens,
// the wizard, "need it again" and the MCP server.
//
// Thomas's decisions (28-10-2026):
//   - ticking a list line puts it in the pantry at once; a receipt read later
//     (photo review or the AH import) fills in the real product without
//     counting it twice (matchPurchase)
//   - the use-by date is estimated per kind of product (shelf-life.js); he
//     can type the real one
//   - cooking a recipe takes its ingredients off (cookTakes); one tap marks a
//     loose thing "op" or "weggegooid", and thrown-away things are remembered
//   - amounts are packs or pieces, with a fraction when needed: cooking 200 g
//     from a 400 g cheese leaves half a cheese. No gram precision.
import { parseIngredient, nameKey } from "./ingredients.js";
import { canonicalName } from "./item-names.js";
import { isExcluded } from "./excluded.js";
import { daysBetween } from "./intervals.js";
import { ruleRate } from "./usage-rates.js";
import { portionCategory, categoryPack, stapleDefault } from "./default-portions.js";
import { ingredientKey, resolveName, itemFinder, alternativesOf } from "./ingredient-match.js";
import { aliasTarget } from "./item-find.js";

/** A receipt within this many days of a tick is the same shopping. */
export const MATCH_DAYS = 2;
/** Grams or millilitres from which a weighed ingredient takes a pack of unknown size. */
export const WHOLE_PACK_MIN = 150;
/** "Op tijd opmaken": the use-by date is at most this many days away, or past. */
export const DUE_DAYS = 2;

const BASE = { g: ["g", 1], kg: ["g", 1000], mg: ["g", 0.001], ml: ["ml", 1], cl: ["ml", 10], dl: ["ml", 100], l: ["ml", 1000] };
// Counted like a pack: "1 blik tomaten" takes one tin.
const PACK_UNITS = new Set(["pack", "packet", "can", "jar", "bottle", "bowl", "bunch"]);
// Counted like pieces: "2 uien", "3 plakken".
// A stock cube is a piece too: the pantry row "Groentebouillon" counts "1 blokje".
const PIECE_UNITS = new Set(["piece", "slice", "sheet", "cube"]);
// "1 bol" (a bulb of garlic) is one piece; a clove is a tenth of it (CLOVES_PER_BULB).
const PIECE_WORDS = new Set(["", "st", "stuks", "stuk", "x", "pcs", "pieces", "stk", "bol", "bollen"]);
/** Cloves in one bulb of garlic. */
export const CLOVES_PER_BULB = 10;
/** Grams of one clove, against garlic sold by weight. */
export const CLOVE_GRAMS = 5;
// Spoons: measured through the thing's category (default-portions.js).
const SPOON_TSP = { tsp: 1, tbsp: 3, dash: 3 };

export const round2 = (n) => Math.round(n * 100) / 100;

/**
 * The size of one pack, from a product size or a list amount: "400 g" ->
 * { qty: 400, base: "g" }, "1 l" -> { qty: 1000, base: "ml" }, "10 st" ->
 * { qty: 10, base: "piece" }. Null when it says nothing usable ("los").
 */
export function packSize(text) {
  const p = parseIngredient(String(text ?? "").replace(/^\d+\s*x\s*/i, ""));
  if (p.qty === null || !(p.qty > 0)) return null;
  if (BASE[p.unit]) return { qty: p.qty * BASE[p.unit][1], base: BASE[p.unit][0] };
  if ((p.unit === null && PIECE_WORDS.has(nameKey(p.name))) || PIECE_UNITS.has(p.unit)) return { qty: p.qty, base: "piece" };
  return null;
}

/**
 * A ticked list line as a pantry amount: "2 melk" is 2, "6 eieren" is 6
 * (pieces), "500 g gehakt" is one pack of 500 g, no amount is 1.
 */
export function fromEntry(entry) {
  const a = (entry?.amounts ?? []).find((x) => x && x.text === undefined && x.qty > 0);
  if (!a) return { amount: 1, pack_size: "" };
  if (BASE[a.unit]) return { amount: 1, pack_size: `${a.qty} ${a.unit}` };
  if (a.unit === null || PACK_UNITS.has(a.unit) || PIECE_UNITS.has(a.unit)) return { amount: Math.min(round2(a.qty), 100), pack_size: "" };
  return { amount: 1, pack_size: "" };
}

const live = (row) => row && !row.deleted_at;

/**
 * The row a purchase fills in instead of adding one: a row of the same item
 * that came from ticking the list (no purchase yet), put in within
 * MATCH_DAYS of the day bought. A row that was already used up still
 * matches (it was this shopping, eaten before the receipt came); a row
 * someone removed (unticked, or "remove") does not. The oldest wins.
 */
export function matchPurchase(rows, { item_id, bought_on }) {
  return Object.values(rows ?? {})
    .filter((r) => r.item_id === item_id && !r.source_purchase_id && r.source_entry_id
      && (!r.deleted_at || r.taken > 0)
      && Math.abs(daysBetween(r.added_on, bought_on)) <= MATCH_DAYS)
    .sort((a, b) => a.added_on.localeCompare(b.added_on) || a.id.localeCompare(b.id))[0] ?? null;
}

const words = (key) => key.split(" ").filter(Boolean);

/**
 * Does the ingredient (key) mean the thing bought (key)? "rode ui" was bought
 * as "ui"; "kipfilet" as "kip". Used by the wizard ("in the house") too.
 */
export function sameThing(ingredientKey, boughtKey) {
  if (!ingredientKey || !boughtKey) return false;
  if (ingredientKey === boughtKey) return true;
  const iw = words(ingredientKey);
  const bw = words(boughtKey);
  if (bw.every((w) => iw.includes(w))) return true;
  return bw.length === 1 && bw[0].length >= 3 && iw.some((w) => w.startsWith(bw[0]));
}

/** The key a pantry row is matched under: its item's, else its own title's. */
export function rowKey(row, items = {}) {
  return items[row.item_id]?.name_key ?? nameKey(row.title);
}

/** A key with each word under its canonical name: "rode ui" is "rode uien". */
const canonicalWords = (key) => key.split(" ").map((w) => canonicalName(w).key).join(" ");

// Colour words (28-10-2026): "rode ui" is not "Uien" (yellow). Both
// sides with a colour must agree; an ingredient with one meets a pantry row
// without one only when that product has no default colour.
const COLOURS = { rode: "red", rood: "red", gele: "yellow", geel: "yellow", witte: "white", wit: "white", groene: "green", groen: "green" };
// What a pantry row without a colour word is, for the products where it matters.
const DEFAULT_COLOUR = { uien: "yellow" };
// Explicit one-word synonyms, no guessing: "puntpaprika" is a paprika, and
// nacho chips are tortilla chips (one word, like the pantry row "Tortillachips").
const WORD_SYNONYMS = { puntpaprika: "paprika", nacho: "tortillachips", nachos: "tortillachips" };
// Stock cubes: "groenten bouillonblokje", "kippenbouillonblokje" and the pantry
// rows "Groentebouillon" / "Kippenbouillon" / "Runderbouillon" are one word
// per kind; a plain "bouillon(blokje)" is any kind, the vegetable one first.
const BOUILLON_KIND = { groente: "groente", groenten: "groente", kip: "kippen", kippen: "kippen", rund: "runder", runder: "runder", vis: "vis", vlees: "vlees" };
const GENERIC_BOUILLON_FIRST = "groentebouillon";

/** { colour, words } of a key: "lente ui" and "tortilla chips" folded into one word each, colour words taken out. */
function normalized(key) {
  const folded = key
    .replace(/\b(lente|bos) ?ui(?:en)?\b/g, "bosui")
    .replace(/\b(tortilla|nacho|nachos) chips\b/g, "tortillachips")
    .replace(/\b(groenten?|kippen|kip|runder|rund|vis|vlees) ?bouillon(?: ?blok(?:je|jes|ken)?)?\b/g, (_, kind) => `${BOUILLON_KIND[kind]}bouillon`)
    .replace(/\bbouillon ?blok(?:je|jes|ken)?\b/g, "bouillon");
  let colour = null;
  const words = [];
  for (const w of folded.split(" ").filter(Boolean)) {
    if (COLOURS[w]) colour = COLOURS[w];
    else words.push(WORD_SYNONYMS[w] ?? w);
  }
  const text = canonicalWords(words.join(" "));
  return { colour, text: text.trim() };
}

/**
 * How well an ingredient name means a pantry thing: 0 for no, else higher is
 * more specific (the same words, then the same colour, beat a part of the
 * name). "X of Y" ("nacho of tortilla chips") is each alternative on its own.
 */
export function stuffScore(ingredientKey, key) {
  if (!ingredientKey || !key) return 0;
  const b = normalized(key);
  let best = 0;
  for (const alt of ingredientKey.split(" of ")) {
    const a = normalized(alt.trim());
    if (!a.text || !b.text) continue;
    const have = b.colour ?? DEFAULT_COLOUR[b.text];
    if (a.colour && have && a.colour !== have) continue;
    const exact = a.text === b.text;
    // A plain stock cube takes any kind of stock, the vegetable one first.
    if (a.text === "bouillon" && /^[a-z]+bouillon$/.test(b.text)) {
      best = Math.max(best, 10 + (b.text === GENERIC_BOUILLON_FIRST ? 2 : 0));
      continue;
    }
    if (!(exact || sameThing(a.text, b.text) || sameThing(b.text, a.text))) continue;
    best = Math.max(best, (exact ? 100 : 10) + (a.colour && a.colour === b.colour ? 5 : 0) + (!a.colour && !b.colour ? 1 : 0));
  }
  return best;
}

/** Does an ingredient name mean this pantry thing? Under canonical names ("ui" is "uien"), colours and the explicit synonyms. */
export function sameStuff(ingredientKey, key) {
  return stuffScore(ingredientKey, key) > 0;
}

/** Live rows, never an excluded thing. */
export function liveRows(pantry) {
  return Object.values(pantry ?? {}).filter((r) => live(r) && r.amount > 0 && !isExcluded(r.title));
}

/** Whole days from today to the use-by date (negative: past), or null. */
export function daysLeft(row, today) {
  return row.use_by ? daysBetween(today, row.use_by) : null;
}

/**
 * The pantry tab's two groups: { due, rest }. Due ("Op tijd opmaken") is a
 * use-by date within DUE_DAYS or past, soonest first; the rest by name, the
 * dated ones first.
 */
export function pantryGroups(pantry, today, days = DUE_DAYS) {
  const rows = liveRows(pantry);
  const due = rows.filter((r) => r.use_by && daysLeft(r, today) <= days)
    .sort((a, b) => a.use_by.localeCompare(b.use_by) || a.title.localeCompare(b.title));
  const dueIds = new Set(due.map((r) => r.id));
  const rest = rows.filter((r) => !dueIds.has(r.id))
    .sort((a, b) => (!a.use_by - !b.use_by) || String(a.use_by).localeCompare(String(b.use_by)) || a.title.localeCompare(b.title));
  return { due, rest };
}

/**
 * Is this canonical key in stock for "need it again"? A row with a use-by
 * date counts until that date; one without (dry goods) for one usual
 * interval after it came in, so a bag of rice nobody marked "op" does not
 * hide the rice forever.
 */
export function inStock(pantry, key, today, interval) {
  // A counted-down row (withUsage) is in the house exactly while something is left.
  return liveRows(pantry).some((r) => canonicalName(r.title).key === key && (r.per_day > 0 ? true : r.use_by
    ? r.use_by >= today
    : !interval || daysBetween(r.added_on, today) < interval));
}

/** An amount as it is read: to the nearest quarter, and never less than ¼ while something is left. */
export function displayAmount(n) {
  if (!(n > 0)) return 0;
  return Math.max(0.25, Math.round(n * 4) / 4);
}

/** How many times each item was thrown away: { item_id: { count, last } }. Undone events do not count. */
export function wasteCounts(events) {
  const out = {};
  for (const e of Object.values(events ?? {})) {
    if (e.deleted_at || e.reason !== "thrown") continue;
    const w = (out[e.item_id] ??= { count: 0, last: "" });
    w.count++;
    if (e.happened_on > w.last) w.last = e.happened_on;
  }
  return out;
}

/** Packs of `row` that `ing` (scaled) needs, or null when unsure. Also "Bijna op" (low-stock.js). */
export function packsFor(ing, row) {
  if (ing.qty === null || ing.qty === undefined || !(ing.qty > 0)) return null;
  const pack = packSize(row.pack_size);
  if (BASE[ing.unit]) {
    const [base, f] = BASE[ing.unit];
    // Weighed, against a pack of known weight: the share of it. Without one,
    // a real amount (400 g kipfilet) is the pack; a splash (100 ml melk from
    // a carton of unknown size) is too unsure to take anything.
    if (pack && pack.base === base) return (ing.qty * f) / pack.qty;
    return ing.qty * f >= WHOLE_PACK_MIN ? 1 : null;
  }
  if (PACK_UNITS.has(ing.unit)) return ing.qty;
  if (ing.unit === null || PIECE_UNITS.has(ing.unit)) {
    if (pack?.base === "piece") return ing.qty / pack.qty;
    // "2 kipfilets" from a pack of 500 g: the pack.
    if (pack) return 1;
    return ing.qty;
  }
  // Spoons, pinches, cloves, a handful: a little from a pack, never a whole one.
  return null;
}

/**
 * The size of one pack of a row from the household's own products: the row's
 * product, else the item's preferred product (this recipe's first, then any
 * store and recipe, then any other preference), else the product bought most
 * often for the item. { qty, base } or null.
 */
export function householdPack(data, row, recipeId = "") {
  const sizeOf = (id) => {
    const p = id ? data?.products?.[id] : null;
    return p && !p.deleted_at ? packSize(p.size) : null;
  };
  const own = sizeOf(row?.product_id);
  if (own) return own;
  const itemId = row?.item_id;
  if (!itemId) return null;
  const rank = (p) => (p.recipe_id && p.recipe_id === recipeId ? 0 : !p.store && !p.recipe_id ? 1 : 2);
  const prefs = Object.values(data?.preferences ?? {})
    .filter((p) => p && !p.deleted_at && p.item_id === itemId && p.product_id && (!p.recipe_id || p.recipe_id === recipeId))
    .sort((a, b) => rank(a) - rank(b) || String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
  for (const p of prefs) {
    const s = sizeOf(p.product_id);
    if (s) return s;
  }
  const counts = new Map();
  for (const x of Object.values(data?.purchases ?? {})) {
    if (x && !x.deleted_at && x.item_id === itemId && x.product_id) counts.set(x.product_id, (counts.get(x.product_id) ?? 0) + 1);
  }
  for (const [id] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    const s = sizeOf(id);
    if (s) return s;
  }
  return null;
}

const weighed = (pack) => Boolean(pack) && (pack.base === "g" || pack.base === "ml");

/**
 * The ingredient written without an amount, with its category's default
 * portion ("Ketchup": 2 el, "Italiaanse kruiden": 1 tl), marked
 * default_portion; the ingredient itself when it has an amount; null when
 * nothing sensible can be said (no amount and no category, or salt and pepper).
 */
export function withDefaultPortion(ing, key = nameKey(ing?.name)) {
  if (!ing) return null;
  if (ing.qty !== null && ing.qty !== undefined && ing.qty > 0) return ing;
  const cat = portionCategory(key);
  if (!cat || cat.ignore || !cat.portion) return null;
  return { ...ing, qty: cat.portion.qty, unit: cat.portion.unit, qty_max: null, default_portion: true };
}

/**
 * Packs of `row` that `ing` (already scaled) needs: { packs, estimate }, or
 * null when unsure. Beyond packsFor:
 *   - spoons and a default portion go through the category (default-portions.js):
 *     a teaspoon in g or ml, against the row's pack size, else the household's
 *     product size, else the category's default pack ("ketchup" 500 ml); a
 *     spoon of a thing without a category is 5 g or ml, only against a known size
 *   - a weighed amount against a row without a pack size: the household's
 *     product size, else a staple's default (pasta 500 g) or the category's
 *     default pack; only then the old rule (WHOLE_PACK_MIN takes one pack)
 *   - cloves against garlic: CLOVES_PER_BULB to a bulb, CLOVE_GRAMS against a weight
 *   - salt and pepper, pinches: nothing
 * estimate is true whenever a default from the table decided the amount.
 * ctx: { data, recipeId, key }.
 */
export function needOf(ing, row, { data = {}, recipeId = "", key = nameKey(ing?.name) } = {}) {
  if (!ing || !(ing.qty > 0) || ing.unit === "pinch") return null;
  const cat = portionCategory(key);
  if (cat?.ignore) return null;
  const rowPack = packSize(row.pack_size);
  const house = () => householdPack(data, row, recipeId);
  const catPack = () => (cat ? packSize(categoryPack(cat, key)) : null);

  if (ing.unit === "clove") {
    const pack = rowPack ?? house();
    if (pack?.base === "g") return { packs: (ing.qty * CLOVE_GRAMS) / pack.qty, estimate: false };
    // A row without a size, or counted in bulbs ("1 bol"), counts bulbs.
    return { packs: ing.qty / CLOVES_PER_BULB / (pack?.base === "piece" ? pack.qty : 1), estimate: false };
  }

  const spoons = SPOON_TSP[ing.unit];
  if (spoons || (ing.default_portion && BASE[ing.unit])) {
    const qty = spoons ? ing.qty * spoons * (cat?.tsp?.[0] ?? 5) : ing.qty * BASE[ing.unit][1];
    const known = [rowPack, house()].find(weighed) ?? null;
    const pack = known ?? (cat ? catPack() : null);
    if (!weighed(pack)) return null;
    // Sauces and oil: a gram is a millilitre, near enough for a spoon.
    return { packs: qty / pack.qty, estimate: true };
  }

  if (BASE[ing.unit]) {
    const [base, f] = BASE[ing.unit];
    const qty = ing.qty * f;
    if (rowPack && rowPack.base === base) return { packs: qty / rowPack.qty, estimate: false };
    if (!rowPack) {
      const h = house();
      if (h && h.base === base) return { packs: qty / h.qty, estimate: false };
      const d = packSize(stapleDefault(key)) ?? catPack();
      if (d && d.base === base) return { packs: qty / d.qty, estimate: true };
    }
  }
  const packs = packsFor(ing, row);
  return packs === null ? null : { packs, estimate: false };
}

/**
 * The pantry's view of cooking `recipe` now, ingredient by ingredient (the
 * same matching and amounts as cookTakes, without the "already cooked
 * today" rule): [{ index, name, have, need, estimate, takes }] for every
 * ingredient that matches a row. index: its place in recipe.ingredients;
 * have: packs left in the matching rows before this ingredient takes;
 * need: packs it needs (null when unsure); takes: [{ pantry_id, amount, title }].
 */
export function cookPlan({ recipe, data: stored, today, scale = (i) => i, short = null }) {
  // From what is left today: a counted-down row (the cat's tuna) has less than it says.
  const data = withUsage(stored, today) ?? {};
  const rows = liveRows(data.pantry)
    .sort((a, b) => (!a.use_by - !b.use_by) || String(a.use_by).localeCompare(String(b.use_by)) || a.added_on.localeCompare(b.added_on));
  const left = new Map(rows.map((r) => [r.id, r.amount]));
  const find = pantryFinder(data, rows);
  const out = [];
  for (const [index, raw] of (recipe.ingredients ?? []).entries()) {
    if (!raw || raw.heading || raw.optional) continue;
    // The name without how it is prepared: "melk, lauwwarm" is melk.
    const key = ingredientKey(raw.name);
    if (!key || isExcluded(raw.name)) continue;
    // The thing the household calls it (public/shared/ingredient-match.js):
    // its rows come first, whatever their titles say; else the old word match.
    // Portions and pack defaults read the recipe's own words ("verse
    // peterselie" is no jar of dried herbs), not the item's name.
    const hit = resolveName(raw.name, find);
    // "nasi of wokgroenten": one of them, so nothing is taken unless every
    // alternative is the same item (then hit has its rows).
    if (!hit && alternativesOf(raw.name)) continue;
    // The most specific rows first ("tortilla chips" takes "Tortillachips"
    // before anything called "chips"); among equals, the ones that run out first.
    const scored = rows.map((r) => [r, left.get(r.id) > 0 ? (hit?.target.rows.has(r) ? RESOLVED : stuffScore(key, rowKey(r, data.items))) : 0]).filter(([, sc]) => sc > 0);
    const top = Math.max(0, ...scored.map(([, sc]) => sc));
    const matching = scored.filter(([, sc]) => sc === top).map(([r]) => r);
    if (!matching.length) {
      if (short) noteShort(short, raw, key, scale, data, 1, hit?.target.item?.id ?? null);
      continue;
    }
    const have = round2(matching.reduce((n, r) => n + left.get(r.id), 0));
    const base = withDefaultPortion(raw, key);
    // The pack it is weighed against is the first row's; unsure leaves it alone.
    const need = base ? needOf(scale(base), matching[0], { data, recipeId: recipe.id, key }) : null;
    const line = { index, name: raw.name, have, need: need ? round2(need.packs) : null, estimate: Boolean(need?.estimate), takes: [] };
    out.push(line);
    let rest = need ? need.packs : 0;
    // Several rows of one thing: take from the first until it is empty, then the next.
    for (const r of matching) {
      if (rest <= 0.005) break;
      const take = round2(Math.min(rest, left.get(r.id)));
      if (take <= 0) continue;
      left.set(r.id, round2(left.get(r.id) - take));
      rest = round2(rest - take);
      line.takes.push({ pantry_id: r.id, amount: take, title: r.title });
    }
    // Less in the house than this cook needed: the rest waits for a receipt.
    if (short && need && rest > 0.005 && need.packs > 0) noteShort(short, raw, key, scale, data, rest / need.packs, matching[0].item_id);
  }
  return out;
}

/** The score of a row of the very item an ingredient resolved to: above any word match. */
const RESOLVED = 1000;

/**
 * key -> { item, rows } for the ingredient resolver: the household's item of
 * that name (findItem) with its live rows (its own item id, an item merged
 * into it, or a row titled the same canonical name), else the rows whose own
 * key is that name (a row without an item). Null when neither exists, so
 * the resolver tries its next candidate.
 */
function pantryFinder(data, rows) {
  const items = data.items ?? {};
  const findItemOf = itemFinder(data);
  const byKey = new Map();
  for (const r of rows) {
    const k = canonicalName(rowKey(r, items)).key;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  return (key) => {
    const item = findItemOf(key);
    if (item) {
      const own = canonicalName(item.name_key ?? nameKey(item.name)).key;
      const mine = rows.filter((r) => r.item_id === item.id || aliasTarget(items, items[r.item_id])?.id === item.id
        || canonicalName(rowKey(r, items)).key === own);
      return { item, rows: new Set(mine) };
    }
    const loose = byKey.get(canonicalName(key).key);
    return loose ? { item: null, rows: new Set(loose) } : null;
  };
}

// ------------------------------------------ cooking before the receipt
//
// Thomas, 28-10-2026: he shops, cooks the same evening, and the receipt comes
// the next morning. What a cook needed but the pantry did not have (nothing,
// or too little) is a pending take, in the ingredient's own terms (the scaled
// qty and unit), tied to the cook and the item. A receipt purchase that
// matches it, bought from MATCH_DAYS before to PENDING_DAYS after the cook,
// takes it off the row it makes: that row is what was bought minus what was
// cooked (applyPending, called by the op engine's stockFromPurchase).

/** A purchase bought at most this many days after the cook still pays a pending take. */
export const PENDING_DAYS = 3;
/** Pending takes per cook, at most (pantry.pend validates it). */
export const PENDING_MAX = 40;

// Water from the tap is never bought: no pending take for it.
const TAP_WATER = /^(kraan|heet|kokend|kook|lauw|ijskoud )?water$/;

/** The event a pending take becomes when a purchase pays it. */
export const pendingEventId = (pendingId) => `pt-${pendingId}`.slice(0, 64);

function noteShort(short, raw, key, scale, data, fraction, itemId) {
  if (TAP_WATER.test(key) || portionCategory(key)?.ignore) return;
  const base = withDefaultPortion(raw, key);
  if (!base || base.unit === "pinch") return;
  const ing = scale(base);
  if (!(ing.qty > 0)) return;
  const qty = Math.round(ing.qty * Math.min(1, fraction) * 1000) / 1000;
  if (!(qty > 0)) return;
  const item = itemId ? null : Object.values(data.items ?? {}).find((i) => i && !i.deleted_at && i.name_key === key);
  short.push({
    name: String(raw.name).slice(0, 120), name_key: key, item_id: itemId ?? item?.id ?? null,
    qty, unit: ing.unit ?? null, default_portion: Boolean(base.default_portion),
  });
}

/**
 * What a cook of `recipe` on `today` needed but the pantry did not have:
 * [{ name, name_key, item_id, qty, unit, default_portion }], the same walk
 * as cookTakes (cookPlan). Empty when this recipe was already taken off or
 * left pending on that day (cook mode's end and "gegeten" are one meal).
 */
export function cookPending({ recipe, data, today, scale = (i) => i }) {
  const done = Object.values(data?.pantry_events ?? {}).some((e) => e && !e.deleted_at && e.reason === "cooked"
    && e.recipe_id === recipe.id && e.happened_on === today)
    || Object.values(data?.pending_takes ?? {}).some((p) => p && !p.deleted_at && p.recipe_id === recipe.id && p.cooked_on === today);
  if (done) return [];
  const short = [];
  cookPlan({ recipe, data, today, scale, short });
  return short.slice(0, PENDING_MAX);
}

/** Does a pending take wait for this purchase's row: open, in the window, the same thing? */
export function pendingFits(p, row, items = {}) {
  if (!p || p.deleted_at || p.status !== "pending" || !row?.added_on) return false;
  const d = daysBetween(p.cooked_on, row.added_on);
  if (d < -MATCH_DAYS || d > PENDING_DAYS) return false;
  if (p.item_id && p.item_id === row.item_id) return true;
  return stuffScore(p.name_key, rowKey(row, items)) > 0;
}

/**
 * Packs of `row` that a pending take needs, against the row's own pack size
 * only (the phone and the worker must agree, and the worker holds no more
 * than the row): { packs, estimate } or null when unsure.
 */
export function pendingNeed(p, row) {
  const ing = { name: p.name, qty: p.qty, unit: p.unit ?? null, qty_max: null, ...(p.default_portion ? { default_portion: true } : {}) };
  return needOf(ing, row, { data: {}, key: p.name_key });
}

/**
 * What cooking `recipe` for `servings` takes out of the pantry:
 * [{ pantry_id, amount, title, ingredient, estimate }]. The recipe's amounts
 * are scaled; each ingredient takes from the matching rows that run out
 * first (cookPlan). Never more than a row holds. estimate: a default from
 * default-portions.js decided it ("(schatting)" in the toast). Empty when
 * this recipe was already taken off today (cook mode's end and "gegeten"
 * are one meal).
 *
 * data: { pantry, items, pantry_events, products, preferences, purchases };
 * scale: a function (ingredient) -> scaled ingredient (the screen's
 * scaleIngredient for the servings cooked).
 */
export function cookTakes({ recipe, data: stored, today, scale = (i) => i }) {
  const data = withUsage(stored, today);
  const already = Object.values(data.pantry_events ?? {}).some((e) => !e.deleted_at && e.reason === "cooked"
    && e.recipe_id === recipe.id && e.happened_on === today);
  if (already) return [];
  const takes = new Map();
  for (const line of cookPlan({ recipe, data, today, scale })) {
    for (const t of line.takes) {
      const prev = takes.get(t.pantry_id);
      takes.set(t.pantry_id, {
        pantry_id: t.pantry_id, amount: round2((prev?.amount ?? 0) + t.amount), title: t.title,
        ingredient: prev?.ingredient ?? line.name, estimate: Boolean(prev?.estimate || line.estimate),
      });
    }
  }
  return [...takes.values()];
}

/**
 * The "Op de lijst" sheet's pantry view: Map ingredient index -> { on, have,
 * kind }. kind "enough": the pantry has what this cook needs (on false,
 * pre-unticked); "partial": less than needed (on true, stays ticked); "have":
 * in the house but the amount needed is unsure (on null: the sheet's own
 * default). Ingredients with nothing in the house are absent. Same matching
 * and amounts as cookTakes, on the live amounts (withUsage).
 */
export function listCover({ recipe, data, today, scale = (i) => i }) {
  const out = new Map();
  for (const line of cookPlan({ recipe, data, today, scale })) {
    if (!(line.have > 0)) continue;
    if (line.need === null) out.set(line.index, { on: null, have: line.have, kind: "have" });
    else if (line.have >= line.need - 0.005) out.set(line.index, { on: false, have: line.have, kind: "enough" });
    else out.set(line.index, { on: true, have: line.have, kind: "partial" });
  }
  return out;
}

/**
 * Pantry rows that must be used up soon, for the wizard: [{ key, title,
 * days }] with days until the use-by date (0 today, negative past).
 */
export function useUpSoon(pantry, today, items = {}, days = DUE_DAYS + 1) {
  return liveRows(withUsage({ pantry, items }, today).pantry).filter((r) => r.use_by && daysLeft(r, today) <= days)
    .map((r) => ({ key: rowKey(r, items), title: r.title, days: daysLeft(r, today) }))
    .sort((a, b) => a.days - b.days);
}

/** The longest "waarschuw onder" text an item keeps. */
export const LOW_AT_MAX = 20;

/**
 * A per-item "Bijna op" threshold as typed (items.low_at): "300 g", "1,5 kg",
 * "2 st", or a bare number of packs ("0,5"; "½ pak" too). Returns
 * { packs } or { qty, base } (base "g", "ml" or "piece"), or null when it is
 * not a positive amount it can compare.
 */
export function parseLowAt(text) {
  const raw = String(text ?? "").trim();
  if (!raw || raw.length > LOW_AT_MAX || raw.startsWith("-")) return null;
  const p = parseIngredient(raw);
  if (p.qty === null || !(p.qty > 0) || p.qty_max !== null) return null;
  if (!p.name && (p.unit === null || p.unit === "pack")) return p.qty <= 100 ? { packs: round2(p.qty) } : null;
  const size = packSize(raw);
  if (!size || size.qty > 100000) return null;
  return size;
}

// ------------------------------------------------ used at a steady rate
//
// Thomas, 28-10-2026: some things go at a steady rate, not by recipes (the
// cat's pouches, 6 a week; a fountain filter a month; toothpaste). The pantry
// counts them down by itself, so he knows what is left. Nothing is written
// day by day: what is left is computed when it is read, from the stored
// amount, the day it was true (amount_on, else added_on) and the rate.
//   - the rate is the item's use_per_day (packs or pieces a day, set by a
//     person or Claude through item.rate; 0 is "no countdown"), else the
//     household-goods table (usage-rates.js, source "rule"; never food)
//   - several rows of one item drain oldest first (added_on), one at a time
//   - a correction, an "op" or cooking settles the item's rows on that day
//     (public/shared/ops.js), so the countdown starts again from what is true

/** "Bijna op" for a counted-down thing: less than this many days of supply left. */
export const RATE_WARN_DAYS = 7;
/** The most an item.rate may say: 50 packs or pieces a day. */
export const RATE_MAX = 50;
/** The least: one in ten years. Below that it is no countdown. */
export const RATE_MIN = 1 / 3650;
export const RATE_SOURCES = ["claude", "person"];
/**
 * Higher wins: Claude's rate never replaces a person's, nor one the pantry
 * learned (public/shared/rate-learning.js, source "learned"); a person's
 * replaces either and restarts the learning.
 */
export const RATE_RANK = { claude: 1, learned: 2, person: 2 };

/**
 * The rate of a row: { per_day, source } with per_day in the row's own amount
 * units, or null when it is not counted down. The item's own rate first (0:
 * never, also no rule), else the table by the item's name and the row's title.
 */
export function rowRate(row, item) {
  if (!row) return null;
  const own = item?.use_per_day;
  if (own !== null && own !== undefined) {
    const n = Number(own);
    return n >= RATE_MIN && n <= RATE_MAX ? { per_day: n, source: item.rate_source ?? "person" } : null;
  }
  const names = [item?.name, row.title].filter(Boolean);
  if (names.some((n) => isExcluded(n))) return null;
  const rule = ruleRate(names, row.pack_size);
  return rule ? { per_day: rule, source: "rule" } : null;
}

const DAY_MS = 86_400_000;
const dayNumber = (day) => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
const dayText = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const anchorOf = (row) => row.amount_on || row.added_on;
// A countdown that ends within this much of a day ends on that day (6/7 a day is no exact float).
const EPSILON = 1e-6;

/**
 * What is left of one item's rows on `today`, counted down at their rates,
 * oldest row first. rows: the item's live rows. Returns Map id -> null (not
 * counted down) or { amount, per_day, source, days_left, empty_on }:
 * amount what is left (never below 0), days_left until this row is empty
 * (counting the older rows that go first), empty_on the day it ran out.
 * A row whose amount was set after `today` is taken as it is.
 */
export function drainRows(rows, item, today) {
  const end = dayNumber(today);
  const out = new Map();
  const rated = [];
  for (const r of rows) {
    const rate = live(r) && r.added_on ? rowRate(r, item) : null;
    if (!rate) {
      out.set(r.id, null);
      continue;
    }
    rated.push({ r, rate, at: Math.min(dayNumber(anchorOf(r)), end), left: Math.max(0, Number(r.amount) || 0), empty: null });
  }
  if (!rated.length) return out;
  const age = (a, b) => a.r.added_on.localeCompare(b.r.added_on) || a.r.id.localeCompare(b.r.id);
  const present = [];
  let now = Math.min(...rated.map((x) => x.at));
  // Use from the oldest row in the house until `until`; nothing in the house uses nothing.
  const run = (until) => {
    while (now < until) {
      const front = present.find((x) => x.left > 0);
      if (!front) {
        now = until;
        break;
      }
      const lasts = front.left / front.rate.per_day;
      if (now + lasts <= until + EPSILON) {
        now += lasts;
        front.left = 0;
        front.empty = now;
      } else {
        front.left -= front.rate.per_day * (until - now);
        now = until;
      }
    }
  };
  for (const x of [...rated].sort((a, b) => a.at - b.at || age(a, b))) {
    run(x.at);
    present.push(x);
    present.sort(age);
  }
  run(end);
  let ahead = 0;
  for (const x of present) {
    const amount = x.left < 0.005 ? 0 : round2(x.left);
    if (amount > 0) ahead += x.left / x.rate.per_day;
    out.set(x.r.id, {
      amount, per_day: x.rate.per_day, source: x.rate.source,
      days_left: amount > 0 ? ahead : 0,
      empty_on: amount > 0 ? null : dayText(Math.ceil((x.empty ?? end) - EPSILON)),
    });
  }
  return out;
}

/** What is left of one row on `today` (it alone, as if no other row of the item were there). */
export function currentAmount(row, item, today) {
  return drainRows([row], item, today).get(row.id)?.amount ?? row.amount;
}

/** The event id that says a counted-down row ran out. */
export const rateEventId = (rowId) => `ru-${rowId}`.slice(0, 64);

const USAGE = Symbol("usage");

/**
 * The view with every counted-down row at what is left `today`: amount is the
 * current amount, amount_on today, plus stored_amount, per_day, rate_source,
 * days_left and empty_on. A row that ran out keeps amount 0 (liveRows skips
 * it) and gets a "used" event on the day it ran out (rateEventId), so "Bijna
 * op", "aanbevolen" and "Weer nodig" read it as "op". Everything that reads
 * amounts goes through this; it is safe to call twice (a view it made is
 * returned as it is for the same day). Pure: the view is not changed. Not
 * cached: the op engine changes state in place, so a cache would go stale.
 */
export function withUsage(view, today) {
  if (!view?.pantry || view[USAGE] === today) return view;
  const byItem = new Map();
  const keyOf = new Map();
  for (const [key, r] of Object.entries(view.pantry)) {
    if (!live(r)) continue;
    keyOf.set(r, key);
    if (!byItem.has(r.item_id)) byItem.set(r.item_id, []);
    byItem.get(r.item_id).push(r);
  }
  let pantry = null;
  let events = null;
  for (const [itemId, rows] of byItem) {
    const item = view.items?.[itemId];
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const [rowId, cur] of drainRows(rows, item, today)) {
      if (!cur) continue;
      const r = byId.get(rowId);
      pantry ??= { ...view.pantry };
      pantry[keyOf.get(r)] = { ...r, amount: cur.amount, amount_on: today, stored_amount: r.amount, per_day: cur.per_day,
        rate_source: cur.source, days_left: cur.days_left, empty_on: cur.empty_on };
      if (cur.amount > 0) continue;
      const eid = rateEventId(rowId);
      if (view.pantry_events?.[eid]) continue;
      events ??= { ...(view.pantry_events ?? {}) };
      events[eid] = { id: eid, pantry_id: rowId, item_id: r.item_id, product_id: r.product_id ?? null, reason: "used",
        amount: r.amount, recipe_id: null, happened_on: cur.empty_on, member_id: null,
        created_at: `${cur.empty_on}T00:00:00.000Z`, deleted_at: null, rate: true };
    }
  }
  return pantry ? { ...view, pantry, pantry_events: events ?? view.pantry_events ?? {}, [USAGE]: today } : view;
}

/** Days of supply left of a set of (withUsage) rows: the longest, or null when none is counted down. */
export function supplyDays(rows) {
  const rated = rows.filter((r) => r.per_day > 0);
  return rated.length ? Math.max(0, ...rated.map((r) => r.days_left ?? 0)) : null;
}

/** The pantry row a ticked list line makes: one per line, whoever ticks it. */
export const entryPantryId = (entryId) => `pe-${entryId}`.slice(0, 64);
/** The pantry row a receipt purchase makes when no tick came first. */
export const purchasePantryId = (purchaseId) => `pp-${purchaseId}`.slice(0, 64);
