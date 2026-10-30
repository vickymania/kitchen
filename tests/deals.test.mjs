// Deal rules and the Deals tab (28-10-2026): the deal text parsed on
// real folder wordings (tests/fixtures/deal-offers.json, read from the live
// offers on 28-10-2026), each rule type, the store limit and "omweg waard",
// "aanbevolen" from the pantry and "need it again", the ops and their checks,
// the rows on D1 (only what changed, an idle poll still one read), relevance,
// a rule's match, require and exclude words, "omweg waard vanaf 50%", the
// deepest discount first, "Vochtig tp" counting as "Vochtig toiletpapier",
// the list line's "cheaper at the other store", and never an excluded thing.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { hashDevice } from "../worker/auth.js";
import { applyOp, emptyState, OpError } from "../public/shared/ops.js";
import { parseDeal, parseSize, effectivePrice, meetsRule, ruleChecks } from "../public/shared/deal-math.js";
import { dealsFor, ruleProductMatches, lowReason, dealNote, isRegularStore, namesWord, matchWordHit, requireCheck, BRAND_VARIANTS,
  excluded, priceAt, cheaperElsewhere, sameProductOffer } from "../public/shared/deals.js";
import { relevanceTest, currentOffers } from "../public/shared/offers.js";
import { amsterdamDay } from "../worker/offers.js";
import { mapProduct, vocabulary } from "../tools/import_ah.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "deal-offers.json"), "utf8"));
const real = (name, store) => {
  const o = REAL.find((x) => x.name === name && (!store || x.store === store));
  assert.ok(o, `fixture has ${name}`);
  return o;
};
const TODAY = "2026-10-29";

// ------------------------------------------------------------- parsing

test("parsing: every real wording in the fixture is understood", () => {
  for (const o of REAL) assert.notEqual(parseDeal(o.deal), null, `deal "${o.deal}"`);
  assert.deepEqual(parseDeal("2 voor 1.99"), { kind: "multi", count: 2, cents: 199 });
  assert.deepEqual(parseDeal("3 voor 6.00"), { kind: "multi", count: 3, cents: 600 });
  assert.deepEqual(parseDeal("1+1 gratis"), { kind: "free", buy: 1, free: 1 });
  assert.deepEqual(parseDeal("2+3 gratis"), { kind: "free", buy: 2, free: 3 });
  assert.deepEqual(parseDeal("2e halve prijs"), { kind: "nth", nth: 2, pct: 50 });
  assert.deepEqual(parseDeal("25% korting"), { kind: "pct", pct: 25, min: 1 });
  assert.deepEqual(parseDeal("-57%"), { kind: "pct", pct: 57, min: 1 });
  assert.deepEqual(parseDeal("2 stuks 40%"), { kind: "pct", pct: 40, min: 2 });
  assert.deepEqual(parseDeal("€1.00 euro korting"), { kind: "off", cents: 100 });
  assert.deepEqual(parseDeal("voor 3.79"), { kind: "price", cents: 379 });
  assert.deepEqual(parseDeal("per 100 GRAM voor €1.89"), { kind: "weight", grams: 100, cents: 189 });
  assert.deepEqual(parseDeal("BONUS"), { kind: "folder" });
  assert.deepEqual(parseDeal(null), { kind: "folder" });
});

test("parsing: the brief's wordings that this week's folders did not have", () => {
  assert.deepEqual(parseDeal("2 voor 2,40"), { kind: "multi", count: 2, cents: 240 });
  assert.deepEqual(parseDeal("3 voor 5,-"), { kind: "multi", count: 3, cents: 500 });
  assert.deepEqual(parseDeal("per kilo"), { kind: "weight", grams: 1000, cents: null });
  assert.deepEqual(parseDeal("2e gratis"), { kind: "free", buy: 1, free: 1 });
  assert.equal(parseDeal("op is op, wees er snel bij"), null, "unsure: null");
  assert.equal(parseDeal("0+1 gratis"), null);
  assert.equal(parseDeal("150% korting"), null);
});

test("parsing: sizes, a range is no size", () => {
  assert.deepEqual(parseSize("6 x 85 g"), { count: 6, grams: 510, ml: null });
  assert.deepEqual(parseSize("12 x 85 gram"), { count: 12, grams: 1020, ml: null });
  assert.deepEqual(parseSize("42 stuks"), { count: 42, grams: null, ml: null });
  assert.deepEqual(parseSize("18 rollen"), { count: 18, grams: null, ml: null });
  assert.deepEqual(parseSize("1 kilo"), { count: null, grams: 1000, ml: null });
  assert.deepEqual(parseSize("0.75 liter"), { count: null, grams: null, ml: 750 });
  assert.deepEqual(parseSize(null, "Wasverzachters 42 wasbeurten en geurboosters"), { count: 42, grams: null, ml: null });
  assert.equal(parseSize("Los"), null);
  assert.equal(parseSize("150 gram", "Alle Chio chips 70-150 gram"), null, "the size says 150, the name a range");
  assert.equal(parseSize("8 rollen", "Alle Edet keukenpapier 6 t/m 8 rollen"), null);
});

test("effective price: per piece and per unit on real offers, never a guessed price", () => {
  const e = (o, normal) => effectivePrice(o, normal);
  const potatoes = e(real("AH (Iets) kruimige en vastkokende aardappelen 1 kilo"));
  assert.equal(potatoes.piece_cents, 99.5, "2 voor 1.99 is 99,5 cents each");
  assert.equal(potatoes.min_qty, 2);
  assert.equal(potatoes.per.kg, 99.5);
  assert.equal(potatoes.discount_pct, null, "no normal price: discount unknown");
  assert.equal(potatoes.is_discount, null, "in the bonus: trusted as an offer");

  assert.equal(e(real("AH (Iets) kruimige en vastkokende aardappelen 1 kilo"), 129).discount_pct, 22.87, "with the normal price");

  const bak = e(real("Alle AH Gekoelde bakaardappelen 450 gram"));
  assert.deepEqual([bak.piece_cents, bak.per.kg, bak.per.piece], [89, 197.78, null], "a bag of 450 g is no piece count");

  const melon = e(real("AH Cantaloupe meloen"));
  assert.deepEqual([melon.piece_cents, melon.was_cents, melon.discount_pct], [224, 298.67, 25], "the price is after 25% off");

  const wipes = e(real("Edet vochtig toiletpapier", "Hoogvliet"));
  assert.deepEqual([wipes.piece_cents, wipes.was_cents, wipes.discount_pct, wipes.is_discount], [119, 276.74, 57, true]);

  const tomato = e(real("AH Snoepgroente tomaat bak 1 kilo"));
  assert.deepEqual([tomato.piece_cents, tomato.was_cents, tomato.per.kg], [499, 599, 499]);

  const hachee = e(real("AH Greenfields runderhachee"));
  assert.deepEqual([hachee.piece_cents, hachee.per.kg], [null, 1890], "per 100 gram: only a kg price");

  // 1+1 and 2e halve prijs carry no price at AH: only with a normal price.
  const pasta = real("Alle AH Verse pasta's, noedels, pasta- en woksauzen");
  assert.deepEqual([e(pasta).piece_cents, e(pasta).discount_pct, e(pasta).min_qty], [null, 50, 2]);
  assert.equal(e(pasta, 300).piece_cents, 150);
  const coffee = real("Alle Douwe Egberts en L'OR koffiebone en capsules voor Nespresso 10-20 stuks");
  assert.deepEqual([e(coffee, 400).piece_cents, e(coffee).discount_pct, e(coffee, 400).per.piece], [300, 25, null], "a range of 10-20 gives no per piece");
  assert.deepEqual([e(real("Alle Knorr, Unox soep in zak en Hellmann's en Calvé sauzen")).discount_pct, e(real("AH Appels en peren")).min_qty], [50, 2]);

  const folder = e(real("Blauwe bessen", "Dirk"));
  assert.deepEqual([folder.piece_cents, folder.discount_pct, folder.is_discount], [389, null, null], "a folder price, nothing more");
  assert.deepEqual([e(real("Blauwe bessen", "Dirk"), 389).is_discount, e(real("Blauwe bessen", "Dirk"), 499).discount_pct], [false, 22.04]);

  assert.equal(e(real("Slapen")), null, "BONUS without a price: nothing sure");

  // The brief's own wordings.
  const pack = (deal, price, size = null, name = "x") => e({ deal, price_cents: price, size, name });
  assert.equal(pack("2 voor 2,40", null).piece_cents, 120);
  assert.equal(pack("3 voor 5,-", null).piece_cents, 166.67);
  assert.equal(pack("per kilo", 499).per.kg, 499);
  const pouches = pack("-20%", 450, "6 x 85 g");
  assert.deepEqual([pouches.per.piece, pouches.per.kg], [75, 882.35]);

  // Every real row: either null or finite numbers.
  for (const o of REAL) {
    const x = e(o);
    if (!x) continue;
    for (const v of [x.piece_cents, x.was_cents, x.discount_pct, ...Object.values(x.per)]) assert.ok(v === null || Number.isFinite(v), o.name);
  }
});

