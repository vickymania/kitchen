import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { applyOp, emptyState } from "../public/shared/ops.js";
import { parseIngredient } from "../public/shared/ingredients.js";
import { estimateRecipe, needsEstimate, parseNevo } from "../tools/estimate_carbs.mjs";

const ctx = { memberId: "member-thomas", now: "2026-10-28T12:00:00.000Z", isAdmin: true };

// The NEVO file is pipe separated with the carbohydrate column named "CHO (g)".
const CSV = [
  '"NEVO-code"|"Voedingsmiddelnaam/Dutch food name"|"Hoeveelheid/Quantity"|"CHO (g)"',
  '5|"Rijst witte rauw"|"per 100g"|"78"',
  '63|"Ui rauw"|"per 100g"|"6,3"',
  '513|"Kaas Goudse 48+ gem"|"per 100g"|"0"',
  '884|"Paprika rode rauw"|"per 100g"|"4,3"',
  '1687|"Opvolgmelk per 100 ml"|"per 100ml"|"8,6"',
].join("\n");
const foods = parseNevo(CSV);
// 5 = rice, 63 = onion, 513 = cheese, 884 = red pepper in the tool's rules.

const recipe = (lines, servings = 2, nutrition = null) => ({
  id: "recipe-test1", title: "Test", servings, nutrition,
  ingredients: lines.map((l) => parseIngredient(l)),
});

test("NEVO file: decimal comma, per 100 g rows only", () => {
  assert.equal(foods.get(63).cho, 6.3);
  assert.equal(foods.get(5).name, "Rijst witte rauw");
  assert.equal(foods.has(1687), false);
});

test("carbs add up over the ingredients and divide by the servings", () => {
  const est = estimateRecipe(recipe(["200 g rijst", "2 ui", "100 g geraspte kaas", "1 tl zout", "200 ml water"], 2), foods);
  // 200 g rice = 156, 2 onions (150 g each) = 18.9
  assert.equal(Math.round(est.total * 10) / 10, 174.9);
  assert.equal(Math.round(est.perServing * 10) / 10, 87.5);
  assert.equal(est.confidence, "high");
  assert.deepEqual(est.reasons, []);
});

test("an unknown amount of a carb-rich food, an unmatched food or no servings is low confidence", () => {
  assert.equal(estimateRecipe(recipe(["rijst"]), foods).confidence, "low");
  const unmatched = estimateRecipe(recipe(["100 g dragonfruit"]), foods);
  assert.equal(unmatched.confidence, "low");
  assert.ok(unmatched.reasons.some((r) => r.includes("dragonfruit")));
  const noServings = estimateRecipe(recipe(["100 g rijst"], null), foods);
  assert.equal(noServings.perServing, null);
  assert.equal(noServings.confidence, "low");
});

test("a carb-free food without an amount does not lower the confidence, but is listed", () => {
  const est = estimateRecipe(recipe(["100 g rijst", "geraspte kaas"], 1), foods);
  assert.equal(est.confidence, "high");
  assert.equal(est.lines.find((l) => l.status === "negligible").label, "geraspte kaas");
});

test("optional lines are skipped and to-taste lines count as 0", () => {
  const est = estimateRecipe(recipe(["100 g rijst", "optioneel: 2 ui", "paprika, naar smaak"], 1), foods);
  assert.equal(Math.round(est.total), 78);
  assert.deepEqual(est.lines.map((l) => l.status), ["ok", "skipped", "to_taste"]);
});

test("only a cookable recipe without carbs needs an estimate", () => {
  assert.equal(needsEstimate(recipe(["100 g rijst"])), true);
  assert.equal(needsEstimate(recipe(["100 g rijst"], 2, { carbs_g: 40 })), false);
  assert.equal(needsEstimate({ ...recipe([]), ingredients: [] }), false);
});

test("recipe.put keeps carbs_estimated and drops it without carbs", () => {
  const s = emptyState();
  applyOp(s, { type: "recipe.put", id: "recipe-test1", recipe: { title: "Test", nutrition: { carbs_g: 65, carbs_estimated: true } } }, ctx);
  assert.deepEqual(s.recipes["recipe-test1"].nutrition, { kcal: null, carbs_g: 65, protein_g: null, fat_g: null, carbs_estimated: true });
  applyOp(s, { type: "recipe.put", id: "recipe-test1", recipe: { nutrition: { carbs_g: 70 } } }, ctx);
  assert.equal(s.recipes["recipe-test1"].nutrition.carbs_estimated, undefined);
  applyOp(s, { type: "recipe.put", id: "recipe-test1", recipe: { nutrition: { kcal: 300, carbs_estimated: true } } }, ctx);
  assert.equal(s.recipes["recipe-test1"].nutrition.carbs_estimated, undefined);
});

test("the screens show 'estimated' wherever carbs show", () => {
  for (const file of ["public/app/recipe.js", "public/app/recipes.js"]) {
    assert.match(fs.readFileSync(file, "utf8"), /carbs_estimated/, file);
  }
  for (const lang of ["en", "nl"]) {
    const recipe = JSON.parse(fs.readFileSync(`public/i18n/${lang}.json`, "utf8")).recipe;
    assert.ok(recipe.carbs_estimated && recipe.carbs_short_estimated, lang);
  }
});
