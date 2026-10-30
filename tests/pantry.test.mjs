// Phase 4, the pantry: the shelf-life table, ticking and receipts without
// double counting, cooking with scaling and units, thrown things remembered,
// the due list, the wizard's use-up weight, "need it again", usage on D1,
// and never an excluded thing. The MCP tool is tested in tests/mcp.test.mjs.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { applyOp, emptyState, OpError } from "../public/shared/ops.js";
import { shelfLife, estimateUseBy, NONE, RULES } from "../public/shared/shelf-life.js";
import {
  packSize, fromEntry, matchPurchase, cookTakes, pantryGroups, inStock, displayAmount, wasteCounts, useUpSoon,
  entryPantryId, liveRows,
} from "../public/shared/pantry.js";
import { scaleIngredient, parseIngredient } from "../public/shared/ingredients.js";
import { propose, WEIGHTS } from "../public/shared/wizard.js";
import { dueItems } from "../public/shared/intervals.js";
import { buildOps, PANTRY_DAYS, vocabulary } from "../tools/import_ah.mjs";
import { hashDevice } from "../worker/auth.js";

const ctx = (now = "2026-10-28T10:00:00.000Z") => ({ memberId: "member-thomas-01", isAdmin: true, now });

// ------------------------------------------------------------ shelf life

test("shelf life: per kind of product, conservative, none for dry goods", () => {
  const days = (name) => shelfLife(name).days;
  assert.equal(days("Kipfilet"), 2, "fresh meat");
  assert.equal(days("Rundergehakt"), 2);
  assert.equal(days("Zalmfilet"), 2, "fish");
  assert.equal(days("Halfvolle melk"), 7, "milk");
  assert.equal(days("Karnemelk"), 7);
  assert.equal(days("Kokosmelk"), NONE, "coconut milk is a tin, not milk");
  assert.equal(days("Jong belegen kaas"), 28, "cheese ~4 weeks");
  assert.equal(days("Geraspte kaas"), 7, "grated cheese goes sooner");
  assert.equal(days("Pindakaas"), NONE, "peanut butter is no cheese");
  assert.equal(days("Spaghetti"), NONE, "pasta none");
  assert.equal(days("Verse pasta"), 5, "fresh pasta has a date");
  assert.equal(days("Basmati rijst"), NONE);
  assert.equal(days("Tomatenblokjes"), NONE, "a tin");
  assert.equal(days("Tomaten"), 5);
  assert.equal(days("Appelsap"), 5, "juice, not an apple");
  assert.equal(days("Verse kruiden"), 3, "fresh herbs are no dried herbs");
  assert.equal(days("Eieren"), 21);
  assert.equal(days("Roomboter"), 30, "butter, not cream");
  assert.equal(days("Slagroom"), 7);
  assert.equal(days("Kattenbakvulling"), null, "nothing known: no estimate");
  assert.equal(estimateUseBy("2026-10-28", "Kipfilet"), "2026-10-30");
  assert.equal(estimateUseBy("2026-10-28", "Spaghetti"), null, "keeps: no date");
  assert.equal(estimateUseBy("2026-10-31", "Melk"), "2026-11-07", "across a month");
  assert.equal(estimateUseBy("2026-10-28", "AH Huismerk iets", "Kipfilet"), "2026-10-30", "the first name that says something decides");
  for (const [pattern, d, kind] of RULES) {
    assert.ok(pattern instanceof RegExp && (d === NONE || (Number.isInteger(d) && d > 0 && d <= 60)) && kind, `rule ${kind}`);
  }
});

test("pack sizes and ticked amounts", () => {
  assert.deepEqual(packSize("400 g"), { qty: 400, base: "g" });
  assert.deepEqual(packSize("1 l"), { qty: 1000, base: "ml" });
  assert.deepEqual(packSize("0,5 kg"), { qty: 500, base: "g" });
  assert.deepEqual(packSize("10 st"), { qty: 10, base: "piece" });
  assert.deepEqual(packSize("6 stuks"), { qty: 6, base: "piece" });
  assert.equal(packSize("los"), null);
  assert.equal(packSize(""), null);
  assert.deepEqual(fromEntry({ amounts: [{ qty: 2, unit: null }] }), { amount: 2, pack_size: "" }, "2 melk: two packs");
  assert.deepEqual(fromEntry({ amounts: [{ qty: 500, unit: "g" }] }), { amount: 1, pack_size: "500 g" }, "500 g gehakt: one pack of 500 g");
  assert.deepEqual(fromEntry({ amounts: [] }), { amount: 1, pack_size: "" });
  assert.deepEqual(fromEntry({ amounts: [{ text: "veel" }] }), { amount: 1, pack_size: "" });
  assert.equal(displayAmount(0.5), 0.5);
  assert.equal(displayAmount(0.62), 0.5);
  assert.equal(displayAmount(0.1), 0.25, "a little left still shows");
});

