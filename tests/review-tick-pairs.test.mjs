// The nightly check's input for a tick no receipt filled next to a receipt
// line of an item nobody listed (tickReceiptPairs, public/shared/pantry.js).
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { tickReceiptPairs, TICK_PAIRS_MAX, MATCH_DAYS } from "../public/shared/pantry.js";
import { addDays } from "../public/shared/shelf-life.js";

const DAY = "2026-11-06";
const items = { a: { id: "a", name: "Chinese groente" }, b: { id: "b", name: "Wokgroenten" }, c: { id: "c", name: "Melk" } };
const products = { p1: { id: "p1", name: "Wokgroente Chinees", brand: "AH" }, p2: { id: "p2", name: "Halfvolle melk", brand: "AH" } };
const tick = (id, item_id, o = {}) => ({ id, item_id, title: items[item_id].name, amount: 1, taken: 0, added_on: DAY, source_entry_id: `e-${id}`, source_purchase_id: null, deleted_at: null, ...o });
const buy = (id, item_id, product_id, o = {}) => ({ id, item_id, product_id, title: "x", source: "receipt", bought_on: DAY, deleted_at: null, ...o });
const run = (o) => tickReceiptPairs({ products, items, since: addDays(DAY, -3), ...o });

test("an unfilled tick next to a receipt line of an unlisted item is a pair", () => {
  const out = run({ pantry: { t: tick("t", "a") }, purchases: { x: buy("x", "b", "p1") } });
  assert.deepEqual(out, [{ day: DAY, purchase_id: "x", product_id: "p1", item_id: "b", ticks: [{ item_id: "a", empty: false }] }]);
});

test("a tick cooked away still pairs, marked empty", () => {
  const out = run({ pantry: { t: tick("t", "a", { amount: 0, taken: 1, deleted_at: "2026-11-05T20:00:00Z" }) }, purchases: { x: buy("x", "b", "p1") } });
  assert.equal(out[0].ticks[0].empty, true);
});

test("no pair when the receipt line's item was ticked itself, or the tick got its receipt", () => {
  assert.deepEqual(run({ pantry: { t: tick("t", "a"), u: tick("u", "b") }, purchases: { x: buy("x", "b", "p1") } }), []);
  assert.deepEqual(run({ pantry: { t: tick("t", "a", { source_purchase_id: "other" }) }, purchases: { x: buy("x", "b", "p1") } }), []);
});

test("no pair outside MATCH_DAYS, before `since`, for a deleted or history purchase, or a tick that was removed", () => {
  const old = addDays(DAY, -MATCH_DAYS - 1);
  assert.deepEqual(run({ pantry: { t: tick("t", "a", { added_on: old }) }, purchases: { x: buy("x", "b", "p1") } }), []);
  assert.deepEqual(run({ pantry: { t: tick("t", "a") }, purchases: { x: buy("x", "b", "p1", { bought_on: addDays(DAY, -9) }) } }), []);
  assert.deepEqual(run({ pantry: { t: tick("t", "a") }, purchases: { x: buy("x", "b", "p1", { deleted_at: "z" }), y: buy("y", "b", "p1", { source: "history" }) } }), []);
  assert.deepEqual(run({ pantry: { t: tick("t", "a", { deleted_at: "z" }) }, purchases: { x: buy("x", "b", "p1") } }), []);
});

test("a remembered 'Laat staan' (no_move) is never offered again", () => {
  const args = { pantry: { t: tick("t", "a"), s: tick("s", "c") }, purchases: { x: buy("x", "b", "p1") } };
  assert.equal(run(args)[0].ticks.length, 2);
  assert.deepEqual(run({ ...args, noMove: new Set(["p1|a"]) })[0].ticks.map((t) => t.item_id), ["c"]);
  assert.deepEqual(run({ ...args, noMove: new Set(["p1|a", "p1|c"]) }), []);
});

test("the input stays small", () => {
  const purchases = {};
  const pantry = { t: tick("t", "a") };
  for (let i = 0; i < 30; i++) purchases[`x${i}`] = buy(`x${i}`, `i${i}`, "p1");
  assert.equal(run({ pantry, purchases }).length, TICK_PAIRS_MAX);
});
