// "Bijna op" (28-10-2026): what is running out in the pantry, shown
// above the grocery list with one tap "op de lijst". Pure functions only,
// shared by the list, the Voorraad tab and the MCP server.
//
// His rules:
//   - low when what is left is under a quarter pack (LOW_DEFAULT), or less
//     than a recipe that uses it needs ("te weinig voor <recept>")
//   - per item settable ("rijst: waarschuw onder 300 g", items.low_at), or
//     never (items.low_off); a setting replaces the default rule
//   - also low when it ran out through cooking or "op" (not when the last of
//     it was thrown away: that says buy less, not buy again)
//   - everything in the pantry, never an excluded thing, never what is on the list
//   - a thing counted down at a steady rate (the cat's pouches; withUsage in
//     pantry.js) is low when less than RATE_WARN_DAYS of supply is left, and
//     "op" on the day its countdown reaches zero
// Rows are summed per canonical name (item-names.js): "Ei" and "Eieren" are one.
import { nameKey } from "./ingredients.js";
import { canonicalName } from "./item-names.js";
import { isExcluded } from "./excluded.js";
import { daysBetween } from "./intervals.js";
import { isHidden, recipeIngredientKeys } from "./again-scope.js";
import { liveRows, packSize, packsFor, parseLowAt, rowKey, stuffScore, round2, withUsage, supplyDays, RATE_WARN_DAYS } from "./pantry.js";

/** The default threshold: under a quarter pack is low. */
export const LOW_DEFAULT = 0.25;
/** An item that ran out stays "Bijna op" this many days, then it is history. */
export const EMPTY_DAYS = 7;

const keyOf = (name) => canonicalName(name ?? "").key;
const live = (x) => x && !x.deleted_at;

/**
 * What is left of a set of rows: { packs, qty, base }. qty and base (g, ml,
 * piece) only when every row has a pack size of that kind; base null and
 * qty = packs when no row has a pack size (the amount counts the things).
 */
export function leftOf(rows) {
  const packs = round2(rows.reduce((n, r) => n + r.amount, 0));
  const sizes = rows.map((r) => packSize(r.pack_size));
  if (sizes.every((s) => s === null)) return { packs, qty: packs, base: null };
  if (sizes.some((s) => s === null) || new Set(sizes.map((s) => s.base)).size > 1) return { packs, qty: null, base: null, mixed: true };
  return { packs, qty: round2(rows.reduce((n, r, i) => n + r.amount * sizes[i].qty, 0)), base: sizes[0].base };
}

/**
 * Is `left` under `threshold` (parseLowAt)? true / false, or null when they
 * cannot be compared (grams typed, but no pack size known).
 */
export function underThreshold(left, threshold) {
  if (!threshold) return null;
  if (threshold.packs !== undefined) return left.packs < threshold.packs;
  if (left.base === threshold.base) return left.qty < threshold.qty;
  // Pieces against rows without a pack size: the amount counts the pieces.
  if (threshold.base === "piece" && left.base === null && !left.mixed) return left.packs < threshold.qty;
  return null;
}

/** The live, not excluded items under each canonical key. */
function itemsByKey(items) {
  const out = new Map();
  for (const it of Object.values(items ?? {})) {
    if (!live(it) || isExcluded(it.name)) continue;
    const k = keyOf(it.name);
    if (!k) continue;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(it);
  }
  return out;
}

/** The live pantry rows of one canonical key, and what is left of them. */
export function stockOf(view, key) {
  const rows = liveRows(view.pantry).filter((r) => keyOf(view.items?.[r.item_id]?.name ?? r.title) === key);
  return { rows, left: leftOf(rows) };
}

/**
 * Per canonical key with rows, what each live recipe needs of it in packs:
 * Map key -> Map recipe_id -> { recipe, packs }. An ingredient counts for the
 * most specific matching thing only (as cookTakes takes it), at the recipe's
 * own servings; spoons and splashes count for nothing.
 */
