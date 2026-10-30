// A recipe's ingredient lines find the household's own items (30-10-2026: an
// imported recipe for sausage rolls touched 4 of its 13 lines). One resolver
// for cooking (cookPlan: cookTakes, cookPending, listCover), "Op de lijst",
// the MCP's recipe_to_list and "product voor dit recept".
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIngredient } from "../public/shared/ingredients.js";
import { matchKeys, resolveIngredient, listTargets, numberForms, ingredientKey } from "../public/shared/ingredient-match.js";
import { cookTakes, cookPending, listCover } from "../public/shared/pantry.js";
import { applyOp, emptyState } from "../public/shared/ops.js";
import { auditRecipes, reportText } from "../tools/audit_recipe_items.mjs";

const DAY = "2026-10-30";
const p = (line) => parseIngredient(line);
const head = (name) => ({ name, heading: true });
const key = (s) => s.toLowerCase();

function itemsOf(names) {
  return Object.fromEntries(names.map((name) => {
    const id = `item-${key(name).replace(/[^a-z]+/g, "-")}`;
    return [id, { id, name, name_key: key(name), deleted_at: null }];
  }));
}
const named = (data, name) => resolveIngredient(name, data)?.item.name ?? null;

const HOUSE = {
  items: itemsOf(["Bloem", "Gehakt", "Eieren", "Melk", "Volle melk", "Beschuit", "Nootmuskaat", "Gist", "Zout", "Peper",
    "Rode ui", "Uien", "Basterdsuiker", "Roomboter", "Chilisaus", "Kaas", "Saus", "Paprika"]),
  aliases: {},
};

test("preparation after a comma or at the end is a note, not part of the name", () => {
  const cases = [
    ["200 ml melk, lauwwarm", "melk", "lauwwarm"],
    ["1 ei, losgeklopt", "ei", "losgeklopt"],
    ["1 ei losgeklopt", "ei", "losgeklopt"],
    ["2 beschuiten, verkruimeld", "beschuiten", "verkruimeld"],
    ["120 g boter, in blokjes", "boter", "in blokjes"],
    ["100 g boter, gesmolten", "boter", "gesmolten"],
    ["50 g boter, op kamertemperatuur", "boter", "op kamertemperatuur"],
    ["3 tenen knoflook, fijngehakt", "knoflook", "fijngehakt"],
    ["1 ui gesnipperd", "ui", "gesnipperd"],
    ["2 uien, gepeld en gesnipperd", "uien", "gepeld en gesnipperd"],
  ];
  for (const [line, name, note] of cases) {
    const r = p(line);
    assert.deepEqual([r.name, r.note], [name, note], line);
  }
  // Lists and mince stay whole.
  assert.equal(p("olie, peper, zout").name, "olie, peper, zout");
  assert.equal(p("750 g half-om-halfgehakt").name, "half-om-halfgehakt");
  assert.equal(p("half om half gehakt").name, "half om half gehakt");
  assert.equal(p("vegetarische gehaktballen").name, "vegetarische gehaktballen");
  // A line stored before the parser knew: the resolver reads it the same.
  assert.equal(ingredientKey("melk, lauwwarm"), "melk");
  assert.equal(ingredientKey("ei, losgeklopt"), "ei");
});

test("the real lines find the household's items", () => {
  const want = {
    "wit patentbloem": "Bloem",
    "half-om-halfgehakt": "Gehakt",
    "ei": "Eieren",
    "ei, losgeklopt": "Eieren",
    "melk, lauwwarm": "Melk",
    "beschuiten, verkruimeld": "Beschuit",
    "gemalen nootmuskaat": "Nootmuskaat",
    "instant gist": "Gist",
    "zout": "Zout",
    "boter": "Roomboter",
    "basterdsuiker": "Basterdsuiker",
    "chilisaus": "Chilisaus",
    "rundergehakt": "Gehakt",
    "verse paprika": "Paprika",
  };
  for (const [name, item] of Object.entries(want)) assert.equal(named(HOUSE, name), item, name);
  assert.equal(resolveIngredient("wit patentbloem", HOUSE).how, "compound");
  assert.equal(resolveIngredient("ei, losgeklopt", HOUSE).how, "same");
  assert.equal(resolveIngredient("beschuiten", HOUSE).how, "number");
  assert.equal(resolveIngredient("instant gist", HOUSE).how, "plain");
});

