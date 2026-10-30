// Stars for recipes (30-10-2026): recipe.rate per person (null
// clears, skip only answers the question), the household average, "Hoe was
// <recipe> gisteren?" the day after a cook (once, skippable), the stars in the
// wizard's ranking and in the MCP recipe tools' ranking.
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { applyOp, emptyState, OpError } from "../public/shared/ops.js";
import { importerMayApply } from "../worker/auth.js";
import { rateAsks, recipeStars, starsByRecipe, starsPart, ASK_AFTER_DAYS } from "../public/shared/recipe-ratings.js";
import { propose, scoreRecipe, WEIGHTS } from "../public/shared/wizard.js";

const THOMAS = "member-thomas-01";
const SAM = "member-sam-00001";
const ctx = (memberId, now = "2026-10-30T09:00:00.000Z") => ({ memberId, isAdmin: memberId === THOMAS, now });
const recipe = (id, title, extra = {}) => ({ id, title, servings: 2, ingredients: [{ name: "kipfilet", qty: 300, unit: "g" }], steps: ["Bak."], deleted_at: null, ...extra });

function withRecipes() {
  const s = emptyState();
  s.recipes["recipe-pasta-001"] = recipe("recipe-pasta-001", "Pastapotje HenkTorino");
  s.recipes["recipe-chili-001"] = recipe("recipe-chili-001", "Chili");
  return s;
}

// ------------------------------------------------------------ the op

test("recipe.rate: per member, the same again writes nothing, null clears, a bad value is refused", () => {
  const s = withRecipes();
  const rate = (memberId, o, now) => applyOp(s, { type: "recipe.rate", recipe_id: "recipe-pasta-001", on: "2026-10-30", ...o }, ctx(memberId, now));
  const first = rate(THOMAS, { id: "rrate-thomas-001", stars: 8 });
  assert.deepEqual(first.changed, [["recipe_ratings", "rrate-thomas-001"]]);
  assert.deepEqual(rate(THOMAS, { id: "rrate-thomas-999", stars: 8 }).changed, [], "the same stars again: nothing, and no second row");
  rate(SAM, { id: "rrate-sam-00001", stars: 4 });
  assert.equal(Object.keys(s.recipe_ratings).length, 2, "one row per person");
  assert.deepEqual(recipeStars(s.recipe_ratings, "recipe-pasta-001"), { average: 6, count: 2, byMember: { [THOMAS]: 8, [SAM]: 4 } });
  rate(THOMAS, { id: "rrate-thomas-001", stars: 10 }, "2026-10-30T10:00:00.000Z");
  assert.equal(s.recipe_ratings["rrate-thomas-001"].stars, 10, "a change patches the person's row");
  assert.equal(recipeStars(s.recipe_ratings, "recipe-pasta-001").average, 7);
  rate(SAM, { stars: null });
  assert.equal(s.recipe_ratings["rrate-sam-00001"].stars, null, "null clears");
  assert.equal(s.recipe_ratings["rrate-sam-00001"].deleted_at, null, "the row stays (it remembers the question was answered)");
  assert.deepEqual(recipeStars(s.recipe_ratings, "recipe-pasta-001"), { average: 10, count: 1, byMember: { [THOMAS]: 10 } }, "a cleared row is not in the average");
  assert.deepEqual(rate(SAM, { stars: null }).changed, [], "clearing twice: nothing");
  assert.deepEqual(applyOp(s, { type: "recipe.rate", recipe_id: "recipe-chili-001", stars: null }, ctx(THOMAS)).changed, [], "clearing what was never rated: nothing");
  for (const stars of [0, 11, 2.5, "x", -1]) assert.throws(() => rate(THOMAS, { stars }), OpError);
  assert.throws(() => applyOp(s, { type: "recipe.rate", id: "rrate-x-0000001", recipe_id: "recipe-none-0001", stars: 3 }, ctx(THOMAS)), OpError);
  assert.equal(importerMayApply({ type: "recipe.rate", recipe_id: "recipe-pasta-001", stars: 3 }), false, "the importer never rates");
});

test("starsPart: ten stars pull, two push, six or none is neutral", () => {
  assert.equal(starsPart(10), 1);
  assert.equal(starsPart(2), -1);
  assert.equal(starsPart(1), -1, "clamped");
  assert.equal(starsPart(6), 0);
  assert.equal(starsPart(null), 0);
  assert.equal(starsPart(8), 0.5);
  assert.equal(starsPart(9), 0.75);
});

// ------------------------------------------------------------ the day-after question