function recipeNeeds(view, groups) {
  const refs = [...groups.values()].filter((g) => g.rows.length).map((g) => {
    // The pack it is weighed against: a row that has a pack size, else any.
    const ref = g.rows.find((r) => packSize(r.pack_size)) ?? g.rows[0];
    return { key: g.key, ref, refKey: rowKey(ref, view.items) };
  });
  const best = new Map();
  const topOf = (ingKey) => {
    if (best.has(ingKey)) return best.get(ingKey);
    const scored = refs.map((r) => [r, stuffScore(ingKey, r.refKey)]).filter(([, s]) => s > 0);
    const top = Math.max(0, ...scored.map(([, s]) => s));
    const out = scored.filter(([, s]) => s === top).map(([r]) => r);
    best.set(ingKey, out);
    return out;
  };
  const needs = new Map();
  for (const recipe of Object.values(view.recipes ?? {})) {
    if (!live(recipe)) continue;
    for (const ing of recipe.ingredients ?? []) {
      if (!ing || ing.heading || ing.optional) continue;
      const k = nameKey(ing.name);
      if (!k || isExcluded(ing.name)) continue;
      for (const r of topOf(k)) {
        const packs = packsFor(ing, r.ref);
        if (packs === null) continue;
        if (!needs.has(r.key)) needs.set(r.key, new Map());
        const per = needs.get(r.key);
        const prev = per.get(recipe.id);
        per.set(recipe.id, { recipe, packs: round2((prev?.packs ?? 0) + packs) });
      }
    }
  }
  return needs;
}

/**
 * The recipe there is too little left for, or null. The recipes cooked with
 * this thing before count first: the most recently cooked one that needs more
 * than is left. Without such a cook, only when no recipe that uses it can be
 * made from what is left (the one needing least is named).
 */
function shortFor(needs, events, left) {
  if (!needs?.size) return null;
  const cooked = new Map();
  for (const e of events) {
    if (e.reason !== "cooked" || !e.recipe_id || !needs.has(e.recipe_id)) continue;
    if ((cooked.get(e.recipe_id) ?? "") < e.happened_on) cooked.set(e.recipe_id, e.happened_on);
  }
  const over = (n) => n.packs > left.packs + 0.005;
  if (cooked.size) {
    const short = [...cooked].map(([id, on]) => [needs.get(id), on]).filter(([n]) => over(n))
      .sort((a, b) => b[1].localeCompare(a[1]) || a[0].recipe.title.localeCompare(b[0].recipe.title));
    return short[0]?.[0] ?? null;
  }
  const all = [...needs.values()];
  if (!all.every(over)) return null;
  return all.sort((a, b) => a.packs - b.packs || a.recipe.title.localeCompare(b.recipe.title))[0];
}

const ORDER = { empty: 0, recipe: 1, below: 2 };

/**
 * What is running low: [{ key, name, item_id, title, code, left, low_at,
 * recipe, need, on, via, pack_size, listed }], sorted empty first, then too
 * little for a recipe, then under the threshold, then by name.
 *   code "empty": none left, it ran out on `on` through `via` (used / cooked)
 *   code "recipe": less than `recipe` ({ id, title }) needs (`need` packs)
 *   code "below": under the threshold (`low_at` as typed, null: LOW_DEFAULT)
 * `left` is leftOf(); `item_id` / `title` are the item to put on the list.
 * `days_left` / `per_day`: days of supply left and the rate, for a thing
 * counted down at a steady rate (else null); such a thing is "below" when
 * under RATE_WARN_DAYS, unless its own threshold says otherwise.
 * Items on the open list are left out unless includeListed (then `listed`).
 */
