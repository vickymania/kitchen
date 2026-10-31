import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseIngredient, nameKey, scaleIngredient, mergeAmounts, parseAmount, formatQty,
} from "../public/shared/ingredients.js";
import { ingredientsFromSteps, parseRecipeText, splitTitle } from "../public/shared/recipe-text.js";

const p = (line) => {
  const { qty, qty_max, unit, name, note, optional } = parseIngredient(line);
  return { qty, qty_max, unit, name, note, optional };
};

test("quantities, units and names from Thomas's own format", () => {
  assert.deepEqual(p("300 gr rijst"), { qty: 300, qty_max: null, unit: "g", name: "rijst", note: "", optional: false });
  assert.deepEqual(p("2 ui"), { qty: 2, qty_max: null, unit: null, name: "ui", note: "", optional: false });
  assert.deepEqual(p("1 blokje kippenbouillon (Maggi)"), { qty: 1, qty_max: null, unit: "cube", name: "kippenbouillon", note: "Maggi", optional: false });
  assert.deepEqual(p("250 ml crème fraîche"), { qty: 250, qty_max: null, unit: "ml", name: "crème fraîche", note: "", optional: false });
  assert.deepEqual(p("2 eetlepel kerriepoeder"), { qty: 2, qty_max: null, unit: "tbsp", name: "kerriepoeder", note: "", optional: false });
  assert.deepEqual(p("verse (platte) peterselie"), { qty: null, qty_max: null, unit: null, name: "verse peterselie", note: "platte", optional: false });
  assert.deepEqual(p("optioneel: maïzena"), { qty: null, qty_max: null, unit: null, name: "maïzena", note: "", optional: true });
});

test("the shapes pasted from websites", () => {
  assert.equal(p("▢400 gram bami groenten (voorgesneden groentepakket)").unit, "g");
  assert.equal(p("▢2 teentjes knoflook").unit, "clove");
  assert.equal(p("▢2 teentjes knoflook").name, "knoflook");
  assert.deepEqual(p("200ml water"), { qty: 200, qty_max: null, unit: "ml", name: "water", note: "", optional: false });
  assert.equal(p("snufje komijn").qty, 1);
  assert.equal(p("snufje komijn").unit, "pinch");
  assert.deepEqual(p("(Geraspte kaas)"), { qty: null, qty_max: null, unit: null, name: "Geraspte kaas", note: "", optional: true });
  assert.equal(p("1 blik gepelde tomaten (400 gram)").note, "400 gram");
  assert.equal(p("½ tl zout").qty, 0.5);
  assert.equal(p("1,5 kg aardappelen").qty, 1.5);
  assert.equal(p("1 1/2 el suiker").qty, 1.5);
  assert.deepEqual([p("2-3 tenen knoflook").qty, p("2-3 tenen knoflook").qty_max], [2, 3]);
  assert.equal(p("Optioneel: Snufje chili").optional, true);
  assert.equal(p("Optioneel: Snufje chili").name, "chili");
});

test("a lone letter is a unit only after a number", () => {
  assert.equal(p("2 l melk").unit, "l");
  assert.equal(p("limoen").name, "limoen");
  assert.equal(p("limoen").unit, null);
});

test("name keys find the same item", () => {
  assert.equal(nameKey("Ui"), nameKey(" ui "));
  assert.equal(nameKey("Crème fraîche"), "creme fraiche");
  assert.equal(nameKey("uien (rood)"), "uien");
});

test("scaling rounds the way a cook would", () => {
  const ing = parseIngredient("300 gr rijst");
  assert.equal(scaleIngredient(ing, 4, 2).qty, 150);
  assert.equal(scaleIngredient(parseIngredient("1 ui"), 4, 6).qty, 1.5);
  assert.equal(scaleIngredient(parseIngredient("snufje zout"), 4, 8).qty, 1);
  assert.equal(scaleIngredient(parseIngredient("verse peterselie"), 4, 8).qty, null);
});

