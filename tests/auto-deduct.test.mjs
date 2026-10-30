// Cooking takes everything off the pantry, also what a recipe writes without
// an amount (28-10-2026: "ook de dingen 'met rust' moeten automatisch
// gaan, wat is anders het doel van voorraadbeheer?"): default portions per
// category, default pack sizes, stock cubes and garlic, and the "Op de lijst"
// sheet that knows what is at home. Pastapotje HenkTorino against a pantry
// like his is the case it was built for.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { cookTakes, listCover, needOf, householdPack, withDefaultPortion, packSize } from "../public/shared/pantry.js";
import { portionCategory, categoryPack, stapleDefault, PORTIONS } from "../public/shared/default-portions.js";
import { parseIngredient, scaleIngredient, nameKey } from "../public/shared/ingredients.js";

const DAY = "2026-10-28";
const ing = (line) => parseIngredient(line);
const head = (name) => ({ name, heading: true });

function pantryOf(rows) {
  return Object.fromEntries(rows.map((r, i) => [r.id, {
    id: r.id, item_id: r.item_id ?? `item-${r.id}`, taken: 0, pack_size: "", added_on: `2026-10-${String(10 + i).padStart(2, "0")}`,
    use_by: null, deleted_at: null, ...r,
  }]));
}

// Pastapotje HenkTorino, as it is in the recipe book (serves 3).
const HENK = {
  id: "todo-791e381af57e24df79a6776a", servings: 3,
  ingredients: [
    head("Voor de pasta:"), ing("500 gr pasta"), ing("1 groenten bouillonblokje"),
    head("Voor de saus:"), ing("500 gr rundergehakt"), ing("2 uien"), ing("2 teen knoflook"), ing("Italiaanse kruiden"),
    ing("1 bakje champignons"), ing("400 gr Italiaanse groentemix"), ing("1 zakje macaroni kruidenmix"),
    head("Lekker erbij:"), ing("Ketchup"),
  ],
};

// A pantry like his on 28-10-2026: the rows that matter, and the look-alikes that must not be taken.
const HIS = () => ({
  pantry: pantryOf([
    { id: "p-pasta", title: "Pasta", amount: 1 },
    { id: "p-pasta-beker", title: "Pasta beker", amount: 1, pack_size: "1 beker" },
    { id: "p-groente-10", title: "Groentebouillon", amount: 10, pack_size: "1 blokje" },
    { id: "p-groente-5", title: "Groentebouillon", amount: 5, pack_size: "1 blokje" },
    { id: "p-kip-bouillon", title: "Kippenbouillon", amount: 11, pack_size: "1 blokje" },
    { id: "p-rund-bouillon", title: "Runderbouillon", amount: 5, pack_size: "1 blokje" },
    { id: "p-uien", title: "Uien", amount: 1, pack_size: "1 stuk", use_by: "2026-11-15" },
    { id: "p-rode-ui-1", title: "Rode ui", amount: 1, pack_size: "1 stuk", use_by: "2026-11-24" },
    { id: "p-rode-ui-2", title: "Rode ui", amount: 1, pack_size: "1 stuk", use_by: "2026-11-24" },
    { id: "p-knoflook", title: "Knoflook", amount: 3, pack_size: "1 bol", use_by: "2026-11-27" },
    { id: "p-knoflooksaus", title: "Knoflooksaus", amount: 0.5, use_by: "2026-11-27" },
    { id: "p-knoflookpoeder", title: "Knoflookpoeder?", amount: 1 },
    { id: "p-kruiden", title: "Italiaanse kruiden", amount: 0.3 },
    { id: "p-oregano", title: "Oregano", amount: 0.25 },
    { id: "p-ketchup", title: "Ketchup", amount: 1.5, use_by: "2026-11-27" },
    { id: "p-mayo", title: "Mayonaise", amount: 0.25, use_by: "2026-11-27" },
    { id: "p-peper", title: "Zwarte peper", amount: 1 },
    { id: "p-sprx", title: "Verse spruitjes", amount: 1 },
  ]),
  items: {}, pantry_events: {}, products: {}, preferences: {}, purchases: {},
});

const takesOf = (recipe, data, servings) => cookTakes({
  recipe, data, today: DAY, scale: servings ? (i) => scaleIngredient(i, recipe.servings, servings) : undefined,
}).map((t) => [t.pantry_id, t.amount, t.estimate]);