test("the most specific item wins; words that change the product are never dropped first", () => {
  // Half-om-half gehakt as its own item: that one, not Gehakt.
  const own = { items: itemsOf(["Gehakt", "Half om half gehakt"]), aliases: {} };
  assert.equal(named(own, "half-om-halfgehakt"), "Half om half gehakt");
  assert.equal(named(own, "rundergehakt"), "Gehakt");
  // Milk: the exact one first; "volle melk" falls back to Melk only when there is no Volle melk.
  assert.equal(named(HOUSE, "melk"), "Melk");
  assert.equal(named(HOUSE, "volle melk"), "Volle melk");
  assert.equal(named({ items: itemsOf(["Melk"]) }, "volle melk"), "Melk");
  assert.equal(named({ items: itemsOf(["Volle melk", "Halfvolle melk"]) }, "melk"), null, "a word is never added");
  // Colours: rode ui is Rode ui; with only Uien it is nothing; rode peper is no Peper.
  assert.equal(named(HOUSE, "rode ui"), "Rode ui");
  assert.equal(named(HOUSE, "ui"), "Uien");
  assert.equal(named(HOUSE, "2 uien".replace(/^\d+ /, "")), "Uien");
  assert.equal(named({ items: itemsOf(["Uien"]) }, "rode ui"), null);
  assert.equal(named(HOUSE, "rode peper"), null);
  // In the name is not the same thing.
  assert.equal(named(HOUSE, "kokosmelk"), null);
  assert.equal(named(HOUSE, "pindakaas"), null);
  assert.equal(named(HOUSE, "sojasaus"), null);
  // Never a typo.
  assert.equal(named(HOUSE, "bleom"), null);
  assert.equal(named(HOUSE, "gsit"), null);
});

test("aliases and merged names count, exact before anything looser", () => {
  const data = {
    items: {
      ...itemsOf(["Bloem", "Tarwebloem extra"]),
      "item-old-meel": { id: "item-old-meel", name: "Bakmeel", name_key: "bakmeel", deleted_at: "2026-10-29T00:00:00Z", merged_into: "item-bloem" },
    },
    aliases: { "alias-1": { id: "alias-1", item_id: "item-tarwebloem-extra", name: "Patentbloem", name_key: "patentbloem", deleted_at: null } },
  };
  assert.equal(named(data, "wit patentbloem"), "Tarwebloem extra", "the alias beats the compound rule");
  assert.equal(named(data, "bakmeel"), "Bloem", "a merged name goes where it went");
  assert.equal(named(data, "tarwebloem"), "Bloem");
  assert.equal(named({ items: itemsOf(["Tortillachips", "Chips"]) }, "tortilla chips"), "Tortillachips");
});

test("candidate names: deterministic, most specific first", () => {
  assert.deepEqual(matchKeys("ei, losgeklopt").map((x) => x.key), ["ei", "eieren", "eien"]);
  assert.equal(matchKeys("wit patentbloem")[0].key, "wit patentbloem");
  assert.deepEqual(matchKeys("wit patentbloem"), matchKeys("wit patentbloem"));
  assert.ok(!matchKeys("rundvlees").some((x) => x.key === "vlees"), "a generic line is never a candidate");
  assert.deepEqual(numberForms("beschuiten").slice(0, 1), ["beschuit"]);
  assert.ok(numberForms("tomaten").includes("tomaat"));
  assert.ok(numberForms("kip").includes("kippen"));
  assert.ok(numberForms("champignons").includes("champignon"));
});