test("amounts add up across units of the same kind", () => {
  assert.deepEqual(mergeAmounts([{ qty: 400, unit: "g" }], [{ qty: 300, unit: "g" }]), [{ qty: 700, unit: "g" }]);
  assert.deepEqual(mergeAmounts([{ qty: 800, unit: "g" }], [{ qty: 0.5, unit: "kg" }]), [{ qty: 1.3, unit: "kg" }]);
  assert.deepEqual(mergeAmounts([{ qty: 2, unit: null }], [{ qty: 1, unit: null }]), [{ qty: 3, unit: null }]);
  assert.deepEqual(mergeAmounts([{ qty: 2, unit: "tbsp" }], [{ qty: 100, unit: "g" }]), [{ qty: 2, unit: "tbsp" }, { qty: 100, unit: "g" }]);
  assert.deepEqual(mergeAmounts([{ text: "1 grote" }], [{ text: "1 grote" }]), [{ text: "1 grote" }]);
});

test("typed amounts", () => {
  assert.deepEqual(parseAmount("500 gr"), [{ qty: 500, unit: "g" }]);
  assert.deepEqual(parseAmount("2"), [{ qty: 2, unit: null }]);
  assert.deepEqual(parseAmount("een grote"), [{ text: "een grote" }]);
  assert.deepEqual(parseAmount(""), []);
});

test("numbers read like a recipe", () => {
  assert.equal(formatQty(0.5), "½");
  assert.equal(formatQty(1.5), "1½");
  assert.equal(formatQty(1.3, "nl"), "1,3");
  assert.equal(formatQty(1.3, "en"), "1.3");
  assert.equal(formatQty(700), "700");
});

test("a To Do note with a heading glued on and the block pasted twice", () => {
  const note = [
    "Voedingswaarde per portie",
    "Calorieën: 295kcal | Koolhydraten: 57g | Eiwitten: 4g | Vetten: 2g | Verzadigd vet: 1g",
    "", "Ingrediënten", "4 personen", "",
    "▢400 gram bami groenten", "▢250 gram mie", "▢olie, peper, zoutIngrediënten", "4 personen", "",
    "▢400 gram bami groenten", "▢250 gram mie", "▢olie, peper, zout", "",
    "Lekker met: gebakken ei, gebakken uitjes, atjar.",
  ].join("\n");
  const r = parseRecipeText(note);
  assert.equal(r.servings, 4);
  assert.deepEqual(r.ingredients.map((i) => i.name), ["bami groenten", "mie", "olie, peper, zout"]);
  assert.equal(r.nutrition.carbs_g, 57);
  assert.equal(r.nutrition.kcal, 295);
  assert.match(r.notes, /^Lekker met:/);
});

test("Thomas's own format: servings line, tip at the end", () => {
  const r = parseRecipeText("4 Personen:\n\n300 gr rijst\n2 ui\noptioneel: maïzena\n\nOok lekker koolhydraatarm met bloemkoolrijst");
  assert.equal(r.servings, 4);
  assert.equal(r.ingredients.length, 3);
  assert.equal(r.notes, "Ook lekker koolhydraatarm met bloemkoolrijst");
});

test("an intro sentence and serving suggestions in brackets", () => {
  const r = parseRecipeText("Heerlijk om te serveren met wraps, tortillachips en rijst\nRecept voor 4 personen\nIngrediënten\n\n(Geraspte kaas)\n▢500 gram rundergehakt\n▢olie, peper en zout");
  assert.equal(r.servings, 4);
  assert.deepEqual(r.ingredients.map((i) => [i.name, i.optional]), [["Geraspte kaas", true], ["rundergehakt", false], ["olie, peper en zout", false]]);
  assert.match(r.notes, /^Heerlijk/);
});

test("sub-headings: a colon, a dashed rule, or a dash over undashed lines", () => {
  const r = parseRecipeText([
    "- Deeg", "500g wit patentbloem", "½ tl zout", "", "- ­Verder nodig", "knoflooksaus", "",
    "Sate:", "400 g kip", "Teriyaki Saus-----------", "3 el Bruine suiker",
  ].join("\n"));
  assert.deepEqual(r.ingredients.filter((i) => i.heading).map((i) => i.name), ["Deeg", "Verder nodig", "Sate", "Teriyaki Saus"]);
  assert.equal(r.ingredients.filter((i) => !i.heading).length, 5);
});

