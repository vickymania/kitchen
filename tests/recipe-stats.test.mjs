// Recipe stats and sorting (30-10-2026): how often a recipe was
// cooked (total and per person, tombstones out, one day once) and every order
// of the recipe book, with unrated / no-time / never-cooked items last.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cookStats, recipeCooks, recipeMinutes, sortRecipes, starsByRecipe, SORT_MODES } from "../public/shared/recipe-ratings.js";

const cook = (id, recipe_id, member_id, cooked_on, deleted_at = null) => ({ id, recipe_id, member_id, cooked_on, deleted_at });

test("cook stats count per person and in total", () => {
  const cooks = {
    a: cook("a", "r1", "thomas", "2026-10-01"),
    b: cook("b", "r1", "thomas", "2026-10-05"),
    c: cook("c", "r1", "henk", "2026-10-12"),
    d: cook("d", "r2", "henk", "2026-09-30"),
  };
  const s = cookStats(cooks).get("r1");
  assert.deepEqual(s, { total: 3, last: "2026-10-12", byMember: { thomas: 2, henk: 1 } });
  assert.equal(recipeCooks(cooks, "r2").total, 1);
  assert.equal(recipeCooks(cooks, "nope"), null);
});

test("cook stats skip tombstones", () => {
  const cooks = {
    a: cook("a", "r1", "thomas", "2026-10-01"),
    b: cook("b", "r1", "thomas", "2026-10-20", "2026-10-21T00:00:00Z"),
  };
  const s = recipeCooks(cooks, "r1");
  assert.equal(s.total, 1);
  assert.equal(s.last, "2026-10-01");
  assert.equal(recipeCooks({ b: cooks.b }, "r1"), null);
  assert.equal(cookStats(undefined).size, 0);
});

test("the same recipe on the same day counts once", () => {
  const cooks = {
    a: cook("a", "r1", "thomas", "2026-10-01"),
    b: cook("b", "r1", "thomas", "2026-10-01"),
    c: cook("c", "r1", "henk", "2026-10-01"),
  };
  const s = recipeCooks(cooks, "r1");
  assert.equal(s.total, 1);
  assert.deepEqual(s.byMember, { thomas: 1, henk: 1 });
});

const R = (id, title, extra = {}) => ({ id, title, ...extra });
const recipes = [
  R("a", "Appeltaart", { time_minutes: 90, created_at: "2026-10-03T10:00:00Z" }),
  R("b", "Bami", { time_minutes: 20, created_at: "2026-10-05T10:00:00Z" }),
  R("c", "Chili", { time_class: "normal", created_at: "2026-09-01T10:00:00Z" }),
  R("d", "Dahl", { created_at: "2026-10-04T10:00:00Z" }),
  R("e", "Erwtensoep", { time_class: "fast" }),
];
const ratings = {
  1: { recipe_id: "a", member_id: "m1", stars: 5, deleted_at: null },
  2: { recipe_id: "b", member_id: "m1", stars: 2, deleted_at: null },
  3: { recipe_id: "c", member_id: "m1", stars: 4, deleted_at: null },
  4: { recipe_id: "c", member_id: "m2", stars: 5, deleted_at: null },
};
const cooks = {
  1: cook("1", "a", "m1", "2026-10-01"),
  2: cook("2", "b", "m1", "2026-10-01"),
  3: cook("3", "b", "m1", "2026-10-09"),
  4: cook("4", "b", "m2", "2026-10-10"),
  5: cook("5", "c", "m1", "2026-10-20"),
};
const order = (mode) => sortRecipes([...recipes].reverse(), mode, {
  stars: starsByRecipe(ratings), cooks: cookStats(cooks), compare: (x, y) => x.localeCompare(y),
}).map((r) => r.id).join("");

test("A-Z is the default and the fallback for an unknown mode", () => {
  assert.equal(order("title"), "abcde");
  assert.equal(order("whatever"), "abcde");
});

test("stars: best and worst first, unrated last in both", () => {
  assert.equal(order("stars_best"), "acbde");
  assert.equal(order("stars_worst"), "bcade");
});

test("time: short and long first, no time last in both; a class stands in for minutes", () => {
  assert.equal(recipeMinutes(recipes[0]), 90);
  assert.equal(recipeMinutes(recipes[2]), 45);
  assert.equal(recipeMinutes(recipes[3]), null);
  assert.equal(order("time_short"), "becad");
  assert.equal(order("time_long"), "acbed");
});

test("most cooked counts days, never cooked last", () => {
  assert.equal(order("cooked_most"), "bacde");
});

test("recently cooked: newest day first, never cooked last", () => {
  assert.equal(order("cooked_recent"), "cbade");
});

test("longest not cooked: oldest last cook first, never cooked after all cooked ones", () => {
  const by = { ...cooks, 6: cook("6", "a", "m1", "2026-10-25") };
  const got = sortRecipes([...recipes].reverse(), "cooked_oldest", { cooks: cookStats(by), compare: (x, y) => x.localeCompare(y) });
  assert.equal(got.map((r) => r.id).join(""), "bcade");
  assert.equal(order("cooked_oldest"), "abcde");
});

test("newest added first, no date last", () => {
  assert.equal(order("newest"), "bdace");
});

test("every mode gives all recipes once and leaves the input alone", () => {
  const input = [...recipes];
  for (const mode of SORT_MODES) {
    assert.equal(order(mode).split("").sort().join(""), "abcde", mode);
  }
  sortRecipes(input, "newest");
  assert.deepEqual(input, recipes);
});
