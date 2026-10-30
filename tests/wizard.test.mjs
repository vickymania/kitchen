import "./never-suggest.mjs";
﻿// The "what shall I eat" wizard: recipe labels, Claude labelling them (the
// Claude API is never called: globalThis.fetch is replaced), cooked tracking,
// and the ranking.
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { applyOp, emptyState, OpError } from "../public/shared/ops.js";
import { propose, passes, optionCounts, sameThing, mainIngredients, usableBonus, lastCookedDays, mealsForHour, QUESTIONS } from "../public/shared/wizard.js";
import { labelPatch, mealsPatch, LABEL_DAILY_LIMIT } from "../worker/labels.js";
import { MODEL } from "../worker/claude.js";
import { planLabels } from "../tools/label_recipes.mjs";

const ctx = (memberId = "member-thomas-01") => ({ memberId, isAdmin: true, now: "2026-10-27T10:00:00.000Z" });
const LABELS = { cuisine: "italian", main_ingredient: "mince", time_class: "normal", time_minutes: 45 };

// ------------------------------------------------------------------ labels

test("labels: set through recipe.put, from the fixed vocabulary only", () => {
  const s = emptyState();
  applyOp(s, { type: "recipe.put", id: "recipe-lasagne-1", recipe: { title: "Lasagne" } }, ctx());
  applyOp(s, { type: "recipe.put", id: "recipe-lasagne-1", recipe: { ...LABELS, labels_by: "claude" } }, ctx());
  const r = s.recipes["recipe-lasagne-1"];
  assert.deepEqual([r.title, r.cuisine, r.main_ingredient, r.time_class, r.time_minutes, r.labels_by],
    ["Lasagne", "italian", "mince", "normal", 45, "claude"], "a patch: the title stays");
  const bad = (recipe) => assert.throws(() => applyOp(s, { type: "recipe.put", id: "recipe-lasagne-1", recipe }, ctx()), OpError);
  bad({ cuisine: "martian", labels_by: "person" });
  bad({ main_ingredient: "tofu", labels_by: "person" });
  bad({ time_class: "slow", labels_by: "person" });
  bad({ time_minutes: 0, labels_by: "person" });
  bad({ labels_by: "robot" });
  bad({ cuisine: "dutch" });   // labels must say who set them
  applyOp(s, { type: "recipe.put", id: "recipe-lasagne-1", recipe: { cuisine: null, labels_by: "person" } }, ctx());
  assert.equal(s.recipes["recipe-lasagne-1"].cuisine, null, "a person can clear a label");
});

test("labels: Claude never overwrites labels a person set", () => {
  const s = emptyState();
  applyOp(s, { type: "recipe.put", id: "recipe-curry-01", recipe: { title: "Curry", cuisine: "indian", labels_by: "person" } }, ctx());
  assert.throws(() => applyOp(s, { type: "recipe.put", id: "recipe-curry-01", recipe: { cuisine: "thai", labels_by: "claude" } }, ctx()),
    (e) => e.code === "labels_by_person");
  assert.equal(s.recipes["recipe-curry-01"].cuisine, "indian");
  applyOp(s, { type: "recipe.put", id: "recipe-curry-01", recipe: { cuisine: "thai", labels_by: "person" } }, ctx());
  assert.equal(s.recipes["recipe-curry-01"].cuisine, "thai", "the person may change their own");
});

test("labels: Claude's answer is checked against the vocabulary", () => {
  assert.deepEqual(labelPatch({ cuisine: "italian", main_ingredient: "mince", time_class: "normal", time_minutes: 44.6 }),
    { ...LABELS, time_minutes: 45, meals: null, labels_by: "claude" });
  assert.deepEqual(labelPatch({ cuisine: "klingon", main_ingredient: "chicken", time_class: "???", time_minutes: 20 }),
    { cuisine: null, main_ingredient: "chicken", time_class: "fast", time_minutes: 20, meals: null, labels_by: "claude" });
  assert.equal(labelPatch({ cuisine: "x", main_ingredient: "y", time_class: "z" }), null);
});