test("a line of alternatives finds an item only when every alternative is that item; cooking takes nothing for it", () => {
  const data = {
    items: itemsOf(["Linzen", "Kikkererwten", "Kippenbouillon", "Groentebouillon", "Kip", "Water"]),
    aliases: { "alias-lens": { id: "alias-lens", item_id: "item-linzen", name: "Bruine linzen", name_key: "bruine linzen", deleted_at: null } },
  };
  assert.equal(named(data, "linzen of kikkererwten"), null, "two different items: nothing");
  assert.equal(named(data, "kippenbouillon, groentebouillon of water"), null);
  assert.equal(named(data, "linzen of rode bonen"), null, "one alternative unknown: nothing");
  assert.equal(named(data, "kippen- of runderbouillon"), null, "a half word never resolves (kippen- is no Kip)");
  assert.equal(named(data, "linzen en/of kikkererwten"), null);
  assert.equal(named(data, "bruine linzen of linzen"), "Linzen", "every alternative is the same item");
  assert.equal(named(data, "ei, losgeklopt met een scheutje melk of water"), null, "no Eieren here; the of is in the note, not an alternative");
  assert.equal(named(HOUSE, "ei, losgeklopt met een scheutje melk of water"), "Eieren");
  assert.deepEqual(listTargets("linzen of kikkererwten", data).map((t) => [t.item, t.title]), [[null, "linzen of kikkererwten"]], "on the list as its own words, no item");
  const kitchen = {
    items: data.items, aliases: data.aliases, pantry_events: {},
    pantry: {
      "p-linzen": { id: "p-linzen", item_id: "item-linzen", title: "Linzen", amount: 2, taken: 0, pack_size: "", added_on: DAY, use_by: null, deleted_at: null },
      "p-kikker": { id: "p-kikker", item_id: "item-kikkererwten", title: "Kikkererwten", amount: 2, taken: 0, pack_size: "", added_on: DAY, use_by: null, deleted_at: null },
    },
  };
  const takes = (line) => cookTakes({ recipe: { id: "recipe-alt-0001", ingredients: [p(line)] }, data: kitchen, today: DAY }).map((t) => t.pantry_id);
  assert.deepEqual(takes("1 blik linzen of kikkererwten"), [], "one of two: nothing taken");
  assert.deepEqual(takes("1 blik bruine linzen of linzen"), ["p-linzen"], "both the same item: taken");
});

test("apostrophe plurals, ripe and finely cut, and generic oil", () => {
  const data = { items: itemsOf(["Mango", "Knoflook", "Pita", "Olie"]), aliases: {} };
  assert.equal(named(data, "mango's"), "Mango");
  assert.equal(named(data, "mango’s"), "Mango", "a curly apostrophe too");
  assert.equal(named(data, "grote pita's"), "Pita");
  assert.equal(named(data, "mango's, eetrijp"), "Mango");
  assert.equal(named(data, "mango, rijp"), "Mango");
  assert.equal(named(data, "knoflook, fijngesneden"), "Knoflook");
  assert.equal(named(data, "knoflook fijngesneden"), "Knoflook");
  assert.equal(named(data, "knoflook, gesnipperd"), "Knoflook");
  assert.deepEqual([p("2 teentjes knoflook, fijngesneden").name, p("2 teentjes knoflook, fijngesneden").note], ["knoflook", "fijngesneden"]);
  assert.equal(named(data, "plantaardige olie"), null, "a generic oil is left alone, never forced onto Olie");
});

test("what goes on the list: the item's name, salt and pepper as two lines, unknown names without their preparation", () => {
  assert.deepEqual(listTargets("wit patentbloem", HOUSE).map((t) => t.title), ["Bloem"]);
  assert.deepEqual(listTargets("zout en peper", HOUSE).map((t) => t.title), ["Zout", "Peper"]);
  assert.deepEqual(listTargets("zout en peper", { items: {} }).map((t) => [t.title, t.item]), [["zout", null], ["peper", null]]);
  assert.deepEqual(listTargets("olie, peper en zout", HOUSE).map((t) => t.title), ["olie", "Peper", "Zout"]);
  assert.deepEqual(listTargets("kerriepasta, verkruimeld", HOUSE).map((t) => t.title), ["kerriepasta"]);
  assert.deepEqual(listTargets("kip en champignons", HOUSE).map((t) => t.title), ["kip en champignons"], "only known parts split");
});

// Sausage rolls as an imported recipe has them: three eggs in three places.
const ROLLS = {
  id: "recipe-rolls-01", title: "Worstenbroodjes van Thomas", servings: 12,
  ingredients: [
    head("Deeg:"), p("500 g wit patentbloem"), p("10 gram instant gist"), p("200 ml melk, lauwwarm"), p("1 ei"),
    p("120 g boter, in blokjes"), p("1 el basterdsuiker"), p("6 g zout"),
    head("Vulling:"), p("750 g half-om-halfgehakt"), p("2 beschuiten, verkruimeld"), p("1 ei, losgeklopt"),
    p("½ tl gemalen nootmuskaat"), p("1 el chilisaus"), p("zout en peper"),
    head("Afwerking:"), p("1 ei, losgeklopt"),
  ],
};

