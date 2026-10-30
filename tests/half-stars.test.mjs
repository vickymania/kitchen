// Half stars (30-10-2026): ratings go from 0.5 to 10 in steps of 0.5,
// for recipes and products. The ops refuse everything else, the tap cycle is a
// pure function (n, then the half below, then nothing), a half star is drawn
// half full, averages keep one decimal and the database keeps the .5.
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeEnv } from "./d1-shim.mjs";
import { applyOp, emptyState, OpError } from "../public/shared/ops.js";
import { isStarValue, starsLabel, nextTap, starFill, starsByRecipe, rateAsks } from "../public/shared/recipe-ratings.js";
import { productStars, bestBuys } from "../public/shared/recent-purchases.js";

const ME = "member-thomas-01";
const ctx = () => ({ memberId: ME, isAdmin: true, now: "2026-10-30T09:00:00.000Z" });

test("ops: every half from 0.5 to 10 is kept, anything else is refused", () => {
  const s = emptyState();
  applyOp(s, { type: "product.put", id: "product-kaas-01", product: { name: "Oude kaas" } }, ctx());
  applyOp(s, { type: "recipe.put", id: "recipe-chili-001", recipe: { title: "Chili", servings: 2, ingredients: [], steps: ["Kook."] } }, ctx());
  for (let n = 1; n <= 20; n++) {
    const stars = n / 2;
    applyOp(s, { type: "rating.set", id: "rating-t-0001", product_id: "product-kaas-01", stars }, ctx());
    assert.equal(s.ratings["rating-t-0001"].stars, stars);
    applyOp(s, { type: "recipe.rate", id: "rrate-t-00001", recipe_id: "recipe-chili-001", stars, on: "2026-10-30" }, ctx());
    assert.equal(s.recipe_ratings["rrate-t-00001"].stars, stars);
  }
  for (const bad of [0, 0.3, 0.25, 6.7, 10.5, 11, -0.5, "x", "", NaN, Infinity, true]) {
    assert.throws(() => applyOp(s, { type: "rating.set", id: "rating-t-0001", product_id: "product-kaas-01", stars: bad }, ctx()), OpError, `rating.set ${bad}`);
    assert.throws(() => applyOp(s, { type: "recipe.rate", id: "rrate-t-00001", recipe_id: "recipe-chili-001", stars: bad, on: "2026-10-30" }, ctx()), OpError, `recipe.rate ${bad}`);
  }
  assert.equal(s.ratings["rating-t-0001"].stars, 10, "a refused op changes nothing");
  assert.equal(isStarValue(0.5) && isStarValue(9.5) && isStarValue(10), true);
  assert.equal(isStarValue(0) || isStarValue(10.5) || isStarValue(2.2) || isStarValue(null), false);
});

test("tap cycle: n, then the half below, then nothing; another star starts over", () => {
  assert.equal(nextTap(null, 7), 7);
  assert.equal(nextTap(7, 7), 6.5);
  assert.equal(nextTap(6.5, 7), null);
  assert.equal(nextTap(null, 1), 1);
  assert.equal(nextTap(1, 1), 0.5);
  assert.equal(nextTap(0.5, 1), null);
  assert.equal(nextTap(6.5, 9), 9, "another star gives its whole number");
  assert.equal(nextTap(7, 3), 3);
  assert.equal(nextTap(6.5, 6), 6, "the star below a half is a whole tap");
  // A full run on one star comes back to where it began.
  let v = null;
  const seen = [];
  for (let i = 0; i < 4; i++) { v = nextTap(v, 4); seen.push(v); }
  assert.deepEqual(seen, [4, 3.5, null, 4]);
});

test("drawing: stars up to the value are full, the one below a half is half, the rest empty", () => {
  const fills = (v) => Array.from({ length: 10 }, (_, i) => starFill(v, i + 1)).join(" ");
  assert.equal(fills(6.5), "full full full full full full half empty empty empty");
  assert.equal(fills(7), "full full full full full full full empty empty empty");
  assert.equal(fills(0.5), "half empty empty empty empty empty empty empty empty empty");
  assert.equal(fills(null), "empty empty empty empty empty empty empty empty empty empty");
});

test("display and averages: a Dutch comma, one decimal", () => {
  assert.equal(starsLabel(6.5), "★6,5");
  assert.equal(starsLabel(8), "★8");
  assert.equal(starsLabel(6.5, "en"), "★6.5");
  const rows = {
    a: { id: "a", member_id: "m1", recipe_id: "r", stars: 6.5, deleted_at: null },
    b: { id: "b", member_id: "m2", recipe_id: "r", stars: 7, deleted_at: null },
    c: { id: "c", member_id: "m3", recipe_id: "r", stars: 7.5, deleted_at: null },
    d: { id: "d", member_id: "m4", recipe_id: "r", stars: 6, deleted_at: null },
  };
  assert.equal(starsByRecipe(rows).get("r").average, 6.8);
  assert.equal(starsByRecipe(rows).get("r").byMember.m1, 6.5);
  assert.equal(productStars({ x: { product_id: "p", stars: 6.5 }, y: { product_id: "p", stars: 7 } }).get("p").average, 6.75);
  const view = { cooks: { c: { id: "c", recipe_id: "r", cooked_on: "2026-10-29" } }, recipes: { r: { id: "r", title: "Chili" } }, recipe_ratings: { a: { id: "a", member_id: "m1", recipe_id: "r", stars: 6.5 } } };
  assert.equal(rateAsks(view, "m1", "2026-10-30")[0].stars, 6.5, "the question shows a half star as given");
  assert.equal(typeof bestBuys, "function");
});

test("database: a half star survives the INTEGER column, in both tables", async () => {
  const env = await makeEnv();
  await env.DB.exec(`
    INSERT INTO households (id, name, rev, created_at) VALUES ('hh-1', 'Thuis', 1, 'x');
    INSERT INTO members (id, household_id, name, created_at, rev) VALUES ('m-1', 'hh-1', 'Thomas', 'x', 1);
    INSERT INTO products (id, household_id, name, product_key, created_at, updated_at, rev) VALUES ('x-1', 'hh-1', 'Kaas', 'kaas||', 'x', 'x', 1);`);
  await env.DB.prepare("INSERT INTO recipe_ratings (id, household_id, member_id, recipe_id, stars, created_at, updated_at, rev) VALUES ('q-1', 'hh-1', 'm-1', 'r-1', 6.5, 'x', 'x', 1)").run();
  await env.DB.prepare("INSERT INTO ratings (id, household_id, member_id, product_id, stars, created_at, updated_at, rev) VALUES ('p-1', 'hh-1', 'm-1', 'x-1', 0.5, 'x', 'x', 1)").run();
  assert.equal((await env.DB.prepare("SELECT stars FROM recipe_ratings WHERE id = 'q-1'").first()).stars, 6.5);
  assert.equal((await env.DB.prepare("SELECT stars FROM ratings WHERE id = 'p-1'").first()).stars, 0.5);
});
