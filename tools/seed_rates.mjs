// Starting rates from the purchase history (30-10-2026: "zo min
// mogelijk zelf instellen"). One-off: the pantry learns from there on
// (public/shared/rate-learning.js). Reads the live data, never writes it
// unless --write is given.
//
//     node tools/seed_rates.mjs [origin]                 dry run: print the table
//     node tools/seed_rates.mjs --write <origin>         send the proposals as item.rate (source "claude")
//
// Two kinds of proposal, both from the purchases (AH receipts 2026 and the To
// Do history 2020-2024) of the last WINDOW_DAYS:
//   update  an item that already counts down (its own rate, Claude's or the
//           default table): packs bought / days, when that differs more than
//           CHANGE_MIN from the rate it has. A person's or a learned rate is
//           shown, never written (an estimate never replaces either).
//   new     a steady thing that does not count down yet: bought at least
//           MIN_PURCHASES times, at regular gaps (REGULAR_SHARE of the gaps
//           within a factor 2 of the median gap).
// Never an excluded thing (public/shared/excluded.js), never an item with again = 'hide',
// never low_off, never a recipe-only ingredient (again-scope.js isHidden),
// never a generic line (item-names.js GENERIC).
//
// The rate: the packs of every shopping day but the last (the last one is not
// used up yet) over the days from the first to the last. The token comes from
// mcp/.env (tools/import_ah.mjs readToken) and is never printed.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isExcluded } from "../public/shared/excluded.js";
import { isHidden, recipeIngredientKeys } from "../public/shared/again-scope.js";
import { canonicalName, isGeneric } from "../public/shared/item-names.js";
import { daysBetween, median, localToday } from "../public/shared/intervals.js";
import { rowRate, RATE_MIN, RATE_MAX } from "../public/shared/pantry.js";
import { addDays } from "../public/shared/shelf-life.js";
import { stableId } from "./import_todo.mjs";
import { pushOps, readToken } from "./import_ah.mjs";

/** The history read: this many days back from today. */
export const WINDOW_DAYS = 365;
/** At least this many shopping days in the window. */
export const MIN_PURCHASES = 4;
/** This share of the gaps lies within a factor 2 of the median gap: regular. */
export const REGULAR_SHARE = 0.75;
/** An existing rate is proposed anew only when the history differs more than this. */
export const CHANGE_MIN = 0.2;

const live = (x) => x && !x.deleted_at;

/** { days, packs, median_gap, regular, per_day } for one item's purchases in the window, or null. */
export function historyRate(purchases, today) {
  const from = addDays(today, -WINDOW_DAYS);
  const byDay = new Map();
  for (const p of purchases) {
    if (!live(p) || !p.bought_on || p.bought_on < from || p.bought_on > today) continue;
    byDay.set(p.bought_on, (byDay.get(p.bought_on) ?? 0) + (Number(p.qty) > 0 ? Number(p.qty) : 1));
  }
  const days = [...byDay.keys()].sort();
  if (days.length < 2) return { days: days.length, packs: 0, median_gap: null, regular: false, per_day: null };
  const gaps = days.slice(1).map((d, i) => daysBetween(days[i], d));
  const m = median(gaps);
  const regular = gaps.filter((g) => g >= m / 2 && g <= m * 2).length / gaps.length >= REGULAR_SHARE;
  const packs = days.slice(0, -1).reduce((s, d) => s + byDay.get(d), 0);
  const span = daysBetween(days[0], days.at(-1));
  const perDay = span > 0 ? Math.min(RATE_MAX, Math.max(RATE_MIN, packs / span)) : null;
  return { days: days.length, packs, median_gap: m, regular, per_day: perDay };
}

/**
 * The proposals for the household's data ({ items, recipes, purchases,
 * pantry } as id maps): [{ item, action: "update" | "new" | "keep", current,
 * history, proposed }] sorted by action then name. "keep": counted down by a
 * person or learned, shown only.
 */