test("rateAsks: the day after a cook, not the same day, not two days later; once; skip", () => {
  const s = withRecipes();
  s.cooks["cook-pasta-0001"] = { id: "cook-pasta-0001", recipe_id: "recipe-pasta-001", cooked_on: "2026-10-29", deleted_at: null };
  assert.equal(ASK_AFTER_DAYS, 1);
  assert.deepEqual(rateAsks(s, THOMAS, "2026-10-29"), [], "not on the day of the cook: he still has to eat it");
  assert.deepEqual(rateAsks(s, THOMAS, "2026-10-30"), [{ recipe_id: "recipe-pasta-001", title: "Pastapotje HenkTorino", cooked_on: "2026-10-29", stars: null }]);
  assert.deepEqual(rateAsks(s, THOMAS, "2026-10-31"), [], "only the day after");
  // Sam answers: gone for Sam, still asked of Thomas.
  applyOp(s, { type: "recipe.rate", id: "rrate-sam-00001", recipe_id: "recipe-pasta-001", stars: 4, on: "2026-10-30" }, ctx(SAM));
  assert.deepEqual(rateAsks(s, SAM, "2026-10-30"), []);
  assert.equal(rateAsks(s, THOMAS, "2026-10-30").length, 1);
  // Thomas skips: no stars, no question again for this cook.
  const skip = applyOp(s, { type: "recipe.rate", id: "rrate-thomas-001", recipe_id: "recipe-pasta-001", skip: true, on: "2026-10-30" }, ctx(THOMAS));
  assert.equal(skip.changed.length, 1);
  assert.equal(s.recipe_ratings["rrate-thomas-001"].stars, null);
  assert.deepEqual(rateAsks(s, THOMAS, "2026-10-30"), []);
  assert.deepEqual(applyOp(s, { type: "recipe.rate", recipe_id: "recipe-pasta-001", skip: true, on: "2026-10-30" }, ctx(THOMAS)).changed, [], "skipping twice: nothing");
  assert.equal(recipeStars(s.recipe_ratings, "recipe-pasta-001").count, 1, "a skip is not a vote");
  // The next cook is asked about again, with the stars he gave before shown.
  applyOp(s, { type: "recipe.rate", recipe_id: "recipe-pasta-001", stars: 3, on: "2026-10-30" }, ctx(THOMAS));
  s.cooks["cook-pasta-0002"] = { id: "cook-pasta-0002", recipe_id: "recipe-pasta-001", cooked_on: "2026-11-05", deleted_at: null };
  assert.deepEqual(rateAsks(s, THOMAS, "2026-11-06").map((a) => [a.cooked_on, a.stars]), [["2026-11-05", 3]]);
  // Rated on the recipe page on the cooking evening itself: that cook is answered.
  s.cooks["cook-chili-0001"] = { id: "cook-chili-0001", recipe_id: "recipe-chili-001", cooked_on: "2026-11-05", deleted_at: null };
  applyOp(s, { type: "recipe.rate", id: "rrate-thomas-002", recipe_id: "recipe-chili-001", stars: 5, on: "2026-11-05" }, ctx(THOMAS));
  assert.deepEqual(rateAsks(s, THOMAS, "2026-11-06").map((a) => a.recipe_id), ["recipe-pasta-001"]);
  // An undone cook or a deleted recipe asks nothing; no person, nothing.
  s.cooks["cook-pasta-0002"].deleted_at = "2026-11-05T20:00:00.000Z";
  assert.deepEqual(rateAsks(s, THOMAS, "2026-11-06"), []);
  assert.deepEqual(rateAsks(s, null, "2026-10-30"), []);
});

test("rateAsks: two cooks of one recipe the day before are one question", () => {
  const s = withRecipes();
  s.cooks.a = { id: "a", recipe_id: "recipe-chili-001", cooked_on: "2026-10-29", deleted_at: null };
  s.cooks.b = { id: "b", recipe_id: "recipe-chili-001", cooked_on: "2026-10-29", deleted_at: null };
  s.cooks.c = { id: "c", recipe_id: "recipe-pasta-001", cooked_on: "2026-10-29", deleted_at: null };
  assert.deepEqual(rateAsks(s, THOMAS, "2026-10-30").map((a) => a.title), ["Chili", "Pastapotje HenkTorino"]);
});

// ------------------------------------------------------------ ranking