function pantryOf(rows) {
  return Object.fromEntries(rows.map((r, i) => [r.id, {
    id: r.id, taken: 0, pack_size: "", added_on: `2026-10-${String(10 + i).padStart(2, "0")}`, use_by: null, deleted_at: null, ...r,
  }]));
}
const KITCHEN = () => ({
  ...HOUSE,
  pantry: pantryOf([
    // A row's title is the product; its item decides.
    { id: "p-bloem", item_id: "item-bloem", title: "Huismerk tarwebloem", amount: 1, pack_size: "1 kg" },
    { id: "p-gehakt", item_id: "item-gehakt", title: "Gehakt", amount: 1, pack_size: "500 g" },
    { id: "p-eieren", item_id: "item-eieren", title: "Eieren", amount: 1, pack_size: "10 stuks" },
    { id: "p-melk", item_id: "item-melk", title: "Melk", amount: 1, pack_size: "1 l" },
    { id: "p-volle", item_id: "item-volle-melk", title: "Volle melk", amount: 1, pack_size: "1 l" },
    { id: "p-beschuit", item_id: "item-beschuit", title: "Beschuit", amount: 1, pack_size: "13 stuks" },
    { id: "p-gist", item_id: "item-gist", title: "Gist", amount: 1, pack_size: "7 g" },
    { id: "p-boter", item_id: "item-roomboter", title: "Roomboter", amount: 1, pack_size: "250 g" },
    { id: "p-nootmuskaat", item_id: "item-nootmuskaat", title: "Nootmuskaat", amount: 1, pack_size: "30 g" },
  ]),
  pantry_events: {}, products: {}, preferences: {}, purchases: {},
});

test("cooking takes the eggs three times, the flour, the mince and the rest from the right rows", () => {
  const takes = Object.fromEntries(cookTakes({ recipe: ROLLS, data: KITCHEN(), today: DAY }).map((t) => [t.pantry_id, t.amount]));
  assert.equal(takes["p-eieren"], 0.3, "3 eggs of 10");
  assert.equal(takes["p-bloem"], 0.5, "500 g of 1 kg");
  assert.equal(takes["p-gehakt"], 1, "all the mince there is");
  assert.equal(takes["p-melk"], 0.2, "Melk, never Volle melk");
  assert.equal(takes["p-volle"], undefined);
  assert.equal(takes["p-beschuit"], 0.15);
  assert.equal(takes["p-boter"], 0.48);
  assert.ok(takes["p-gist"] > 0, "instant gist is Gist");
  assert.ok(takes["p-nootmuskaat"] > 0, "gemalen nootmuskaat is Nootmuskaat");

  // What was missing waits for the receipt, on the right item: 250 g mince.
  const pending = cookPending({ recipe: ROLLS, data: KITCHEN(), today: DAY });
  const mince = pending.find((x) => x.item_id === "item-gehakt");
  assert.deepEqual([mince.qty, mince.unit], [250, "g"]);
  assert.ok(!pending.some((x) => /zout|peper/.test(x.name_key)), "salt and pepper are never pending");
  // Nothing in the house for basterdsuiker: pending on its item, not a stranger.
  assert.equal(pending.find((x) => x.name === "basterdsuiker")?.item_id, "item-basterdsuiker");

  // The sheet sees the same: the eggs line by line, each from what the previous ones left.
  const cover = listCover({ recipe: ROLLS, data: KITCHEN(), today: DAY });
  const eggs = ROLLS.ingredients.map((x, i) => [x, i]).filter(([x]) => /^ei\b/.test(x.name ?? "")).map(([, i]) => cover.get(i));
  assert.equal(eggs.length, 3);
  assert.ok(eggs.every((c) => c?.kind === "enough"));
  assert.equal(cover.get(ROLLS.ingredients.findIndex((x) => x.name === "half-om-halfgehakt")).kind, "partial");
});