// ---------------------------------------------- tick, receipt, no doubles

function tickState() {
  const s = emptyState();
  applyOp(s, { type: "entry.add", id: "entry-melk-0001", item_id: "item-melk-00001", title: "Melk", amounts: [{ qty: 2, unit: null }] }, ctx());
  applyOp(s, { type: "entry.add", id: "entry-kip-00001", item_id: "item-kip-000001", title: "Kipfilet", amounts: [{ qty: 500, unit: "g" }] }, ctx());
  applyOp(s, { type: "entry.add", id: "entry-sprt-0001", item_id: "item-sprt-00001", title: "Spruitjes" }, ctx());
  return s;
}

const receipt = (id, day = "2026-10-28") => ({ type: "receipt.save", id, store: "AH", bought_on: day, total_cents: 0, lines: [] });

test("tick: the line goes into the pantry with an estimated date; untick takes it out again", () => {
  const s = tickState();
  const { changed } = applyOp(s, { type: "entry.check", id: "entry-melk-0001", checked: true, on: "2026-10-28" }, ctx());
  const row = s.pantry[entryPantryId("entry-melk-0001")];
  assert.deepEqual([row.title, row.amount, row.added_on, row.use_by, row.use_by_source, row.source_entry_id],
    ["Melk", 2, "2026-10-28", "2026-11-04", "estimate", "entry-melk-0001"]);
  assert.deepEqual(changed.map(([k]) => k).sort(), ["entries", "pantry"], "the line and its one row");
  applyOp(s, { type: "entry.check", id: "entry-kip-00001", checked: true, on: "2026-10-28" }, ctx());
  const kip = s.pantry[entryPantryId("entry-kip-00001")];
  assert.deepEqual([kip.amount, kip.pack_size, kip.use_by], [1, "500 g", "2026-10-30"]);
  applyOp(s, { type: "entry.check", id: "entry-melk-0001", checked: false }, ctx());
  assert.ok(row.deleted_at, "a mistap undone: gone again");
  applyOp(s, { type: "entry.check", id: "entry-melk-0001", checked: true, on: "2026-10-28" }, ctx());
  assert.equal(s.pantry[row.id].deleted_at, null, "ticked again: the same row back");
  assert.equal(Object.keys(s.pantry).length, 2);
});

test("tick: excluded never goes into the pantry", () => {
  const s = tickState();
  applyOp(s, { type: "entry.check", id: "entry-sprt-0001", checked: true }, ctx());
  assert.equal(Object.keys(s.pantry).length, 0);
  assert.throws(() => applyOp(s, { type: "pantry.add", id: "pantry-sprx-001", item_id: "item-sprx-00001", title: "Verse spruitjes" }, ctx()),
    (e) => e instanceof OpError && e.code === "excluded");
  const groups = pantryGroups({ x: { id: "x", title: "Groene Ster spruitjes", amount: 1, added_on: "2026-10-28", use_by: "2026-10-28" } }, "2026-10-28");
  assert.deepEqual([groups.due.length, groups.rest.length], [0, 0], "and a row that slipped in is never shown");
});

