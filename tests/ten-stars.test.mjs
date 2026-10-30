// Ten stars instead of five (30-10-2026): migration 0026 doubles the
// old 1-5 once and bumps the revs, rating.set and recipe.rate take 1-10 and
// refuse 0, 11 and non-integers, averages and "beste koop" read the new scale,
// the wizard weight keeps its old strength (2 = -1, 6 = 0, 10 = +1) and the
// screen texts say ten.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { makeEnv, applyMigration } from "./d1-shim.mjs";
import { applyOp, emptyState, OpError } from "../public/shared/ops.js";
import { starsByRecipe, starsPart, STARS_MAX, STARS_NEUTRAL } from "../public/shared/recipe-ratings.js";
import { scoreRecipe, STARS_REASON_MIN } from "../public/shared/wizard.js";
import { productStars, bestBuys } from "../public/shared/recent-purchases.js";

const ME = "member-thomas-01";
const ctx = (memberId = ME) => ({ memberId, isAdmin: true, now: "2026-10-30T09:00:00.000Z" });

test("migration 0026: every stars value doubles once, tombstones and cleared rows too, revs go up", async () => {
  const env = await makeEnv({ before: "0026" });
  await env.DB.exec(`
    INSERT INTO households (id, name, rev, created_at) VALUES ('hh-ten', 'Thuis', 40, 'x'), ('hh-none', 'Leeg', 7, 'x');
    INSERT INTO members (id, household_id, name, created_at, rev) VALUES ('m-1', 'hh-ten', 'Thomas', 'x', 1), ('m-2', 'hh-ten', 'Sam', 'x', 1);
    INSERT INTO products (id, household_id, name, product_key, created_at, updated_at, rev) VALUES ('p-1', 'hh-ten', 'Kaas', 'kaas||', 'x', 'x', 1);
    INSERT INTO ratings (id, household_id, member_id, product_id, stars, note, created_at, updated_at, deleted_at, rev) VALUES
      ('r-1', 'hh-ten', 'm-1', 'p-1', 1, '', 'x', 'x', NULL, 3),
      ('r-2', 'hh-ten', 'm-2', 'p-1', 5, '', 'x', 'x', '2026-10-01', 4);
    INSERT INTO recipe_ratings (id, household_id, member_id, recipe_id, stars, asked_on, created_at, updated_at, deleted_at, rev) VALUES
      ('q-1', 'hh-ten', 'm-1', 'rec-1', 3, '2026-10-29', 'x', 'x', NULL, 5),
      ('q-2', 'hh-ten', 'm-2', 'rec-1', NULL, '2026-10-29', 'x', 'x', NULL, 6),
      ('q-3', 'hh-ten', 'm-2', 'rec-2', 5, NULL, 'x', 'x', NULL, 6);`);
  applyMigration(env, "0026");
  const stars = async (table) => Object.fromEntries((await env.DB.prepare(`SELECT id, stars, rev FROM ${table}`).all()).results.map((r) => [r.id, [r.stars, r.rev]]));
  assert.deepEqual(await stars("ratings"), { "r-1": [2, 41], "r-2": [10, 41] });
  assert.deepEqual(await stars("recipe_ratings"), { "q-1": [6, 41], "q-2": [null, 6], "q-3": [10, 41] }, "a cleared row stays cleared and untouched");
  assert.equal((await env.DB.prepare("SELECT rev FROM households WHERE id = 'hh-ten'").first()).rev, 41, "the phones pull everything above 40");
  assert.equal((await env.DB.prepare("SELECT rev FROM households WHERE id = 'hh-none'").first()).rev, 7, "a household without stars is left alone");
});

test("migration 0026: a database without any stars migrates without error", async () => {
  const env = await makeEnv({ before: "0026" });
  applyMigration(env, "0026");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM ratings").first()).n, 0);
});

test("ops: rating.set and recipe.rate take 1 to 10 and refuse 0, 11, fractions and text", () => {
  assert.equal(STARS_MAX, 10);
  const s = emptyState();
  applyOp(s, { type: "product.put", id: "product-kaas-01", product: { name: "Oude kaas" } }, ctx());
  applyOp(s, { type: "recipe.put", id: "recipe-chili-001", recipe: { title: "Chili", servings: 2, ingredients: [], steps: ["Kook."] } }, ctx());
  for (const n of [1, 7, 10]) {
    applyOp(s, { type: "rating.set", id: "rating-t-0001", product_id: "product-kaas-01", stars: n }, ctx());
    assert.equal(s.ratings["rating-t-0001"].stars, n);
    applyOp(s, { type: "recipe.rate", id: "rrate-t-00001", recipe_id: "recipe-chili-001", stars: n, on: "2026-10-30" }, ctx());
    assert.equal(s.recipe_ratings["rrate-t-00001"].stars, n);
  }
  for (const bad of [0, 11, 100, -3, 5.5, "x", NaN]) {
    assert.throws(() => applyOp(s, { type: "rating.set", id: "rating-t-0001", product_id: "product-kaas-01", stars: bad }, ctx()), OpError, `rating.set ${bad}`);
    assert.throws(() => applyOp(s, { type: "recipe.rate", id: "rrate-t-00001", recipe_id: "recipe-chili-001", stars: bad, on: "2026-10-30" }, ctx()), OpError, `recipe.rate ${bad}`);
  }
  assert.equal(s.ratings["rating-t-0001"].stars, 10, "a refused op changes nothing");
});