// ---------------------------------------------------------- each rule type

test("rules: max price per piece, multi-buys per piece", () => {
  const rule = { max_price_cents: 125 };
  assert.equal(meetsRule(rule, effectivePrice({ deal: "2 voor 2,40", name: "x" })), true, "€1,20 each");
  assert.equal(meetsRule(rule, effectivePrice({ deal: "2 voor 2,60", name: "x" })), false, "€1,30 each");
  assert.equal(meetsRule(rule, effectivePrice(real("Edet vochtig toiletpapier maxi pack"))), false, "AH: €2,14");
  assert.equal(meetsRule(rule, effectivePrice(real("Edet vochtig toiletpapier", "Hoogvliet"))), true, "Hoogvliet: €1,19");
  assert.equal(meetsRule(rule, effectivePrice(real("Alle AH Verse pasta's, noedels, pasta- en woksauzen"))), false, "unknown price: never passes");
  assert.deepEqual(ruleChecks(rule, effectivePrice({ deal: "2 voor 2,40", name: "x" })), [{ check: "max_price", ok: true, value: 120 }]);
});

test("rules: only on offer, with an optional minimum discount", () => {
  const only = { offer_only: 1 };
  assert.equal(meetsRule(only, effectivePrice(real("Edet vochtig toiletpapier maxi pack"))), true, "50% korting");
  assert.equal(meetsRule(only, effectivePrice(real("Blauwe bessen", "Dirk"))), true, "only a folder price: trusted");
  assert.equal(meetsRule(only, effectivePrice(real("Blauwe bessen", "Dirk"), 389)), false, "the normal price: no discount");
  const twenty = { offer_only: 1, min_discount_pct: 20 };
  assert.equal(meetsRule(twenty, effectivePrice(real("AH Cantaloupe meloen"))), true, "25%");
  assert.equal(meetsRule(twenty, effectivePrice(real("AH Snoepgroente tomaat bak 1 kilo"))), false, "€1 off €5,99 is 17%");
  assert.equal(meetsRule(twenty, effectivePrice(real("Blauwe bessen", "Dirk"))), false, "a minimum needs a number");
});

test("rules: max price per kg, l or piece in the pack", () => {
  const kg = { max_unit_price_cents: 200, unit: "kg" };
  assert.equal(meetsRule(kg, effectivePrice(real("Alle AH Gekoelde bakaardappelen 450 gram"))), true, "€1,98 per kg");
  assert.equal(meetsRule(kg, effectivePrice(real("AH Snoepgroente tomaat bak 1 kilo"))), false, "€4,99 per kg");
  assert.equal(meetsRule(kg, effectivePrice(real("AH Bloemkool"))), false, "no weight: unknown");
  const litre = { max_unit_price_cents: 400, unit: "l" };
  assert.equal(meetsRule(litre, effectivePrice(real("Alle AH Verse sappen en smoothies 500 ml"))), true, "2 voor 3.75: €3,75 per l");
  // Nat kattenvoer per pouch: bulk packs welcome.
  const pouch = { max_unit_price_cents: 60, unit: "piece" };
  assert.equal(meetsRule(pouch, effectivePrice({ name: "Felix pouches", size: "12 x 85 g", deal: null, price_cents: 650 })), true, "54 cents a pouch");
  assert.equal(meetsRule(pouch, effectivePrice({ name: "Felix pouches", size: "4 x 85 g", deal: null, price_cents: 280 })), false, "70 cents a pouch");
  assert.equal(meetsRule(pouch, effectivePrice(real("Felix pouches"))), false, "no count: unknown");
});

// ----------------------------------------------------------- dealsFor

const ITEMS = {
  wipes: { id: "item-wipes-001", name: "Vochtig toiletpapier", name_key: "vochtig toiletpapier" },
  pods: { id: "item-pods-0001", name: "Wasmiddel pods", name_key: "wasmiddel pods" },
  cat: { id: "item-cat-00001", name: "Nat kattenvoer", name_key: "nat kattenvoer" },
  sprouts: { id: "item-sprx-0001", name: "Verse spruitjes", name_key: "verse spruitjes" },
};
const PRODUCTS = {
  edet: { id: "product-edet-01", item_id: ITEMS.wipes.id, brand: "Edet", name: "Edet Amandelmelk vochtig toiletpapier", size: "42 stuks", store: "Albert Heijn", last_price_cents: 279 },
  ariel: { id: "product-ariel-1", item_id: ITEMS.pods.id, brand: "Ariel", name: "Ariel 4in1 pods+ active wasmiddelcapsules", size: "15 wasbeurten", store: "Albert Heijn", last_price_cents: 1599 },
};
const rule = (id, o) => ({ id, product_id: "", max_price_cents: null, offer_only: 0, min_discount_pct: null, max_unit_price_cents: null, unit: null, detour: 0, deleted_at: null, ...o });

function view(extra = {}) {
  const offers = {};
  REAL.forEach((o, i) => { offers[`of-real-${i}`] = { id: `of-real-${i}`, ...o }; });
  const add = (id, o) => { offers[id] = { id, brand: null, size: null, category: null, valid_from: "2026-10-26", valid_until: "2026-11-01", ...o }; };
  add("of-ariel-ah", { store: "Albert Heijn", name: "Ariel 4in1 pods+ active wasmiddelcapsules", deal: "50% korting", price_cents: 799 });
  add("of-ariel-dirk", { store: "Dirk", name: "Ariel 4in1 pods active", deal: null, price_cents: 1599, size: "15 wasbeurten" });
  add("of-cat-lidl", { store: "Lidl", name: "Nat kattenvoer in saus", deal: "-20%", price_cents: 520, size: "12 x 85 g" });
  add("of-cat-ah", { store: "Albert Heijn", name: "AH Nat kattenvoer kip", deal: null, price_cents: 360, size: "4 x 85 g" });
  add("of-sprx", { store: "Albert Heijn", name: "Spruitjes extra fijn", deal: "25% korting", price_cents: 449 });
  return {
    items: Object.fromEntries(Object.values(ITEMS).map((i) => [i.id, { ...i, deleted_at: null }])),
    products: Object.fromEntries(Object.values(PRODUCTS).map((p) => [p.id, { ...p, deleted_at: null }])),
    offers,
    purchases: {}, entries: {}, preferences: {}, recipes: {}, pantry: {}, pantry_events: {},
    deal_rules: {
      a: rule("rule-edet-0001", { item_id: ITEMS.wipes.id, product_id: PRODUCTS.edet.id, max_price_cents: 125 }),
      b: rule("rule-ariel-001", { item_id: ITEMS.pods.id, product_id: PRODUCTS.ariel.id, offer_only: 1 }),
      c: rule("rule-cat-00001", { item_id: ITEMS.cat.id, detour: 1 }),
    },
    ...extra,
  };
}
const hitsOf = (v, today = TODAY) => dealsFor(v, today).map((h) => `${h.item.name} @ ${h.offer.store}: ${h.offer.name}`);

test("deals: the product's brand with the item's name finds Thomas's Edet wipes", () => {
  const item = ITEMS.wipes;
  assert.equal(ruleProductMatches(PRODUCTS.edet, item, real("Edet vochtig toiletpapier", "Hoogvliet")), true);
  assert.equal(ruleProductMatches(PRODUCTS.edet, item, real("Vochtig toiletpapier", "Dirk")), false, "no brand: not his product");
  assert.equal(ruleProductMatches(PRODUCTS.edet, item, real("Page vochtig toiletpapier")), false, "another brand");
  const pink = { id: "p-pink", name: "Edet Amandelmelk vochtig toiletpapier", brand: "Edet", size: "" };
  assert.equal(ruleProductMatches(pink, item, { store: "Dirk", name: "Vochtig toiletpapier" }), false,
    "the full product name holds the folder words, but not the brand");
  const ahWipes = { brand: "AH", name: "AH Vochtig toiletpapier", store: "Albert Heijn" };
  assert.equal(ruleProductMatches(ahWipes, item, { store: "Dirk", name: "Vochtig toiletpapier" }), false, "a store brand only in its own store");
});