test("receipt after a tick fills in the product and never counts twice", () => {
  const s = tickState();
  applyOp(s, { type: "entry.check", id: "entry-melk-0001", checked: true, on: "2026-10-27" }, ctx());
  applyOp(s, receipt("receipt-0000001"), ctx());
  const { result } = applyOp(s, {
    type: "purchase.add", id: "purchase-000001", source: "receipt", receipt_id: "receipt-0000001", pantry: true,
    title: "melk", item_id: "item-unused-0001", bought_on: "2026-10-28", store: "AH", qty: 2, price_cents: 238,
    product: { id: "product-melk-01", name: "Halfvolle melk", brand: "AH", size: "1 l" },
  }, ctx());
  const rows = liveRows(s.pantry);
  assert.equal(rows.length, 1, "one row, not two");
  assert.equal(result.pantry_id, entryPantryId("entry-melk-0001"));
  assert.deepEqual([rows[0].product_id, rows[0].pack_size, rows[0].amount, rows[0].source_purchase_id],
    ["product-melk-01", "1 l", 2, "purchase-000001"]);
  // The same purchase again (a retry) changes nothing.
  applyOp(s, { type: "purchase.add", id: "purchase-000001", source: "receipt", pantry: true, title: "melk", bought_on: "2026-10-28", item_id: "item-unused-0001" }, ctx());
  assert.equal(liveRows(s.pantry).length, 1);
  // A second purchase of milk on the same receipt is a second carton set: a row of its own.
  applyOp(s, { type: "purchase.add", id: "purchase-000002", source: "receipt", pantry: true, title: "melk", item_id: "item-unused-0002", bought_on: "2026-10-28", qty: 1 }, ctx());
  assert.equal(liveRows(s.pantry).length, 2, "the tick was used up by the first purchase");
});

test("receipt after cooking: what was bought minus what was taken; far apart is not the same shopping", () => {
  const s = tickState();
  applyOp(s, { type: "entry.check", id: "entry-kip-00001", checked: true, on: "2026-10-28" }, ctx());
  const pid = entryPantryId("entry-kip-00001");
  applyOp(s, { type: "pantry.use", reason: "cooked", on: "2026-10-28", takes: [{ event_id: "event-cook-0001", pantry_id: pid, amount: null }] }, ctx());
  assert.ok(s.pantry[pid].deleted_at, "eaten the same day");
  applyOp(s, {
    type: "purchase.add", id: "purchase-kip-001", source: "receipt", pantry: true, title: "Kipfilet", item_id: "item-unused-0003",
    bought_on: "2026-10-29", qty: 1, product: { id: "product-kip-001", name: "Kipfilet", brand: "AH", size: "500 g" },
  }, ctx());
  assert.equal(liveRows(s.pantry).length, 0, "the AH import a day later does not bring the eaten chicken back");
  assert.equal(s.pantry[pid].source_purchase_id, "purchase-kip-001");
  assert.equal(matchPurchase(s.pantry, { item_id: "item-kip-000001", bought_on: "2026-10-29" }), null, "filled in once");

  const t = tickState();
  applyOp(t, { type: "entry.check", id: "entry-melk-0001", checked: true, on: "2026-10-20" }, ctx());
  applyOp(t, { type: "purchase.add", id: "purchase-melk-09", source: "receipt", pantry: true, title: "Melk", item_id: "item-unused-0004", bought_on: "2026-10-28", qty: 1 }, ctx());
  assert.equal(liveRows(t.pantry).length, 2, "eight days apart: another shopping");
  const fromHistory = tickState();
  applyOp(fromHistory, { type: "purchase.add", id: "purchase-hist-01", source: "history", pantry: true, title: "Melk", item_id: "item-unused-0005", bought_on: "2026-10-28" }, ctx());
  assert.equal(Object.keys(fromHistory.pantry).length, 0, "the old history never fills the pantry");
  const noFlag = tickState();
  applyOp(noFlag, { type: "purchase.add", id: "purchase-old-001", source: "receipt", title: "Melk", item_id: "item-unused-0006", bought_on: "2024-01-02" }, ctx());
  assert.equal(Object.keys(noFlag.pantry).length, 0, "a receipt without pantry: true (an old AH receipt) neither");
});

test("AH import: only the last PANTRY_DAYS days' receipts go into the pantry", () => {
  const line = (name) => ({ kind: "product", name, brand: "AH", size: "1 l", qty: 1, price_cents: 119, webshopId: 1, posId: 1, receiptName: name });
  const r = (id, day) => ({ id, day, total_cents: 119, lines: [line("Halfvolle melk")], dropped: { excluded: 0, other: 0 } });
  const vocab = vocabulary(["Melk"]);
  const { ops } = buildOps([r("old-1", "2024-05-01"), r("new-1", "2026-10-25")], vocab, { pantrySince: "2026-10-18" });
  const purchases = ops.filter((o) => o.type === "purchase.add");
  assert.deepEqual(purchases.map((o) => [o.bought_on, Boolean(o.pantry)]), [["2024-05-01", false], ["2026-10-25", true]]);
  assert.equal(buildOps([r("new-1", "2026-10-25")], vocab).ops.filter((o) => o.pantry).length, 0, "no pantrySince: none");
  assert.equal(PANTRY_DAYS, 10);
});

