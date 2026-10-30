// One-off pass: every item without a shelf life gets one from Claude Haiku,
// through POST /api/items/shelf-fill (worker/shelf.js), so the key stays in
// the worker and the op engine keeps a person's value. 25 items per request,
// all 25 in ONE Claude request.
//
//   node tools/fill_shelf_life.mjs --preview [origin]   counts and the estimated cost, no paid call
//   node tools/fill_shelf_life.mjs --push <origin>      fill them
//
// Items that already have a person's or Claude's value are never sent;
// an excluded thing is skipped by the route. Running it twice sends nothing new.
// The Bearer token comes from KITCHEN_TOKEN or mcp/.env (a git worktree reads
// the main kitchen folder's copy). The token is never printed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// claude-haiku-5-5: $0.10 per million input tokens, $0.50 per million output.
const PRICE_IN = 0.10 / 1e6;
const PRICE_OUT = 0.50 / 1e6;
// Measured shape of one request: the prompt and schema, plus per item its line
// in and its answer out; output counted generously (thinking at low effort).
const TOKENS_PER_REQUEST_IN = 600;
const TOKENS_PER_ITEM_IN = 25;
const TOKENS_PER_ITEM_OUT = 120;

/** Dollars for `items` items in batches of `batch`, a deliberate overestimate. */
export function estimateCost(items, batch = 25) {
  const requests = Math.ceil(items / batch);
  const input = requests * TOKENS_PER_REQUEST_IN + items * TOKENS_PER_ITEM_IN;
  const output = items * TOKENS_PER_ITEM_OUT;
  return { requests, input, output, dollars: input * PRICE_IN + output * PRICE_OUT };
}

function readToken() {
  if (process.env.KITCHEN_TOKEN) return process.env.KITCHEN_TOKEN;
  for (const env of [path.join(ROOT, "mcp", ".env"), path.join(ROOT, "..", "kitchen", "mcp", ".env")]) {
    const m = fs.existsSync(env) && fs.readFileSync(env, "utf8").match(/^KITCHEN_TOKEN=(\S+)/m);
    if (m) return m[1];
  }
  throw new Error("No token: set KITCHEN_TOKEN or run `node tools/admin.mjs bootstrap` first");
}

async function post(origin, token, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${origin}/api/items/shelf-fill`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status < 500 || attempt >= 2) return { status: res.status, out: await res.json().catch(() => ({})) };
    await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1)));
  }
}

const daysText = (d) => (d === -1 ? "keeps" : `${d} d`);

/** Walk the items with the route's cursor until it says done. `send` is post(), replaceable in a test. */
export async function fill(send, log = console.log) {
  let after = "";
  let written = 0;
  let failed = 0;
  for (;;) {
    const { status, out } = await send(after ? { after } : {});
    if (status === 429) {
      log(`Stopped: ${out.error ?? "rate limited"}. Run it again tomorrow for the rest.`);
      break;
    }
    if (status !== 200) throw new Error(`/api/items/shelf-fill: ${status} ${out.error ?? ""}`);
    for (const r of out.results ?? []) log(`${r.name} -> ${daysText(r.shelf_days)}${r.opened_days ? `, open ${r.opened_days} d` : ""} (${r.kind})`);
    written += out.written ?? 0;
    failed += out.failed ?? 0;
    if (!out.next) break;
    after = out.next;
  }
  log(`\nWritten ${written}${failed ? `, no answer for ${failed} (run again to retry those)` : ""}.`);
  return { written, failed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--push");
  const pv = process.argv.indexOf("--preview");
  if (at < 0 && pv < 0) {
    console.log("Use --preview [origin] or --push <origin>.");
  } else {
    if (at > 0 && !process.argv[at + 1]) throw new Error("--push needs an origin, e.g. https://groceries.vexed.works");
    const given = at > 0 ? process.argv[at + 1] : process.argv[pv + 1];
    const origin = (given && !given.startsWith("--") ? given : "https://groceries.vexed.works").replace(/\/$/, "");
    const token = readToken();
    const { status, out } = await post(origin, token, { dry_run: true });
    if (status !== 200) throw new Error(`/api/items/shelf-fill: ${status} ${out.error ?? ""}`);
    const cost = estimateCost(out.todo, out.batch);
    console.log(`${out.todo} items without a shelf life (${out.excluded} excluded, never sent); ` +
      `${out.claude} by Claude, ${out.person} by a person, ${out.rule} by a rule (never sent).`);
    console.log(`${cost.requests} requests to claude-haiku-5-5, ~${cost.input} tokens in, ~${cost.output} out: ` +
      `about $${cost.dollars.toFixed(3)} at most.`);
    if (at > 0) await fill((body) => post(origin, token, body));
  }
}
