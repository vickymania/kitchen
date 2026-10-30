// "Binnenkort nodig" (29-10-2026: "onderaan mijn boodschappenlijst,
// ook in de widget, een gedeelte 'binnenkort nodig:' met per stuk hoeveel
// voorraad ik nog heb, zodat ik weet dat ik die misschien mee kan nemen"),
// shown as "Al nodig?" with a "Nog niet" per row (notYetOp).
// A hint under the list, not part of it. Pure functions only, shared by the
// web list (public/app/pantry.js soonSection) and the widget's route
// (worker/widget.js).
//
// What counts, nothing of its own:
//   - everything "Bijna op" flags (public/shared/low-stock.js lowStock)
//   - plus what is counted down at a steady rate (withUsage in pantry.js) and
//     runs out within NEEDED_SOON_DAYS
//   - never what is on the list (open or in the basket), never an excluded thing, never an item switched
//     off for "Bijna op" (low_off), never a recipe-only ingredient hidden from
//     "Weer nodig" unless it has its own "waarschuw onder" (low_at), never
//     an item put off with "Nog niet" (not_yet_until after today)
// Soonest run-out first.
import { canonicalName } from "./item-names.js";
import { isExcluded } from "./excluded.js";
import { isHidden, recipeIngredientKeys } from "./again-scope.js";
import { liveRows, withUsage, supplyDays, displayAmount, rowRate, round2, packSize, RATE_WARN_DAYS } from "./pantry.js";
import { parseAmount } from "./ingredients.js";
import { lowStock, leftOf, stockKey } from "./low-stock.js";
import { addDays } from "./shelf-life.js";
import { NOT_YET_DAYS } from "./rate-learning.js";

/** A counted-down thing shows once it runs out within this many days. */
export const NEEDED_SOON_DAYS = 14;
/**
 * "Nog niet" (29-10-2026): a counted-down thing gets this many days
 * of use more left; a low thing without a rate stays out of "Al nodig?" this
 * many days. Defined in rate-learning.js, which learns from it too.
 */
export { NOT_YET_DAYS };

const live = (x) => x && !x.deleted_at;

/**
 * What is left, as it is shown: { qty, base }. Grams and millilitres whole,
 * pieces to the quarter, packs as the Voorraad tab shows them (displayAmount).
 * base null: packs (or the things themselves when no pack size is known).
 */
export function leftAmount(left) {
  if (left.base === "g" || left.base === "ml") return { qty: Math.round(left.qty), base: left.base };
  if (left.base === "piece") return { qty: Math.round(left.qty * 4) / 4, base: "piece" };
  return { qty: displayAmount(left.packs), base: null };
}

/** The day a thing is sorted by: ran out first, then days of supply left; a low thing without a rate counts as RATE_WARN_DAYS. */
function sortDays(n) {
  if (n.code === "empty") return -1;
  return n.days_left ?? RATE_WARN_DAYS;
}

/**
 * [{ key, name, item_id, title, code, left, amount, days_left, per_day, on,
 * pack_size }], soonest run-out first, then by name. code is lowStock's
 * ("empty", "recipe", "below") or "soon" (counted down, under
 * NEEDED_SOON_DAYS, not low yet). amount is leftAmount(left); days_left only
 * when there is a rate.
 */
