// Turns the Microsoft To Do export (tools/export_todo.mjs) into ops and sends
// them through the same API the apps use, so every recipe passes the same
// checks as one typed on a phone.
//
//     node tools/import_todo.mjs --preview          write migration/export/preview.txt, send nothing
//     node tools/import_todo.mjs --push <origin>    e.g. https://recipes.vexed.works
//
// --push reads the Bearer token from KITCHEN_TOKEN or mcp/.env (tools/admin.mjs
// token). Ids are derived from the To Do ids, so running it twice updates the
// same recipes instead of making copies. Photos come from
// migration/export/photos-small/ (tools/resize_photos.py).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ingredientsFromSteps, parseRecipeText, splitTitle } from "../public/shared/recipe-text.js";
import { isExcluded, isExcludedLookalike } from "../public/shared/excluded.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPORT = path.join(ROOT, "migration", "export");

export const stableId = (prefix, todoId) => `${prefix}-${createHash("sha256").update(todoId).digest("hex").slice(0, 24)}`;

// Hand fixes after reading the preview. Kept small on purpose: the parser
// should get it right, this is for what only a person can see.
const RENAME = { "mais . Cc": "mais" };

function stepsOf(task) {
  // Graph returns checklist items in the order To Do shows them. A step that
  // was wrapped over several lines in the source becomes one line again.
  return (task.checklistItems ?? []).map((c) => c.displayName.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
}

/**
 * Recipes read from photos of cookbook pages (migration/export/photo-recipes.json,
 * keyed by To Do title): 16 "ideas" had only a photo of the page. Each entry
 * holds servings, ingredient lines, steps and nutrition as printed; or
 * skip_photo with the reason when the attached photo shows another recipe.
 */
function photoRecipes() {
  const file = path.join(EXPORT, "photo-recipes.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

/** { recipes: [{ id, recipe, photoFile, todoTitle }], entries: [{ id, title, note }], history: [...] } */
export function buildMigration(data, fromPhotos = photoRecipes()) {
  const recipes = data.lists.recipes.tasks.map((task) => {
    const { title, servings: fromTitle } = splitTitle(task.title);
    const parsed = parseRecipeText(task.body?.content ?? "");
    let steps = stepsOf(task);
    let ingredients = parsed.ingredients;
    if (!ingredients.length) ({ ingredients, steps } = ingredientsFromSteps(steps));
    const recipe = {
      title,
      servings: fromTitle ?? parsed.servings ?? null,
      ingredients: ingredients.map((i) => ({ ...i, name: RENAME[i.name] ?? i.name })),
      steps,
      notes: parsed.notes,
      nutrition: parsed.nutrition,
    };
    const page = fromPhotos[task.title];
    if (page?.ingredients) {
      recipe.servings = page.servings ?? recipe.servings;
      recipe.ingredients = parseRecipeText(page.ingredients.join("\n")).ingredients;
      recipe.steps = page.steps ?? [];
      recipe.nutrition = page.nutrition ?? null;
    }
    const photoFile = page?.skip_photo ? null : task.photos?.[0]?.file ?? null;
    return { id: stableId("todo", task.id), recipe, photoFile, todoTitle: task.title, created: task.createdDateTime };
  });

  const groceries = data.lists.groceries.tasks;
  const entries = groceries
    .filter((t) => t.status !== "completed")
    .map((t) => ({ id: stableId("todo", t.id), title: t.title.trim(), note: (t.body?.content ?? "").trim().slice(0, 500) }));
  // Purchase history for phase 2, without excluded things (public/shared/excluded.js).
  const history = groceries
    .filter((t) => t.status === "completed" && !isExcluded(t.title))
    .map((t) => ({ title: t.title.trim(), completed: t.completedDateTime?.dateTime ?? null }));
  return { recipes, entries, history };
}

/**
 * The old list "Boodschappen" (2019–2024, export-old-list.json) is from a time
 * Thomas does not want to build on: its history is kept only without any
 * excluded thing, look-alikes included.
 */
export function oldHistory(data) {
  return data.lists.groceries.tasks
    .filter((t) => t.status === "completed" && !isExcluded(t.title) && !isExcludedLookalike(t.title))
    .map((t) => ({ title: t.title.trim(), completed: t.completedDateTime?.dateTime ?? null }));
}

function preview(m) {
  const out = [];
  for (const { recipe: r, todoTitle, photoFile } of m.recipes) {
    out.push(`=== ${todoTitle}  ->  "${r.title}"  servings=${r.servings ?? "-"}  photo=${photoFile ? "yes" : "no"}`);
    if (r.nutrition) out.push(`    nutrition ${JSON.stringify(r.nutrition)}`);
    for (const i of r.ingredients) {
      if (i.heading) {
        out.push(`    ## ${i.name}`);
        continue;
      }
      out.push(`    [${i.qty ?? ""}${i.qty_max ? "-" + i.qty_max : ""} ${i.unit ?? ""}] ${i.name}${i.note ? `  (${i.note})` : ""}${i.optional ? "  OPTIONAL" : ""}`);
    }
    if (r.notes) out.push(`    NOTES: ${r.notes.replace(/\n/g, " / ")}`);
    out.push(`    ${r.steps.length} steps${r.steps[0] ? ": " + r.steps[0].slice(0, 70) : ""}`);
  }
  out.push("", `=== Grocery list: ${m.entries.length} open`);
  for (const e of m.entries) out.push(`    ${e.title}${e.note ? "  | " + e.note : ""}`);
  out.push("", `History kept for phase 2: ${m.history.length} completed items`);
  return out.join("\n");
}

function readToken() {
  if (process.env.KITCHEN_TOKEN) return process.env.KITCHEN_TOKEN;
  const env = path.join(ROOT, "mcp", ".env");
  if (fs.existsSync(env)) {
    const m = fs.readFileSync(env, "utf8").match(/^KITCHEN_TOKEN=(\S+)/m);
    if (m) return m[1];
  }
  throw new Error("No token: run `node tools/admin.mjs token` first");
}

async function call(origin, token, pathname, body, type = "application/json") {
  const res = await fetch(origin + pathname, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": type },
    body: type === "application/json" ? JSON.stringify(body) : body,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${pathname}: ${res.status} ${JSON.stringify(out)}`);
  return out;
}

async function push(m, origin, { listOnly = false } = {}) {
  const token = readToken();
  const opId = (key) => stableId("op", key);
  const ops = [];
  let photos = 0;
  for (const { id, recipe, photoFile } of listOnly ? [] : m.recipes) {
    const r = { ...recipe };
    const small = photoFile && path.join(EXPORT, "photos-small", photoFile.replace(/\.\w+$/, ".jpg"));
    if (small && fs.existsSync(small)) {
      r.photo = (await call(origin, token, "/api/photos", fs.readFileSync(small), "image/jpeg")).key;
      photos++;
    }
    ops.push({ op_id: opId(`recipe:${id}:${r.photo ?? ""}`), type: "recipe.put", id, recipe: r });
  }
  for (const e of m.entries) {
    ops.push({ op_id: opId(`entry:${e.id}`), type: "entry.add", id: e.id, item_id: stableId("item", e.id), title: e.title, note: e.note });
  }
  const failed = [];
  for (let i = 0; i < ops.length; i += 50) {
    const { results } = await call(origin, token, "/api/ops", { ops: ops.slice(i, i + 50) });
    failed.push(...results.filter((r) => !r.ok));
  }
  console.log(`Sent ${listOnly ? 0 : m.recipes.length} recipes (${photos} photos) and ${m.entries.length} list items.`);
  if (failed.length) {
    console.log(`Refused: ${JSON.stringify(failed)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const data = JSON.parse(fs.readFileSync(path.join(EXPORT, "export.json"), "utf8"));
  const m = buildMigration(data);
  fs.writeFileSync(path.join(EXPORT, "history.json"), JSON.stringify(m.history, null, 1));
  const old = path.join(EXPORT, "export-old-list.json");
  if (fs.existsSync(old)) {
    const kept = oldHistory(JSON.parse(fs.readFileSync(old, "utf8")));
    fs.writeFileSync(path.join(EXPORT, "history-2019-2024.json"), JSON.stringify(kept, null, 1));
  }
  if (process.argv.includes("--preview")) {
    fs.writeFileSync(path.join(EXPORT, "preview.txt"), preview(m));
    console.log(`Preview: ${path.relative(ROOT, path.join(EXPORT, "preview.txt"))}`);
  }
  const at = process.argv.indexOf("--push");
  if (at > 0) await push(m, process.argv[at + 1].replace(/\/$/, ""), { listOnly: process.argv.includes("--list-only") });
}
