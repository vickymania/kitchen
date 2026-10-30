// Deals without a rule (29-10-2026): what he buys often (on
// OFTEN_MIN_PURCHASES days within OFTEN_DAYS) is an implicit "only on offer"
// rule at AH and Dirk. Matched on the real offer names of 29-10-2026 against
// his real products: brand groups ("Alle Alpro en Melko", "Alle Chio chips")
// and generic Dirk names ("Houdbaar melk", "Plakken kaas") are found, as
// "check" hits unless clearly his product; "Geelvintonijn", "Kaasfondue",
// "Kaas croissants" and the hidden Fanta are not.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { dealsFor, oftenBought, oftenMatch, sizeFits, OFTEN_MIN_PURCHASES, OFTEN_DAYS } from "../public/shared/deals.js";

const TODAY = "2026-10-29";
const day = (n) => new Date(Date.parse(`${TODAY}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

const item = (id, name, extra = {}) => ({ id, name, deleted_at: null, ...extra });
const ITEMS = {
  kwark: item("item-kwark", "Kwark"),
  alpro: item("item-alpro", "Alpro \"yoghurt\""),
  chips: item("item-chips", "Chips"),
  melk: item("item-melk", "Melk"),
  ham: item("item-ham", "Ham"),
  kaas: item("item-kaas", "Kaas"),
  geraspt: item("item-geraspt", "Geraspte kaas"),
  tonijn: item("item-tonijn", "Tonijn"),
  siroop: item("item-siroop", "Siroop"),
  fanta: item("item-fanta", "Fanta", { again: "hide" }),
  nuggets: item("item-nuggets", "Kipnuggets", { low_off: 1 }),
  sprouts: item("item-sprx", "Verse spruitjes"),
  rare: item("item-rare", "Mozzarella"),
};
const product = (id, itemId, brand, name, size) => ({ id, item_id: itemId, brand, name, size, store: "Albert Heijn", last_price_cents: 199, deleted_at: null });
const PRODUCTS = {
  melko: product("p-melko", ITEMS.kwark.id, "Melko", "Melko Romige kwark mango kiwi banaan", "450 g"),
  alpro: product("p-alpro", ITEMS.alpro.id, "Alpro", "Alpro Plantaardig variatie perzik", "500 g"),
  chio: product("p-chio", ITEMS.chips.id, "Chio", "Chio Red paprika", "150 g"),
  party: product("p-party", ITEMS.chips.id, "Chio", "Chio Heartbreakers classic partypack", "170 g"),
  melk: product("p-melk", ITEMS.melk.id, "AH", "AH Houdbare volle melk", "1 l"),
  ham: product("p-ham", ITEMS.ham.id, "AH", "AH Beenham", "150 g"),
  kaas: product("p-kaas", ITEMS.kaas.id, "AH", "AH Goudse belegen plakken", "190 g"),
  geraspt: product("p-geraspt", ITEMS.geraspt.id, "AH", "AH Tex-mex geraspte kaas", "150 g"),
  tonijn: product("p-tonijn", ITEMS.tonijn.id, "Zeeparel", "Zeeparel Tonijnstukken in water", "145 g"),
  soda: product("p-soda", ITEMS.siroop.id, "Sodastream", "Sodastream Pepsi zero sodamix siroop", "440 ml"),
  fanta: product("p-fanta", ITEMS.fanta.id, "Fanta", "Fanta Orange", "1,5 l"),
};

// Three days each in the last year, through item_id or only through the product.
function purchases() {
  const out = {};
  let n = 0;
  const buy = (itemId, productId, ago) => {
    const id = `pu-${n++}`;
    out[id] = { id, item_id: productId ? null : itemId, product_id: productId, title: "x", bought_on: day(ago), store: "Albert Heijn", qty: 1, price_cents: 199, deleted_at: null };
  };
  for (const [itemId, productId] of [
    [ITEMS.kwark.id, PRODUCTS.melko.id], [ITEMS.alpro.id, PRODUCTS.alpro.id], [ITEMS.chips.id, PRODUCTS.chio.id],
    [ITEMS.melk.id, PRODUCTS.melk.id], [ITEMS.ham.id, PRODUCTS.ham.id], [ITEMS.kaas.id, PRODUCTS.kaas.id],
    [ITEMS.geraspt.id, PRODUCTS.geraspt.id], [ITEMS.tonijn.id, PRODUCTS.tonijn.id], [ITEMS.siroop.id, PRODUCTS.soda.id],
    [ITEMS.fanta.id, PRODUCTS.fanta.id], [ITEMS.nuggets.id, null], [ITEMS.sprouts.id, null],
  ]) for (const ago of [10, 60, 200]) buy(itemId, productId, ago);
  buy(ITEMS.chips.id, PRODUCTS.party.id, 30);
  // Mozzarella: twice this year, and once more than a year ago, and twice on one day.
  for (const ago of [5, 5, 100, OFTEN_DAYS + 3]) buy(ITEMS.rare.id, null, ago);
  return out;
}

const offer = (id, store, name, deal = null, price = null, size = null) => ({ id, store, name, brand: null, size, deal, price_cents: price, valid_from: "2026-10-27", valid_until: "2026-11-01", category: null, deleted_at: null });
const OFFERS = [
  offer("o-melko", "Albert Heijn", "Alle Alpro en Melko 400-500 gram", "2 voor 3.99", null, "500 gram"),
  offer("o-chio", "Albert Heijn", "Alle Chio chips 70-150 gram", "2 voor 2.99", null, "150 gram"),
  offer("o-soda", "Albert Heijn", "SodaStream soda mix no sugar red berry flavour", "50% korting"),
  offer("o-melk", "Dirk", "Houdbaar melk", "-58%", 129),
  offer("o-ham", "Dirk", "Ham", null, 199),
  offer("o-plak", "Dirk", "Plakken kaas", null, 399),
  offer("o-rasp", "Dirk", "Geraspte kaas", null, 149),
  offer("o-tuna", "Dirk", "Geelvintonijn", "-30%", 349),
  offer("o-fondue", "Dirk", "Kaasfondue", "-25%", 499),
  offer("o-crois", "Dirk", "Kaas croissants", "-30%", 199),
  offer("o-cola", "Albert Heijn", "Alle Coca-Cola en Fanta literflessen", "2 voor 3.50"),
  offer("o-nugget", "Dirk", "Kipnuggets", "-40%", 249),
  offer("o-sprx", "Albert Heijn", "Spruitjes extra fijn", "25% korting", 449),
  offer("o-ham-lidl", "Lidl", "Ham", "-50%", 99),
  offer("o-moz", "Dirk", "Mozzarella", "-20%", 89),
];

function view(extra = {}) {
  return {
    items: Object.fromEntries(Object.values(ITEMS).map((i) => [i.id, { ...i }])),
    products: Object.fromEntries(Object.values(PRODUCTS).map((p) => [p.id, { ...p }])),
    offers: Object.fromEntries(OFFERS.map((o) => [o.id, { ...o }])),
    purchases: purchases(), entries: {}, preferences: {}, recipes: {}, pantry: {}, pantry_events: {}, deal_rules: {},
    ...extra,
  };
}

test("often: the constants, and which items count as bought often", () => {
  assert.equal(OFTEN_MIN_PURCHASES, 3);
  assert.equal(OFTEN_DAYS, 365);
  const often = oftenBought(view(), TODAY);
  const names = often.map((o) => o.item.name).sort();
  assert.deepEqual(names, ["Alpro \"yoghurt\"", "Chips", "Geraspte kaas", "Ham", "Kaas", "Kwark", "Melk", "Siroop", "Tonijn"],
    "a purchase through its product counts; never an excluded thing, a hidden item (Fanta), one with low_off, or two days and one too old (Mozzarella)");
  const chips = often.find((o) => o.item.name === "Chips");
  assert.equal(chips.count, 4);
  assert.deepEqual(chips.products.map((p) => p.id).sort(), ["p-chio", "p-party"], "his products of the item");
  // A third day this year makes Mozzarella often; two lines on one day are one day.
  const v = view();
  v.purchases["pu-moz-3"] = { id: "pu-moz-3", item_id: ITEMS.rare.id, title: "Mozzarella", bought_on: day(40), deleted_at: null };
  assert.ok(oftenBought(v, TODAY).some((o) => o.item.name === "Mozzarella"));
});

test("often: the real offer names against his real products", () => {
  const P = PRODUCTS;
  const brands = new Set(["alpro", "melko", "chio", "sodastream", "john", "west", "fanta"]);
  const m = (it, products, o) => oftenMatch(it, products, OFFERS.find((x) => x.id === o), brands);
  assert.deepEqual(m(ITEMS.kwark, [P.melko], "o-melko"), { product: P.melko, sure: false, label: "Melko Romige kwark mango kiwi banaan" },
    "a group of brands only: a check hit");
  assert.equal(oftenMatch(ITEMS.kwark, [P.melko], OFFERS[0], new Set()).sure, false, "Alpro unknown: still a brand by its capital");
  assert.equal(oftenMatch(ITEMS.fanta, [P.fanta], OFFERS.find((o) => o.id === "o-cola"), new Set()), null, "\"literflessen\" is a kind, not his Fanta Orange's");
  assert.equal(m(ITEMS.alpro, [P.alpro], "o-melko").sure, false);
  assert.equal(m(ITEMS.alpro, [{ ...P.alpro, size: "200 g" }], "o-melko"), null, "his pack outside 400-500 gram");
  assert.deepEqual(m(ITEMS.chips, [P.party, P.chio], "o-chio"), { product: P.chio, sure: true, label: "Chio Red paprika" },
    "all Chio chips 70-150 gram holds his 150 g bag, not the 170 g partypack");
  assert.equal(m(ITEMS.siroop, [P.soda], "o-soda").sure, false, "his brand and soda mix, another flavour: check");
  assert.equal(m({ name: "Co2" }, [product("p-co2", "i", "Sodastream", "Sodastream Wisselcilinder quick connect", "per stuk")], "o-soda"), null,
    "his brand, another kind of thing");
  assert.deepEqual(m(ITEMS.melk, [P.melk], "o-melk"), { product: P.melk, sure: false, label: "AH Houdbare volle melk" });
  assert.equal(m(ITEMS.ham, [P.ham], "o-ham").sure, false);
  assert.equal(m(ITEMS.kaas, [P.kaas], "o-plak").sure, false, "\"plakken\" is in his cheese");
  assert.equal(m(ITEMS.geraspt, [P.geraspt], "o-rasp").sure, false);
  assert.equal(m(ITEMS.kaas, [P.kaas], "o-rasp"), null, "grated cheese is not his sliced cheese");
  assert.equal(m(ITEMS.tonijn, [P.tonijn], "o-tuna"), null, "Geelvintonijn is not his Zeeparel");
  assert.equal(m(ITEMS.kaas, [P.kaas], "o-fondue"), null);
  assert.equal(m(ITEMS.kaas, [P.kaas], "o-crois"), null, "croissants are no word of his cheese");
  assert.equal(m(ITEMS.melk, [P.melk], "o-sprx"), null);
  assert.equal(m(ITEMS.kaas, [P.kaas], "o-chio"), null);
  // His very product: a full hit.
  const ah = offer("o-ah-melk", "Albert Heijn", "AH Houdbare volle melk", "25% korting", 74);
  assert.equal(oftenMatch(ITEMS.melk, [P.melk], ah, brands).sure, true);
  const mines = product("p-mines", "i", "AH", "AH Bakkersbrood minoesbrood heel", "");
  assert.equal(oftenMatch({ name: "Minoesbrood" }, [mines], offer("o-t", "Albert Heijn", "Alle AH Bakkersbrood minoesbrood heel", "2 voor 2.99"), brands).sure, true);
  assert.equal(oftenMatch({ name: "Minoesbrood" }, [mines], offer("o-t2", "Dirk", "Alle AH Bakkersbrood minoesbrood heel", "2 voor 2.99"), brands), null,
    "an AH product is never in Dirk's folder");
});

test("often: a full hit is really his product (live false hits of 29-10-2026)", () => {
  const ah = (name) => offer(`o-${name}`, "Albert Heijn", name, "25% korting", 199);
  const prod = (brand, name, size = "") => product(`p-${name}`, "i", brand, name, size);
  const speculaas = [prod("AH", "AH Bakkers speculaas"), prod("AH", "AH Gevuld speculaas met amandelspijs"), prod("AH", "AH Speculaas")];
  const salami = [prod("AH", "AH Salami"), prod("", "Salami")];
  const eggs = [prod("AH", "AH Choco ei"), prod("", "Paaseitjes")];
  const none = (it, products, name) => assert.equal(oftenMatch({ name: it }, products, ah(name), new Set(["biteswelove", "bifi"])), null, `${name} is no ${it}`);
  none("Speculaas", speculaas, "BitesWeLove crunchy protein cookiebars speculaas");
  none("Salami", salami, "BiFi Tasty Bites That hot chili salami");
  none("Paaseitjes", eggs, "Trü Frü nature's strawberries milk chocolate");
  none("Paaseitjes", eggs, "Alle A-merk uitdeelsnoep en -chocolade*");
  // The two right ones stay full hits.
  const kip = prod("AH", "AH Scharrel kipfilet 2 stuks");
  assert.equal(oftenMatch({ name: "kipfilet" }, [kip], ah("AH Scharrelkipfilet 2 stuks"), new Set()).sure, true);
  assert.equal(oftenMatch(ITEMS.chips, [PRODUCTS.chio], OFFERS.find((o) => o.id === "o-chio"), new Set()).sure, true);
  // His own AH speculaas in AH's folder is his; the filled one is not his plain one.
  assert.equal(oftenMatch({ name: "Speculaas" }, [speculaas[2]], ah("AH Speculaas"), new Set()).sure, true);
  assert.notEqual(oftenMatch({ name: "Speculaas" }, [speculaas[2]], ah("AH Gevuld speculaas met amandelspijs"), new Set())?.sure, true);
  // A brandless product is never a full hit; an AH product is not Dirk's.
  assert.notEqual(oftenMatch({ name: "Salami" }, [salami[1]], ah("Salami"), new Set())?.sure, true);
  assert.notEqual(oftenMatch({ name: "Salami" }, [salami[0]], offer("o-d", "Dirk", "Salami", null, 199), new Set())?.sure, true);
});

test("often: sizeFits reads a range", () => {
  assert.equal(sizeFits({ size: "150 g" }, { name: "Alle Chio chips 70-150 gram" }), true);
  assert.equal(sizeFits({ size: "170 g" }, { name: "Alle Chio chips 70-150 gram" }), false);
  assert.equal(sizeFits({ size: "0,5 l" }, { name: "Sap 1-1,5 liter" }), false);
  assert.equal(sizeFits({ size: "" }, { name: "Alle Chio chips 70-150 gram" }), null);
  assert.equal(sizeFits({ size: "150 g" }, { name: "Chio chips" }), null);
});

test("often: dealsFor shows them with `often`, at AH and Dirk only, after a rule's hit", () => {
  const v = view();
  const hits = dealsFor(v, TODAY);
  const by = Object.fromEntries(hits.map((h) => [h.offer.id, h]));
  for (const id of ["o-melko", "o-chio", "o-soda", "o-melk", "o-ham", "o-plak", "o-rasp"]) assert.ok(by[id]?.often, `${id} shown`);
  for (const id of ["o-tuna", "o-fondue", "o-crois", "o-cola", "o-nugget", "o-sprx", "o-ham-lidl", "o-moz"]) assert.equal(by[id], undefined, `${id} not shown`);
  assert.equal(by["o-chio"].check, null, "his Chio bag: a full hit");
  assert.equal(by["o-chio"].product.id, "p-chio");
  assert.deepEqual(by["o-melk"].check, ["AH Houdbare volle melk"]);
  assert.equal(by["o-melk"].product, null, "never presented as his product");
  assert.equal(by["o-melk"].bought, 3);
  assert.equal(by["o-melk"].rule.implicit, true);
  assert.equal(hits[0].offer.id, "o-chio", "full hits before check hits");
  assert.ok(hits.filter((h) => h.check).every((h) => !h.low), "a check hit is never recommended");
  // Dirk's -58% milk before the folder prices without a known discount.
  const checks = hits.filter((h) => h.check).map((h) => h.offer.id);
  assert.ok(checks.indexOf("o-melk") < checks.indexOf("o-ham"));
});

test("often: an explicit rule on the item wins over the implicit one", () => {
  const v = view({ deal_rules: { r: { id: "rule-melk", item_id: ITEMS.melk.id, product_id: "", max_price_cents: 100, offer_only: 0, min_discount_pct: null, max_unit_price_cents: null, unit: null, detour: 0, deleted_at: null } } });
  assert.ok(!oftenBought(v, TODAY).some((o) => o.item.id === ITEMS.melk.id));
  const melk = dealsFor(v, TODAY).filter((h) => h.item.id === ITEMS.melk.id);
  assert.equal(melk.length, 0, "€1,29 is over the rule's €1,00: the rule says no, the implicit rule does not step in");
  v.deal_rules.r.max_price_cents = 150;
  const hit = dealsFor(v, TODAY).find((h) => h.offer.id === "o-melk");
  assert.equal(hit.often, undefined);
  assert.equal(hit.rule.id, "rule-melk");
});

test("often: recommended when he is low on it, and the hidden Fanta stays out until shown again", () => {
  const v = view();
  v.offers["o-ah-melk"] = offer("o-ah-melk", "Albert Heijn", "AH Houdbare volle melk", "25% korting", 74);
  v.pantry_events = { e: { id: "e", item_id: ITEMS.melk.id, deleted_at: null } };
  const hit = dealsFor(v, TODAY).find((h) => h.offer.id === "o-ah-melk");
  assert.equal(hit.check, null);
  assert.equal(hit.low?.code, "pantry_empty");
  assert.ok(!dealsFor(v, TODAY).some((h) => /fanta/i.test(h.offer.name)));
  // Shown again in "Weer nodig": bought often again.
  v.items[ITEMS.fanta.id].again = "show";
  assert.ok(oftenBought(v, TODAY).some((o) => o.item.id === ITEMS.fanta.id));
});
