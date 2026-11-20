// A product moved to the right item (product.move), or two items merged
// (item.merge), folds the receipt's pantry row into the tick row of the same
// item, so one bag is not counted twice (Chinese groente, 06-11-2026).
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOp, emptyState } from "../public/shared/ops.js";
import { MATCH_DAYS, entryPantryId, purchasePantryId } from "../public/shared/pantry.js";
import { addDays } from "../public/shared/shelf-life.js";

const TICK_DAY = "2026-11-05";
const BUY_DAY = "2026-11-06";
const A = "item-fold-groente";
const B = "item-fold-wokgroente";
const ENTRY = "entry-fold-0001";
const PURCHASE = "purchase-fold-0001";
const product = { id: "ah-product-fold-1", name: "Wokgroente Chinees", brand: "AH", size: "400 g" };
const ctx = (day, hour = "10") => ({ memberId: "member-thomas-01", isAdmin: true, now: `${day}T${hour}:00:00.000Z` });
const apply = (s, op, day = BUY_DAY) => applyOp(s, op, ctx(day, "18"));

/** Item A ticked on `tick`, then a receipt of `qty` of the product lands on item B. */
function house({ tick = TICK_DAY, qty = 1 } = {}) {
  const s = emptyState();
  applyOp(s, { type: "entry.add", id: ENTRY, item_id: A, title: "Chinese groente" }, ctx(tick, "08"));
  applyOp(s, { type: "entry.check", id: ENTRY, checked: true }, ctx(tick, "09"));
  apply(s, { type: "purchase.add", id: PURCHASE, source: "receipt", pantry: true, title: "Wokgroenten", item_id: B,
    bought_on: BUY_DAY, qty, product });
  return s;
}
const live = (s, itemId) => Object.values(s.pantry).filter((r) => r.item_id === itemId && !r.deleted_at);
const tickRow = (s) => s.pantry[entryPantryId(ENTRY)];
const MOVE = { type: "product.move", product_id: product.id, item_id: A, on: BUY_DAY };
const cookTick = (s) => applyOp(s, { type: "pantry.use", reason: "used", on: TICK_DAY,
  takes: [{ event_id: "event-fold-0001", pantry_id: entryPantryId(ENTRY), amount: 1 }] }, ctx(TICK_DAY, "20"));

test("setup: the receipt on another item makes a second row (the bug)", () => {
  const s = house();
  assert.equal(live(s, A).length, 1);
  assert.equal(live(s, B).length, 1);
});

test("product.move folds the receipt row into the tick row", () => {
  const s = house();
  const { result } = apply(s, MOVE);
  assert.equal(result.folded, 1);
  const rows = live(s, A);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, entryPantryId(ENTRY));
  assert.equal(rows[0].source_purchase_id, PURCHASE);
  assert.equal(rows[0].product_id, product.id);
  assert.equal(rows[0].pack_size, "400 g");
  assert.equal(rows[0].amount, 1);
  const receipt = s.pantry[purchasePantryId(PURCHASE)];
  assert.ok(receipt.deleted_at, "a tombstone, never a hard delete");
  assert.equal(live(s, B).length, 0);
});

test("a tick row cooked away first stays gone", () => {
  const s = house();
  cookTick(s);
  assert.ok(tickRow(s).deleted_at);
  apply(s, MOVE);
  assert.equal(live(s, A).length, 0);
  assert.equal(live(s, B).length, 0);
  assert.equal(tickRow(s).source_purchase_id, PURCHASE);
  assert.equal(tickRow(s).amount, 0);
});

test("item.merge folds in both directions", () => {
  const into = house();
  apply(into, { type: "item.merge", from_item_id: B, into_item_id: A, on: BUY_DAY });
  assert.equal(live(into, A).length, 1);
  assert.equal(live(into, A)[0].source_purchase_id, PURCHASE);
  assert.ok(into.pantry[purchasePantryId(PURCHASE)].deleted_at);

  const from = house();
  apply(from, { type: "item.merge", from_item_id: A, into_item_id: B, on: BUY_DAY });
  const rows = live(from, B);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, entryPantryId(ENTRY));
  assert.equal(rows[0].source_purchase_id, PURCHASE);
  assert.equal(rows[0].amount, 1);
});

test("two bought, one taken: one left", () => {
  const s = house({ qty: 2 });
  cookTick(s);
  apply(s, MOVE);
  const rows = live(s, A);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 1);
});

test("what was taken from the receipt row itself comes off too", () => {
  const s = house({ qty: 2 });
  applyOp(s, { type: "pantry.use", reason: "used", on: BUY_DAY,
    takes: [{ event_id: "event-fold-0002", pantry_id: purchasePantryId(PURCHASE), amount: 1 }] }, ctx(BUY_DAY, "19"));
  apply(s, MOVE);
  assert.equal(live(s, A)[0].amount, 1);
});

test("replaying the move changes nothing", () => {
  const s = house();
  apply(s, MOVE);
  const before = JSON.stringify(s.pantry);
  const again = apply(s, MOVE);
  assert.deepEqual(again.changed, []);
  assert.equal(JSON.stringify(s.pantry), before);
});

test("a tick older than MATCH_DAYS is not folded", () => {
  const s = house({ tick: addDays(BUY_DAY, -MATCH_DAYS - 1) });
  const { result } = apply(s, MOVE);
  assert.equal(result.folded, undefined);
  assert.equal(live(s, A).length, 2);
});
