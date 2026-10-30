// The nightly check's own fixes (30-10-2026): CLEAR duplicate items
// merged by the dedupe tool's rules (public/shared/dedupe.js), question-mark
// names tidied (item.rename), which item each recipe line means
// (public/shared/recipe-links.js, recipe.links), the reviewer's limits on the
// server, and the changelog (auto_changes) with its retention. Fictional names.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { applyOp, emptyState, AUTO_CHANGES_DAYS } from "../public/shared/ops.js";
import { nameKey } from "../public/shared/ingredients.js";
import { addDays } from "../public/shared/shelf-life.js";
import { GUEST_SYNCED } from "../worker/ops-store.js";
import { reviewerMayApply } from "../worker/auth.js";
import * as shared from "../public/shared/dedupe.js";
import * as tool from "../tools/dedupe_items.mjs";
import { linkLine, linkRecipe, linksStale, currentLinks } from "../public/shared/recipe-links.js";
import { suggest } from "../public/shared/suggest.js";
import { nightlyFixes, recipeLinkOps, runNightlyFixes, fixesText } from "../fetcher/review.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/dedupe-items.json"), "utf8"));
const DAY = "2026-10-30";
const HOST = "groceries.localhost:8787";
const ORIGIN = `http://${HOST}`;

function house(spec) {
  const s = emptyState();
  let n = 0;
  for (const [name, bought = 0, extra = {}] of spec) {
    const id = `item-nm-${String(++n).padStart(3, "0")}`;
    s.items[id] = { id, name, name_key: nameKey(name), deleted_at: null, use_per_day: null, rate_source: null, ...extra.item };
    for (let i = 0; i < bought; i++) {
      const pid = `purchase-nm-${n}-${i}`;
      s.purchases[pid] = { id: pid, item_id: id, title: name, bought_on: "2026-10-01", source: "history", deleted_at: null };
    }
  }
  return s;
}
const asNames = (s, g) => ({
  clear: g.clear.map((x) => [s.items[x.target].name, x.members.map((m) => s.items[m.id].name)]),
  doubt: g.doubt.map((f) => [s.items[f.target].name, f.groups.map((x) => [s.items[x.target].name, x.members.map((m) => s.items[m.id].name)]), f.extra.map((m) => [s.items[m.id].name, m.reason])]),
});

// ---------------------------------------------------------------- grouping

test("grouping: the shared module and the tool give the same groups as the tool did before the move", () => {
  const { state, options, expected } = FIXTURE;
  const a = shared.planGroups(state, options);
  const b = tool.planGroups(state, options);
  assert.deepEqual(asNames(state, a), expected, "the fixture's groups are the pre-refactor answer");
  assert.deepEqual(asNames(state, b), expected, "the tool re-exports the same rules");
  assert.equal(tool.cleanName, shared.cleanName);
});

test("grouping: a name with a question mark or filler is never a target; only junk names get a tidy spelling", () => {
  const s = house([["Paprikapoeder?", 6], ["Paprikapoeder", 1], ["Kerrie?", 3], ["x kerrie?", 1], ["Taart? Pruimen?", 1], ["Maybe dille", 4], ["dille", 1]]);
  const g = shared.planGroups(s);
  const target = (n) => g.clear.find((x) => [x.target, ...x.members.map((m) => m.id)].some((id) => s.items[id].name === n));
  assert.equal(s.items[target("Paprikapoeder").target].name, "Paprikapoeder", "the clean name wins over the most bought");
  assert.equal(s.items[target("dille").target].name, "dille", "filler never names the group");
  assert.equal(shared.tidyName("Knoflookpoeder?"), "Knoflookpoeder");
  assert.equal(shared.tidyName("¿saus?"), "Saus");
  assert.equal(shared.tidyName("Taart? Pruimen?"), null, "several things stay as they are");
  assert.equal(shared.tidyName("Maybe dille?"), null, "only a spelling the key ignores");
  assert.equal(shared.tidyName("Komijn"), null);
  const plan = shared.nightlyPlan(g);
  const renamed = Object.fromEntries(plan.renames.map((r) => [r.was, r.name]));
  assert.equal(renamed["Kerrie?"], "Kerrie", "a junk-only group's target gets its tidy name");
  assert.ok(!("Paprikapoeder?" in renamed), "an item merged tonight is not renamed");
  assert.ok(!("Taart? Pruimen?" in renamed));
  for (const r of plan.renames) assert.equal(nameKey(r.name), nameKey(r.was), "item.rename keeps the key");
});