test("wizard ranking: the household's stars pull a recipe up and push a low-rated one down", () => {
  const data = withRecipes();
  for (const r of Object.values(data.recipes)) r.ingredients = [{ name: "spinazie", qty: 1, unit: null }];
  const ctxFor = (ratings) => ({ lastCooked: {}, house: [], bonus: [], today: "2026-10-30", stars: starsByRecipe(ratings) });
  const plain = scoreRecipe(data.recipes["recipe-pasta-001"], ctxFor({})).score;
  const rows = {
    a: { id: "a", member_id: THOMAS, recipe_id: "recipe-pasta-001", stars: 10 },
    b: { id: "b", member_id: SAM, recipe_id: "recipe-pasta-001", stars: 8 },
    c: { id: "c", member_id: THOMAS, recipe_id: "recipe-chili-001", stars: 2 },
  };
  const good = scoreRecipe(data.recipes["recipe-pasta-001"], ctxFor(rows));
  const bad = scoreRecipe(data.recipes["recipe-chili-001"], ctxFor(rows));
  assert.equal(good.score, plain + WEIGHTS.stars * 0.75);
  assert.equal(bad.score, plain - WEIGHTS.stars);
  assert.deepEqual(good.reasons.find((r) => r.key === "stars").vars, { stars: 9, n: 2 }, "8+ stars is a reason");
  assert.equal(bad.reasons.some((r) => r.key === "stars"), false, "low stars are no reason, they only rank lower");
  // In propose: with no chance, the five-star recipe comes first, the one-star last.
  data.recipes["recipe-soep-0001"] = recipe("recipe-soep-0001", "Soep", { ingredients: [{ name: "spinazie", qty: 1, unit: null }] });
  data.recipe_ratings = rows;
  const order = propose({ data, today: "2026-10-30", random: () => 0 }).map((p) => p.recipe.title);
  assert.deepEqual(order, ["Pastapotje HenkTorino", "Soep", "Chili"]);
  // Cleared stars count as none.
  data.recipe_ratings = { ...rows, c: { ...rows.c, stars: null } };
  assert.deepEqual(propose({ data, today: "2026-10-30", random: () => 0 }).map((p) => p.recipe.title).slice(1).sort(), ["Chili", "Soep"]);
});

// ------------------------------------------------------------ on the worker

const HOST = "recipes.localhost";
function call(env, method, p, { body, cookie } = {}) {
  const headers = { Origin: `http://${HOST}` };
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`http://${HOST}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
let counter = 0;
const op = (o) => ({ op_id: `op-rrate-${String(++counter).padStart(6, "0")}`, ...o });
async function send(env, cookie, ops) {
  return (await (await call(env, "POST", "/api/ops", { cookie, body: { ops } })).json()).results;
}
const pullAll = async (env, cookie, since = 0) => (await call(env, "GET", `/api/sync?since=${since}`, { cookie })).json();

test("D1: per member on the server, a replay is one row, the phone's own run gives the same row", async () => {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const thomas = tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456" } }));
  const code = await (await call(env, "POST", "/api/codes", { cookie: thomas, body: { for: "new_member", name: "Sam" } })).json();
  const sam = tokenOf(await call(env, "POST", "/api/pair", { body: { code: code.code } }));
  const put = op({ type: "recipe.put", id: "recipe-pasta-001", recipe: { title: "Pastapotje HenkTorino", servings: 2, ingredients: [], steps: ["Kook."] } });
  assert.equal((await send(env, thomas, [put]))[0].ok, true);
  const before = await pullAll(env, thomas);

  // The phone runs the op on its copy of the server state (public/app/store.js).
  const phone = emptyState();
  for (const [kind, rows] of Object.entries(before)) if (Array.isArray(rows) && phone[kind]) for (const r of rows) phone[kind][r.id] = r;
  const me = before.members.find((m) => m.name === "Thomas").id;
  const rate = { type: "recipe.rate", id: "rrate-thomas-001", recipe_id: "recipe-pasta-001", stars: 4, on: "2026-10-30" };
  applyOp(phone, rate, ctx(me, "2026-10-30T09:00:00.000Z"));

  const first = op(rate);
  assert.equal((await send(env, thomas, [first]))[0].ok, true);
  assert.deepEqual((await send(env, thomas, [first]))[0].result, { recipe_rating_id: "rrate-thomas-001" }, "the same op_id again: its first answer");
  assert.equal((await send(env, thomas, [op({ ...rate, id: "rrate-thomas-002" })]))[0].ok, true, "the same stars from another tap");
  const delta = await pullAll(env, thomas, before.rev);
  assert.equal(delta.recipe_ratings.length, 1, "one row per person, written once");
  const server = delta.recipe_ratings[0];
  const local = phone.recipe_ratings["rrate-thomas-001"];
  for (const f of ["id", "member_id", "recipe_id", "stars", "asked_on", "deleted_at"]) assert.equal(server[f], local[f], f);

  // Sam's own row; Thomas's stays.
  assert.equal((await send(env, sam, [op({ ...rate, id: "rrate-sam-00001", stars: 2 })]))[0].ok, true);
  assert.equal((await send(env, sam, [op({ type: "recipe.rate", recipe_id: "recipe-pasta-001", stars: null })]))[0].ok, true);
  const all = await pullAll(env, thomas);
  const rows = Object.fromEntries(all.recipe_ratings.map((r) => [r.id, r]));
  assert.equal(rows["rrate-thomas-001"].stars, 4);
  assert.equal(rows["rrate-sam-00001"].stars, null, "null clears on the server too");
  assert.deepEqual(recipeStars(rows, "recipe-pasta-001"), { average: 4, count: 1, byMember: { [me]: 4 } });
  assert.equal((await send(env, thomas, [op({ type: "recipe.rate", id: "rrate-x-0000001", recipe_id: "recipe-none-0001", stars: 3 })]))[0].error, "not_found");

  // An idle poll still reads only the counter: the new table adds no read.
  const idle = await pullAll(env, thomas, all.rev);
  assert.deepEqual(idle.recipe_ratings, []);
});