export function neededSoon(stored, today) {
  const view = withUsage(stored, today);
  const items = view.items ?? {};
  const out = new Map();
  const add = (n) => out.set(n.key, { ...n, amount: leftAmount(n.left) });

  for (const l of lowStock(view, today)) {
    if (isExcluded(l.title)) continue;
    add({ key: l.key, name: l.name, item_id: l.item_id, title: l.title, code: l.code, left: l.left,
      days_left: l.days_left ?? null, per_day: l.per_day ?? null, on: l.on, pack_size: l.pack_size });
  }

  // On the list: open, or ticked into the basket (the row's own tick puts it
  // there, and then it is a list line, not a hint). lowStock leaves out only
  // the open ones; the basket ones are left out below.
  const open = new Set();
  for (const e of Object.values(view.entries ?? {})) {
    if (live(e)) open.add(canonicalName(items[e.item_id]?.name ?? e.title).key);
  }

  // Counted down, not low yet, but gone within NEEDED_SOON_DAYS.
  const groups = new Map();
  for (const r of liveRows(view.pantry)) {
    const key = stockKey(r, items);
    if (!key || out.has(key) || open.has(key)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  let ingredientKeys = null;
  for (const [key, rows] of groups) {
    const days = supplyDays(rows);
    if (days === null || days >= NEEDED_SOON_DAYS) continue;
    const newest = [...rows].sort((a, b) => b.added_on.localeCompare(a.added_on))[0];
    const item = items[newest.item_id];
    if (!live(item) || isExcluded(item.name)) continue;
    const siblings = Object.values(items).filter((i) => live(i) && canonicalName(i.name).key === key);
    if (siblings.some((i) => i.low_off)) continue;
    const lowAt = siblings.find((i) => i.low_at)?.low_at ?? null;
    ingredientKeys ??= recipeIngredientKeys(view.recipes);
    if (!lowAt && isHidden({ again: item.again ?? null, key, name: item.name, ingredientKeys })) continue;
    add({ key, name: canonicalName(item.name).name, item_id: item.id, title: item.name, code: "soon", left: leftOf(rows),
      days_left: days, per_day: rows.find((r) => r.per_day > 0)?.per_day ?? null, on: null, pack_size: newest.pack_size ?? "" });
  }

  // "Nog niet" on a thing without a countdown: out of this section (not out of "Bijna op") until that day.
  const snoozed = new Set();
  for (const it of Object.values(items)) {
    if (live(it) && it.not_yet_until && it.not_yet_until > today) snoozed.add(canonicalName(it.name).key);
  }
  return [...out.values()].filter((n) => !snoozed.has(n.key) && !open.has(n.key))
    .sort((a, b) => sortDays(a) - sortDays(b) || a.name.localeCompare(b.name));
}

/**
 * The list line a row's tick makes: { title, amounts }, the item's name and,
 * when its pack size is a weight or volume, that pack ("1 kg"), so the tick
 * fills the pantry with the right pack (as "Op de lijst" in "Bijna op").
 */
export function tickEntry(n) {
  const pack = packSize(n.pack_size);
  const amounts = pack && pack.base !== "piece" ? parseAmount(n.pack_size) : [];
  return { title: n.title, amounts };
}

/**
 * The row's tick box (29-10-2026: one tap puts it in the basket, as
 * if it had been on the list and was ticked): the entry.add and the
 * entry.check of the same new line, sent together. entryId and itemId are
 * new ids (itemId is only used when no item has the name).
 */
export function tickOps(n, entryId, itemId) {
  const { title, amounts } = tickEntry(n);
  return [
    { type: "entry.add", id: entryId, item_id: itemId, title, ...(amounts.length ? { amounts } : {}) },
    { type: "entry.check", id: entryId, checked: true },
  ];
}

/**
 * The op "Nog niet" sends for one neededSoon() entry:
 *   - counted down (a person's, Claude's, a learned or the default rate): a
 *     pantry.update (why "not_yet", add_days NOT_YET_DAYS) of its newest row:
 *     what that row has left when the op is applied plus NOT_YET_DAYS of use; the countdown starts again from
 *     there (pantry.update settles the item's other rows) and the rate learns
 *     that it lasts longer. Every row already gone: a pantry.add of that much.
 *   - otherwise: item.not_yet until NOT_YET_DAYS from today.
 * newId() gives the id of a new pantry row (only the second case uses it).
 */
export function notYetOp(stored, today, entry, newId) {
  const view = withUsage(stored, today);
  const items = view.items ?? {};
  const rows = Object.values(view.pantry ?? {})
    .filter((r) => live(r) && r.per_day > 0 && stockKey(r, items) === entry.key)
    .sort((a, b) => b.added_on.localeCompare(a.added_on) || b.id.localeCompare(a.id));
  if (rows.length) {
    const r = rows[0];
    // why "not_yet": the engine learns from it that this lasts longer (rate-learning.js).
    // add_days, not an amount: the engine adds the days to what is left when
    // it applies the op, so a change made elsewhere since is not overwritten.
    return { type: "pantry.update", id: r.id, add_days: NOT_YET_DAYS, on: today, why: "not_yet" };
  }
  const item = items[entry.item_id];
  const rate = item ? rowRate({ title: item.name, pack_size: entry.pack_size ?? "" }, item) : null;
  if (rate) {
    return { type: "pantry.add", id: newId(), item_id: item.id, title: item.name, amount: Math.max(0.01, round2(NOT_YET_DAYS * rate.per_day)),
      pack_size: entry.pack_size ?? "", on: today };
  }
  return { type: "item.not_yet", item_id: entry.item_id, until: addDays(today, NOT_YET_DAYS) };
}