// ----------------------------------------------------------------- cooking

function pantryOf(rows) {
  return Object.fromEntries(rows.map((r, i) => [r.id, { id: r.id, item_id: r.item_id ?? `item-${i}`, taken: 0, pack_size: "", added_on: "2026-10-26", use_by: null, deleted_at: null, ...r }]));
}
const ing = (line) => parseIngredient(line);

test("cooking: scaled to the servings, converted against the pack, never below zero", () => {
  const data = {
    pantry: pantryOf([
      { id: "pantry-kaas-01", title: "Kaas", amount: 1, pack_size: "400 g" },
      { id: "pantry-kip-01", title: "Kipfilet", amount: 1, pack_size: "" },
      { id: "pantry-eieren-01", title: "Eieren", amount: 1, pack_size: "10 st" },
      { id: "pantry-uien-01", title: "Uien", amount: 3 },
      { id: "pantry-tomaat-a-01", title: "Tomatenblokjes", amount: 1, use_by: null },
      { id: "pantry-olie-01", title: "Olijfolie", amount: 1, pack_size: "500 ml" },
      { id: "pantry-melk-01", title: "Melk", amount: 1, pack_size: "1 l" },
    ]),
    items: {},
    pantry_events: {},
  };
  const recipe = {
    id: "recipe-test-001", servings: 2,
    ingredients: [
      ing("100 g geraspte kaas"), ing("400 g kipfilet"), ing("2 eieren"), ing("1 ui"), ing("2 blikken tomatenblokjes"),
      ing("2 el olijfolie"), ing("1,5 l melk"), { ...ing("peterselie"), optional: true }, { name: "Saus", heading: true },
    ],
  };
  const takes = cookTakes({ recipe, data, today: "2026-10-28", scale: (i) => scaleIngredient(i, 2, 4) });
  const by = Object.fromEntries(takes.map((t) => [t.pantry_id, t.amount]));
  assert.equal(by["pantry-kaas-01"], 0.5, "200 g (scaled ×2) from 400 g: half a cheese");
  assert.equal(by["pantry-kip-01"], 1, "no pack size: one pack, never more than there is");
  assert.equal(by["pantry-eieren-01"], 0.4, "4 eggs from a box of 10");
  assert.equal(by["pantry-uien-01"], 2, "2 onions (ui is uien), counted in pieces");
  assert.equal(by["pantry-tomaat-a-01"], 1, "4 tins wanted, 1 there: never below zero");
  assert.equal(by["pantry-olie-01"], 0.12, "spoons: 4 el (scaled) of oil is 60 ml of a 500 ml bottle, an estimate");
  assert.equal(by["pantry-melk-01"], 1, "3 l wanted from 1 l: all of it, no more");
  assert.deepEqual(cookTakes({ recipe, data, today: "2026-10-28" }).find((t) => t.pantry_id === "pantry-kaas-01").amount, 0.25,
    "without scaling 100 g is a quarter");
  const ticked = { pantry: pantryOf([{ id: "pantry-tick-melk", title: "Melk", amount: 2 }, { id: "pantry-tick-gehakt", title: "Gehakt", amount: 1 }]), items: {}, pantry_events: {} };
  const splash = cookTakes({ recipe: { id: "recipe-splash-01", ingredients: [ing("100 ml melk"), ing("150 g gehakt")] }, data: ticked, today: "2026-10-28" });
  assert.deepEqual(splash.map((t) => [t.pantry_id, t.amount]), [["pantry-tick-gehakt", 1]],
    "no pack size: a splash of milk is left alone, a real amount takes the pack");

  // Through the engine: half a cheese is left, and the undo puts it back.
  const s = emptyState();
  Object.assign(s.pantry, structuredClone(data.pantry));
  applyOp(s, { type: "pantry.use", reason: "cooked", recipe_id: "recipe-test-001", on: "2026-10-28",
    takes: takes.map((t, i) => ({ event_id: `event-cook-${String(i).padStart(4, "0")}`, pantry_id: t.pantry_id, amount: t.amount })) }, ctx());
  assert.equal(s.pantry["pantry-kaas-01"].amount, 0.5);
  assert.ok(s.pantry["pantry-kip-01"].deleted_at, "the chicken is gone");
  assert.equal(liveRows(s.pantry).find((r) => r.id === "pantry-uien-01").amount, 1);
  assert.deepEqual(cookTakes({ recipe, data: s, today: "2026-10-28" }), [], "cook mode's end and \"gegeten\" are one meal");
  applyOp(s, { type: "pantry.unuse", event_ids: Object.keys(s.pantry_events) }, ctx());
  assert.deepEqual([s.pantry["pantry-kaas-01"].amount, s.pantry["pantry-kip-01"].amount, s.pantry["pantry-kip-01"].deleted_at, s.pantry["pantry-kip-01"].taken], [1, 1, null, 0]);
});