test("HenkTorino: everything it uses comes off, the look-alikes stay", () => {
  assert.deepEqual(takesOf(HENK, HIS(), 3), [
    ["p-pasta", 1, true], // 500 g of a bag of unknown size: the 500 g default, one bag, not more
    ["p-groente-10", 1, false], // one cube from the vegetable stock counted in cubes
    ["p-uien", 1, false], // "uien" without a colour is yellow: the one yellow onion, never the red ones
    ["p-knoflook", 0.2, false], // 2 cloves of a bulb of 10
    ["p-kruiden", 0.07, true], // 1 tl (1 g) of a 15 g jar
    ["p-ketchup", 0.06, true], // 2 el (30 ml) of a 500 ml bottle
  ]);
});

test("HenkTorino: the default portions scale with the servings cooked", () => {
  const by = Object.fromEntries(takesOf(HENK, HIS(), 6).map(([id, n]) => [id, n]));
  assert.equal(by["p-ketchup"], 0.12, "4 el for 6 instead of 3");
  assert.equal(by["p-kruiden"], 0.13, "2 tl");
  assert.equal(by["p-pasta"], 1, "1 kg wanted, one bag there: never below zero, never the Pasta beker");
  assert.equal(by["p-groente-10"], 2);
});

test("default portions: categories, salt and pepper ignored, never an excluded thing", () => {
  const cat = (name) => portionCategory(nameKey(name))?.id ?? null;
  assert.equal(cat("Ketchup"), "condiment");
  assert.equal(cat("Mayonaise"), "condiment");
  assert.equal(cat("Sambal oelek"), "condiment");
  assert.equal(cat("Ketjap manis"), "condiment");
  assert.equal(cat("Sojasaus"), "condiment");
  assert.equal(cat("Italiaanse kruiden"), "dried_herbs");
  assert.equal(cat("Oregano"), "dried_herbs");
  assert.equal(cat("Verse peterselie"), null, "fresh herbs are no jar");
  assert.equal(cat("Paprikapoeder"), "spices");
  assert.equal(cat("Kerrie"), "spices");
  assert.equal(cat("Bakpoeder"), null);
  assert.equal(cat("Olijfolie"), "oil");
  assert.equal(cat("Roomboter"), "butter");
  assert.equal(cat("Zout"), "salt_pepper");
  assert.equal(cat("Peper en zout"), "salt_pepper");
  assert.equal(cat("Zwarte peper"), "salt_pepper");
  assert.equal(cat("Rode peper"), null, "a fresh chili is no pepper from the mill");
  assert.equal(categoryPack(portionCategory("ketchup"), "ketchup"), "500 ml");
  assert.equal(categoryPack(portionCategory("sambal"), "sambal"), "250 ml");
  assert.equal(stapleDefault("pasta"), "500 g");
  assert.equal(stapleDefault("basmati rijst"), "1 kg");
  assert.equal(stapleDefault("bloem"), "1 kg");
  assert.equal(stapleDefault("kristalsuiker"), "1 kg");
  assert.equal(stapleDefault("verse pasta"), null);
  for (const c of PORTIONS) {
    if (c.ignore) continue;
    assert.ok(c.portion && c.tsp && c.packs?.length, c.id);
    assert.ok(packSize(c.packs.at(-1)[1]), `${c.id}: a fallback pack`);
  }
  assert.equal(withDefaultPortion(ing("zout")), null);
  assert.equal(withDefaultPortion(ing("verse koriander")), null);

  const data = {
    pantry: pantryOf([
      { id: "p-zout", title: "Zout", amount: 1 }, { id: "p-peper", title: "Zwarte peper", amount: 1 },
      { id: "p-boter", title: "Roomboter", amount: 2.25 }, { id: "p-olie", title: "Olijfolie", amount: 1 },
      { id: "p-sprx", title: "Verse spruitjes", amount: 1, pack_size: "750 ml" },
    ]),
    items: {}, pantry_events: {},
  };
  const recipe = { id: "recipe-defaults-01", servings: 2, ingredients: [
    ing("peper en zout"), ing("1 tl zout"), ing("zwarte peper"), ing("boter"), ing("olijfolie, naar smaak"), ing("2 el verse spruitjes"),
  ] };
  assert.deepEqual(takesOf(recipe, data), [["p-boter", 0.06, true], ["p-olie", 0.03, true]],
    "15 g of a 250 g block, 2 el of a litre; no salt, no pepper, never sprouts");
});