test("in a list where every line has a dash, no line is a heading (Hunters' Chicken)", () => {
  const r = parseRecipeText("Ingrediënten:\n- 4 kippenborst\n- 100g geraspte kaas\n\nGroenten:\n- sperziebonen\n- broccoli\n\nTip: maak zelf je bbq saus");
  assert.deepEqual(r.ingredients.map((i) => (i.heading ? `## ${i.name}` : i.name)), ["kippenborst", "geraspte kaas", "## Groenten", "sperziebonen", "broccoli"]);
  assert.equal(r.notes, "Tip: maak zelf je bbq saus");
  const burgers = parseRecipeText("Voor 6 burgers\n- 6 Italiaanse bollen\n- Paneermeel, op gevoel\n- Ketchup, scheut\n- friet voor ernaast");
  assert.equal(burgers.servings, 6);
  assert.deepEqual(burgers.ingredients.map((i) => [i.name, i.note, Boolean(i.heading)]),
    [["Italiaanse bollen", "", false], ["Paneermeel", "op gevoel", false], ["Ketchup", "scheut", false], ["friet voor ernaast", "", false]]);
});

test("a whole list on one line is split (Bloemberg)", () => {
  const r = parseRecipeText("Ingrediënten 4 personen\n1 kg aardappelen, zout, peper, kerriepoeder, scheutje melk, boter, 2 uien, 400 g half om half gehakt.");
  assert.equal(r.servings, 4);
  assert.deepEqual(r.ingredients.map((i) => i.name), ["aardappelen", "zout", "peper", "kerriepoeder", "melk", "boter", "uien", "half om half gehakt"]);
});

test("ingredients kept as the first steps move over, instructions stay", () => {
  const { ingredients, steps } = ingredientsFromSteps(["75g Havermoutvlokken", "1 banaan", "snuf kaneel", "Blendeer allees en bak de pannenkoekjes"]);
  assert.deepEqual(ingredients.map((i) => i.name), ["Havermoutvlokken", "banaan", "kaneel"]);
  assert.deepEqual(steps, ["Blendeer allees en bak de pannenkoekjes"]);
  assert.equal(ingredientsFromSteps(["0) Pak pasta(500g) in boulion koken", "1.2) 2 uien"]).ingredients.length, 0);
});

test("titles carry the serving count", () => {
  assert.deepEqual(splitTitle("Pasta carbonara 4 p"), { title: "Pasta carbonara", servings: 4 });
  assert.deepEqual(splitTitle("Chicken teriyaki 2 personen"), { title: "Chicken teriyaki", servings: 2 });
  assert.deepEqual(splitTitle("Vegetarische Dahl 4p"), { title: "Vegetarische Dahl", servings: 4 });
  assert.deepEqual(splitTitle("Tortellini 3 jaar special"), { title: "Tortellini 3 jaar special", servings: null });
});

test("the same line in two sections stays twice: an egg for the dough and one for the filling", () => {
  const { ingredients } = parseRecipeText([
    "Voor het deeg:", "500 g bloem", "1 ei",
    "Voor de vulling:", "750 g gehakt", "1 ei", "1 ei",
    "Verder nodig:", "1 ei, losgeklopt",
  ].join("\n"));
  const lines = ingredients.map((i) => (i.heading ? `# ${i.name}` : i.raw));
  assert.deepEqual(lines, ["# Voor het deeg", "500 g bloem", "1 ei", "# Voor de vulling", "750 g gehakt", "1 ei", "# Verder nodig", "1 ei, losgeklopt"]);
});

test("sneetjes is a slice: '8 sneetjes brood' is 8 slices of brood (31-10-2026)", () => {
  const ing = parseIngredient("8 sneetjes brood");
  assert.deepEqual([ing.qty, ing.unit, ing.name], [8, "slice", "brood"]);
});