export function lowStock(stored, today, { includeListed = false } = {}) {
  const view = withUsage(stored, today);
  const items = view.items ?? {};
  const byKey = itemsByKey(items);
  const groups = new Map();
  const groupOf = (name) => {
    if (!name || isExcluded(name)) return null;
    const key = keyOf(name);
    if (!key) return null;
    if (!groups.has(key)) groups.set(key, { key, rows: [], events: [] });
    return groups.get(key);
  };
  for (const r of liveRows(view.pantry)) groupOf(items[r.item_id]?.name ?? r.title)?.rows.push(r);
  for (const e of Object.values(view.pantry_events ?? {})) {
    if (!live(e)) continue;
    groupOf(items[e.item_id]?.name ?? view.pantry?.[e.pantry_id]?.title)?.events.push(e);
  }
  const open = new Set();
  for (const e of Object.values(view.entries ?? {})) {
    if (!live(e) || e.checked_at) continue;
    open.add(keyOf(items[e.item_id]?.name ?? e.title));
  }

  let needs = null;
  let ingredientKeys = null;
  const out = [];
  for (const g of groups.values()) {
    const its = byKey.get(g.key) ?? [];
    if (its.some((i) => i.low_off)) continue;
    const listed = open.has(g.key);
    if (listed && !includeListed) continue;
    // The item to name and to put on the list: the newest row's, else the newest event's.
    const newest = [...g.rows].sort((a, b) => b.added_on.localeCompare(a.added_on))[0];
    const lastEvent = [...g.events].sort((a, b) => b.happened_on.localeCompare(a.happened_on) || String(b.created_at).localeCompare(String(a.created_at)))[0];
    const item = items[newest?.item_id] ?? items[lastEvent?.item_id] ?? its[0] ?? null;
    if (!item || !live(item)) continue;
    const setting = (item.low_at ? item : its.find((i) => i.low_at))?.low_at ?? null;
    const base = {
      key: g.key, name: canonicalName(item.name).name, item_id: item.id, title: item.name, low_at: setting,
      pack_size: newest?.pack_size ?? "", listed, recipe: null, need: null, on: null, via: null,
      days_left: supplyDays(g.rows), per_day: g.rows.find((r) => r.per_day > 0)?.per_day ?? null,
    };

    if (!g.rows.length) {
      // Ran out: only through "op" or cooking, and only lately.
      if (!lastEvent || lastEvent.reason === "thrown") continue;
      // A recipe-only ingredient (hidden from "Weer nodig": avocado, bosui) is
      // bought for the next cook, not kept in stock: its running out is no news
      // (28-10-2026). A setting ("waarschuw onder…") still counts.
      ingredientKeys ??= recipeIngredientKeys(view.recipes);
      if (!setting && !lastEvent.rate && isHidden({ again: item.again ?? null, key: g.key, name: item.name, ingredientKeys })) continue;
      const age = daysBetween(lastEvent.happened_on, today);
      if (age < 0 || age > EMPTY_DAYS) continue;
      out.push({ ...base, code: "empty", left: { packs: 0, qty: 0, base: null }, on: lastEvent.happened_on, via: lastEvent.reason });
      continue;
    }

    const left = leftOf(g.rows);
    const verdict = underThreshold(left, setting ? parseLowAt(setting) : null);
    if (verdict !== null) {
      if (verdict) out.push({ ...base, code: "below", left });
      continue;
    }
    // Counted down at a steady rate: low a week before it runs out. A rate a
    // person or Claude set replaces the recipe and quarter rules; the rough
    // household-goods default (usage-rates.js) only adds to them.
    if (base.days_left !== null) {
      if (base.days_left < RATE_WARN_DAYS) {
        out.push({ ...base, code: "below", left, low_at: null });
        continue;
      }
      if (g.rows.some((r) => r.per_day > 0 && r.rate_source !== "rule")) continue;
    }
    // The default rule (also when a typed weight cannot be compared).
    needs ??= recipeNeeds(view, groups);
    const short = shortFor(needs.get(g.key), g.events, left);
    if (short) out.push({ ...base, code: "recipe", left, recipe: { id: short.recipe.id, title: short.recipe.title }, need: short.packs });
    else if (left.packs < LOW_DEFAULT) out.push({ ...base, code: "below", left, low_at: null });
  }
  return out.sort((a, b) => ORDER[a.code] - ORDER[b.code] || a.name.localeCompare(b.name));
}

/** Map key -> low entry, also for what is on the list: the Voorraad tab's marks. */
export function lowByKey(view, today) {
  return new Map(lowStock(view, today, { includeListed: true }).map((l) => [l.key, l]));
}

/** The canonical key a pantry row is summed under. */
export const stockKey = (row, items = {}) => keyOf(items[row.item_id]?.name ?? row.title);
