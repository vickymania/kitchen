// Seeds the purchase history ("need it again") from the Microsoft To Do
// export: every completed grocery line becomes a purchase with source
// "history", sent through /api/ops like any phone's change.
//
//     node tools/import_history.mjs --preview          print what would be sent, send nothing
//     node tools/import_history.mjs --push <origin>    e.g. https://groceries.vexed.works
//
// Reads (never writes) migration/export/history.json (2025 onward) and
// migration/export/history-2019-2024.json, made by tools/import_todo.mjs. They
// are personal data and stay out of git. --push takes the Bearer token from
// KITCHEN_TOKEN or mcp/.env, like tools/import_todo.mjs. Ids come from the
// line itself, so a second run sends the same ops and changes nothing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseListInput, nameKey } from "../public/shared/ingredients.js";
import { isExcluded, isExcludedLookalike } from "../public/shared/excluded.js";
import { intervalOf } from "../public/shared/intervals.js";
import { canonicalName, isGeneric } from "../public/shared/item-names.js";
import { stableId } from "./import_todo.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPORT = path.join(ROOT, "migration", "export");
// The export lives in the main kitchen folder; a git worktree has no copy.
const MAIN_EXPORT = "C:\\path\\to\\the\\workspace\\VEXED.WORKS\\kitchen\\migration\\export";
export const FILES = ["history.json", "history-2019-2024.json"];

function exportDir() {
  if (process.env.KITCHEN_EXPORT) return process.env.KITCHEN_EXPORT;
  return fs.existsSync(path.join(EXPORT, FILES[0])) ? EXPORT : MAIN_EXPORT;
}

/**
 * [{ title, completed }] per file -> purchase.add ops. Lines without a date,
 * without a name or naming an excluded thing (or a look-alike of one) are left out.
 */
export function buildPurchases(files) {
  const ops = [];
  const seen = new Map();
  const skipped = { excluded: 0, empty: 0 };
  for (const [file, rows] of files) {
    for (const row of rows) {
      const day = String(row?.completed ?? "").slice(0, 10);
      const { title } = parseListInput(String(row?.title ?? ""));
      if (!nameKey(title) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        skipped.empty++;
        continue;
      }
      if (isExcluded(title) || isExcludedLookalike(row.title)) {
        skipped.excluded++;
        continue;
      }
      // The same line twice on one day is two purchases with their own id.
      const base = `${file}:${nameKey(title)}:${day}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      ops.push({
        op_id: stableId("op", `history:${base}:${n}`),
        type: "purchase.add",
        id: stableId("purchase", `${base}:${n}`),
        item_id: stableId("item", `history:${nameKey(title)}`),
        title,
        bought_on: day,
        source: "history",
      });
    }
  }
  return { ops, skipped };
}

function readFiles(dir) {
  return FILES.filter((f) => fs.existsSync(path.join(dir, f)))
    .map((f) => [f, JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))]);
}

function preview({ ops, skipped }) {
  const byTitle = new Map();
  for (const op of ops) {
    if (isGeneric(op.title)) continue;
    const { key, name } = canonicalName(op.title);
    if (!byTitle.has(key)) byTitle.set(key, { title: name, days: [] });
    byTitle.get(key).days.push(op.bought_on);
  }
  const regular = [...byTitle.values()]
    .map((x) => ({ ...x, ...intervalOf(x.days) }))
    .filter((x) => x.interval)
    .sort((a, b) => b.days.length - a.days.length);
  const out = [
    `${ops.length} purchases of ${byTitle.size} items; left out: ${skipped.excluded} excluded, ${skipped.empty} without name or date.`,
    `${regular.length} items bought on 3 or more days (they get a usual interval):`,
    ...regular.slice(0, Number(process.env.PREVIEW_ROWS ?? 60)).map((x) => `  ${x.title.padEnd(32)} ${String(x.days.length).padStart(3)}x  every ~${Math.round(x.interval)} d  last ${x.last}`),
  ];
  return out.join("\n");
}

function readToken() {
  if (process.env.KITCHEN_TOKEN) return process.env.KITCHEN_TOKEN;
  const env = path.join(ROOT, "mcp", ".env");
  const m = fs.existsSync(env) && fs.readFileSync(env, "utf8").match(/^KITCHEN_TOKEN=(\S+)/m);
  if (m) return m[1];
  throw new Error("No token: set KITCHEN_TOKEN or run `node tools/admin.mjs bootstrap` first");
}

async function push(ops, origin) {
  const token = readToken();
  const failed = [];
  for (let i = 0; i < ops.length; i += 50) {
    let res;
    // A busy D1 answers 503 now and then; the ops are idempotent, so retry.
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`${origin}/api/ops`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ops: ops.slice(i, i + 50) }),
      });
      if (res.status < 500 || attempt >= 4) break;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`/api/ops: ${res.status} ${out.error ?? ""}`);
    failed.push(...out.results.filter((r) => !r.ok));
    process.stdout.write(`\r${Math.min(i + 50, ops.length)} / ${ops.length}`);
  }
  console.log(`\nSent ${ops.length} purchases.`);
  if (failed.length) {
    console.log(`Refused: ${JSON.stringify(failed.slice(0, 20))}${failed.length > 20 ? ` and ${failed.length - 20} more` : ""}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = exportDir();
  const built = buildPurchases(readFiles(dir));
  if (process.argv.includes("--preview")) console.log(preview(built));
  const at = process.argv.indexOf("--push");
  if (at > 0) {
    if (!process.argv[at + 1]) throw new Error("--push needs an origin, e.g. https://groceries.vexed.works");
    await push(built.ops, process.argv[at + 1].replace(/\/$/, ""));
  }
  if (!process.argv.includes("--preview") && at < 0) console.log("Use --preview or --push <origin>.");
}