test("averages: the household's average is on the 10 scale", () => {
  const rows = {
    a: { id: "a", member_id: "m1", recipe_id: "r", stars: 10, deleted_at: null },
    b: { id: "b", member_id: "m2", recipe_id: "r", stars: 7, deleted_at: null },
    c: { id: "c", member_id: "m3", recipe_id: "r", stars: null, deleted_at: null },
  };
  assert.deepEqual(starsByRecipe(rows).get("r"), { average: 8.5, count: 2, byMember: { m1: 10, m2: 7 } });
  const ratings = { x: { id: "x", member_id: "m1", product_id: "p", stars: 9 }, y: { id: "y", member_id: "m2", product_id: "p", stars: 4 } };
  assert.equal(productStars(ratings).get("p").average, 6.5);
});

test("beste koop: stars per euro picks the same product on the doubled scale", () => {
  const mk = (a, b) => ({
    items: { i: { id: "i", name: "Melk", deleted_at: null } },
    products: {
      "p-ah": { id: "p-ah", item_id: "i", name: "Halfvolle melk", brand: "", size: "1 l", last_price_cents: 109, deleted_at: null },
      "p-cb": { id: "p-cb", item_id: "i", name: "Campina melk", brand: "", size: "1 l", last_price_cents: 146, deleted_at: null },
    },
    ratings: { r1: { id: "r1", member_id: "m1", product_id: "p-ah", stars: a }, r2: { id: "r2", member_id: "m1", product_id: "p-cb", stars: b } },
  });
  assert.equal(bestBuys(mk(3, 5)).get("i").product.id, "p-cb");
  const doubled = bestBuys(mk(6, 10)).get("i");
  assert.equal(doubled.product.id, "p-cb");
  assert.equal(doubled.stars, 10);
  assert.equal(bestBuys(mk(6, 6)).get("i").product.id, "p-ah", "equal stars: the cheaper one");
});

test("wizard: the stars weight is the old one on the new scale (2 = -1, 6 = 0, 10 = +1)", () => {
  assert.equal(STARS_NEUTRAL, 6);
  assert.deepEqual([2, 6, 10, 9, 4].map(starsPart), [-1, 0, 1, 0.75, -0.5]);
  assert.equal(starsPart(1), -1, "one star is no lower than two");
  assert.equal(starsPart(undefined), 0);
  const recipe = { id: "r", title: "Chili", ingredients: [{ name: "spinazie", qty: 1, unit: null }], deleted_at: null };
  const score = (average) => scoreRecipe(recipe, { lastCooked: {}, house: [], bonus: [], today: "2026-10-30", stars: new Map([["r", { average, count: 1 }]]) });
  assert.ok(score(10).score > score(6).score && score(6).score > score(2).score);
  assert.equal(STARS_REASON_MIN, 8);
  assert.ok(score(8).reasons.some((r) => r.key === "stars"), "8 and up is a reason");
  assert.ok(!score(7.5).reasons.some((r) => r.key === "stars"));
});

test("display: the texts say ten and the compact forms are short", () => {
  for (const lang of ["nl", "en"]) {
    const text = JSON.parse(fs.readFileSync(new URL(`../public/i18n/${lang}.json`, import.meta.url), "utf8"));
    assert.match(text.product.pick_stars, /10/, lang);
    assert.doesNotMatch(JSON.stringify(text.rstars) + JSON.stringify(text.product.stars), /\/5|1 (tot|to) 5/, lang);
    assert.match(text.rstars.average.other.replace("{avg}", "8,5").replace("{n}", "2"), /^★8,5 · 2 /);
    assert.equal(text.rstars.reason.replace("{stars}", "9"), "★9");
  }
  const src = (f) => fs.readFileSync(new URL(`../public/app/${f}`, import.meta.url), "utf8");
  assert.doesNotMatch(src("stars.js") + src("product.js"), /\[1, 2, 3, 4, 5\]/, "no hard-coded five buttons");
});