test("deals: AH and Dirk only, other stores when the rule says omweg waard", () => {
  const v = view();
  const hits = hitsOf(v);
  // Edet ≤ €1,25: AH's €2,14 fails, Hoogvliet's €1,19 is not a regular store.
  assert.ok(!hits.some((h) => h.startsWith("Vochtig toiletpapier")), hits.join("\n"));
  // Ariel only on offer: AH 50% passes, Dirk's folder at the normal price does not.
  assert.ok(hits.includes("Wasmiddel pods @ Albert Heijn: Ariel 4in1 pods+ active wasmiddelcapsules"));
  assert.ok(!hits.some((h) => h.includes("@ Dirk: Ariel")), "Dirk at €15,99 is no discount on €15,99");
  // Nat kattenvoer, omweg waard: Lidl counts.
  assert.ok(hits.includes("Nat kattenvoer @ Lidl: Nat kattenvoer in saus"));
  assert.ok(hits.includes("Nat kattenvoer @ Albert Heijn: AH Nat kattenvoer kip"));
  // Edet with omweg waard: Hoogvliet's €1,19 passes, AH's €2,14 still fails.
  v.deal_rules.a = { ...v.deal_rules.a, detour: 1 };
  const detour = hitsOf(v);
  assert.ok(detour.includes("Vochtig toiletpapier @ Hoogvliet: Edet vochtig toiletpapier"));
  assert.ok(!detour.some((h) => h.includes("maxi pack")), "AH €2,14 > €1,25");
  // The cat food without omweg waard: only AH.
  v.deal_rules.c = { ...v.deal_rules.c, detour: 0 };
  assert.ok(!hitsOf(v).some((h) => h.includes("@ Lidl")));
  assert.equal(isRegularStore("AH"), true);
  assert.equal(isRegularStore("Dirk van den Broek"), true);
  assert.equal(isRegularStore("Hoogvliet"), false);
});

test("deals: a cleared rule, an expired offer or a gone product shows nothing", () => {
  const v = view();
  v.deal_rules.b = { ...v.deal_rules.b, deleted_at: "2026-10-28T10:00:00Z" };
  assert.ok(!hitsOf(v).some((h) => h.startsWith("Wasmiddel pods")));
  assert.ok(!hitsOf(view(), "2026-11-02").some((h) => h.includes("Ariel")), "the AH bonus ended on 1 nov");
  const gone = view();
  gone.products[PRODUCTS.ariel.id].deleted_at = "2026-10-28T10:00:00Z";
  assert.ok(!hitsOf(gone).some((h) => h.startsWith("Wasmiddel pods")));
});

test("deals: never an excluded thing, whatever the rule", () => {
  const v = view();
  v.deal_rules.w = rule("rule-sprx-0001", { item_id: ITEMS.sprouts.id, detour: 1 });
  assert.ok(!hitsOf(v).some((h) => /spruit/i.test(h)));
  // And an offer that is excluded never shows under another item's rule.
  v.offers["of-pods-sprx"] = { id: "of-pods-sprx", store: "Albert Heijn", name: "Wasmiddel pods Groene Ster editie", deal: "25% korting", price_cents: 100, valid_until: "2026-11-01", valid_from: null };
  v.deal_rules.p = rule("rule-pods-any1", { item_id: ITEMS.pods.id, offer_only: 1 });
  assert.ok(!hitsOf(v).some((h) => /groene ster/i.test(h)));
});

test("aanbevolen: the pantry had it and it is gone, or little is left, or it must go; need it again", () => {
  const v = view();
  const due = [];
  const item = v.items[ITEMS.pods.id];
  assert.equal(lowReason(v, item, "2026-11-01", TODAY, due), null, "never in the pantry, not a regular: no reason");

  // Used up: a pantry event and no live row.
  v.pantry_events = { e: { id: "event-pods-001", item_id: item.id, reason: "used", amount: 1, happened_on: "2026-10-27", deleted_at: null } };
  assert.deepEqual(lowReason(v, item, "2026-11-01", TODAY, due), { code: "pantry_empty" });

  // Half a pack left on 20-10; the household-goods default (usage-rates.js:
  // a pack of pods ~40 days) has counted it down to 0,28 since.
  v.pantry = { r: { id: "pantry-pods-01", item_id: item.id, title: "Wasmiddel pods", amount: 0.5, added_on: "2026-10-20", use_by: null, deleted_at: null } };
  assert.deepEqual(lowReason(v, item, "2026-11-01", TODAY, due), { code: "pantry_low", amount: 0.28 });

  // Two packs: not low, whatever "need it again" says.
  v.pantry.r = { ...v.pantry.r, amount: 2 };
  const timer = [{ item, since: 40, interval: 30, due: true, in_pantry: false }];
  assert.equal(lowReason(v, item, "2026-11-01", TODAY, timer), null);

  // What is left goes off tomorrow.
  v.pantry.r = { ...v.pantry.r, use_by: "2026-10-30" };
  assert.deepEqual(lowReason(v, item, "2026-11-01", TODAY, due), { code: "pantry_use_by", use_by: "2026-10-30" });

  // Nothing in the pantry, due again (or due before the offer ends).
  v.pantry = {};
  v.pantry_events = {};
  assert.deepEqual(lowReason(v, item, "2026-11-01", TODAY, timer), { code: "again_due", since: 40, interval: 30 });
  assert.deepEqual(lowReason(v, item, "2026-11-01", TODAY, [{ item, since: 27, interval: 30, due: false, in_pantry: false }]), { code: "again_soon", days: 3 });
  assert.equal(lowReason(v, item, "2026-11-01", TODAY, [{ item, since: 10, interval: 30, due: false, in_pantry: false }]), null);
});

test("aanbevolen comes first, then the biggest saving; the reason travels with the hit", () => {
  const v = view();
  const before = dealsFor(v, TODAY);
  assert.ok(before.every((h) => !h.low));
  // The cat food ran out: it goes first, above Ariel's bigger saving.
  v.pantry_events = { e: { id: "event-cat-0001", item_id: ITEMS.cat.id, reason: "used", amount: 1, happened_on: "2026-10-28", deleted_at: null } };
  const after = dealsFor(v, TODAY);
  assert.equal(after[0].item.id, ITEMS.cat.id);
  assert.deepEqual(after[0].low, { code: "pantry_empty" });
  const rest = after.filter((h) => !h.low);
  for (let i = 1; i < rest.length; i++) assert.ok((rest[i - 1].saving_cents ?? -Infinity) >= (rest[i].saving_cents ?? -Infinity), "by saving");
  // "Need it again" from real purchases: bought every 10 days, last 12 days ago.
  const w = view();
  w.purchases = Object.fromEntries(["2026-09-27", "2026-10-07", "2026-10-17"].map((d, i) => [`p${i}`,
    { id: `purchase-pods-${i}`, item_id: ITEMS.pods.id, title: "Wasmiddel pods", bought_on: d, deleted_at: null }]));
  const pods = dealsFor(w, TODAY).find((h) => h.item.id === ITEMS.pods.id);
  assert.equal(pods.low.code, "again_due");
  assert.equal(dealsFor(w, TODAY)[0].item.id, ITEMS.pods.id);
});

test("deals: the note on the list line", () => {
  assert.equal(dealNote({ store: "Dirk", deal: "-55%", valid_until: "2026-11-03" }), "Dirk · -55% t/m 3 nov");
  assert.equal(dealNote({ store: "Poiesz", deal: null, valid_until: "2026-10-31" }), "Poiesz t/m 31 okt");
});

// ------------------------------------------------------------- the ops

const ctx = { memberId: "member-thomas-01", isAdmin: true, now: "2026-10-28T10:00:00.000Z" };

function opState() {
  const s = emptyState();
  for (const i of Object.values(ITEMS)) s.items[i.id] = { ...i, deleted_at: null };
  for (const p of Object.values(PRODUCTS)) s.products[p.id] = { ...p, deleted_at: null };
  return s;
}
const refused = (s, op) => {
  try {
    applyOp(s, op, ctx);
  } catch (e) {
    assert.ok(e instanceof OpError, String(e));
    return e.code;
  }
  return null;
};

