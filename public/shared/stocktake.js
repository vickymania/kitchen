// The stocktake walk, "Nalopen" on the Voorraad tab (20-11-2026: "ik
// denk dat mn hele voorraad inmiddels uit balans is"). Most pantry rows began
// as guesses when the pantry was set up (photos, estimates) and nothing ever
// confirmed them. The walk shows one thing at a time and one tap answers:
// "Klopt", "Minder" (a lower amount), "Meer" (one pack more) or "Op".
// public/app/pantry.js draws it; the answers are ops (pantry.check, pantry.use
// in public/shared/ops.js). Pure functions, no clock: the caller passes today.
import { liveRows, packSize, householdPack, displayAmount, round2 } from "./pantry.js";
import { isExcluded } from "./excluded.js";
import { daysBetween } from "./intervals.js";

/** A thing checked (or bought) within this many days is not asked again. */
export const CHECK_DAYS = 60;
/** "Minder" offers at most this many amounts. */
export const LESS_MAX = 8;

/**
 * The day a row's amount was last known to be true, or null: the walk's
 * checked_on, or the day a tick or a receipt put it in (a real shopping).
 * A row put in by hand (pantry.add: the setup's photos and guesses) only
 * counts once it was checked.
 */
export function trustedOn(row) {
  const bought = row.source_entry_id || row.source_purchase_id ? row.added_on : null;
  const checked = row.checked_on ?? null;
  if (!bought) return checked;
  if (!checked) return bought;
  return checked > bought ? checked : bought;
}

/** Does this row want a look? Never trusted, or not within CHECK_DAYS. */
export function rowNeedsCheck(row, today) {
  const on = trustedOn(row);
  return !on || daysBetween(on, today) > CHECK_DAYS;
}

/** The order the walk asks things in: lower first. */
export const TIERS = { setup: 0, no_size: 1, rest: 2, own_rate: 3 };

/**
 * The walk's tier of one item's rows:
 *   own_rate  counted down at a learned or a household-set rate: last
 *   setup     a row put in by hand that was never checked (the setup's guesses)
 *   no_size   a row without a pack size the household knows (householdPack)
 *   rest      everything else
 */
export function tierOf(rows, item, data) {
  const own = Number(item?.use_per_day) > 0 && (item.rate_source === "learned" || item.rate_source === "person");
  if (own) return TIERS.own_rate;
  if (rows.some((r) => !r.source_entry_id && !r.source_purchase_id && !r.checked_on)) return TIERS.setup;
  if (rows.some((r) => !packSize(r.pack_size) && !householdPack(data, r))) return TIERS.no_size;
  return TIERS.rest;
}

/**
 * Every thing in the house as the walk sees it, one per item: { item_id,
 * name, rows (oldest first), amount (the total), due (wants a look), tier }.
 * view: the view at today's amounts (withUsage). Never an excluded thing; an
 * item private to someone else never (memberId: who walks).
 */
export function walkGroups(view, today, { memberId = null } = {}) {
  const byItem = new Map();
  for (const r of liveRows(view.pantry)) {
    const item = view.items?.[r.item_id];
    if (item && (isExcluded(item.name) || (item.private_to && item.private_to !== memberId))) continue;
    if (!byItem.has(r.item_id)) byItem.set(r.item_id, []);
    byItem.get(r.item_id).push(r);
  }
  const out = [];
  for (const [itemId, list] of byItem) {
    const item = view.items?.[itemId] ?? null;
    const rows = [...list].sort((a, b) => a.added_on.localeCompare(b.added_on) || a.id.localeCompare(b.id));
    out.push({
      item_id: itemId, name: item?.name ?? rows[0].title, rows,
      amount: round2(rows.reduce((sum, r) => sum + r.amount, 0)),
      due: rows.some((r) => rowNeedsCheck(r, today)),
      tier: tierOf(rows, item, view),
    });
  }
  return out;
}

/**
 * What the walk still asks, in order: the things that want a look, by tier,
 * then by name. `skip`: item ids passed over in this walk (they come back the
 * next time). Resuming is nothing more than this list again: an answered
 * thing is checked today and drops out.
 */
export function walkQueue(groups, skip = new Set()) {
  return groups.filter((g) => g.due && !skip.has(g.item_id))
    .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name, "nl") || a.item_id.localeCompare(b.item_id));
}

/** { done, total }: the things looked at (or bought) recently of all there are. */
export function walkProgress(groups) {
  return { done: groups.filter((g) => !g.due).length, total: groups.length };
}

/**
 * "Minder": the amounts under `amount` (as shown, to the quarter). Up to one
 * pack: ¾ ½ ¼ under it. More: the quarters of the last pack (2¾ 2½ 2¼),
 * then whole packs down to 1, at most LESS_MAX. Never 0: that is "Op".
 */
export function lessChoices(amount) {
  const shown = displayAmount(amount);
  if (!(shown > 0)) return [];
  const out = [];
  const whole = Math.ceil(shown) - 1;
  for (const q of [0.75, 0.5, 0.25]) if (whole + q < shown) out.push(whole + q);
  for (let n = whole; n >= 1 && out.length < LESS_MAX; n--) if (n < shown) out.push(n);
  return out.slice(0, LESS_MAX);
}

/**
 * The op of an answer, or null. answer: "right" (Klopt), "less" with
 * `amount`, "more" (one pack more). "Op" is a pantry.use the screen sends itself.
 */
export function answerOp(group, answer, today, amount = null) {
  const ids = group.rows.map((r) => r.id).slice(0, 40);
  if (answer === "right") return { type: "pantry.check", ids, on: today };
  if (answer === "less" && amount > 0 && amount < group.amount) return { type: "pantry.check", ids, on: today, amount: round2(amount) };
  if (answer === "more") return { type: "pantry.check", ids, on: today, amount: round2(group.amount + 1) };
  return null;
}

/**
 * What the app thinks, in parts: [{ amount, size }] per pack size, rows of
 * one size together ("¾ pak · 1 l" is { amount: 0.75, size: "1 l" }); size ""
 * when the row has none.
 */
export function amountParts(group) {
  const bySize = new Map();
  for (const r of group.rows) {
    const size = packSize(r.pack_size) ? r.pack_size : "";
    bySize.set(size, round2((bySize.get(size) ?? 0) + r.amount));
  }
  return [...bySize].map(([size, amount]) => ({ amount, size }));
}
