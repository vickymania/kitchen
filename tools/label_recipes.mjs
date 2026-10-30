// One-time pass: Claude labels every recipe that has no labels yet, for the
// "what shall I eat" wizard. Each recipe goes through POST /api/recipes/label,
// so the key stays in the worker and the op engine keeps a person's labels.
//
//   node tools/label_recipes.mjs --preview [origin]   what would be sent, no paid call
//   node tools/label_recipes.mjs --push <origin>      label them (about a cent each)
//
// Add `--only meals` to either for the recipes labelled before meals existed
// (28-10-2026): only recipes without meals are sent, a person's too, and the
// route lets Claude fill the meals and nothing else.
//
// The Bearer token comes from KITCHEN_TOKEN or mcp/.env, like the other tools;
// a git worktree has no mcp/.env and reads the main kitchen folder's copy.
// Running it twice sends nothing new: labelled recipes are skipped, by this
// tool and by the route.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CENTS_PER_RECIPE = 1;

/**
 * Which recipes to send: the ones nobody labelled yet, or with
 * `only: "meals"` the ones without meals.
 */
export function planLabels(recipes, { only = null } = {}) {
  const live = recipes.filter((r) => !r.deleted_at);
  if (only === "meals") {
    return {
      todo: live.filter((r) => !r.meals?.length),
      claude: live.filter((r) => r.meals?.length && r.labels_by === "claude").length,
      person: live.filter((r) => r.meals?.length && r.labels_by === "person").length,
    };
  }
  return {
    todo: live.filter((r) => !r.labels_by),
    claude: live.filter((r) => r.labels_by === "claude").length,
    person: live.filter((r) => r.labels_by === "person").length,
  };
}

function readToken() {
  if (process.env.KITCHEN_TOKEN) return process.env.KITCHEN_TOKEN;
  for (const env of [path.join(ROOT, "mcp", ".env"), path.join(ROOT, "..", "kitchen", "mcp", ".env")]) {
    const m = fs.existsSync(env) && fs.readFileSync(env, "utf8").match(/^KITCHEN_TOKEN=(\S+)/m);
    if (m) return m[1];
  }
  throw new Error("No token: set KITCHEN_TOKEN or run `node tools/admin.mjs bootstrap` first");
}

async function recipesOf(origin, token) {
  const res = await fetch(`${origin}/api/sync?since=0`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`/api/sync: ${res.status}`);
  return (await res.json()).recipes;
}

async function push(origin, token, todo, only) {
  let done = 0;
  const failed = [];
  for (const r of todo) {
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`${origin}/api/recipes/label`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(only ? { id: r.id, only } : { id: r.id }),
      });
      if (res.status < 500 || attempt >= 2) break;
      await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1)));
    }
    const out = await res.json().catch(() => ({}));
    if (res.status === 429) {
      console.log(`\nStopped: ${out.error ?? "rate limited"}. Run it again tomorrow for the rest.`);
      break;
    }
    if (!res.ok) failed.push(`${r.title}: ${out.error ?? res.status}`);
    else {
      done++;
      const l = out.labels;
      console.log(`${r.title} -> ${l ? [l.cuisine, l.main_ingredient, l.time_class, l.time_minutes && `${l.time_minutes} min`, l.meals?.join("+")].filter(Boolean).join(", ") : out.skipped}`);
    }
  }
  console.log(`\nLabelled ${done} of ${todo.length}.`);
  if (failed.length) {
    console.log(`Failed:\n${failed.join("\n")}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--push");
  const pv = process.argv.indexOf("--preview");
  if (at < 0 && pv < 0) {
    console.log("Use --preview [origin] or --push <origin>.");
  } else {
    if (at > 0 && !process.argv[at + 1]) throw new Error("--push needs an origin, e.g. https://recipes.vexed.works");
    const given = at > 0 ? process.argv[at + 1] : process.argv[pv + 1];
    const origin = (given && !given.startsWith("--") ? given : "https://recipes.vexed.works").replace(/\/$/, "");
    const oi = process.argv.indexOf("--only");
    const only = oi > 0 ? process.argv[oi + 1] : null;
    if (oi > 0 && only !== "meals") throw new Error("--only takes one value: meals");
    const token = readToken();
    const plan = planLabels(await recipesOf(origin, token), { only });
    const what = only ? "without meals" : "without labels";
    const never = only ? "" : " (never sent)";
    console.log(`${plan.todo.length} recipes ${what} (about €${(plan.todo.length * CENTS_PER_RECIPE / 100).toFixed(2)}); ` +
      `${plan.claude} labelled by Claude, ${plan.person} by a person${never}.`);
    if (pv > 0) for (const r of plan.todo) console.log(`- ${r.title}${only && r.labels_by === "person" ? " (person's labels kept)" : ""}`);
    if (at > 0) await push(origin, token, plan.todo, only);
  }
}
