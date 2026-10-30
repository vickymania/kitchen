// Which recipe ingredients find no household item (30-10-2026: a
// recipe imported by Claude barely touched the pantry). For every live
// recipe, each ingredient line -> the item the resolver gives it
// (public/shared/ingredient-match.js) or none, what "Op de lijst" would put
// on the list, and whether cooking it now would take something out of the
// pantry (cookPlan). Then every unresolved name across all recipes, most
// used first: the list of aliases or items still missing.
//
//     node tools/audit_recipe_items.mjs [origin]    read /api/sync, write the report, print a summary
//
// Read-only: it never sends an op. The Bearer token comes from mcp/.env
// (readToken of tools/import_ah.mjs) and is never printed. The report holds
// recipe text, so it goes to migration/export/ (git-ignored).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveIngredient, listTargets, itemFinder, ingredientKey } from "../public/shared/ingredient-match.js";
import { cookPlan } from "../public/shared/pantry.js";
import { portionCategory } from "../public/shared/default-portions.js";
import { isExcluded } from "../public/shared/excluded.js";
import { localToday } from "../public/shared/intervals.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPORT_FILE = path.join(ROOT, "migration", "export", "audit-recipe-items.txt");

// Water from the tap is never an item; such a line is not "unresolved".
const TAP = /^(?:kraan|heet|kokend|kook|lauw|ijskoud )?water$/;

/**
 * The audit, pure: { recipes: [{ recipe, lines: [{ index, name, key, item,
 * how, list, pantry, basic }] }], unresolved: [{ key, count, recipes,
 * names }], totals }. item: the resolved item's name or null; list: the
 * titles "Op de lijst" would add (an existing item's name, or "new: <name>");
 * pantry: the rows cooking would take from now, by title ("" when nothing).
 */
export function auditRecipes(data, today) {
  const find = itemFinder(data);
  const recipes = [];
  const missing = new Map();
  const totals = { lines: 0, resolved: 0, unresolved: 0, pantry: 0, skipped: 0 };
  const live = Object.values(data.recipes ?? {}).filter((r) => r && !r.deleted_at)
    .sort((a, b) => String(a.title).localeCompare(String(b.title)));
  for (const recipe of live) {
    const plan = new Map(cookPlan({ recipe, data, today }).map((l) => [l.index, l]));
    const lines = [];
    for (const [index, ing] of (recipe.ingredients ?? []).entries()) {
      if (!ing || ing.heading || !ing.name) continue;
      const key = ingredientKey(ing.name);
      if (!key || isExcluded(ing.name) || TAP.test(key)) {
        totals.skipped++;
        continue;
      }
      totals.lines++;
      const targets = listTargets(ing.name, data, find);
      const list = targets.map((t) => (t.item ? t.item.name : `new: ${t.title}`));
      // "zout en peper": one line per thing, each with its own item, is resolved too.
      const split = targets.length > 1 && targets.every((t) => t.item);
      const hit = resolveIngredient(ing.name, data, find) ?? (split ? { item: { name: list.join(" + ") }, how: "split" } : null);
      const used = plan.get(index);
      const pantry = used ? [...new Set(used.takes.map((t) => t.title))].join(", ") || (used.have > 0 ? "(in the house, amount unsure)" : "") : "";
      const basic = Boolean(portionCategory(key)?.ignore);
      if (hit) totals.resolved++;
      else {
        totals.unresolved++;
        const m = missing.get(key) ?? { key, count: 0, recipes: new Set(), names: new Set(), basic };
        m.count++;
        m.recipes.add(recipe.title);
        m.names.add(ing.name);
        missing.set(key, m);
      }
      if (pantry) totals.pantry++;
      lines.push({ index, name: ing.name, optional: Boolean(ing.optional), key, item: hit?.item.name ?? null, how: hit?.how ?? null, list, pantry, basic });
    }
    recipes.push({ recipe: { id: recipe.id, title: recipe.title }, lines });
  }
  const unresolved = [...missing.values()]
    .map((m) => ({ ...m, recipes: [...m.recipes], names: [...m.names] }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return { recipes, unresolved, totals };
}

/** The report as text. */
export function reportText(audit, { origin = "", today = "" } = {}) {
  const t = audit.totals;
  const out = [
    `Recipe ingredients -> household items${origin ? ` (${origin}` : ""}${today ? `, ${today})` : origin ? ")" : ""}`,
    `${audit.recipes.length} recipes, ${t.lines} ingredient lines: ${t.resolved} find an item, ${t.unresolved} do not; ${t.pantry} would take from the pantry now; ${t.skipped} skipped (tap water, never-suggest).`,
    "",
    "== Unresolved names, most used first (count, recipes) ==",
    ...audit.unresolved.map((m) => `${String(m.count).padStart(3)}  ${m.key}${m.basic ? " [basic]" : ""}  <- ${m.recipes.slice(0, 4).join(" | ")}${m.recipes.length > 4 ? ` +${m.recipes.length - 4}` : ""}`),
    "",
    "== Per recipe: line -> item (how) · list · pantry ==",
  ];
  for (const r of audit.recipes) {
    out.push("", `# ${r.recipe.title}`);
    for (const l of r.lines) {
      const item = l.item ? `${l.item} (${l.how})` : "-- no item";
      out.push(`  ${l.name}${l.optional ? " [optional]" : ""} -> ${item} · list: ${l.list.join(" + ")} · pantry: ${l.pantry || "-"}`);
    }
  }
  return `${out.join("\n")}\n`;
}

/* --------------------------------------------------------------- CLI */

const byId = (rows) => Object.fromEntries((rows ?? []).filter((r) => r && !r.deleted_at).map((r) => [r.id, r]));

async function fetchSync(origin, token) {
  const res = await fetch(`${origin}/api/sync`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`/api/sync: ${res.status}`);
  const all = await res.json();
  // Merged items keep their tombstone: findItem follows it to where the name went.
  const items = Object.fromEntries((all.items ?? []).filter((i) => i && (!i.deleted_at || i.merged_into)).map((i) => [i.id, i]));
  return {
    items, aliases: byId(all.aliases), recipes: byId(all.recipes), pantry: byId(all.pantry), pantry_events: byId(all.pantry_events),
    products: byId(all.products), preferences: byId(all.preferences), purchases: byId(all.purchases),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const named = process.argv.slice(2).find((a) => /^https?:\/\//.test(a));
  const origin = (named ?? "https://groceries.vexed.works").replace(/\/$/, "");
  const { readToken } = await import("./import_ah.mjs");
  const data = await fetchSync(origin, readToken());
  const today = localToday();
  const audit = auditRecipes(data, today);
  const text = reportText(audit, { origin, today });
  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, text);
  const lines = text.split("\n");
  const per = lines.indexOf("== Per recipe: line -> item (how) · list · pantry ==");
  console.log(lines.slice(0, Math.min(per, 40)).join("\n"));
  console.log(`\nWritten: ${REPORT_FILE}`);
}
