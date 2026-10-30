// "Need it again": per item, how often it is usually bought and when it is
// due, from the purchase history (receipts and the old To Do lists).
//
// The usual interval is the median gap between purchase days, and only once
// an item was bought on at least 3 different days (2 gaps). A median, so one
// month away or one panic buy does not move it much. Excluded things never show,
// whatever the history says (public/shared/excluded.js).
//
// Used by the groceries "Again" tab and by the MCP server.
import { isExcluded } from "./excluded.js";
import { canonicalName, isGeneric } from "./item-names.js";
// pantry.js imports daysBetween from here; the cycle is safe because neither
// file calls the other while it loads.
import { inStock, withUsage } from "./pantry.js";
import { recipeIngredientKeys, isHidden } from "./again-scope.js";

export const MIN_PURCHASES = 3;
// Something bought every five months is not a regular; and an item that
// missed two whole rounds (plus two weeks) is no longer bought, not overdue.
// Without these the old 2019-2024 list filled the tab with "1190 days ago,
// usually every ~447 days".
export const MAX_INTERVAL = 120;
const isStale = (since, interval) => since > 2 * interval + 14;
const DAY = 86_400_000;

/** Whole days from YYYY-MM-DD `a` to `b`. */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
}

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** { days: [sorted unique YYYY-MM-DD], interval, last } for one item's purchases. */
export function intervalOf(dates) {
  const days = [...new Set(dates.filter(Boolean))].sort();
  const gaps = [];
  for (let i = 1; i < days.length; i++) gaps.push(daysBetween(days[i - 1], days[i]));
  return {
    days,
    interval: days.length >= MIN_PURCHASES ? median(gaps) : null,
    last: days.at(-1) ?? null,
  };
}

/**
 * Items with a usual interval, due ones first.
 * state: the household view (items, purchases, entries). today: YYYY-MM-DD.
 * Returns [{ item, name (canonical, for display), interval, last, since, due, ratio, on_list, in_pantry, hidden }].
 * Something still in the pantry (phase 4) is never due: it is in the house.
 * `hidden` (public/shared/again-scope.js): a recipe ingredient that is no
 * cooking basic, or an item someone hid (items.again). Every item is returned;
 * the deals ("aanbevolen") use them all, while the tab and the MCP tool show
 * only `visibleDue` (or { visibleOnly: true }).
 */
export function dueItems(state, today, { visibleOnly = false } = {}) {
  const ingredientKeys = recipeIngredientKeys(state.recipes);
  // What is left today: a counted-down row that ran out is not in the house.
  const pantry = withUsage(state, today).pantry;
  // Purchases and open list lines are grouped by the canonical product, so
  // "Ei" and "Eieren" count together and a line "Eieren" puts "Ei" on the list.
  const groups = new Map();
  const group = (key) => {
    if (!groups.has(key)) groups.set(key, { dates: [], items: new Map() });
    return groups.get(key);
  };
  for (const p of Object.values(state.purchases ?? {})) {
    if (p.deleted_at || !p.item_id || isExcluded(p.title) || isGeneric(p.title)) continue;
    const g = group(canonicalName(p.title).key);
    g.dates.push(p.bought_on);
    g.items.set(p.item_id, (g.items.get(p.item_id) ?? 0) + 1);
  }
  const open = new Set();
  for (const e of Object.values(state.entries ?? {})) {
    if (e.checked_at || e.deleted_at) continue;
    open.add(canonicalName(state.items?.[e.item_id]?.name ?? e.title).key);
  }
  const out = [];
  for (const [key, { dates, items }] of groups) {
    const live = [...items].map(([id, n]) => [state.items?.[id], n]).filter(([it]) => it && !it.deleted_at);
    if (!live.length) continue;
    // The item shown is the one bought most often; the name is the canonical one.
    const item = live.sort((a, b) => b[1] - a[1])[0][0];
    const name = canonicalName(item.name).name;
    if (isExcluded(item.name) || isGeneric(item.name)) continue;
    const { interval, last } = intervalOf(dates);
    if (!interval || interval > MAX_INTERVAL) continue;
    const since = daysBetween(last, today);
    if (isStale(since, interval)) continue;
    const ratio = since / interval;
    // The override of the item shown, else of any other item counted under this product.
    const again = item.again ?? live.map(([it]) => it.again).find(Boolean) ?? null;
    const hidden = isHidden({ again, key, name, ingredientKeys });
    const stocked = inStock(pantry, key, today, interval);
    out.push({ item, name, interval: Math.round(interval), last, since, due: since >= interval && !stocked, ratio, on_list: open.has(key), in_pantry: stocked, hidden, again });
  }
  return out.filter((d) => !visibleOnly || !d.hidden).sort((a, b) => (b.due - a.due) || (b.ratio - a.ratio) || a.name.localeCompare(b.name));
}

/** Today as YYYY-MM-DD in the phone's own time zone. */
export function localToday(now = new Date()) {
  const d = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 10);
}
