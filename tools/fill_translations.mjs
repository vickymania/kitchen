// The one-off fill of the other language (30-10-2026: every item and
// every recipe in both languages). The worker translates new things in the
// calls it already makes; the ~1200 existing items and the book are filled
// once by the coordinator itself, in cheap batches, never through a paid
// worker route. This tool is the file between them:
//
//     node tools/fill_translations.mjs --export [origin]
//         writes migration/export/translations-<day>.json (git-ignored: it
//         holds household data): every live item without an English name
//         (never-suggest items left out) and every recipe without a current
//         translation, each with empty fields to fill in
//     node tools/fill_translations.mjs --import <file> [origin]
//         dry run: checks the filled file and runs its ops through the op
//         engine on a copy of the live data; writes nothing
//     node tools/fill_translations.mjs --import <file> --write <origin>
//         sends them: item.translate and recipe.translate, as Claude's
//         (a person's English name is never replaced)
//
// The file (format "kitchen-translations-1"):
//   { format, made_at, origin,
//     items:   [{ id, name, name_en: null }],             fill name_en
//     recipes: [{ id, lang, to, of, title, ingredients: [lines], steps, notes,
//                 translation: { title: "", ingredients: [], steps: [], notes: "" } }] }  fill translation
// An item or recipe left empty is skipped. `of` is the fingerprint of the
// recipe as exported: a recipe edited after the export gets a stale
// translation (shown as the original until the worker refreshes it).
// Op ids are stable, so sending a file twice is a replay. The token comes
// from mcp/.env (tools/import_ah.mjs readToken) and is never printed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyOp, OpError } from "../public/shared/ops.js";
import { isExcluded } from "../public/shared/excluded.js";
import { needsTranslation, recipeLang, otherLang, recipeFingerprint, ingredientLines } from "../public/shared/bilingual.js";
import { stableId } from "./import_todo.mjs";
import { pushOps, readToken } from "./import_ah.mjs";
import { stateOf } from "./dedupe_items.mjs";

export const FORMAT = "kitchen-translations-1";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** What still needs the other language, as the file to fill in. */
export function exportData(state, { origin = "", now = new Date().toISOString() } = {}) {
  const collator = new Intl.Collator("nl", { sensitivity: "base", numeric: true });
  const items = Object.values(state.items)
    .filter((i) => !i.deleted_at && !i.name_en && !isExcluded(i.name))
    .sort((a, b) => collator.compare(a.name, b.name))
    .map((i) => ({ id: i.id, name: i.name, name_en: null }));
  const recipes = Object.values(state.recipes)
    .filter((r) => !r.deleted_at && needsTranslation(r))
    .sort((a, b) => collator.compare(a.title, b.title))
    .map((r) => ({
      id: r.id, lang: recipeLang(r), to: otherLang(recipeLang(r)), of: recipeFingerprint(r),
      title: r.title, ingredients: ingredientLines(r), steps: r.steps ?? [], notes: r.notes ?? "",
      translation: { title: "", ingredients: [], steps: [], notes: "" },
    }));
  return { format: FORMAT, made_at: now, origin, items, recipes };
}

/** The ops a filled file asks for, and what was skipped or wrong. */
export function opsFromFile(file) {
  if (file?.format !== FORMAT) throw new Error(`not a ${FORMAT} file`);
  const ops = [];
  const notes = [];
  for (const x of file.items ?? []) {
    const name = typeof x.name_en === "string" ? x.name_en.replace(/\s+/g, " ").trim() : "";
    if (!name) continue;
    if (isExcluded(name)) { notes.push(`skipped ${x.name}: never-suggest word`); continue; }
    ops.push({ type: "item.translate", op_id: stableId("op", `fill_translations:item:${x.id}:${name}`), item_id: x.id, name_en: name, source: "claude" });
  }
  for (const r of file.recipes ?? []) {
    const tr = r.translation;
    if (!tr || typeof tr.title !== "string" || !tr.title.trim()) continue;
    const lines = Array.isArray(tr.ingredients) ? tr.ingredients : [];
    if (lines.length !== (r.ingredients ?? []).length) notes.push(`${r.title}: ${lines.length} ingredient lines for ${(r.ingredients ?? []).length}`);
    if ((tr.steps ?? []).length !== (r.steps ?? []).length) notes.push(`${r.title}: ${(tr.steps ?? []).length} steps for ${(r.steps ?? []).length}`);
    ops.push({
      type: "recipe.translate", op_id: stableId("op", `fill_translations:recipe:${r.id}:${r.of}`), id: r.id,
      translation: { lang: r.to, title: tr.title, ingredients: lines, steps: tr.steps ?? [], notes: tr.notes ?? "", of: r.of, by: "claude" },
    });
  }
  return { ops, notes };
}

/** The ops on a copy of the live data: which the engine would refuse. */
export function simulate(state, ops, now = new Date().toISOString()) {
  return ops.map((op) => {
    try {
      return { ok: true, result: applyOp(state, op, { memberId: null, isAdmin: true, now }).result };
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      return { ok: false, error: e.code };
    }
  });
}

async function liveState(origin, token) {
  const res = await fetch(`${origin}/api/sync`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`/api/sync: ${res.status}`);
  return stateOf(await res.json());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const write = args.includes("--write");
  const named = write ? at("--write") : args.find((a) => /^https?:\/\//.test(a));
  if (write && !/^https?:\/\//.test(named ?? "")) throw new Error("--write needs an origin, e.g. https://groceries.vexed.works");
  const origin = (named ?? "https://groceries.vexed.works").replace(/\/$/, "");
  const token = readToken();
  if (args.includes("--export")) {
    const data = exportData(await liveState(origin, token), { origin });
    const dir = path.join(ROOT, "migration", "export");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `translations-${new Date().toLocaleDateString("sv-SE")}.json`);
    fs.writeFileSync(file, `${JSON.stringify(data, null, 1)}\n`);
    console.log(`${data.items.length} items without an English name, ${data.recipes.length} recipes without a current translation -> ${path.relative(ROOT, file)}`);
  } else if (at("--import")) {
    const { ops, notes } = opsFromFile(JSON.parse(fs.readFileSync(at("--import"), "utf8")));
    for (const n of notes) console.log(`  note: ${n}`);
    const outcomes = simulate(await liveState(origin, token), ops);
    const refused = outcomes.map((o, i) => [o, ops[i]]).filter(([o]) => !o.ok);
    const items = ops.filter((o) => o.type === "item.translate").length;
    console.log(`${items} item.translate, ${ops.length - items} recipe.translate against ${origin}.`);
    if (refused.length) {
      for (const [o, op] of refused) console.log(`  REFUSED ${op.item_id ?? op.id}: ${o.error}`);
      console.log(`${refused.length} op(s) would be refused: nothing is sent, also not with --write.`);
      process.exitCode = 1;
    } else if (!write) {
      console.log("Dry run: nothing written. Add --write <origin> to send them.");
    } else {
      const failed = await pushOps(ops, origin, token);
      console.log(`\nSent ${ops.length}; refused ${failed.length}.`);
      if (failed.length) { console.log(JSON.stringify(failed)); process.exitCode = 1; }
    }
  } else {
    console.log("Usage: node tools/fill_translations.mjs --export [origin] | --import <file> [--write <origin>]");
  }
}