export function proposeRates(data, today) {
  const ingredientKeys = recipeIngredientKeys(data.recipes);
  const byItem = new Map();
  for (const p of Object.values(data.purchases ?? {})) {
    if (!live(p) || !p.item_id) continue;
    if (!byItem.has(p.item_id)) byItem.set(p.item_id, []);
    byItem.get(p.item_id).push(p);
  }
  const packOf = new Map();
  for (const r of Object.values(data.pantry ?? {})) if (live(r) && r.pack_size) packOf.set(r.item_id, r.pack_size);
  const out = [];
  for (const item of Object.values(data.items ?? {})) {
    if (!live(item) || isExcluded(item.name) || isGeneric(item.name) || item.again === "hide" || item.low_off) continue;
    if (Number(item.use_per_day) === 0 && item.use_per_day !== null && item.use_per_day !== undefined) continue;   // "niet aftellen"
    const key = canonicalName(item.name).key;
    if (isHidden({ again: item.again ?? null, key, name: item.name, ingredientKeys })) continue;
    const history = historyRate(byItem.get(item.id) ?? [], today);
    if (!history.per_day || history.days < MIN_PURCHASES) continue;
    const current = rowRate({ title: item.name, pack_size: packOf.get(item.id) ?? "" }, item);
    if (current) {
      if (Math.abs(history.per_day - current.per_day) / current.per_day <= CHANGE_MIN) continue;
      const own = current.source === "person" || current.source === "learned";
      out.push({ item, action: own ? "keep" : "update", current, history, proposed: history.per_day });
    } else if (history.regular) {
      out.push({ item, action: "new", current: null, history, proposed: history.per_day });
    }
  }
  const order = { update: 0, new: 1, keep: 2 };
  return out.sort((a, b) => order[a.action] - order[b.action] || a.item.name.localeCompare(b.item.name));
}

/** The item.rate ops for the written proposals: Claude's estimate, so a person's value or a learned one stays. */
export function seedOps(proposals, today) {
  return proposals.filter((p) => p.action !== "keep").map((p) => ({
    op_id: stableId("op", `seed-rates:${p.item.id}:${p.proposed.toFixed(6)}`),
    type: "item.rate", item_id: p.item.id, use_per_day: p.proposed, source: "claude", on: today,
  }));
}

/** "1 per 9 d", "6 / wk": a rate short for the table. */
export function rateShort(perDay) {
  if (!(perDay > 0)) return "-";
  return perDay >= 1 / 7 ? `${Math.round(perDay * 7 * 10) / 10} / wk` : `1 per ${Math.round(1 / perDay)} d`;
}

export function tableText(proposals) {
  const pad = (s, n) => String(s).slice(0, n).padEnd(n);
  const lines = [`${pad("action", 7)} ${pad("item", 28)} ${pad("now", 24)} ${pad("history", 22)} proposed`];
  for (const p of proposals) {
    const now = p.current ? `${rateShort(p.current.per_day)} (${p.current.source})` : "-";
    const hist = `${p.history.days}x, gap ~${Math.round(p.history.median_gap)} d${p.history.regular ? "" : " irr."}`;
    lines.push(`${pad(p.action, 7)} ${pad(p.item.name, 28)} ${pad(now, 24)} ${pad(hist, 22)} ${rateShort(p.proposed)}`);
  }
  const count = (a) => proposals.filter((p) => p.action === a).length;
  lines.push("", `update ${count("update")} · new ${count("new")} · keep (a person's or learned rate, not written) ${count("keep")}`);
  return lines.join("\n");
}

/* --------------------------------------------------------------- CLI */

const byId = (rows) => Object.fromEntries((rows ?? []).filter(live).map((r) => [r.id, r]));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const write = args.indexOf("--write");
  const named = write >= 0 ? args[write + 1] : args.find((a) => /^https?:\/\//.test(a));
  if (write >= 0 && !/^https?:\/\//.test(named ?? "")) throw new Error("--write needs an origin, e.g. https://groceries.vexed.works");
  const origin = (named ?? "https://groceries.vexed.works").replace(/\/$/, "");
  const token = readToken();
  const res = await fetch(`${origin}/api/sync`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`/api/sync: ${res.status}`);
  const all = await res.json();
  const data = { items: byId(all.items), recipes: byId(all.recipes), purchases: byId(all.purchases), pantry: byId(all.pantry) };
  const today = localToday();
  const proposals = proposeRates(data, today);
  console.log(tableText(proposals));
  if (write < 0) {
    console.log("\nDry run: nothing written. Add --write <origin> to send the update and new rows as Claude's estimates.");
  } else {
    const ops = seedOps(proposals, today);
    console.log(`\nSending ${ops.length} item.rate ops to ${origin}...`);
    const failed = await pushOps(ops, origin, token);
    console.log(`\nSent ${ops.length}; refused ${failed.length}.`);
    if (failed.length) { console.log(JSON.stringify(failed.slice(0, 20))); process.exitCode = 1; }
  }
}