test("pack sizes: the household's own product before the default, never a whole pack because it is unknown", () => {
  const recipe = (line) => ({ id: "recipe-pack-01", ingredients: [ing(line)] });
  const base = () => ({ pantry: pantryOf([{ id: "p-pasta", item_id: "item-pasta", title: "Pasta", amount: 2 }, { id: "p-rijst", title: "Rijst", amount: 1 },
    { id: "p-kip", title: "Kipfilet", amount: 1 }, { id: "p-ketchup", item_id: "item-ketchup", title: "Ketchup", amount: 1 }]),
  items: {}, pantry_events: {}, products: {}, preferences: {}, purchases: {} });
  assert.deepEqual(takesOf(recipe("200 g pasta"), base()), [["p-pasta", 0.4, true]], "200 g of the 500 g default");
  assert.deepEqual(takesOf(recipe("750 g spaghetti"), { ...base(), pantry: pantryOf([{ id: "p-sp", title: "Spaghetti", amount: 2 }]) }), [["p-sp", 1.5, true]]);
  assert.deepEqual(takesOf(recipe("300 g rijst"), base()), [["p-rijst", 0.3, true]], "rice: 1 kg");
  assert.deepEqual(takesOf(recipe("400 g kipfilet"), base()), [["p-kip", 1, false]], "no default known: a real amount is still the pack");

  // His preferred pasta is a 1 kg bag.
  const pref = base();
  pref.products = { "prod-pasta-1kg": { id: "prod-pasta-1kg", item_id: "item-pasta", name: "AH Penne", size: "1 kg", deleted_at: null } };
  pref.preferences = { "pf-1": { id: "pf-1", item_id: "item-pasta", store: "", recipe_id: "", product_id: "prod-pasta-1kg", deleted_at: null } };
  assert.deepEqual(takesOf(recipe("500 g pasta"), pref), [["p-pasta", 0.5, false]], "the household's product size, no estimate");

  // The ketchup he buys most is a 700 ml bottle.
  const bought = base();
  bought.products = {
    "prod-k-700": { id: "prod-k-700", name: "Heinz ketchup", size: "700 ml", deleted_at: null },
    "prod-k-300": { id: "prod-k-300", name: "Knijpfles", size: "300 ml", deleted_at: null },
  };
  bought.purchases = Object.fromEntries([["a", "prod-k-700"], ["b", "prod-k-700"], ["c", "prod-k-300"]]
    .map(([id, product_id]) => [id, { id, item_id: "item-ketchup", product_id, bought_on: DAY, deleted_at: null }]));
  assert.deepEqual(householdPack(bought, bought.pantry["p-ketchup"]), { qty: 700, base: "ml" });
  assert.deepEqual(takesOf(recipe("Ketchup"), bought), [["p-ketchup", 0.04, true]], "30 ml of 700 ml");
});

test("stock cubes: each kind to its own row, a plain cube from the vegetable one first", () => {
  const data = () => ({ pantry: pantryOf([
    { id: "p-rund", title: "Runderbouillon", amount: 5, pack_size: "1 blokje" },
    { id: "p-kip", title: "Kippenbouillon", amount: 11, pack_size: "1 blokje" },
    { id: "p-groente", title: "Groentebouillon", amount: 1, pack_size: "1 blokje" },
  ]), items: {}, pantry_events: {} });
  const one = (line, d = data()) => takesOf({ id: `recipe-${nameKey(line).replace(/ /g, "-")}`, ingredients: [ing(line)] }, d);
  assert.deepEqual(one("1 groenten bouillonblokje"), [["p-groente", 1, false]]);
  assert.deepEqual(one("1 groentebouillonblokje"), [["p-groente", 1, false]]);
  assert.deepEqual(one("1 kippenbouillonblokje"), [["p-kip", 1, false]]);
  assert.deepEqual(one("2 blokjes runderbouillon"), [["p-rund", 2, false]]);
  assert.deepEqual(one("1 bouillonblokje"), [["p-groente", 1, false]], "the vegetable one first");
  assert.deepEqual(one("2 bouillonblokjes"), [["p-groente", 1, false]], "one vegetable cube left: that one, not more");
  const noVeg = data();
  noVeg.pantry["p-groente"].amount = 0;
  assert.deepEqual(one("1 bouillonblokje", noVeg), [["p-rund", 1, false]], "no vegetable stock: another kind (the oldest row)");
  assert.deepEqual(one("1 kippenbouillonblokje", { ...noVeg, pantry: pantryOf([{ id: "p-groente", title: "Groentebouillon", amount: 3, pack_size: "1 blokje" }]) }), [],
    "chicken stock never takes the vegetable stock");
  assert.deepEqual(packSize("1 blokje"), { qty: 1, base: "piece" });
});