// ------------------------------------------------------------------ cooked

test("cooked: one row per recipe per day, can be taken back, unknown recipe refused", () => {
  const s = emptyState();
  applyOp(s, { type: "recipe.put", id: "recipe-chili-01", recipe: { title: "Chili" } }, ctx());
  const first = applyOp(s, { type: "recipe.cooked", id: "cook-chili-0001", recipe_id: "recipe-chili-01", cooked_on: "2026-10-20" }, ctx());
  assert.deepEqual(first.changed, [["cooks", "cook-chili-0001"]]);
  const twice = applyOp(s, { type: "recipe.cooked", id: "cook-chili-0002", recipe_id: "recipe-chili-01", cooked_on: "2026-10-20" }, ctx());
  assert.equal(twice.result.cook_id, "cook-chili-0001");
  assert.deepEqual(twice.changed, [], "cook mode and the eaten button on one day are one row");
  applyOp(s, { type: "recipe.cooked", id: "cook-chili-0003", recipe_id: "recipe-chili-01", cooked_on: "2026-10-25" }, ctx());
  assert.deepEqual(lastCookedDays(s.cooks), { "recipe-chili-01": "2026-10-25" });
  applyOp(s, { type: "recipe.uncooked", id: "cook-chili-0003" }, ctx());
  assert.deepEqual(lastCookedDays(s.cooks), { "recipe-chili-01": "2026-10-20" });
  assert.throws(() => applyOp(s, { type: "recipe.cooked", id: "cook-none-0001", recipe_id: "recipe-nothere1", cooked_on: "2026-10-25" }, ctx()),
    (e) => e.code === "not_found");
  assert.throws(() => applyOp(s, { type: "recipe.cooked", id: "cook-chili-0004", recipe_id: "recipe-chili-01", cooked_on: "gisteren" }, ctx()), OpError);
});

// ------------------------------------------------------------ the worker

const HOST = "recipes.localhost:8787";