test("cooking: two rows of one thing, the one that runs out first is taken first", () => {
  const data = {
    pantry: pantryOf([
      { id: "p-melk-new", title: "Melk", amount: 1, pack_size: "1 l", use_by: "2026-11-04" },
      { id: "p-melk-old", title: "Melk", amount: 0.5, pack_size: "1 l", use_by: "2026-10-29" },
    ]),
    items: {}, pantry_events: {},
  };
  const takes = cookTakes({ recipe: { id: "recipe-pann-001", ingredients: [ing("750 ml melk")] }, data, today: "2026-10-28" });
  assert.deepEqual(takes.map((t) => [t.pantry_id, t.amount]), [["p-melk-old", 0.5], ["p-melk-new", 0.25]]);
});

// ------------------------------------------------------- op, thrown, undo

test("pantry.use: thrown is remembered per item, undo forgets it", () => {
  const s = emptyState();
  applyOp(s, { type: "pantry.add", id: "pantry-sla-0001", item_id: "item-sla-000001", title: "Sla", on: "2026-10-20" }, ctx());
  applyOp(s, { type: "pantry.add", id: "pantry-sla-0002", item_id: "item-unused-0001", title: "sla", on: "2026-10-25" }, ctx());
  assert.equal(s.pantry["pantry-sla-0001"].use_by, "2026-10-23", "estimated");
  applyOp(s, { type: "pantry.use", reason: "thrown", on: "2026-10-26", takes: [{ event_id: "event-thrown-01", pantry_id: "pantry-sla-0001" }] }, ctx());
  applyOp(s, { type: "pantry.use", reason: "thrown", on: "2026-10-28", takes: [{ event_id: "event-thrown-02", pantry_id: "pantry-sla-0002" }] }, ctx());
  assert.deepEqual(wasteCounts(s.pantry_events), { "item-sla-000001": { count: 2, last: "2026-10-28" } }, "per item, both times");
  assert.equal(liveRows(s.pantry).length, 0);
  applyOp(s, { type: "pantry.unuse", event_ids: ["event-thrown-02"] }, ctx());
  assert.equal(wasteCounts(s.pantry_events)["item-sla-000001"].count, 1);
  assert.equal(liveRows(s.pantry).length, 1, "and the lettuce is back");
  // A replayed use changes nothing; "op" is not waste.
  applyOp(s, { type: "pantry.use", reason: "used", takes: [{ event_id: "event-used-001", pantry_id: "pantry-sla-0002" }] }, ctx());
  applyOp(s, { type: "pantry.use", reason: "used", takes: [{ event_id: "event-used-001", pantry_id: "pantry-sla-0002" }] }, ctx());
  assert.equal(wasteCounts(s.pantry_events)["item-sla-000001"].count, 1);
  assert.throws(() => applyOp(s, { type: "pantry.use", reason: "eaten", takes: [{ event_id: "event-bad-0001", pantry_id: "pantry-sla-0002" }] }, ctx()),
    (e) => e.code === "bad_field");
  assert.throws(() => applyOp(s, { type: "pantry.update", id: "pantry-sla-0001", use_by: "morgen" }, ctx()), (e) => e.code === "not_found");
});