test("on the list: three eggs are one Eieren line of 3, no item is made for the recipe's words", () => {
  const s = emptyState();
  Object.assign(s.items, structuredClone(HOUSE.items));
  const before = Object.keys(s.items).length;
  let n = 0;
  for (const ing of ROLLS.ingredients.filter((x) => !x.heading)) {
    const targets = listTargets(ing.name, s);
    for (const t of targets) {
      n++;
      applyOp(s, {
        type: "entry.add", id: `entry-line-${String(n).padStart(4, "0")}`, item_id: t.item?.id ?? `item-new-${String(n).padStart(4, "0")}`, title: t.title,
        amounts: ing.qty !== null && targets.length === 1 ? [{ qty: ing.qty, unit: ing.unit }] : [],
        source: { recipe_id: ROLLS.id, title: ROLLS.title },
      }, { memberId: "member-thomas", now: "2026-10-30T12:00:00.000Z", isAdmin: true });
    }
  }
  const lines = Object.values(s.entries);
  const eggs = lines.filter((e) => e.item_id === "item-eieren");
  assert.equal(eggs.length, 1);
  assert.deepEqual(eggs[0].amounts, [{ qty: 3, unit: null }]);
  assert.equal(lines.find((e) => e.item_id === "item-bloem").title, "Bloem");
  assert.equal(lines.find((e) => e.item_id === "item-gehakt").title, "Gehakt");
  assert.deepEqual(lines.filter((e) => e.item_id === "item-zout").map((e) => e.amounts), [[{ qty: 6, unit: "g" }]], "6 g zout and the zout of 'zout en peper' are one line");
  assert.ok(lines.some((e) => e.item_id === "item-peper"));
  assert.equal(Object.keys(s.items).length, before, "no new items");
});

test("the audit: every line, its item, the list and the pantry, and what is still unresolved", () => {
  const data = { ...KITCHEN(), recipes: { [ROLLS.id]: ROLLS, "recipe-x": { id: "recipe-x", title: "Soep van Noor", ingredients: [p("1 l water"), p("2 pastinaken"), p("1 sjalot")] } } };
  const audit = auditRecipes(data, DAY);
  assert.equal(audit.totals.unresolved, 2);
  assert.deepEqual(audit.unresolved.map((m) => m.key), ["pastinaken", "sjalot"]);
  assert.equal(audit.totals.skipped, 1, "tap water");
  const rolls = audit.recipes.find((r) => r.recipe.id === ROLLS.id);
  assert.ok(rolls.lines.every((l) => l.item), "every line of the rolls finds an item");
  const flour = rolls.lines.find((l) => l.name === "wit patentbloem");
  assert.deepEqual([flour.item, flour.how, flour.list, flour.pantry], ["Bloem", "compound", ["Bloem"], "Huismerk tarwebloem"]);
  const sp = rolls.lines.find((l) => l.name === "zout en peper");
  assert.deepEqual([sp.item, sp.how, sp.list], ["Zout + Peper", "split", ["Zout", "Peper"]]);
  const text = reportText(audit, { today: DAY });
  assert.match(text, /2 ingredient lines|ingredient lines: \d+ find an item, 2 do not/);
  assert.match(text, /wit patentbloem -> Bloem \(compound\)/);
});

// English recipes keep their language; only the matching translates (30-10-2026).
const DAKGANGJEONG = [
  ["900 g boneless chicken thigh fillets ((2 pounds), cut into bite size pieces)", "Kipdijfilet"],
  ["2 Tbsp fish sauce", null],
  ["1 tsp onion powder", "Uienpoeder"],
  ["1 tsp garlic powder", "Knoflookpoeder"],
  ["1 tsp fine sea salt", "Zout"],
  ["1/4 tsp ginger powder", "Gember gemalen"],
  ["1.5 cups corn starch", "Maizena"],
  ["cooking oil (for deep frying (I used rice bran oil))", null],
  ["1/4 cups soy sauce", "Sojasaus"],
  ["2 Tbsp brown sugar", "Basterdsuiker"],
  ["2 Tbsp honey", "Honing"],
  ["2 Tbsp water", null],
  ["1/2 Tbsp minced ginger", "Gember"],
  ["1/2 Tbsp minced garlic", "Knoflook"],
  ["3 dried chilies ((optional))", "Chilivlokken"],
  ["2 green onions ((optional), white part)", "Bosui"],
  ["2 tsp corn starch", "Maizena"],
  ["toasted sesame seeds", "Sesamzaad"],
  ["green onions (, thinly sliced)", "Bosui"],
];
const EN_HOUSE = {
  items: itemsOf(["Kipdijfilet", "Uienpoeder", "Knoflookpoeder", "Zout", "Gember gemalen", "Gember", "Maizena", "Sojasaus",
    "Basterdsuiker", "Honing", "Knoflook", "Chilivlokken", "Bosui", "Sesamzaad", "Zonnebloemolie", "Kipfilet"]),
  aliases: {},
};