test("garlic: cloves against bulbs, against a weight, and a bulb itself", () => {
  const row = (pack_size, amount = 3) => ({ pantry: pantryOf([{ id: "p-knoflook", title: "Knoflook", amount, pack_size }]), items: {}, pantry_events: {} });
  const one = (line, d) => takesOf({ id: "recipe-garlic-01", ingredients: [ing(line)] }, d);
  assert.deepEqual(one("2 tenen knoflook", row("1 bol")), [["p-knoflook", 0.2, false]]);
  assert.deepEqual(one("2 teentjes knoflook, geperst", row("")), [["p-knoflook", 0.2, false]], "a row without a size counts bulbs");
  assert.deepEqual(one("2 tenen knoflook", row("3 bollen", 1)), [["p-knoflook", 0.07, false]], "a net of 3 bulbs");
  assert.deepEqual(one("2 tenen knoflook", row("250 g", 1)), [["p-knoflook", 0.04, false]], "5 g a clove");
  assert.deepEqual(one("1 knoflook", row("1 bol")), [["p-knoflook", 1, false]], "a whole bulb");
  assert.deepEqual(packSize("1 bol"), { qty: 1, base: "piece" });
});

test("needOf: spoons of a thing without a category only against a known weight", () => {
  const row = (pack_size) => ({ id: "p", title: "Tomatenpuree", pack_size, item_id: "i" });
  assert.deepEqual(needOf(ing("2 el tomatenpuree"), row("140 g")), { packs: 30 / 140, estimate: true });
  assert.equal(needOf(ing("2 el tomatenpuree"), row("")), null, "unknown size: left alone");
  assert.equal(needOf(ing("snufje nootmuskaat"), row("30 g")), null, "a pinch is nothing");
});

test("the add-to-list sheet: what the pantry has enough of is unticked, a part stays ticked", () => {
  const scale = (i) => scaleIngredient(i, 3, 3);
  const cover = listCover({ recipe: HENK, data: HIS(), today: DAY, scale });
  const at = (name) => cover.get(HENK.ingredients.findIndex((i) => i.name === name));
  assert.deepEqual(at("pasta"), { on: false, have: 1, kind: "enough" }, "one 500 g bag for 500 g");
  assert.deepEqual(at("groenten bouillonblokje"), { on: false, have: 15, kind: "enough" }, "both rows count");
  assert.deepEqual(at("uien"), { on: true, have: 1, kind: "partial" }, "1 of the 2 onions: stays ticked, \"nog 1 in huis\"");
  assert.deepEqual(at("knoflook"), { on: false, have: 3, kind: "enough" });
  assert.deepEqual(at("Italiaanse kruiden"), { on: false, have: 0.3, kind: "enough" });
  assert.deepEqual(at("Ketchup"), { on: false, have: 1.5, kind: "enough" });
  assert.equal(at("rundergehakt"), undefined, "nothing in the house: no note, the sheet's own default");
  assert.equal(at("champignons"), undefined);

  // Cooked already today: the sheet still looks ahead to the next cook.
  const cooked = HIS();
  cooked.pantry_events = { e1: { id: "e1", reason: "cooked", recipe_id: HENK.id, happened_on: DAY, deleted_at: null } };
  assert.equal(listCover({ recipe: HENK, data: cooked, today: DAY, scale }).get(HENK.ingredients.findIndex((i) => i.name === "pasta")).kind, "enough");
  assert.deepEqual(cookTakes({ recipe: HENK, data: cooked, today: DAY }), []);

  // Double the servings: the one bag of pasta is a part now.
  const six = listCover({ recipe: HENK, data: HIS(), today: DAY, scale: (i) => scaleIngredient(i, 3, 6) });
  assert.deepEqual(six.get(HENK.ingredients.findIndex((i) => i.name === "pasta")), { on: true, have: 1, kind: "partial" });

  // In the house, amount unsure: a note, the default tick.
  const fresh = { id: "recipe-fresh-01", ingredients: [ing("verse peterselie")] };
  const d = { pantry: pantryOf([{ id: "p-pet", title: "Peterselie", amount: 1 }]), items: {}, pantry_events: {} };
  assert.deepEqual(listCover({ recipe: fresh, data: d, today: DAY }).get(0), { on: null, have: 1, kind: "have" });

  // Live amounts: ketchup counted down to nothing is not in the house.
  const rated = { pantry: pantryOf([{ id: "p-k", item_id: "item-k", title: "Ketchup", amount: 0.5, added_on: "2026-10-01" }]),
    items: { "item-k": { id: "item-k", name: "Ketchup", use_per_day: 0.1 } }, pantry_events: {} };
  assert.equal(listCover({ recipe: { id: "r-k", ingredients: [ing("Ketchup")] }, data: rated, today: DAY }).size, 0);

  // Never an excluded thing, not even as "in huis".
  const sprouts = { id: "r-w", ingredients: [ing("2 el verse spruitjes")] };
  assert.equal(listCover({ recipe: sprouts, data: HIS(), today: DAY }).size, 0);
});