function call(env, method, path, { body, cookie } = {}) {
  const headers = { Origin: `http://${HOST}` };
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`http://${HOST}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}

async function household(extra = {}) {
  const env = { ...(await makeEnv()), ...extra };
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const res = await call(env, "POST", "/api/pair", { body: { code: "123456" } });
  const token = res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
  return { env, thomas: token };
}

let counter = 0;
const op = (o) => ({ op_id: `op-wiz-${String(++counter).padStart(6, "0")}`, ...o });
const send = async (env, cookie, ops) => (await (await call(env, "POST", "/api/ops", { cookie, body: { ops } })).json()).results;

function mockClaude(answer, { status = 200 } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(answer) }] }), { status });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const RECIPE = {
  title: "Spaghetti bolognese", servings: 4,
  ingredients: [{ name: "gehakt", qty: 500, unit: "g" }, { name: "spaghetti", qty: 400, unit: "g" }],
  steps: ["Bak het gehakt.", "Kook de spaghetti."],
};

test("label route: Claude labels a recipe, the labels sync as a recipe.put, the key never comes back", async () => {
  const { env, thomas } = await household({ ANTHROPIC_API_KEY: "test-key-not-real" });
  assert.deepEqual((await send(env, thomas, [op({ type: "recipe.put", id: "recipe-bolo-001", recipe: RECIPE })])).map((r) => r.ok), [true]);
  const before = await (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();

  const claude = mockClaude({ cuisine: "italian", main_ingredient: "mince", time_class: "normal", time_minutes: 40 });
  let res;
  try {
    res = await call(env, "POST", "/api/recipes/label", { cookie: thomas, body: { id: "recipe-bolo-001" } });
  } finally {
    claude.restore();
  }
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual(out.labels, { cuisine: "italian", main_ingredient: "mince", time_class: "normal", time_minutes: 40, meals: null, labels_by: "claude" });
  assert.equal(claude.calls.length, 1);
  const sent = claude.calls[0].body;
  assert.equal(sent.model, MODEL);
  assert.equal(sent.model, "claude-sonnet-5-5");
  assert.equal(sent.output_config.format.type, "json_schema");
  assert.ok(sent.output_config.format.schema.properties.cuisine.enum.includes("italian"));
  const prompt = sent.messages[0].content[0].text;
  assert.ok(prompt.includes("Spaghetti bolognese") && prompt.includes("gehakt") && prompt.includes("Kook de spaghetti"),
    "title, ingredients and steps go along");
  assert.ok(!JSON.stringify(out).includes("test-key"), "the key never comes back");

  const delta = await (await call(env, "GET", `/api/sync?since=${before.rev}`, { cookie: thomas })).json();
  assert.equal(delta.recipes.length, 1, "the labels arrive in the delta");
  assert.deepEqual([delta.recipes[0].cuisine, delta.recipes[0].labels_by, delta.recipes[0].title], ["italian", "claude", "Spaghetti bolognese"]);

  // Asked again: already labelled, no second paid call.
  const again = mockClaude({ cuisine: "dutch", main_ingredient: "mince", time_class: "fast", time_minutes: 20 });
  try {
    const r2 = await (await call(env, "POST", "/api/recipes/label", { cookie: thomas, body: { id: "recipe-bolo-001" } })).json();
    assert.equal(r2.skipped, "labelled");
    assert.equal(again.calls.length, 0);
  } finally {
    again.restore();
  }
});

test("label route: never over a person's labels, no key, no device, unknown recipe, daily limit", async () => {
  const off = await household();
  await send(off.env, off.thomas, [op({ type: "recipe.put", id: "recipe-off-0001", recipe: RECIPE })]);
  assert.equal((await call(off.env, "POST", "/api/recipes/label", { cookie: off.thomas, body: { id: "recipe-off-0001" } })).status, 503);

  const { env, thomas } = await household({ ANTHROPIC_API_KEY: "test-key-not-real" });
  await send(env, thomas, [
    op({ type: "recipe.put", id: "recipe-mine-0001", recipe: { ...RECIPE, cuisine: "dutch", labels_by: "person" } }),
    op({ type: "recipe.put", id: "recipe-free-0001", recipe: RECIPE }),
  ]);
  const claude = mockClaude({ cuisine: "italian", main_ingredient: "mince", time_class: "normal", time_minutes: 40 });
  try {
    const mine = await call(env, "POST", "/api/recipes/label", { cookie: thomas, body: { id: "recipe-mine-0001" } });
    assert.deepEqual([mine.status, (await mine.json()).error], [409, "labels_by_person"]);
    assert.equal((await call(env, "POST", "/api/recipes/label", { body: { id: "recipe-free-0001" } })).status, 401);
    assert.equal((await call(env, "POST", "/api/recipes/label", { cookie: thomas, body: { id: "recipe-nothere1" } })).status, 404);
    assert.equal(claude.calls.length, 0, "no paid call for a refused request");
    const full = await (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();
    assert.equal(full.recipes.find((r) => r.id === "recipe-mine-0001").cuisine, "dutch");

    const hh = (await env.DB.prepare("SELECT id FROM households").first()).id;
    await env.DB.prepare("INSERT INTO usage_limits (bucket, count) VALUES (?, ?)")
      .bind(`label:${hh}:${new Date().toISOString().slice(0, 10)}`, LABEL_DAILY_LIMIT).run();
    const limited = await call(env, "POST", "/api/recipes/label", { cookie: thomas, body: { id: "recipe-free-0001" } });
    assert.deepEqual([limited.status, (await limited.json()).error], [429, "too_many_labels"]);
    assert.equal(claude.calls.length, 0);
  } finally {
    claude.restore();
  }
});

test("cooked route: the op syncs, an idle poll still reads only the counter", async () => {
  const { env, thomas } = await household();
  await send(env, thomas, [op({ type: "recipe.put", id: "recipe-cook-0001", recipe: RECIPE })]);
  const r = await send(env, thomas, [
    op({ type: "recipe.cooked", id: "cook-row-000001", recipe_id: "recipe-cook-0001", cooked_on: "2026-10-27" }),
    op({ type: "recipe.cooked", id: "cook-row-000002", recipe_id: "recipe-cook-0001", cooked_on: "2026-10-27" }),
  ]);
  assert.deepEqual(r.map((x) => [x.ok, x.result.cook_id]), [[true, "cook-row-000001"], [true, "cook-row-000001"]], "the server loads the day's row too");
  const full = await (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();
  assert.deepEqual(full.cooks.map((c) => [c.id, c.recipe_id, c.cooked_on]), [["cook-row-000001", "recipe-cook-0001", "2026-10-27"]]);
  const undo = await send(env, thomas, [op({ type: "recipe.uncooked", id: "cook-row-000001" })]);
  assert.equal(undo[0].ok, true);
  const delta = await (await call(env, "GET", `/api/sync?since=${full.rev}`, { cookie: thomas })).json();
  assert.ok(delta.cooks[0].deleted_at, "the tombstone reaches the other phones");
  const idle = await (await call(env, "GET", `/api/sync?since=${delta.rev}`, { cookie: thomas })).json();
  assert.equal(idle.cooks.length, 0);
});

test("label tool: only recipes without labels are sent, never a person's", () => {
  const plan = planLabels([
    { id: "r1", title: "A", labels_by: null },
    { id: "r2", title: "B", labels_by: "claude" },
    { id: "r3", title: "C", labels_by: "person" },
    { id: "r4", title: "D" },
  ]);
  assert.deepEqual(plan.todo.map((r) => r.id), ["r1", "r4"]);
  assert.deepEqual([plan.claude, plan.person], [1, 1]);
});

// ------------------------------------------------------------------ ranking

const TODAY = "2026-10-27";
const recipe = (id, extra = {}) => ({
  id, title: id, ingredients: [{ name: "ui" }], steps: ["kook"], nutrition: null,
  cuisine: "dutch", main_ingredient: "chicken", time_class: "normal", ...extra,
});
const fixed = () => 0.5;
const data = (recipes, extra = {}) => ({
  recipes: Object.fromEntries(recipes.map((r) => [r.id, r])), cooks: {}, purchases: {}, entries: {}, items: {}, ...extra,
});

test("ranking: the answers are hard filters; an unlabelled recipe passes only don't mind", () => {
  const r = recipe("r", { cuisine: "italian", main_ingredient: "pasta", time_class: "fast", nutrition: { carbs_g: 55 } });
  assert.equal(passes(r, {}), true);
  assert.equal(passes(r, { cuisine: "italian", main: "pasta", time: "fast", carbs: "normal" }), true);
  assert.equal(passes(r, { cuisine: "dutch" }), false);
  assert.equal(passes(r, { main: "chicken" }), false);
  assert.equal(passes(r, { carbs: "light" }), false, "55 g is not light");
  assert.equal(passes(recipe("slow", { time_class: "elaborate" }), { time: "normal" }), false);
  assert.equal(passes(recipe("slow", { time_class: "elaborate" }), { time: "elaborate" }), true);
  assert.equal(passes(recipe("fast", { time_class: "fast" }), { time: "normal" }), true, "time is what you have");
  const bare = recipe("bare", { cuisine: null, main_ingredient: null, time_class: null });
  assert.equal(passes(bare, { cuisine: "dutch" }), false);
  assert.equal(passes(bare, { main: "chicken" }), false);
  assert.equal(passes(bare, { time: "fast" }), false);
});

test("ranking: unknown carbs pass only don't mind", () => {
  const unknown = recipe("unknown");
  assert.equal(passes(unknown, { carbs: "light" }), false);
  assert.equal(passes(unknown, { carbs: "normal" }), false);
  assert.equal(passes(unknown, { carbs: null }), true);
  assert.equal(passes(recipe("low", { nutrition: { carbs_g: 30 } }), { carbs: "light" }), true);
});

test("ranking: long not eaten, in the house and in the bonus win, with their reasons", () => {
  const chicken = recipe("kip-curry", { ingredients: [{ name: "kipfilet" }, { name: "rijst" }, { name: "zout" }, { name: "koriander", optional: true }] });
  const mince = recipe("chili", { ingredients: [{ name: "gehakt" }, { name: "bonen" }] });
  const eaten = recipe("stamppot", { ingredients: [{ name: "boerenkool" }] });
  const d = data([chicken, mince, eaten], {
    cooks: {
      c1: { id: "c1", recipe_id: "stamppot", cooked_on: "2026-10-26" },
      c2: { id: "c2", recipe_id: "chili", cooked_on: "2026-09-14" },
    },
    items: { i1: { id: "i1", name: "kip", name_key: "kip" } },
    purchases: { p1: { id: "p1", item_id: "i1", title: "kip", bought_on: "2026-10-24" } },
  });
  const out = propose({ data: d, today: TODAY, random: fixed, bonus: [{ name: "AH Rundergehakt 500 g", until: "2026-11-02" }] });
  assert.deepEqual(out.map((p) => p.recipe.id), ["chili", "kip-curry", "stamppot"]);
  assert.deepEqual(out[0].reasons.map((r) => [r.key, r.vars]), [["not_eaten", { n: 43 }], ["bonus", { name: "gehakt" }]]);
  assert.deepEqual(out[1].reasons.map((r) => [r.key, r.vars]), [["in_house", { name: "kipfilet", day: "2026-10-24" }]],
    "half the main ingredients (salt and the optional coriander do not count)");
  assert.deepEqual(out[2].reasons, [], "eaten yesterday: last, and no reason to push it");
});

test("ranking: a line on the list counts, old purchases do not", () => {
  const d = data([recipe("soep", { ingredients: [{ name: "rode ui" }, { name: "tomaat" }] })], {
    items: { iu: { id: "iu", name_key: "ui" }, it: { id: "it", name_key: "tomaat" } },
    entries: { e1: { id: "e1", item_id: "iu", title: "Ui", checked_at: null } },
    purchases: { p1: { id: "p1", item_id: "it", title: "tomaat", bought_on: "2026-10-01" } },
  });
  const [p] = propose({ data: d, today: TODAY, random: fixed });
  assert.deepEqual(p.reasons.map((r) => [r.key, r.vars]), [["on_list", { name: "rode ui" }]]);
  assert.equal(sameThing("rode ui", "ui"), true);
  assert.equal(sameThing("kipfilet", "kip"), true);
  assert.equal(sameThing("uitjes", "ui"), false);
  assert.equal(sameThing("tomaat", "tomatenpuree"), false);
});

test("ranking: ideas may come up, marked as an idea; deleted and excluded ones never", () => {
  const idea = { id: "idee", title: "Pad thai", ingredients: [], steps: [], cuisine: "thai", main_ingredient: "noodles", time_class: "normal" };
  const gone = recipe("weg", { deleted_at: "2026-10-01T00:00:00Z" });
  const d = data([idea, gone, recipe("a"), recipe("b")]);
  const out = propose({ data: d, today: TODAY, random: fixed, count: 10 });
  assert.deepEqual(out.map((p) => p.recipe.id).sort(), ["a", "b", "idee"]);
  assert.equal(out.find((p) => p.recipe.id === "idee").idea, true);
  assert.equal(out.find((p) => p.recipe.id === "a").idea, false);
  assert.deepEqual(propose({ data: d, today: TODAY, random: fixed, exclude: ["a", "idee"] }).map((p) => p.recipe.id), ["b"]);
});

test("ranking: chance varies the three, the answers still hold", () => {
  const many = Array.from({ length: 12 }, (_, i) => recipe(`r${i}`));
  const seen = new Set();
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 20; i++) for (const p of propose({ data: data(many), today: TODAY, random: rnd })) seen.add(p.recipe.id);
  assert.ok(seen.size > 6, `only ${seen.size} different recipes in 20 runs`);
  assert.equal(propose({ data: data(many), answers: { cuisine: "thai" }, today: TODAY, random: rnd }).length, 0);
});

test("excluded: never a bonus reason, never counted as a main ingredient", () => {
  const stew = recipe("stoof", { ingredients: [{ name: "verse spruitjes" }, { name: "runderlappen" }, { name: "Groene Ster" }] });
  assert.deepEqual(mainIngredients(stew).map((i) => i.name), ["runderlappen"]);
  const bonus = [{ name: "Spruitjes extra fijn", until: "2026-11-02" }, { name: "Groene Ster spruitjes 500 g" }, { name: "Groenhof" }];
  assert.deepEqual(usableBonus(bonus, TODAY), []);
  const [p] = propose({ data: data([stew]), today: TODAY, random: fixed, bonus });
  assert.deepEqual(p.reasons, []);
  const ok = propose({ data: data([stew]), today: TODAY, random: fixed, bonus: [...bonus, { name: "AH Runderlappen" }] });
  assert.deepEqual(ok[0].reasons.map((r) => r.vars.name), ["runderlappen"]);
  assert.deepEqual(usableBonus([{ name: "Kipfilet", until: "2026-10-20" }], TODAY), [], "an expired offer is not mentioned");
});

test("wizard: only answers that still lead to a recipe are offered", () => {
  const recipes = {
    a: { id: "a", cuisine: "italian", main_ingredient: "pasta", time_class: "fast", nutrition: { carbs_g: 60 } },
    b: { id: "b", cuisine: "mexican", main_ingredient: "chicken", time_class: "normal" },
    c: { id: "c", cuisine: "italian", main_ingredient: "mince", time_class: "elaborate", deleted_at: "2026-10-01" },
  };
  assert.deepEqual(optionCounts(recipes, {}, "cuisine", ["italian", "mexican", "dutch"]), { italian: 1, mexican: 1, dutch: 0 },
    "a deleted recipe does not count");
  assert.deepEqual(optionCounts(recipes, { cuisine: "italian" }, "main", ["pasta", "chicken", "mince"]), { pasta: 1, chicken: 0, mince: 0 });
  assert.deepEqual(optionCounts(recipes, { cuisine: "mexican", main: null, time: null }, "carbs", ["light", "normal"]), { light: 0, normal: 0 },
    "unknown carbs only pass \"don't mind\"");
  assert.deepEqual(optionCounts(recipes, { cuisine: "italian", main: "pasta", carbs: "light" }, "time", ["fast", "normal"]), { fast: 1, normal: 1 },
    "later answers (left over after going back) do not count");
});

// ------------------------------------------------------------------- meals

test("meals: a set from the fixed vocabulary, stored in order, empty is unlabelled", () => {
  const s = emptyState();
  const put = (recipe) => applyOp(s, { type: "recipe.put", id: "recipe-pancake-1", recipe }, ctx());
  put({ title: "Pannenkoeken" });
  assert.equal(s.recipes["recipe-pancake-1"].meals, null);
  put({ meals: ["lunch", "breakfast", "lunch"], labels_by: "person" });
  assert.deepEqual(s.recipes["recipe-pancake-1"].meals, ["breakfast", "lunch"], "fixed order, no doubles");
  put({ meals: [], labels_by: "person" });
  assert.equal(s.recipes["recipe-pancake-1"].meals, null, "none is not labelled");
  const bad = (recipe) => assert.throws(() => put(recipe), (e) => e instanceof OpError && e.code === "bad_field");
  bad({ meals: ["supper"], labels_by: "person" });
  bad({ meals: "dinner", labels_by: "person" });
  bad({ meals: [1], labels_by: "person" });
  bad({ meals: ["dinner"] });   // labels must say who set them
  assert.deepEqual(mealsPatch({ meals: ["dinner", "brunch", "breakfast"] }), { meals: ["breakfast", "dinner"], labels_by: "claude" });
  assert.equal(mealsPatch({ meals: ["brunch"] }), null);
  assert.deepEqual(labelPatch({ ...LABELS, meals: ["dinner"] }).meals, ["dinner"]);
});

test("meals: Claude fills a person's empty meals and nothing else; a person's meals stay", () => {
  const s = emptyState();
  const put = (recipe) => applyOp(s, { type: "recipe.put", id: "recipe-curry-01", recipe }, ctx());
  put({ title: "Curry", cuisine: "indian", labels_by: "person" });
  assert.throws(() => put({ meals: ["dinner"], cuisine: "thai", labels_by: "claude" }), (e) => e.code === "labels_by_person",
    "meals together with another label: refused");
  put({ meals: ["dinner"], labels_by: "claude" });
  const r = s.recipes["recipe-curry-01"];
  assert.deepEqual([r.meals, r.cuisine, r.labels_by], [["dinner"], "indian", "person"], "the labels stay the person's");
  assert.throws(() => put({ meals: ["lunch"], labels_by: "claude" }), (e) => e.code === "labels_by_person",
    "once there are meals, Claude does not change them");
  put({ meals: ["lunch", "dinner"], labels_by: "person" });
  assert.deepEqual(s.recipes["recipe-curry-01"].meals, ["lunch", "dinner"], "the person may change them");

  // Claude's own labels: meals can be added on top.
  applyOp(s, { type: "recipe.put", id: "recipe-soup-001", recipe: { title: "Soep", ...LABELS, labels_by: "claude" } }, ctx());
  applyOp(s, { type: "recipe.put", id: "recipe-soup-001", recipe: { meals: ["lunch"], labels_by: "claude" } }, ctx());
  assert.deepEqual([s.recipes["recipe-soup-001"].meals, s.recipes["recipe-soup-001"].cuisine], [["lunch"], "italian"]);
});

test("meals route: only meals are asked and written, a person's other labels kept, no second call", async () => {
  const { env, thomas } = await household({ ANTHROPIC_API_KEY: "test-key-not-real" });
  await send(env, thomas, [
    op({ type: "recipe.put", id: "recipe-mine-0002", recipe: { ...RECIPE, ...LABELS, cuisine: "dutch", labels_by: "person" } }),
    op({ type: "recipe.put", id: "recipe-done-0002", recipe: { ...RECIPE, meals: ["lunch"], labels_by: "person" } }),
  ]);
  const claude = mockClaude({ meals: ["dinner"] });
  try {
    const res = await call(env, "POST", "/api/recipes/label", { cookie: thomas, body: { id: "recipe-mine-0002", only: "meals" } });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).labels, { meals: ["dinner"], labels_by: "claude" });
    assert.equal(claude.calls.length, 1);
    assert.deepEqual(Object.keys(claude.calls[0].body.output_config.format.schema.properties), ["meals"], "asks for meals only");

    const full = await (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();
    const mine = full.recipes.find((r) => r.id === "recipe-mine-0002");
    assert.deepEqual([mine.meals, mine.cuisine, mine.time_minutes, mine.labels_by], [["dinner"], "dutch", 45, "person"]);

    const again = await (await call(env, "POST", "/api/recipes/label", { cookie: thomas, body: { id: "recipe-mine-0002", only: "meals" } })).json();
    const done = await (await call(env, "POST", "/api/recipes/label", { cookie: thomas, body: { id: "recipe-done-0002", only: "meals" } })).json();
    assert.deepEqual([again.skipped, done.skipped], ["labelled", "labelled"]);
    assert.equal(claude.calls.length, 1, "no paid call when there are meals already");
    const odd = await call(env, "POST", "/api/recipes/label", { cookie: thomas, body: { id: "recipe-mine-0002", only: "cuisine" } });
    assert.equal(odd.status, 400);
    assert.equal(claude.calls.length, 1);
  } finally {
    claude.restore();
  }
});

test("label tool: --only meals sends every recipe without meals, a person's too", () => {
  const plan = planLabels([
    { id: "r1", title: "A", labels_by: "claude", cuisine: "dutch", meals: null },
    { id: "r2", title: "B", labels_by: "person", cuisine: "thai" },
    { id: "r3", title: "C", labels_by: "person", meals: ["lunch"] },
    { id: "r4", title: "D", labels_by: "claude", meals: ["dinner"] },
    { id: "r5", title: "E", labels_by: null },
    { id: "r6", title: "F", deleted_at: "2026-10-01" },
  ], { only: "meals" });
  assert.deepEqual(plan.todo.map((r) => r.id), ["r1", "r2", "r5"]);
  assert.deepEqual([plan.claude, plan.person], [1, 1]);
  assert.deepEqual(planLabels([{ id: "r1", labels_by: "claude", meals: null }]).todo, [], "without --only nothing changes");
});

test("wizard: the meal is the first question; a recipe without meals passes only don't mind", () => {
  assert.equal(QUESTIONS[0], "meal");
  const pancakes = recipe("pancakes", { meals: ["breakfast", "lunch"] });
  assert.equal(passes(pancakes, { meal: "breakfast" }), true);
  assert.equal(passes(pancakes, { meal: "lunch" }), true);
  assert.equal(passes(pancakes, { meal: "dinner" }), false);
  assert.equal(passes(recipe("bare"), { meal: "dinner" }), false);
  assert.equal(passes(recipe("bare"), { meal: null }), true);

  const recipes = {
    a: { id: "a", meals: ["dinner"], cuisine: "italian", main_ingredient: "pasta", time_class: "fast" },
    b: { id: "b", meals: ["breakfast", "lunch"], cuisine: "dutch", main_ingredient: "eggs", time_class: "fast" },
    c: { id: "c", cuisine: "mexican", main_ingredient: "chicken", time_class: "normal" },
    d: { id: "d", meals: ["lunch"], cuisine: "thai", deleted_at: "2026-10-01" },
  };
  assert.deepEqual(optionCounts(recipes, {}, "meal", ["breakfast", "lunch", "dinner"]), { breakfast: 1, lunch: 1, dinner: 1 });
  assert.deepEqual(optionCounts(recipes, { meal: "dinner" }, "cuisine", ["italian", "dutch", "mexican"]), { italian: 1, dutch: 0, mexican: 0 },
    "the meal filters the later questions");
  assert.deepEqual(optionCounts(recipes, { meal: null }, "cuisine", ["italian", "dutch", "mexican"]), { italian: 1, dutch: 1, mexican: 1 },
    "don't mind keeps the recipe without meals");
  assert.deepEqual(optionCounts({ c: recipes.c }, {}, "meal", ["breakfast", "lunch", "dinner"]), { breakfast: 0, lunch: 0, dinner: 0 },
    "a meal no recipe has is hidden");
  const picked = propose({ data: data(Object.values(recipes).map((r) => recipe(r.id, r))), answers: { meal: "breakfast" }, today: TODAY, random: fixed });
  assert.deepEqual(picked.map((p) => p.recipe.id), ["b"]);
});

test("wizard: the meal that fits the time of day is offered first", () => {
  // Snack and dessert are never "the meal of the hour": they come last.
  assert.deepEqual(mealsForHour(7), ["breakfast", "lunch", "dinner", "snack", "dessert"]);
  assert.deepEqual(mealsForHour(10), ["breakfast", "lunch", "dinner", "snack", "dessert"]);
  assert.deepEqual(mealsForHour(11), ["lunch", "breakfast", "dinner", "snack", "dessert"]);
  assert.deepEqual(mealsForHour(15), ["lunch", "breakfast", "dinner", "snack", "dessert"]);
  assert.deepEqual(mealsForHour(16), ["dinner", "breakfast", "lunch", "snack", "dessert"]);
  assert.deepEqual(mealsForHour(23), ["dinner", "breakfast", "lunch", "snack", "dessert"]);
  assert.deepEqual(mealsForHour(0), ["breakfast", "lunch", "dinner", "snack", "dessert"]);
});