test("pantry.update: the person's date and amount; a person's date survives a receipt", () => {
  const s = emptyState();
  applyOp(s, { type: "entry.add", id: "entry-kaas-0001", item_id: "item-kaas-00001", title: "Kaas" }, ctx());
  applyOp(s, { type: "entry.check", id: "entry-kaas-0001", checked: true, on: "2026-10-28" }, ctx());
  const pid = entryPantryId("entry-kaas-0001");
  applyOp(s, { type: "pantry.update", id: pid, use_by: "2026-12-01", amount: 0.5 }, ctx());
  assert.deepEqual([s.pantry[pid].use_by, s.pantry[pid].use_by_source, s.pantry[pid].amount], ["2026-12-01", "person", 0.5]);
  applyOp(s, { type: "purchase.add", id: "purchase-kaas-01", source: "receipt", pantry: true, title: "Kaas", item_id: "item-unused-0001", bought_on: "2026-10-28", qty: 1,
    product: { id: "product-kaas-01", name: "Jong belegen kaas", brand: "AH", size: "400 g" } }, ctx());
  assert.equal(s.pantry[pid].use_by, "2026-12-01", "the typed date stays");
  applyOp(s, { type: "pantry.update", id: pid, amount: 0 }, ctx());
  assert.ok(s.pantry[pid].deleted_at, "zero is gone");
});

// ------------------------------------------------------------ the due list

test("due list: within two days or past first, soonest first; the rest dated first, then by name", () => {
  const p = pantryOf([
    { id: "a", title: "Rijst", amount: 1, use_by: null },
    { id: "b", title: "Melk", amount: 1, use_by: "2026-11-04" },
    { id: "c", title: "Kipfilet", amount: 1, use_by: "2026-10-29" },
    { id: "d", title: "Yoghurt", amount: 1, use_by: "2026-10-27" },
    { id: "e", title: "Kaas", amount: 1, use_by: "2026-10-30" },
    { id: "f", title: "Spinazie", amount: 1, use_by: "2026-10-31" },
    { id: "g", title: "Weg", amount: 0, use_by: "2026-10-28" },
  ]);
  const { due, rest } = pantryGroups(p, "2026-10-28");
  assert.deepEqual(due.map((r) => r.title), ["Yoghurt", "Kipfilet", "Kaas"]);
  assert.deepEqual(rest.map((r) => r.title), ["Spinazie", "Melk", "Rijst"]);
  assert.deepEqual(useUpSoon(p, "2026-10-28").map((u) => [u.title, u.days]), [["Yoghurt", -1], ["Kipfilet", 1], ["Kaas", 2], ["Spinazie", 3]]);
});

// ------------------------------------------------------------------ wizard

test("wizard: a recipe that uses up what must go comes first, with the reason", () => {
  const recipe = (id, title, main) => ({ id, title, ingredients: [{ name: main, qty: 1 }], steps: ["x"], meals: ["dinner"] });
  const data = {
    recipes: {
      r1: { ...recipe("r1", "Kip kerrie", "kipfilet"), ingredients: [{ name: "kipfilet", qty: 1 }, { name: "melk", qty: 1 }] },
      r2: recipe("r2", "Pasta pesto", "pesto"),
      r3: recipe("r3", "Zalm", "zalm"),
      r4: recipe("r4", "Pannenkoeken", "melk"),
    },
    cooks: {}, purchases: {}, entries: {}, items: {},
    pantry: pantryOf([
      { id: "p1", title: "Kipfilet", amount: 1, use_by: "2026-10-29" },
      { id: "p2", title: "Melk", amount: 1, use_by: "2026-11-10" },
    ]),
  };
  const [first, ...others] = propose({ data, today: "2026-10-28", random: () => 0, count: 4 });
  assert.equal(first.recipe.id, "r1");
  assert.deepEqual(first.reasons[0], { key: "use_up", vars: { name: "kipfilet", days: 1 }, weight: WEIGHTS.use_up });
  assert.deepEqual(first.reasons[1].key === "in_house" && first.reasons[1].vars.name, "melk", "not kipfilet twice: the other one in the house");
  const milk = others.find((p) => p.recipe.id === "r4");
  assert.equal(milk.reasons[0].key, "in_house", "the pantry also counts as in the house, without a use-up push");
  assert.ok(others[0].recipe.id === "r4", "in the house beats nothing");
});

// ---------------------------------------------------------- need it again