test("grouping: clearPair is pairwise and strict; mergeProblem refuses excluded, heavy and clashing pairs", () => {
  assert.ok(shared.clearPair("Pastinaak", "x pastinaken 500g"));
  assert.ok(shared.clearPair("Bloemtortilla", "Tortillas"));
  assert.ok(!shared.clearPair("Komijn", "Gemalen komijn"), "a doubt word is never clear");
  assert.ok(!shared.clearPair("Fruit", "Fruit 2"), "generic");
  assert.ok(!shared.clearPair("Spruitjes", "x spruitjes"), "never-suggest");
  const f = (name, bought = 0, extra = {}) => ({ item: { name, use_per_day: null, rate_source: null, ...extra }, bought, rules: 0, rate: false, ...extra.f });
  assert.equal(shared.mergeProblem(f("Pruim 2"), f("Pruim")), null);
  assert.equal(shared.mergeProblem(f("Pruimen", shared.HEAVY), f("Pruim", shared.HEAVY)), "both_heavy");
  assert.equal(shared.mergeProblem(f("Tonijn"), f("Kattentonijn")), "not_clear");
  assert.equal(shared.mergeProblem(f("x spruitjes"), f("Spruitjes")), "excluded");
  assert.equal(shared.mergeProblem({ ...f("Zeep 2"), rules: 1 }, { ...f("Zeep"), rules: 1 }), "deal_rule");
});

test("nightly plan: at most NIGHTLY_MERGE_MAX merges, the rest counted for the next night; excluded items never", () => {
  const spec = [];
  for (let i = 0; i < 15; i++) {
    const w = `Kruid${String.fromCharCode(97 + i)}${String.fromCharCode(97 + i)}`;
    spec.push([w, 2], [`x ${w}`, 1]);
  }
  spec.push(["Spruitjes", 3], ["x spruitjes", 1]);
  const s = house(spec);
  const plan = shared.nightlyPlan(shared.planGroups(s));
  assert.equal(plan.merges.length, shared.NIGHTLY_MERGE_MAX);
  assert.equal(plan.left, 15 - shared.NIGHTLY_MERGE_MAX);
  const touched = plan.merges.flatMap((m) => [m.from, m.into]).map((id) => s.items[id].name);
  assert.ok(!touched.some((n) => /spruit/i.test(n)), "never an excluded item");
});

// ------------------------------------------------------------- the server