test("English parsing: units, nested brackets, optional, preparation", () => {
  const r = p("900 g boneless chicken thigh fillets ((2 pounds), cut into bite size pieces)");
  assert.deepEqual([r.qty, r.unit, r.name], [900, "g", "chicken thigh fillets"]);
  assert.equal(r.note, "boneless; 2 pounds, cut into bite size pieces");
  const o = p("2 green onions ((optional), white part)");
  assert.deepEqual([o.optional, o.name, o.note], [true, "green onions", "white part"]);
  assert.equal(p("3 dried chilies ((optional))").optional, true);
  assert.equal(p("3 dried chilies ((optional))").note, "");
  assert.deepEqual([p("1.5 cups corn starch").qty, p("1.5 cups corn starch").unit], [1.5, "cup"]);
  assert.equal(p("2 Tbsp honey").unit, "tbsp");
  assert.equal(p("1 tbs honey").unit, "tbsp");
  assert.deepEqual([p("12 strips bacon").qty, p("12 strips bacon").unit, p("12 strips bacon").name], [12, "strip", "bacon"]);
  assert.deepEqual([p("2 lb potatoes").unit, p("2 lb potatoes").qty], ["g", 905]);
  assert.deepEqual([p("8 oz cheese").unit, p("8 oz cheese").qty], ["g", 225]);
  assert.equal(p("2 cups of flour").name, "flour");
  const m = p("1/2 Tbsp minced ginger");
  assert.deepEqual([m.name, m.note], ["ginger", "minced"]);
  assert.deepEqual([p("toasted sesame seeds").name, p("toasted sesame seeds").note], ["sesame seeds", "toasted"]);
  assert.deepEqual([p("green onions (, thinly sliced)").name, p("green onions (, thinly sliced)").note], ["green onions", "thinly sliced"]);
  assert.equal(p("cooking oil (for deep frying (I used rice bran oil))").name, "cooking oil");
  // Dutch stays Dutch.
  assert.deepEqual([p("200 g spekblokjes, uitgebakken").name, p("200 g spekblokjes, uitgebakken").note], ["spekblokjes", "uitgebakken"]);
  assert.equal(p("kippenbouillon (Maggi)").note, "Maggi");
  assert.equal(p("2 el van de saus").name, "van de saus");
});

test("an English recipe finds the Dutch household's items through the lexicon", () => {
  let linked = 0;
  for (const [line, want] of DAKGANGJEONG) {
    const got = named(EN_HOUSE, p(line).name);
    assert.equal(got, want, line);
    if (got) linked += 1;
  }
  assert.equal(linked, 16);
  // Exact and Dutch steps come first; the lexicon is the last step.
  assert.equal(resolveIngredient("zout", EN_HOUSE).how, "exact");
  assert.equal(resolveIngredient("soy sauce", EN_HOUSE).how, "english");
  // A generic oil stays unresolved unless the household has "Olie"; no typo guessing.
  const withOil = { items: itemsOf(["Olie"]), aliases: {} };
  assert.equal(named(withOil, "cooking oil"), "Olie");
  assert.equal(named(withOil, "soi sauce"), null);
  assert.equal(named(EN_HOUSE, "chicken breast"), "Kipfilet");
  assert.equal(named(EN_HOUSE, "fish sauce"), null);
  assert.equal(named(EN_HOUSE, "ginger powder"), "Gember gemalen");
  // Without "Gember gemalen" the powder falls back to Gember (gemalen is a free word).
  assert.equal(named({ items: itemsOf(["Gember"]), aliases: {} }, "ground ginger"), "Gember");
});