test("need it again: something still in the pantry is not due", () => {
  const purchases = {};
  ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"].forEach((d, i) => {
    purchases[`pm${i}`] = { id: `pm${i}`, item_id: "item-melk", title: "Melk", bought_on: d };
    purchases[`pr${i}`] = { id: `pr${i}`, item_id: "item-rijst", title: "Rijst", bought_on: d };
  });
  const items = { "item-melk": { id: "item-melk", name: "Melk" }, "item-rijst": { id: "item-rijst", name: "Rijst" } };
  const base = { purchases, items, entries: {} };
  const due = (pantry) => Object.fromEntries(dueItems({ ...base, pantry }, "2026-10-28").map((d) => [d.name, [d.due, d.in_pantry]]));
  assert.deepEqual(due({}), { Melk: [true, false], Rijst: [true, false] });
  const pantry = pantryOf([
    { id: "a", item_id: "item-melk", title: "Melk", amount: 1, use_by: "2026-11-02", added_on: "2026-10-26" },
    { id: "b", item_id: "item-rijst", title: "Rijst", amount: 1, use_by: null, added_on: "2026-10-26" },
  ]);
  assert.deepEqual(due(pantry), { Melk: [false, true], Rijst: [false, true] });
  assert.equal(inStock(pantry, "melk", "2026-11-03", 7), false, "past its date it no longer counts");
  assert.equal(inStock(pantry, "rijst", "2026-11-10", 7), false, "no date: one usual round, then it may be due again");
});

// --------------------------------------------------------------- on D1