function call(env, method, p, { body, cookie, bearer, host = HOST } = {}) {
  const headers = { Origin: `http://${host}` };
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`http://${host}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
let n = 0;
const opId = () => `op-nightly-${String(++n).padStart(6, "0")}`;

async function setup(items = []) {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const thomas = tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456", label: "phone" } }));
  const code = await (await call(env, "POST", "/api/codes", { cookie: thomas, body: { for: "reviewer" } })).json();
  const reviewer = tokenOf(await call(env, "POST", "/api/pair", { body: { code: code.code, label: "Thuisserver controle" } }));
  // Items and old purchases as rows (an excluded thing cannot be made by an op any more).
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
  for (const [id, title, bought = 0] of items) {
    await env.DB.exec(`INSERT INTO items (id, household_id, name, name_key, created_at, rev) SELECT ${q(id)}, id, ${q(title)}, ${q(nameKey(title))}, 'x', 1 FROM households;`);
    for (let i = 0; i < bought; i++) {
      await env.DB.exec(`INSERT INTO purchases (id, household_id, item_id, title, bought_on, store, qty, source, created_at, rev)
        SELECT ${q(`pur-${id}-${i}`)}, id, ${q(id)}, ${q(title)}, '2026-10-01', 'AH', 1, 'history', 'x', 1 FROM households;`);
    }
  }
  return { env, thomas, reviewer };
}
const send = async (env, who, ops) => {
  const res = await call(env, "POST", "/api/ops", { ...who, body: { ops: ops.map((o) => ({ op_id: opId(), ...o })) } });
  return { status: res.status, body: await res.json() };
};
const syncOf = async (env, who) => (await call(env, "GET", "/api/sync?since=0", who)).json();

test("reviewer: a clear merge passes and lands in the changelog; not clear, two established, excluded or a title is refused whole", async () => {
  const { env, thomas, reviewer } = await setup([
    ["item-nm-pastinaak", "Pastinaak", 3], ["item-nm-pastx", "x pastinaak", 1],
    ["item-nm-pruim", "Pruim", 6], ["item-nm-pruimen", "Pruimen", 6],
    ["item-nm-tonijn", "Tonijn", 1], ["item-nm-katt", "Kattentonijn", 1],
    ["item-nm-spruit", "Spruitjes", 1], ["item-nm-spruitx", "x spruitjes", 0],
  ]);
  const r = { bearer: reviewer };
  const merge = (from, into) => ({ type: "item.merge", from_item_id: from, into_item_id: into, on: DAY });
  assert.equal((await send(env, r, [merge("item-nm-tonijn", "item-nm-katt")])).status, 403, "not one thing by the rules");
  assert.equal((await send(env, r, [merge("item-nm-pruimen", "item-nm-pruim")])).status, 403, "two established items");
  assert.equal((await send(env, r, [merge("item-nm-spruitx", "item-nm-spruit")])).status, 403, "never an excluded item");
  assert.equal(reviewerMayApply({ ...merge("item-nm-pastx", "item-nm-pastinaak"), into_title: "Pastinaak" }), false, "never into a title");
  const ok = await send(env, r, [merge("item-nm-pastx", "item-nm-pastinaak")]);
  assert.equal(ok.status, 200);
  assert.ok(ok.body.results[0].ok);
  const all = await syncOf(env, { cookie: thomas });
  assert.ok(!all.items.some((i) => i.id === "item-nm-pastx"), "merged");
  assert.deepEqual(all.auto_changes.map((c) => [c.what, c.name, c.target]), [["merge", "x pastinaak", "Pastinaak"]]);
  // A person's own merge writes no changelog row.
  await send(env, { cookie: thomas }, [merge("item-nm-tonijn", "item-nm-katt")]);
  assert.equal((await syncOf(env, { cookie: thomas })).auto_changes.length, 1);
});

test("reviewer: at most NIGHTLY_MERGE_MAX merges a day (usage_limits), then 429", async () => {
  const items = [];
  for (let i = 0; i < shared.NIGHTLY_MERGE_MAX + 1; i++) {
    const w = `Kruid${String.fromCharCode(97 + i)}${String.fromCharCode(97 + i)}`;
    items.push([`item-nm-k${i}a`, w, 1], [`item-nm-k${i}b`, `x ${w}`, 0]);
  }
  const { env, reviewer } = await setup(items);
  for (let i = 0; i < shared.NIGHTLY_MERGE_MAX; i++) {
    const res = await send(env, { bearer: reviewer }, [{ type: "item.merge", from_item_id: `item-nm-k${i}b`, into_item_id: `item-nm-k${i}a`, on: DAY }]);
    assert.equal(res.status, 200, `merge ${i + 1}`);
  }
  const over = await send(env, { bearer: reviewer }, [{ type: "item.merge", from_item_id: `item-nm-k${shared.NIGHTLY_MERGE_MAX}b`, into_item_id: `item-nm-k${shared.NIGHTLY_MERGE_MAX}a`, on: DAY }]);
  assert.deepEqual([over.status, over.body.error], [429, "too_many_merges"]);
});

test("reviewer: item.rename only to a tidier spelling, never of an excluded item; recipe.links only from the reviewer; all logged", async () => {
  const { env, thomas, reviewer } = await setup([["item-nm-kerrie", "Kerrie?", 1], ["item-nm-spruit", "Spruitjes?", 1], ["item-nm-bloem", "Bloem", 2]]);
  await send(env, { cookie: thomas }, [{ type: "recipe.put", id: "recipe-nm-pannenkoek", recipe: { title: "Pannenkoeken", servings: 4,
    ingredients: [{ qty: 250, unit: "g", name: "bloem" }, { qty: 500, unit: "ml", name: "melk" }, { name: "water" }, { name: "ovenschaal" }], steps: ["Bak."] } }]);
  const r = { bearer: reviewer };
  assert.equal(reviewerMayApply({ type: "item.rename", item_id: "item-nm-kerrie", name: "Kerrie?" }), false);
  assert.equal((await send(env, r, [{ type: "item.rename", item_id: "item-nm-spruit", name: "Spruitjes" }])).status, 403, "never an excluded item");
  assert.equal((await send(env, r, [{ type: "item.rename", item_id: "item-nm-kerrie", name: "Kerrie" }])).status, 200);
  const before = await syncOf(env, { cookie: thomas });
  const recipe = before.recipes.find((x) => x.id === "recipe-nm-pannenkoek");
  const lines = linkRecipe(recipe, { items: Object.fromEntries(before.items.map((i) => [i.id, i])), aliases: {} });
  const links = { type: "recipe.links", recipe_id: recipe.id, at: recipe.updated_at, lines };
  assert.equal((await send(env, { cookie: thomas }, [links])).status, 403, "never from a person");
  assert.equal((await send(env, r, [links])).status, 200);
  assert.equal((await send(env, r, [{ type: "item.alias", id: "alias-nm-00001", item_id: "item-nm-bloem", name: "patent meel", reason: "ander woord" }])).status, 200);
  const all = await syncOf(env, { cookie: thomas });
  assert.equal(all.items.find((i) => i.id === "item-nm-kerrie").name, "Kerrie");
  const after = all.recipes.find((x) => x.id === recipe.id);
  assert.equal(after.updated_at, recipe.updated_at, "linking never changes the recipe's version");
  assert.deepEqual(currentLinks(after).map((l) => l.item_id ? `${l.name}=${l.item}` : `${l.name}:${l.reason}`), ["bloem=Bloem", "melk:never", "water:tap", "ovenschaal:tool"]);
  const log = Object.fromEntries(all.auto_changes.map((c) => [c.what, c]));
  assert.deepEqual([log.rename.name, log.rename.target], ["Kerrie?", "Kerrie"]);
  assert.deepEqual([log.recipe.name, log.recipe.target, log.recipe.lines.length], ["Pannenkoeken", "1/4", 4]);
  assert.deepEqual([log.alias.name, log.alias.target, log.alias.reason], ["patent meel", "Bloem", "ander woord"]);
});

test("changelog and recipe links: never synced to a recipes-only guest", async () => {
  assert.ok(!GUEST_SYNCED.includes("auto_changes"));
  const { env, thomas, reviewer } = await setup([["item-nm-bloem", "Bloem", 1]]);
  await send(env, { cookie: thomas }, [{ type: "recipe.put", id: "recipe-nm-brood", recipe: { title: "Brood", servings: 1, ingredients: [{ name: "bloem" }, { name: "gist" }], steps: [] } }]);
  const recipe = (await syncOf(env, { cookie: thomas })).recipes[0];
  await send(env, { bearer: reviewer }, [{ type: "recipe.links", recipe_id: recipe.id, at: recipe.updated_at, lines: [{ name: "bloem", item_id: "item-nm-bloem", item: "Bloem", how: "exact" }, { name: "gist", item_id: null, reason: "never" }] }]);
  const inv = await (await call(env, "POST", "/api/invites", { cookie: thomas, host: "recipes.localhost:8787", body: { name: "Henk" } })).json();
  const henk = tokenOf(await call(env, "POST", "/api/pair", { host: "recipes.localhost:8787", body: { invite: inv.url.match(/#\/join\/([\w-]+)$/)[1] } }));
  const seen = await (await call(env, "GET", "/api/sync?since=0", { cookie: henk, host: "recipes.localhost:8787" })).json();
  assert.equal(seen.recipes.length, 1);
  assert.ok(!("ingredient_links" in seen.recipes[0]), "no item data on a guest's recipe");
  assert.ok(!("auto_changes" in seen));
  const mine = await syncOf(env, { cookie: thomas });
  assert.ok(mine.recipes[0].ingredient_links, "the household has them");
});

test("changelog: review.save tombstones rows older than AUTO_CHANGES_DAYS; a replay or an unchanged alias logs nothing", () => {
  const s = emptyState();
  const ctx = { memberId: "m1", isAdmin: true, now: "2026-10-30T05:30:00.000Z", autoLog: true };
  s.items.a = { id: "item-a-000001", name: "Pastinaak", name_key: "pastinaak", deleted_at: null };
  s.items["item-a-000001"] = s.items.a; delete s.items.a;
  s.auto_changes["ac-old"] = { id: "ac-old", day: addDays("2026-10-30", -AUTO_CHANGES_DAYS - 1), what: "alias", name: "x", target: "y", deleted_at: null };
  s.auto_changes["ac-new"] = { id: "ac-new", day: addDays("2026-10-30", -AUTO_CHANGES_DAYS), what: "alias", name: "x", target: "y", deleted_at: null };
  applyOp(s, { type: "review.save", day: "2026-10-30" }, ctx);
  assert.ok(s.auto_changes["ac-old"].deleted_at, "past the window: a tombstone");
  assert.equal(s.auto_changes["ac-new"].deleted_at, null, "on the edge: kept");
  applyOp(s, { op_id: "op-alias-0001", type: "item.alias", id: "alias-a-0001", item_id: "item-a-000001", name: "Pastinaak" }, ctx);
  assert.ok(!s.auto_changes["ac-op-alias-0001"], "its own name: already, nothing logged");
  applyOp(s, { op_id: "op-alias-0002", type: "item.alias", id: "alias-a-0002", item_id: "item-a-000001", name: "Pastinaakje" }, { ...ctx, autoLog: false });
  assert.ok(!s.auto_changes["ac-op-alias-0002"], "a person's alias is not the night's");
});

// --------------------------------------------------------- recipe lines

test("recipe links: linked lines say how; unlinked ones why (excluded, tap, tool, several, never); consumables are no tools", () => {
  const data = { items: Object.fromEntries([["i1", "Bloem"], ["i2", "Eieren"], ["i3", "Zout"], ["i4", "Peper"], ["i5", "Bakpapier"]]
    .map(([id, name]) => [`item-${id}-00000`, { id: `item-${id}-00000`, name, name_key: nameKey(name), deleted_at: null }])), aliases: {} };
  const one = (name) => linkLine(name, data);
  assert.deepEqual([one("bloem").item, one("bloem").how], ["Bloem", "exact"]);
  assert.deepEqual([one("ei, losgeklopt").item, one("ei, losgeklopt").how], ["Eieren", "same"]);
  assert.equal(one("zout en peper").how, "parts");
  assert.equal(one("bakpapier").item, "Bakpapier", "a consumable links like an ingredient");
  assert.equal(one("aluminiumfolie").reason, "never", "a consumable without an item is never bought, no tool");
  assert.equal(one("ovenschaal").reason, "tool");
  assert.equal(one("staafmixer").reason, "tool");
  assert.equal(one("kokend water").reason, "tap");
  assert.equal(one("spruitjes").reason, "excluded");
  assert.equal(one("kaas of ham").reason, "several");
  assert.equal(one("saffraan").reason, "never");
  const recipe = { id: "recipe-x", updated_at: "t1", ingredients: [{ heading: true, name: "Deeg" }, { name: "bloem" }, { name: "saffraan" }] };
  const lines = linkRecipe(recipe, data);
  assert.equal(lines.length, 2, "headings left out");
  assert.ok(linksStale(recipe, lines), "nothing stored yet");
  const stored = { ...recipe, ingredient_links: { at: "t1", lines } };
  assert.ok(!linksStale(stored, lines));
  assert.ok(linksStale({ ...stored, updated_at: "t2" }, lines), "the recipe changed");
  assert.equal(currentLinks({ ...stored, updated_at: "t2" }), null, "the page shows no old marks");
});

// ------------------------------------------------------------ suggestions

test("suggestions: a question-mark name only when typed exactly", () => {
  const view = { items: { a: { id: "a", name: "Knoflookpoeder?", name_key: nameKey("Knoflookpoeder?") }, b: { id: "b", name: "Knoflook", name_key: "knoflook" } }, aliases: {}, purchases: {} };
  assert.deepEqual(suggest(view, "knofl").map((x) => x.item.name), ["Knoflook"]);
  assert.deepEqual(suggest(view, "knoflookpoeder").map((x) => x.item.name), ["Knoflookpoeder?"]);
  const kt = fs.readFileSync(path.join(ROOT, "android/app/src/main/java/works/vexed/groceries/Suggest.kt"), "utf8");
  assert.match(kt, /best\.first > 0 && \(c\.name\.contains\('\?'\)/, "the widget's twin has the same rule");
});

// --------------------------------------------------------------- fetcher

test("nightlyFixes: the tool's op ids, renames before merges, new DOUBT groups asked once after a silent first run", () => {
  const s = house([["Pastinaak", 3], ["x pastinaak", 1], ["Kerrie?", 2], ["Nootmuskaat", 3], ["Gemalen nootmuskaat", 1]]);
  const sync = Object.fromEntries(Object.entries(s).map(([k, rows]) => [k, Object.values(rows)]));
  const first = nightlyFixes(sync, { today: DAY, seen: null });
  assert.deepEqual(first.ops.map((o) => o.type), ["item.rename", "item.merge"]);
  const merge = first.ops.find((o) => o.type === "item.merge");
  assert.equal(merge.op_id, tool.mergeOpId(merge.from_item_id, merge.into_item_id), "a later --write is a replay");
  assert.deepEqual(first.decide, [], "the first run asks nothing: the old groups wait on the backlog");
  const second = nightlyFixes(sync, { today: DAY, seen: [] });
  assert.deepEqual(second.decide.map((d) => d.text), ["Nootmuskaat en Gemalen nootmuskaat samenvoegen?"], "with Samenvoegen / Apart houden (tests/nightly-v2.test.mjs)");
  assert.deepEqual(nightlyFixes(sync, { today: DAY, seen: second.seen }).decide, [], "asked once");
});

test("runNightlyFixes: merges, renames and recipe links go through the worker as the reviewer; the report carries the questions", async () => {
  const { env, thomas, reviewer } = await setup([["item-nm-pastinaak", "Pastinaak", 3], ["item-nm-pastx", "x pastinaak", 1], ["item-nm-kerrie", "Kerrie?", 1]]);
  await send(env, { cookie: thomas }, [{ type: "recipe.put", id: "recipe-nm-soep", recipe: { title: "Soep", servings: 2, ingredients: [{ name: "pastinaak" }, { name: "saffraan" }], steps: [] } }]);
  const viaWorker = (url, init = {}) => worker.fetch(new Request(url.replace(/^https?:\/\/[^/]+/, ORIGIN), { ...init, headers: { ...(init.headers ?? {}), Origin: ORIGIN } }), env);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-nightly-"));
  const out = await runNightlyFixes({ stateDir, today: DAY, origin: ORIGIN, get: viaWorker, post: viaWorker, token: reviewer, say: () => {}, household: { TARGETS: [], EXCLUDES: [] } });
  assert.deepEqual(out.errors, []);
  assert.ok(out.done.includes("x pastinaak -> Pastinaak") && out.done.includes("Kerrie? -> Kerrie") && out.done.includes("linked recipe Soep"), out.done.join("; "));
  assert.deepEqual(out.unlinked, ["Soep: saffraan"]);
  assert.match(fixesText(out), /recipe line without an item: Soep: saffraan/);
  const all = await syncOf(env, { cookie: thomas });
  assert.deepEqual(all.auto_changes.map((c) => c.what).sort(), ["merge", "recipe", "rename"]);
  assert.ok(fs.existsSync(path.join(stateDir, "fixes.json")) && fs.existsSync(path.join(stateDir, "doubt-seen.json")));
  // The next night: nothing new to do.
  const again = recipeLinkOps({ recipes: Object.fromEntries(all.recipes.map((r) => [r.id, r])), items: Object.fromEntries(all.items.map((i) => [i.id, i])), aliases: {} });
  assert.deepEqual(again.ops, [], "linked recipes are not sent again");
});