test("ops: deal_rule.set validates, patches, writes nothing when unchanged; clear tombstones and set revives", () => {
  const s = opState();
  const set = (o) => applyOp(s, { type: "deal_rule.set", id: "rule-new-00001", item_id: ITEMS.wipes.id, product_id: PRODUCTS.edet.id, ...o }, ctx);
  assert.equal(refused(s, { type: "deal_rule.set", id: "rule-new-00001", item_id: ITEMS.wipes.id }), "empty_rule");
  assert.equal(refused(s, { type: "deal_rule.set", id: "rule-new-00001", item_id: ITEMS.wipes.id, unit: "kg" }), "bad_field", "a unit without a price");
  assert.equal(refused(s, { type: "deal_rule.set", id: "rule-new-00001", item_id: ITEMS.wipes.id, max_unit_price_cents: 300 }), "bad_field", "a price without a unit");
  assert.equal(refused(s, { type: "deal_rule.set", id: "rule-new-00001", item_id: ITEMS.wipes.id, max_unit_price_cents: 300, unit: "doos" }), "bad_field");
  assert.equal(refused(s, { type: "deal_rule.set", id: "rule-new-00001", item_id: ITEMS.wipes.id, max_price_cents: -5 }), "bad_field");
  assert.equal(refused(s, { type: "deal_rule.set", id: "rule-new-00001", item_id: ITEMS.wipes.id, min_discount_pct: 99 }), "bad_field");
  assert.equal(refused(s, { type: "deal_rule.set", id: "rule-new-00001", item_id: ITEMS.wipes.id, min_discount_pct: 12.5 }), "bad_field");
  assert.equal(refused(s, { type: "deal_rule.set", id: "rule-new-00001", item_id: "item-nothing-1", detour: true }), "not_found");
  assert.equal(refused(s, { type: "deal_rule.set", id: "rule-new-00001", item_id: ITEMS.wipes.id, product_id: "product-nothing", detour: true }), "not_found");
  assert.equal(refused(s, { type: "deal_rule.set", id: "rule-new-00001", item_id: ITEMS.sprouts.id, detour: true }), "excluded");
  assert.equal(refused(s, { type: "deal_rule.set", id: "rule-new-00001", title: "Groene Ster", item_id: "item-sprt-0001", detour: true }), "excluded");
  assert.deepEqual(Object.keys(s.deal_rules), [], "nothing written by a refused op");

  const first = set({ max_price_cents: 125 });
  assert.deepEqual(first.changed, [["deal_rules", "rule-new-00001"]]);
  const row = s.deal_rules["rule-new-00001"];
  assert.deepEqual([row.max_price_cents, row.offer_only, row.detour, row.product_id], [125, 0, 0, PRODUCTS.edet.id]);

  // A patch: detour added, the price kept. Another id: the same row.
  const patched = applyOp(s, { type: "deal_rule.set", id: "rule-other-001", item_id: ITEMS.wipes.id, product_id: PRODUCTS.edet.id, detour: true }, ctx);
  assert.equal(patched.result.deal_rule_id, "rule-new-00001");
  assert.deepEqual([row.max_price_cents, s.deal_rules["rule-new-00001"].detour], [125, 1]);
  assert.equal(Object.keys(s.deal_rules).length, 1);

  // The rule's id with another scope (no product): refused, the Edet rule keeps its product and price.
  assert.equal(refused(s, { type: "deal_rule.set", id: "rule-new-00001", item_id: ITEMS.wipes.id, require_words: ["amandelmelk"] }), "id_taken");
  assert.deepEqual([s.deal_rules["rule-new-00001"].product_id, s.deal_rules["rule-new-00001"].max_price_cents], [PRODUCTS.edet.id, 125]);

  // The same values again: nothing touched.
  assert.deepEqual(set({ max_price_cents: 125, detour: true }).changed, []);

  // A minimum discount means only on offer.
  set({ min_discount_pct: 20 });
  assert.deepEqual([s.deal_rules["rule-new-00001"].offer_only, s.deal_rules["rule-new-00001"].min_discount_pct], [1, 20]);
  // null removes a condition; removing the last one is refused, clear is the way.
  set({ min_discount_pct: null, offer_only: false, detour: false });
  assert.equal(refused(s, { type: "deal_rule.set", id: "rule-new-00001", item_id: ITEMS.wipes.id, product_id: PRODUCTS.edet.id, max_price_cents: null }), "empty_rule");

  // An item rule is its own row next to the product rule.
  applyOp(s, { type: "deal_rule.set", id: "rule-item-0001", item_id: ITEMS.wipes.id, offer_only: true }, ctx);
  assert.equal(s.deal_rules["rule-item-0001"].product_id, "");
  assert.equal(Object.keys(s.deal_rules).length, 2);

  const cleared = applyOp(s, { type: "deal_rule.clear", item_id: ITEMS.wipes.id, product_id: PRODUCTS.edet.id }, ctx);
  assert.deepEqual(cleared.changed, [["deal_rules", "rule-new-00001"]]);
  assert.ok(s.deal_rules["rule-new-00001"].deleted_at);
  assert.deepEqual(applyOp(s, { type: "deal_rule.clear", item_id: ITEMS.wipes.id, product_id: PRODUCTS.edet.id }, ctx).changed, [], "twice: nothing");
  // Set again: the same row back, starting empty (the old price is not revived).
  set({ detour: true });
  const back = s.deal_rules["rule-new-00001"];
  assert.deepEqual([back.deleted_at, back.max_price_cents, back.detour], [null, null, 1]);

  // A title makes the item, like preference.set.
  const made = applyOp(s, { type: "deal_rule.set", id: "rule-title-001", title: "Kattenbakvulling", item_id: "item-litter-01", offer_only: true }, ctx);
  assert.equal(made.result.item_id, "item-litter-01");
  assert.equal(s.items["item-litter-01"].name, "Kattenbakvulling");
});

// --------------------------------------------------------------- on D1