const HOST = "groceries.localhost";
function call(env, method, p, { body, cookie } = {}) {
  const headers = { Origin: `http://${HOST}` };
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`http://${HOST}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
async function household() {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  return { env, thomas: tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456" } })) };
}
let counter = 0;
const op = (o) => ({ op_id: `op-pantry-${String(++counter).padStart(6, "0")}`, ...o });
const send = async (env, cookie, ops) => (await (await call(env, "POST", "/api/ops", { cookie, body: { ops } })).json()).results;
const pull = async (env, cookie, since) => (await call(env, "GET", `/api/sync?since=${since}`, { cookie })).json();

test("D1: tick, receipt, cook and throw on the worker, the same as on the phone", async () => {
  const { env, thomas } = await household();
  const ok = (results) => results.forEach((r) => assert.equal(r.ok, true, JSON.stringify(r)));
  ok(await send(env, thomas, [
    op({ type: "recipe.put", id: "recipe-kip-0001", recipe: { title: "Kip", servings: 2, ingredients: [{ name: "kipfilet", qty: 250, unit: "g" }] } }),
    op({ type: "entry.add", id: "entry-kip-00001", item_id: "item-kip-000001", title: "Kipfilet" }),
    op({ type: "entry.add", id: "entry-melk-0001", item_id: "item-melk-00001", title: "Melk", amounts: [{ qty: 2, unit: null }] }),
    op({ type: "entry.check", id: "entry-kip-00001", checked: true, on: "2026-10-28" }),
    op({ type: "entry.check", id: "entry-melk-0001", checked: true, on: "2026-10-28" }),
    op({ type: "receipt.save", id: "receipt-d1-0001", store: "AH", bought_on: "2026-10-28", total_cents: 600, lines: [] }),
    op({ type: "purchase.add", id: "purchase-d1-001", source: "receipt", receipt_id: "receipt-d1-0001", pantry: true, title: "Kipfilet", item_id: "item-unused-0001",
      bought_on: "2026-10-28", qty: 1, product: { id: "product-kip-001", name: "Kipfilet", brand: "AH", size: "500 g" } }),
  ]));
  let all = await pull(env, thomas, 0);
  assert.deepEqual(all.pantry.map((r) => [r.title, r.amount, r.pack_size, r.use_by]).sort(),
    [["Kipfilet", 1, "500 g", "2026-10-30"], ["Melk", 2, "", "2026-11-04"]], "two rows: the receipt filled in the tick");
  const kip = all.pantry.find((r) => r.title === "Kipfilet");
  const takes = cookTakes({ recipe: all.recipes[0], data: { pantry: Object.fromEntries(all.pantry.map((r) => [r.id, r])), items: {}, pantry_events: {} }, today: "2026-10-28" });
  assert.deepEqual(takes.map((t) => [t.pantry_id, t.amount]), [[kip.id, 0.5]], "250 g from a pack of 500 g");
  ok(await send(env, thomas, [
    op({ type: "pantry.use", reason: "cooked", recipe_id: "recipe-kip-0001", on: "2026-10-28", takes: [{ event_id: "event-d1-cook-1", pantry_id: kip.id, amount: 0.5 }] }),
    op({ type: "pantry.use", reason: "thrown", on: "2026-10-28", takes: [{ event_id: "event-d1-thro-1", pantry_id: entryPantryId("entry-melk-0001"), amount: 1 }] }),
  ]));
  all = await pull(env, thomas, 0);
  assert.deepEqual(all.pantry.map((r) => [r.title, r.amount]).sort(), [["Kipfilet", 0.5], ["Melk", 1]]);
  assert.deepEqual(all.pantry_events.map((e) => [e.reason, e.amount, e.item_id]).sort(),
    [["cooked", 0.5, "item-kip-000001"], ["thrown", 1, "item-melk-00001"]]);
  ok(await send(env, thomas, [op({ type: "pantry.unuse", event_ids: ["event-d1-cook-1"] })]));
  all = await pull(env, thomas, 0);
  assert.equal(all.pantry.find((r) => r.title === "Kipfilet").amount, 1, "undo on the worker puts it back");
});

test("usage: a pantry change writes only its rows, an idle poll still reads only the counter", async () => {
  const { env, thomas } = await household();
  await send(env, thomas, [op({ type: "pantry.add", id: "pantry-use-0001", item_id: "item-use-000001", title: "Kaas", on: "2026-10-28" })]);
  const head = await pull(env, thomas, 0);
  const batches = [];
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = (stmts) => {
    batches.push(stmts.map((x) => x.sql));
    return batch(stmts);
  };
  await send(env, thomas, [op({ type: "pantry.use", reason: "used", takes: [{ event_id: "event-use-0001", pantry_id: "pantry-use-0001", amount: 0.5 }] })]);
  const tables = batches.at(-1).map((sql) => sql.match(/^(?:INSERT INTO|UPDATE) (\w+)/)[1]).sort();
  assert.deepEqual(tables, ["applied_ops", "households", "pantry", "pantry_events"], "rev + row + event + applied_ops");
  // The same op again: answered from applied_ops, nothing written.
  const before = batches.length;
  await call(env, "POST", "/api/ops", { cookie: thomas, body: { ops: [{ op_id: `op-pantry-${String(counter).padStart(6, "0")}`, type: "pantry.use", reason: "used", takes: [{ event_id: "event-use-0001", pantry_id: "pantry-use-0001", amount: 0.5 }] }] } });
  assert.equal(batches.length, before);
  const delta = await pull(env, thomas, head.rev);
  assert.deepEqual([delta.pantry.length, delta.pantry_events.length, delta.items.length, delta.entries.length], [1, 1, 0, 0], "only what changed");

  const queries = [];
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    queries.push(sql);
    return prepare(sql);
  };
  const idle = await pull(env, thomas, delta.rev);
  assert.deepEqual([idle.pantry.length, idle.pantry_events.length], [0, 0]);
  assert.equal(queries.filter((sql) => /FROM (pantry|pantry_events|list_entries|items|recipes)\b/.test(sql)).length, 0,
    "the idle poll touches no data table");
});

test("D1: another household's pantry row is never touched", async () => {
  const a = await household();
  await send(a.env, a.thomas, [op({ type: "pantry.add", id: "pantry-shared-01", item_id: "item-a-0000001", title: "Kaas" })]);
  const now = new Date().toISOString();
  await a.env.DB.exec(`INSERT INTO households (id, name, rev, created_at) VALUES ('hh-other-000', 'Buren', 0, '${now}');
    INSERT INTO members (id, household_id, name, is_admin, created_at, rev) VALUES ('member-other-1', 'hh-other-000', 'Buur', 1, '${now}', 0);
    INSERT INTO devices (id, member_id, token_hash, created_at) VALUES ('device-other-1', 'member-other-1', '${await hashDevice("t".repeat(43))}', '${now}');`);
  const neighbour = "t".repeat(43);
  const res = await send(a.env, neighbour, [op({ type: "pantry.use", reason: "thrown", takes: [{ event_id: "event-steal-001", pantry_id: "pantry-shared-01" }] })]);
  assert.deepEqual(res[0].result, { events: [] }, "their phone sees no such row");
  const mine = await pull(a.env, a.thomas, 0);
  assert.equal(mine.pantry[0].amount, 1);
});