const HOST = "groceries.localhost:8787";
function call(env, method, p, { body, cookie, bearer } = {}) {
  const headers = { Origin: `http://${HOST}` };
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`http://${HOST}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
let counter = 0;
const op = (o) => ({ op_id: `op-deal-${String(++counter).padStart(6, "0")}`, ...o });
const send = async (env, cookie, ops) => (await (await call(env, "POST", "/api/ops", { cookie, body: { ops } })).json()).results;
const pull = async (env, cookie, since) => (await call(env, "GET", `/api/sync?since=${since}`, { cookie })).json();

function spy(env) {
  const seen = { batches: [], queries: [] };
  const batch = env.DB.batch.bind(env.DB);
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.batch = (stmts) => {
    seen.batches.push(stmts.map((x) => x.sql));
    return batch(stmts);
  };
  env.DB.prepare = (sql) => {
    seen.queries.push(sql);
    return prepare(sql);
  };
  return seen;
}

async function household(code = "123456", name = "Thuis") {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: name, name: "Thomas", code }));
  const thomas = tokenOf(await call(env, "POST", "/api/pair", { body: { code } }));
  const r = await send(env, thomas, [
    op({ type: "entry.add", id: "entry-wipes-01", item_id: ITEMS.wipes.id, title: ITEMS.wipes.name }),
    op({ type: "product.put", id: PRODUCTS.edet.id, product: { ...PRODUCTS.edet, last_price_cents: 279 } }),
  ]);
  assert.ok(r.every((x) => x.ok), JSON.stringify(r));
  return { env, thomas };
}
const tables = (seen) => seen.batches.flat().map((sql) => sql.match(/^(?:INSERT INTO|UPDATE) (\w+)/)?.[1]).sort();

test("sync: a rule goes out as one row; the same again writes nothing; an idle poll is one read", async () => {
  const { env, thomas } = await household();
  const head = await pull(env, thomas, 0);
  assert.deepEqual(head.deal_rules, []);

  let seen = spy(env);
  const [set] = await send(env, thomas, [op({ type: "deal_rule.set", id: "rule-d1-000001", item_id: ITEMS.wipes.id, product_id: PRODUCTS.edet.id, max_price_cents: 125 })]);
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.deepEqual(tables(seen), ["applied_ops", "deal_rules", "households"], "rev bump + the rule + applied_ops");

  const delta = await pull(env, thomas, head.rev);
  assert.deepEqual(delta.deal_rules.map((r) => [r.id, r.item_id, r.product_id, r.max_price_cents, r.offer_only, r.detour]),
    [["rule-d1-000001", ITEMS.wipes.id, PRODUCTS.edet.id, 125, 0, 0]]);
  assert.deepEqual([delta.items.length, delta.products.length, delta.entries.length], [0, 0, 0], "only the change");

  seen = spy(env);
  const [same] = await send(env, thomas, [op({ type: "deal_rule.set", id: "rule-d1-000002", item_id: ITEMS.wipes.id, product_id: PRODUCTS.edet.id, max_price_cents: 125 })]);
  assert.equal(same.result.deal_rule_id, "rule-d1-000001");
  assert.deepEqual(tables(seen), ["applied_ops"], "nothing but the op's receipt");
  assert.equal((await pull(env, thomas, delta.rev)).rev, delta.rev, "no new rev");

  // A patch on D1: the loader brings the row, the price stays.
  await send(env, thomas, [op({ type: "deal_rule.set", id: "rule-d1-000003", item_id: ITEMS.wipes.id, product_id: PRODUCTS.edet.id, detour: true })]);
  const patched = await pull(env, thomas, delta.rev);
  assert.deepEqual(patched.deal_rules.map((r) => [r.id, r.max_price_cents, r.detour]), [["rule-d1-000001", 125, 1]]);

  seen = spy(env);
  const idle = await pull(env, thomas, patched.rev);
  assert.equal(idle.deal_rules.length, 0);
  assert.deepEqual(seen.queries.filter((sql) => !/FROM devices d JOIN members/.test(sql)), ["SELECT rev FROM households WHERE id = ?"], "one row: the counter");

  await send(env, thomas, [op({ type: "deal_rule.clear", item_id: ITEMS.wipes.id, product_id: PRODUCTS.edet.id })]);
  assert.ok((await pull(env, thomas, patched.rev)).deal_rules[0].deleted_at, "a tombstone in the delta");
  assert.deepEqual((await pull(env, thomas, 0)).deal_rules, [], "gone from a full load");

  // Refused ops write nothing at all.
  seen = spy(env);
  const [bad] = await send(env, thomas, [op({ type: "deal_rule.set", id: "rule-d1-000004", item_id: ITEMS.wipes.id })]);
  assert.deepEqual([bad.ok, bad.error], [false, "empty_rule"]);
  assert.deepEqual(tables(seen), []);
});

test("sync: another household sees no rule and overwrites none", async () => {
  const { env, thomas } = await household();
  await send(env, thomas, [op({ type: "deal_rule.set", id: "rule-shared-01", item_id: ITEMS.wipes.id, offer_only: true })]);
  const now = new Date().toISOString();
  await env.DB.exec(`INSERT INTO households (id, name, rev, created_at) VALUES ('hh-other-000', 'Buren', 0, '${now}');
    INSERT INTO members (id, household_id, name, is_admin, created_at, rev) VALUES ('member-other-1', 'hh-other-000', 'Buur', 1, '${now}', 0);
    INSERT INTO devices (id, member_id, token_hash, created_at) VALUES ('device-other-1', 'member-other-1', '${await hashDevice("t".repeat(43))}', '${now}');`);
  const stranger = "t".repeat(43);
  assert.deepEqual((await pull(env, stranger, 0)).deal_rules, []);
  await send(env, stranger, [op({ type: "entry.add", id: "entry-buur-001", item_id: "item-buur-0001", title: "Melk" })]);
  await send(env, stranger, [op({ type: "deal_rule.set", id: "rule-shared-01", item_id: "item-buur-0001", detour: true })]);
  const mine = await pull(env, thomas, 0);
  assert.deepEqual(mine.deal_rules.map((x) => [x.id, x.item_id, x.offer_only, x.detour]), [["rule-shared-01", ITEMS.wipes.id, 1, 0]]);
});

test("relevance: a rule's product keeps its offers, also at an omweg store", async () => {
  const { env, thomas } = await household();
  await send(env, thomas, [
    op({ type: "entry.add", id: "entry-cat-0001", item_id: ITEMS.cat.id, title: "Kattenvoer" }),
    op({ type: "product.put", id: "product-felix-1", product: { name: "Sensations pouches", brand: "Felix", size: "12 x 85 g", store: "Albert Heijn", item_id: ITEMS.cat.id } }),
  ]);
  const json = async (res) => ({ status: res.status, body: await res.json() });
  const code = await json(await call(env, "POST", "/api/codes", { cookie: thomas, body: { for: "fetcher" } }));
  const server = tokenOf(await call(env, "POST", "/api/pair", { body: { code: code.body.code, label: "Thuisserver" } }));
  const today = amsterdamDay();
  const until = amsterdamDay(new Date(Date.now() + 4 * 86400_000));
  const offers = [
    { store: "Poiesz", name: "Felix Sensations pouches", brand: null, size: "12 x 85 g", deal: null, price_cents: 650, valid_from: today, valid_until: until, category: null },
    { store: "Hoogvliet", name: "Edet vochtig toiletpapier", brand: null, size: null, deal: "-57%", price_cents: 119, valid_from: today, valid_until: until, category: null },
  ];
  const before = await json(await call(env, "POST", "/api/offers/sync", { bearer: server, body: { offers } }));
  assert.equal(before.body.irrelevant, 1, "Felix pouches: no item says so yet");
  await send(env, thomas, [op({ type: "deal_rule.set", id: "rule-felix-001", item_id: ITEMS.cat.id, product_id: "product-felix-1", detour: true })]);
  const after = await json(await call(env, "POST", "/api/offers/sync", { bearer: server, body: { offers } }));
  assert.deepEqual([after.body.irrelevant, after.body.added], [0, 1], "kept for the rule");
  const rows = (await pull(env, thomas, 0)).offers.map((o) => `${o.store}: ${o.name}`).sort();
  assert.deepEqual(rows, ["Hoogvliet: Edet vochtig toiletpapier", "Poiesz: Felix Sensations pouches"]);
});

// ------------------------------------------- match words, require words

// Thomas, 28-10-2026: only the pink Edet ("Amandelmelk"); cat food "Minoes
// eten" is "Felix pouches" in the folders. The fixture has no Edet line
// naming a kind this week, so the two named kinds below are made up in the
// folders' own style; the rest are the real rows.
const EDET_PINK = { id: "of-edet-pink", store: "Albert Heijn", name: "Edet Amandelmelk vochtig toiletpapier", brand: null, size: "42 stuks", deal: "voor 1.19", price_cents: 119, valid_from: "2026-10-26", valid_until: "2026-11-01", category: "Huishouden" };
const EDET_SENSITIVE = { ...EDET_PINK, id: "of-edet-sens", name: "Edet Sensitive vochtig toiletpapier", store: "Dirk", deal: "-50%", price_cents: 99 };
const MINES = { id: "item-mines-0001", name: "Minoes eten", name_key: "minoes eten" };
const WIPES_TP = { id: "item-wipes-tp1", name: "Vochtig tp", name_key: "vochtig tp" };
const CAT_WORDS = ["felix", "kattenvoer", "natvoer", "pouches", "sheba", "whiskas"];

function wordView() {
  const v = view();
  v.items[MINES.id] = { ...MINES, deleted_at: null };
  v.items[WIPES_TP.id] = { ...WIPES_TP, deleted_at: null };
  v.offers[EDET_PINK.id] = EDET_PINK;
  v.offers[EDET_SENSITIVE.id] = EDET_SENSITIVE;
  // The pink Edet at any store, at most €1,25; cat food anywhere, found by its words.
  v.deal_rules.a = { ...v.deal_rules.a, detour: 1, require_words: ["amandelmelk"] };
  v.deal_rules.t = rule("rule-mines-001", { item_id: MINES.id, detour: 1, match_words: CAT_WORDS });
  return v;
}

test("words: whole words, a long one also in a compound; never 'tp' inside a word", () => {
  assert.equal(namesWord(real("Felix pouches"), "felix"), true);
  assert.equal(namesWord(real("Felix pouches"), "pouches"), true);
  assert.equal(namesWord({ name: "Kattennatvoer kip" }, "natvoer"), true, "the end of a compound");
  assert.equal(namesWord({ name: "Felixpouches" }, "felix"), true, "the start of a compound");
  assert.equal(namesWord(real("Vochtig toiletpapier", "Dirk"), "tp"), false);
  assert.equal(namesWord({ name: "Kattenbak" }, "kat"), false, "short words only whole");
  assert.equal(namesWord(real("Edet vochtig toiletpapier", "Hoogvliet"), "vochtig toiletpapier"), true, "a phrase: every word");
  assert.equal(matchWordHit({ match_words: CAT_WORDS }, real("Felix pouches")), true);
  assert.equal(matchWordHit({ match_words: CAT_WORDS }, real("Kattenbrokken in saus")), false, "not one of his words");
  assert.equal(matchWordHit({ match_words: null }, real("Felix pouches")), false);
});

test("require words: the pink Edet passes, no kind named is a check, another kind is out", () => {
  const r = { require_words: ["amandelmelk"] };
  assert.deepEqual(requireCheck(r, EDET_PINK, PRODUCTS.edet), { missing: null });
  assert.deepEqual(requireCheck(r, real("Edet vochtig toiletpapier", "Hoogvliet"), PRODUCTS.edet), { missing: ["amandelmelk"] });
  assert.deepEqual(requireCheck(r, real("Edet vochtig toiletpapier maxi pack"), PRODUCTS.edet), { missing: ["amandelmelk"] }, "maxi pack is a size, not a kind");
  assert.deepEqual(requireCheck(r, EDET_SENSITIVE, PRODUCTS.edet), { other: true });
  for (const kind of ["kids", "classic", "aloe", "zeewier", "kamille"]) {
    assert.deepEqual(requireCheck(r, { name: `Edet ${kind} vochtig toiletpapier` }, PRODUCTS.edet), { other: true }, kind);
  }
  assert.ok(BRAND_VARIANTS.edet.includes("sensitive"));
  assert.deepEqual(requireCheck({ require_words: null }, EDET_SENSITIVE), { missing: null }, "nothing required: everything passes");
});

test("deals: Edet only the pink one; a folder line without a kind shows last as a check, never aanbevolen", () => {
  const v = wordView();
  // He is out of wipes: the full hit is recommended, the check hit is not.
  v.pantry_events = { e: { id: "event-wipes-01", item_id: ITEMS.wipes.id, reason: "used", amount: 1, happened_on: "2026-10-27", deleted_at: null } };
  const hits = dealsFor(v, TODAY);
  const wipes = hits.filter((h) => h.item.id === ITEMS.wipes.id);
  assert.deepEqual(wipes.map((h) => [h.offer.store, h.offer.name, h.check]), [
    ["Albert Heijn", "Edet Amandelmelk vochtig toiletpapier", null],
    ["Hoogvliet", "Edet vochtig toiletpapier", ["amandelmelk"]],
  ], "Sensitive is out; AH maxi pack €2,14 is over €1,25");
  assert.deepEqual(wipes[0].low, { code: "pantry_empty" });
  assert.equal(wipes[1].low, null, "a check hit is never recommended");
  const firstCheck = hits.findIndex((h) => h.check);
  assert.ok(firstCheck > 0 && hits.slice(firstCheck).every((h) => h.check), "check hits after every full hit");
  // Without require words the Sensitive one is just Edet.
  v.deal_rules.a = { ...v.deal_rules.a, require_words: null };
  assert.ok(dealsFor(v, TODAY).some((h) => h.offer.id === EDET_SENSITIVE.id && !h.check));
});

test("deals: cat food 'Minoes eten' finds Felix pouches by its match words", () => {
  const v = wordView();
  const mines = dealsFor(v, TODAY).filter((h) => h.item.id === MINES.id).map((h) => `${h.offer.store}: ${h.offer.name}`);
  assert.ok(mines.includes("Poiesz: Felix pouches"), mines.join("\n"));
  assert.ok(!mines.some((x) => /brokken/i.test(x)), "Kattenbrokken in saus is not one of his words");
  // Without its words nothing in the folders says "Minoes eten".
  v.deal_rules.t = { ...v.deal_rules.t, match_words: null };
  assert.deepEqual(dealsFor(v, TODAY).filter((h) => h.item.id === MINES.id), []);
  // Only AH and Dirk without the detour: Poiesz drops out.
  v.deal_rules.t = { ...v.deal_rules.t, match_words: CAT_WORDS, detour: 0 };
  assert.ok(!dealsFor(v, TODAY).some((h) => h.item.id === MINES.id && h.offer.store === "Poiesz"));
});

test("deals: match words never bring excluded", () => {
  const v = wordView();
  v.offers["of-felix-sprt"] = { id: "of-felix-sprt", store: "Albert Heijn", name: "Felix spruitjes", deal: "25% korting", price_cents: 100, valid_from: null, valid_until: "2026-11-01" };
  assert.ok(!dealsFor(v, TODAY).some((h) => /spruit/i.test(h.offer.name)));
  const s = opState();
  assert.equal(refused(s, { type: "deal_rule.set", id: "rule-words-001", item_id: ITEMS.cat.id, match_words: ["felix", "spruitjes"] }), "excluded");
  assert.equal(refused(s, { type: "deal_rule.set", id: "rule-words-001", item_id: ITEMS.cat.id, require_words: ["spruiten"] }), "excluded");
});

test("relevance: a rule's match words keep Felix pouches", () => {
  const names = ["Minoes eten", "Vochtig toiletpapier"];
  assert.equal(relevanceTest(names)(real("Felix pouches")), false, "the item name alone finds nothing");
  assert.equal(relevanceTest([...names, ...CAT_WORDS])(real("Felix pouches")), true);
  assert.equal(relevanceTest([...names, ...CAT_WORDS])({ name: "Kattennatvoer kip" }), true, "a compound, as namesWord");
});

test("vochtig tp: its purchases, pantry rows and events count for the Vochtig toiletpapier rule", () => {
  // 34 buys as "Vochtig tp", 12 as "Vochtig toiletpapier": two items, one product.
  const v = wordView();
  v.purchases = Object.fromEntries(["2026-09-29", "2026-10-09", "2026-10-19"].map((d, i) => [`p${i}`,
    { id: `purchase-tp-00${i}`, item_id: WIPES_TP.id, title: "Vochtig tp", bought_on: d, deleted_at: null }]));
  const pink = () => dealsFor(v, TODAY).find((h) => h.offer.id === EDET_PINK.id);
  assert.deepEqual(pink().low, { code: "again_due", since: 10, interval: 10 }, "need it again from the tp purchases");
  // A pack of "Vochtig tp" at home: not low.
  v.pantry = { r: { id: "pantry-tp-0001", item_id: WIPES_TP.id, title: "Vochtig tp", amount: 2, added_on: "2026-10-28", use_by: null, deleted_at: null } };
  assert.equal(pink().low, null);
  // Half a pack of it: low. Wet wipes are counted down by the household-goods
  // default (a pack ~14 days), so it says when they run out.
  v.pantry.r = { ...v.pantry.r, amount: 0.5 };
  assert.deepEqual(pink().low, { code: "pantry_runs_out", days: 6 });
  // Used up as "Vochtig tp": empty.
  v.pantry = {};
  v.purchases = {};
  v.pantry_events = { e: { id: "event-tp-0001", item_id: WIPES_TP.id, reason: "used", amount: 1, happened_on: "2026-10-27", deleted_at: null } };
  assert.deepEqual(pink().low, { code: "pantry_empty" });
});

test("vochtig tp: the AH import maps every Edet line to the one item", () => {
  const vocab = vocabulary(["Vochtig tp", "Vochtig tp", "Vochtig toiletpapier"], []);
  assert.equal(vocab.get("vochtig toiletpapier").name, "Vochtig toiletpapier");
  assert.equal(vocab.has("vochtig tp"), false, "no second item");
  for (const bare of ["Amandelmelk vochtig toiletpapier", "Vochtig toiletpapier sensitive", "Vochtig toiletpapier"]) {
    const line = { webshopId: "999001", brand: "Edet", receiptName: "EDET VOCHTIG TP", bare };
    assert.equal(mapProduct(line, vocab, {}, {}).item, "Vochtig toiletpapier", bare);
  }
});

test("ops: match and require words are a patch, cleaned, and the same again writes nothing", () => {
  const s = opState();
  s.items[MINES.id] = { ...MINES, deleted_at: null };
  const set = (o) => applyOp(s, { type: "deal_rule.set", id: "rule-mines-001", item_id: MINES.id, ...o }, ctx);
  set({ detour: true, match_words: "Felix, sheba ,whiskas,, Felix" });
  const row = () => s.deal_rules["rule-mines-001"];
  assert.deepEqual(row().match_words, ["felix", "sheba", "whiskas"], "a text is split, cleaned, sorted, no doubles");
  assert.deepEqual(set({ match_words: ["whiskas", "sheba", "felix"] }).changed, [], "the same words again: nothing");
  set({ max_unit_price_cents: 60, unit: "piece" });
  assert.deepEqual([row().match_words, row().detour, row().max_unit_price_cents], [["felix", "sheba", "whiskas"], 1, 60], "a patch keeps the words");
  set({ match_words: [] });
  assert.equal(row().match_words, null, "empty removes them");
  assert.equal(refused(s, { type: "deal_rule.set", id: "rule-mines-001", item_id: MINES.id, match_words: [5] }), "bad_field");
  assert.equal(refused(s, { type: "deal_rule.set", id: "rule-mines-001", item_id: MINES.id, require_words: Array.from({ length: 13 }, (_, i) => `woord${i}`) }), "bad_field");
  // Words alone are a rule: "only the pink one", any price, AH and Dirk.
  const only = applyOp(s, { type: "deal_rule.set", id: "rule-edet-word", item_id: ITEMS.wipes.id, product_id: PRODUCTS.edet.id, require_words: ["Amandelmelk"] }, ctx);
  assert.deepEqual(s.deal_rules[only.result.deal_rule_id].require_words, ["amandelmelk"]);
});

test("sync: words go out as lists in the delta; the same again writes nothing; an idle poll is one read", async () => {
  const { env, thomas } = await household();
  const head = await pull(env, thomas, 0);
  let seen = spy(env);
  const [set] = await send(env, thomas, [op({ type: "deal_rule.set", id: "rule-d1-words1", item_id: ITEMS.wipes.id, product_id: PRODUCTS.edet.id, max_price_cents: 125, require_words: ["amandelmelk"] })]);
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.deepEqual(tables(seen), ["applied_ops", "deal_rules", "households"]);
  const delta = await pull(env, thomas, head.rev);
  assert.deepEqual(delta.deal_rules.map((r) => [r.id, r.require_words, r.match_words]), [["rule-d1-words1", ["amandelmelk"], null]]);
  // A patch of another field keeps the words (the loader parses them back).
  await send(env, thomas, [op({ type: "deal_rule.set", id: "rule-d1-words2", item_id: ITEMS.wipes.id, product_id: PRODUCTS.edet.id, detour: true })]);
  const patched = await pull(env, thomas, delta.rev);
  assert.deepEqual(patched.deal_rules.map((r) => [r.require_words, r.detour, r.max_price_cents]), [[["amandelmelk"], 1, 125]]);
  seen = spy(env);
  await send(env, thomas, [op({ type: "deal_rule.set", id: "rule-d1-words3", item_id: ITEMS.wipes.id, product_id: PRODUCTS.edet.id, require_words: ["Amandelmelk"] })]);
  assert.deepEqual(tables(seen), ["applied_ops"], "the same words: nothing but the receipt");
  seen = spy(env);
  assert.equal((await pull(env, thomas, patched.rev)).deal_rules.length, 0);
  assert.deepEqual(seen.queries.filter((sql) => !/FROM devices d JOIN members/.test(sql)), ["SELECT rev FROM households WHERE id = ?"]);
});

test("relevance on D1: match words keep the Felix pouches folder row", async () => {
  const { env, thomas } = await household();
  await send(env, thomas, [op({ type: "entry.add", id: "entry-mines-01", item_id: MINES.id, title: MINES.name })]);
  const json = async (res) => ({ status: res.status, body: await res.json() });
  const code = await json(await call(env, "POST", "/api/codes", { cookie: thomas, body: { for: "fetcher" } }));
  const server = tokenOf(await call(env, "POST", "/api/pair", { body: { code: code.body.code, label: "Thuisserver" } }));
  const today = amsterdamDay();
  const until = amsterdamDay(new Date(Date.now() + 4 * 86400_000));
  const offers = [{ ...real("Felix pouches"), valid_from: today, valid_until: until }];
  const before = await json(await call(env, "POST", "/api/offers/sync", { bearer: server, body: { offers } }));
  assert.equal(before.body.irrelevant, 1, "Minoes eten alone does not keep it");
  await send(env, thomas, [op({ type: "deal_rule.set", id: "rule-mines-d1", item_id: MINES.id, detour: true, match_words: CAT_WORDS })]);
  const after = await json(await call(env, "POST", "/api/offers/sync", { bearer: server, body: { offers } }));
  assert.deepEqual([after.body.irrelevant, after.body.added], [0, 1]);
});

// --------------------- discount depth, exclude words, detour from 50%

test("discount depth: '-55%' as said, '1+1 gratis' is 50%, '2e halve prijs' 25%, also without a price", () => {
  assert.equal(effectivePrice(real("Vochtig toiletpapier", "Dirk")).discount_pct, 55);
  assert.equal(effectivePrice(real("AH Verse ananas 250 gram en meloenmix 225 gram")).discount_pct, 50, "1+1 gratis");
  assert.equal(effectivePrice(real("Alle Knorr, Unox soep in zak en Hellmann's en Calvé sauzen")).discount_pct, 50, "2+2 gratis");
  assert.equal(effectivePrice(real("Alle AH Excellent borrelkaas en droge worst")).discount_pct, 25, "2e halve prijs");
  assert.equal(effectivePrice(real("AH Appels en peren")).discount_pct, 40, "2 stuks 40%");
  assert.equal(effectivePrice(real("Blauwe bessen", "Dirk")).discount_pct, null, "a folder price says nothing");
});

test("discount depth: within a group the deepest discount comes first, then the saving", () => {
  const v = wordView();
  const hits = dealsFor(v, TODAY);
  const groups = [(h) => !h.check && h.low, (h) => !h.check && !h.low, (h) => h.check];
  let seen = 0;
  for (const inGroup of groups) {
    const g = hits.filter(inGroup);
    seen += g.length;
    for (let i = 1; i < g.length; i++) {
      const [a, b] = [g[i - 1].eff.discount_pct ?? -1, g[i].eff.discount_pct ?? -1];
      assert.ok(a >= b, `${g[i - 1].offer.name} (${a}%) before ${g[i].offer.name} (${b}%)`);
      if (a === b) assert.ok((g[i - 1].saving_cents ?? -Infinity) >= (g[i].saving_cents ?? -Infinity), "then by saving");
    }
  }
  assert.equal(seen, hits.length);
  // A concrete pair: Hoogvliet's Edet -57% goes above AH's -55% among the check hits.
  const checks = hits.filter((h) => h.check).map((h) => `${h.offer.store}: ${h.offer.deal}`);
  assert.deepEqual(checks, ["Hoogvliet: -57%"], "AH maxi pack €2,14 is over €1,25");
  // Without the price limit: a big 40% pack saves the most euros, but the deeper discounts go first.
  v.deal_rules.a = { ...v.deal_rules.a, max_price_cents: null };
  v.offers["of-edet-ah-40"] = { id: "of-edet-ah-40", store: "Albert Heijn", name: "Edet vochtig toiletpapier 6-pack", deal: "-40%", price_cents: 1000, valid_from: null, valid_until: "2026-11-01" };
  const deep = dealsFor(v, TODAY).filter((h) => h.check);
  assert.deepEqual(deep.map((h) => `${h.offer.store}: ${h.eff.discount_pct}%`), ["Hoogvliet: 57%", "Albert Heijn: 50%", "Albert Heijn: 40%"]);
  assert.ok(deep[2].saving_cents > deep[0].saving_cents, "the 40% one saves more euros");
});

const TUNA = { id: "item-tuna-00001", name: "Minoestuna", name_key: "minoestuna" };
const TUNA_WORDS = ["tonijn", "tuna"];
const TUNA_OUT = ["salade", "sushi", "pizza", "wrap", "sandwich", "spread", "tonijnsalade"];

test("exclude words: canned tuna for the cat, never a tuna salad or pizza", () => {
  const v = wordView();
  v.items[TUNA.id] = { ...TUNA, deleted_at: null };
  v.deal_rules.u = rule("rule-tuna-0001", { item_id: TUNA.id, detour: 1, min_discount_pct: 30, offer_only: 1, match_words: TUNA_WORDS, exclude_words: TUNA_OUT });
  const add = (id, store, name, deal, price) => { v.offers[id] = { id, store, name, deal, price_cents: price, brand: null, size: null, valid_from: null, valid_until: "2026-11-01" }; };
  add("of-tuna-water", "Albert Heijn", "AH Tonijn in water", "1+1 gratis", null);
  add("of-tuna-olie", "Dirk", "Zeeparel tonijn in olie", "-35%", 249);
  add("of-tuna-salad", "Albert Heijn", "AH Tonijnsalade", "50% korting", 129);
  add("of-tuna-pizza", "Dirk", "Pizza tonijn", "-50%", 199);
  add("of-tuna-wrap", "Dirk", "Tuna wrap", "-40%", 199);
  const tuna = dealsFor(v, TODAY).filter((h) => h.item.id === TUNA.id).map((h) => h.offer.name);
  assert.deepEqual(tuna, ["AH Tonijn in water", "Zeeparel tonijn in olie"]);
  // The real fixture row: fresh "Geelvintonijn" per 100 gram has no discount, so it fails 30%.
  assert.equal(namesWord(real("AH Geelvintonijn"), "tonijn"), true);
  assert.ok(!tuna.includes("AH Geelvintonijn"));
  assert.equal(excluded({ exclude_words: TUNA_OUT }, { name: "AH Tonijnsalade" }), true, "salade at the end of a compound");
  assert.equal(excluded({ exclude_words: TUNA_OUT }, { name: "AH Tonijn in water" }), false);
});

test("omweg waard vanaf 50%: AH and Dirk from 30%, other stores only from 50%", () => {
  const v = wordView();
  v.deal_rules.t = { ...v.deal_rules.t, offer_only: 1, min_discount_pct: 30, detour_min_discount_pct: 50 };
  const add = (id, store, deal) => { v.offers[id] = { id, store, name: "Felix pouches kip", deal, price_cents: 300, brand: null, size: null, valid_from: null, valid_until: "2026-11-01" }; };
  add("of-felix-ah35", "Albert Heijn", "35% korting");
  add("of-felix-dk25", "Dirk", "-25%");
  add("of-felix-lid40", "Lidl", "-40%");
  add("of-felix-plus50", "PLUS", "-50%");
  const mines = dealsFor(v, TODAY).filter((h) => h.item.id === MINES.id);
  assert.deepEqual(mines.map((h) => `${h.offer.store} ${h.eff.discount_pct}% ${h.detour ? "detour" : "regular"}`), [
    "PLUS 50% detour",
    "Albert Heijn 35% regular",
  ], "Dirk 25% < 30, Lidl 40% < 50, Poiesz has no discount at all");
  assert.ok(mines[0].checks.some((c) => c.check === "detour_min_discount" && c.ok));
  // Without the detour minimum, Lidl's 40% counts.
  v.deal_rules.t = { ...v.deal_rules.t, detour_min_discount_pct: null };
  assert.ok(dealsFor(v, TODAY).some((h) => h.offer.id === "of-felix-lid40"));
});

test("ops: exclude words and the detour minimum; the minimum means omweg waard", () => {
  const s = opState();
  s.items[TUNA.id] = { ...TUNA, deleted_at: null };
  const r = applyOp(s, { type: "deal_rule.set", id: "rule-tuna-0001", item_id: TUNA.id, min_discount_pct: 30, detour_min_discount_pct: 50, match_words: TUNA_WORDS, exclude_words: TUNA_OUT }, ctx);
  const row = s.deal_rules[r.result.deal_rule_id];
  assert.deepEqual([row.detour, row.offer_only, row.min_discount_pct, row.detour_min_discount_pct], [1, 1, 30, 50]);
  assert.deepEqual(row.exclude_words, ["pizza", "salade", "sandwich", "spread", "sushi", "tonijnsalade", "wrap"]);
  assert.equal(refused(s, { type: "deal_rule.set", id: "rule-tuna-0001", item_id: TUNA.id, detour_min_discount_pct: 99 }), "bad_field");
  assert.equal(refused(s, { type: "deal_rule.set", id: "rule-tuna-0001", item_id: TUNA.id, detour_min_discount_pct: 12.5 }), "bad_field");
  assert.equal(refused(s, { type: "deal_rule.set", id: "rule-tuna-0001", item_id: TUNA.id, exclude_words: ["spruitjes"] }), "excluded");
  // A title makes the item when "Minoestuna" is not there yet.
  const made = applyOp(s, { type: "deal_rule.set", id: "rule-tuna-0002", title: "Minoestuna", item_id: "item-tuna-new1", detour: true }, ctx);
  assert.equal(made.result.item_id, TUNA.id, "an existing item by name is reused");
});

test("sync: exclude words and the detour minimum go out and come back", async () => {
  const { env, thomas } = await household();
  const head = await pull(env, thomas, 0);
  const [set] = await send(env, thomas, [op({ type: "deal_rule.set", id: "rule-d1-tuna01", title: "Minoestuna", item_id: "item-d1-tuna001", min_discount_pct: 30, detour_min_discount_pct: 50, match_words: TUNA_WORDS, exclude_words: TUNA_OUT })]);
  assert.equal(set.ok, true, JSON.stringify(set));
  const delta = await pull(env, thomas, head.rev);
  assert.deepEqual(delta.deal_rules.map((x) => [x.detour, x.min_discount_pct, x.detour_min_discount_pct, x.exclude_words.length]), [[1, 30, 50, 7]]);
  assert.deepEqual(delta.items.map((i) => i.name), ["Minoestuna"]);
});

// ------------------------------------------------- cheaper at the other store

const DIRK_WIPES = { id: "product-dirk-wp", item_id: ITEMS.wipes.id, brand: "", name: "Vochtig toiletpapier", size: null, store: "Dirk", last_price_cents: 219 };
const AH_EDET = { id: "product-ah-edet", item_id: ITEMS.wipes.id, brand: "Edet", name: "Edet vochtig toiletpapier maxi pack", size: null, store: "Albert Heijn", last_price_cents: 429 };
const pref = (id, store, product) => ({ id, item_id: ITEMS.wipes.id, store, recipe_id: "", product_id: product.id, updated_at: "2026-10-28", deleted_at: null });

function storeView() {
  const v = view();
  v.products[DIRK_WIPES.id] = { ...DIRK_WIPES, deleted_at: null };
  v.products[AH_EDET.id] = { ...AH_EDET, deleted_at: null };
  v.preferences = { a: pref("pref-ah-000001", "Albert Heijn", AH_EDET), d: pref("pref-dirk-00001", "Dirk", DIRK_WIPES) };
  return v;
}
const LINE = { id: "entry-wipes-01", item_id: ITEMS.wipes.id, title: "Vochtig toiletpapier", sources: [] };

test("cheaper elsewhere: the real AH and Dirk rows, each store's own product", () => {
  const v = storeView();
  const current = currentOffers(v.offers, TODAY);
  // AH: Edet maxi pack 50% korting €2,14; Dirk: its own wipes -55% €0,99.
  assert.deepEqual([priceAt(v, LINE, "Albert Heijn", current, new Map())?.cents, priceAt(v, LINE, "Dirk", current, new Map())?.cents], [214, 99]);
  const hint = cheaperElsewhere(v, LINE, current);
  assert.deepEqual([hint.cheap.store, hint.cheap.cents, hint.dear.store, hint.dear.cents], ["Dirk", 99, "Albert Heijn", 214]);
  assert.equal(hint.cheap.offer.name, "Vochtig toiletpapier");
  // Another kind or pack in the folder is not his product: no price from it.
  assert.equal(sameProductOffer(DIRK_WIPES, EDET_SENSITIVE), false, "Edet Sensitive is not Dirk's own wipes");
  assert.equal(sameProductOffer(PRODUCTS.edet, real("Edet vochtig toiletpapier maxi pack")), false, "a maxi pack is not the 42-pack");
  assert.equal(sameProductOffer(PRODUCTS.edet, EDET_PINK), true);
  assert.equal(sameProductOffer(DIRK_WIPES, real("Vochtig toiletpapier", "Dirk")), true);
  v.offers[EDET_SENSITIVE.id] = { ...EDET_SENSITIVE, price_cents: 49 };
  assert.equal(priceAt(v, LINE, "Dirk", currentOffers(v.offers, TODAY), new Map()).cents, 99, "the Sensitive €0,49 at Dirk does not count");
  // At Dirk already: nothing to say. At AH: Dirk is €1,15 cheaper.
  assert.equal(cheaperElsewhere(v, LINE, current, "Dirk"), null);
  assert.equal(cheaperElsewhere(v, LINE, current, "AH").cheap.store, "Dirk");
});

test("cheaper elsewhere: no offers, the last prices; unknown on one side or another pack is nothing", () => {
  const v = storeView();
  const none = [];
  // Last prices: AH €4,29, Dirk €2,19.
  assert.deepEqual(Object.values(cheaperElsewhere(v, LINE, none)).map((x) => [x.store, x.cents]), [["Dirk", 219], ["Albert Heijn", 429]]);
  // A small gap is noise once a store is chosen: €0,20 and 5%.
  v.products[DIRK_WIPES.id].last_price_cents = 409;
  assert.ok(cheaperElsewhere(v, LINE, none), "no store chosen: still said");
  assert.equal(cheaperElsewhere(v, LINE, none, "Albert Heijn"), null, "€0,20 and 5% is under €0,30 and 10%");
  v.products[DIRK_WIPES.id].last_price_cents = 380;
  assert.equal(cheaperElsewhere(v, LINE, none, "Albert Heijn").cheap.cents, 380, "€0,49 is enough");
  // Dirk's price unknown: nothing, never a guess.
  v.products[DIRK_WIPES.id].last_price_cents = null;
  assert.equal(cheaperElsewhere(v, LINE, none), null);
  // Another pack size: nothing.
  v.products[DIRK_WIPES.id] = { ...v.products[DIRK_WIPES.id], last_price_cents: 219, size: "64 stuks" };
  v.products[AH_EDET.id] = { ...v.products[AH_EDET.id], size: "42 stuks" };
  assert.equal(cheaperElsewhere(v, LINE, none), null);
  // Excluded never.
  assert.equal(cheaperElsewhere(v, { ...LINE, title: "Verse spruitjes" }, none), null);
});
