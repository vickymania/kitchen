// The "which item does this belong to" question of the nightly check (Thomas,
// 04-11-2026: "Pepsi Zero ... staat bij Sodastream cola. Moet dit bij
// Frisdrank of pepsi?" had no buttons): the report shape { text, product_id,
// items }, the validation that drops a question without buttons, product.keep
// ("Laat staan"), and product.move for a purchase that sits on another item
// than its product (the real case: the purchase of 2-11 on "Sodastream cola",
// its product ah-product-436109 already under "Frisdrank").
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOp, emptyState, decisionId, OpError } from "../public/shared/ops.js";
import { decisionSets } from "../public/shared/dedupe.js";
import { decideLine, readReport } from "../fetcher/review.mjs";

const DAY = "2026-11-04";
const ctx = (hour = "10", day = DAY) => ({ memberId: "member-thomas-01", isAdmin: true, now: `${day}T${hour}:00:00.000Z` });
const PRODUCT = "ah-product-436109";
const FRIS = "item-mv-frisdrank";
const COLA = "item-mv-sodacola";

function world() {
  const s = emptyState();
  applyOp(s, { type: "purchase.add", id: "purchase-mv-0001", item_id: FRIS, title: "Frisdrank", bought_on: "2026-10-20", source: "receipt",
    product: { id: PRODUCT, name: "Pepsi Zero sugar cherry", brand: "AH", size: "1,5 l" } }, ctx("08"));
  applyOp(s, { type: "purchase.add", id: "purchase-mv-0002", item_id: COLA, title: "Sodastream cola", bought_on: "2026-11-02", source: "receipt",
    product: { id: PRODUCT, name: "Pepsi Zero sugar cherry", brand: "AH", size: "1,5 l" } }, ctx("09"));
  return s;
}

test("the setup is the real case: product under Frisdrank, a purchase on Sodastream cola", () => {
  const s = world();
  assert.equal(s.products[PRODUCT].item_id, FRIS);
  assert.equal(s.purchases["purchase-mv-0002"].item_id, COLA);
});

test("product.move to the product's own item brings along the purchase on another item; the basket line clears; moving back undoes it", () => {
  const s = world();
  // Ticked on the shopping day of 2-11: inside the window of the purchase that moves.
  applyOp(s, { type: "entry.add", id: "entry-mv-fris01", item_id: FRIS, title: "Frisdrank" }, ctx("07", "2026-11-02"));
  applyOp(s, { type: "entry.check", id: "entry-mv-fris01", checked: true }, ctx("09", "2026-11-02"));
  const out = applyOp(s, { type: "product.move", product_id: PRODUCT, item_id: FRIS, on: DAY }, ctx("11")).result;
  assert.notEqual(out.already, true);
  assert.equal(out.moved.purchases, 1, "the purchase on the other item came along");
  assert.equal(out.moved.products, 0, "the product was already there");
  assert.equal(s.purchases["purchase-mv-0002"].item_id, FRIS);
  assert.equal(s.products[PRODUCT].item_id, FRIS);
  assert.deepEqual(out.cleared, ["entry-mv-fris01"], "clearBasketForMoved still works");
  assert.ok(s.entries["entry-mv-fris01"].deleted_at);
  // Undo: the move to the other item takes the whole product along (what the product screen does).
  applyOp(s, { type: "product.move", product_id: PRODUCT, item_id: COLA, on: DAY }, ctx("12"));
  assert.deepEqual([s.products[PRODUCT].item_id, s.purchases["purchase-mv-0001"].item_id, s.purchases["purchase-mv-0002"].item_id], [COLA, COLA, COLA]);
  // Moving it again to where all of it is writes nothing.
  assert.equal(applyOp(s, { type: "product.move", product_id: PRODUCT, item_id: COLA, on: DAY }, ctx("13")).result.moved.purchases, 0);
});

test("product.keep ('Laat staan'): a no_move decision per item the product is not on; never twice; bad input refused", () => {
  const s = world();
  const out = applyOp(s, { type: "product.keep", product_id: PRODUCT, item_ids: [FRIS, COLA] }, ctx("11")).result;
  assert.equal(out.decisions, 1, "its own item needs no decision");
  assert.ok(s.decisions[decisionId("no_move", PRODUCT, COLA)]);
  assert.ok(decisionSets(s.decisions).noMove.has(`${PRODUCT}|${COLA}`));
  assert.equal(s.products[PRODUCT].item_id, FRIS, "nothing moved");
  assert.equal(s.purchases["purchase-mv-0002"].item_id, COLA, "the purchase stays where it is");
  applyOp(s, { type: "product.keep", product_id: PRODUCT, item_ids: [FRIS, COLA] }, ctx("12"));
  assert.equal(Object.keys(s.decisions).length, 1);
  for (const op of [{ product_id: PRODUCT, item_ids: [] }, { product_id: PRODUCT }, { product_id: "bad id!", item_ids: [FRIS] }]) {
    assert.throws(() => applyOp(s, { type: "product.keep", ...op }, ctx()), (e) => e instanceof OpError);
  }
  assert.throws(() => applyOp(s, { type: "product.keep", product_id: PRODUCT, item_ids: ["item-mv-missing1"] }, ctx()), (e) => e.code === "not_found");
});

test("review.save keeps a move question as an object and rejects a malformed one", () => {
  const s = emptyState();
  const q = { text: "Pepsi Zero sugar cherry (AH, 1,5 l) staat bij Sodastream cola. Moet dit bij Frisdrank of Pepsi?", product_id: PRODUCT, items: ["Frisdrank", "Sodastream cola"] };
  applyOp(s, { type: "review.save", day: DAY, decide: [q, "Oude regel zonder knoppen?"] }, ctx());
  assert.deepEqual(s.reviews[`review-${DAY}`].decide, [q, "Oude regel zonder knoppen?"], "old plain lines in stored reports still read");
  assert.throws(() => applyOp(s, { type: "review.save", day: DAY, decide: [{ text: "x", product_id: "bad id!", items: ["A", "B"] }] }, ctx()), (e) => e.code === "bad_id");
  applyOp(s, { type: "review.save", day: DAY, decide: [{ text: "x", product_id: PRODUCT, items: ["Alleen een"] }] }, ctx());
  assert.deepEqual(s.reviews[`review-${DAY}`].decide, ["x"], "one item is no move question");
});

test("decideLine: only the two objects pass; a plain string or a malformed object is dropped", () => {
  const move = { text: "Waar hoort dit?", product_id: PRODUCT, items: ["Frisdrank", "Pepsi", "Sodastream cola"] };
  assert.deepEqual(decideLine(move), move);
  assert.deepEqual(decideLine({ text: "A?", names: ["A", "B"] }), { text: "A?", names: ["A", "B"] });
  assert.deepEqual(decideLine({ text: "A?", ids: ["item-aaaa-1111", "item-bbbb-2222"], into: "item-aaaa-1111" }), { text: "A?", ids: ["item-aaaa-1111", "item-bbbb-2222"], into: "item-aaaa-1111" });
  for (const bad of ["Moet dit bij Frisdrank?", null, 5, [], {}, { text: "x" }, { text: "x", names: ["A"] },
    { text: "x", product_id: PRODUCT, items: ["A"] }, { text: "x", product_id: PRODUCT, items: ["A", "A"] },
    { text: "x", product_id: PRODUCT, items: ["A", "B", "C", "D"] }, { text: "x", product_id: "bad id!", items: ["A", "B"] },
    { text: "", product_id: PRODUCT, items: ["A", "B"] }, { text: "x", product_id: 5, items: ["A", "B"] }]) {
    assert.equal(decideLine(bad), "", JSON.stringify(bad));
  }
});

test("readReport drops Claude's plain-string questions and keeps the ones with buttons", () => {
  const move = { text: "Waar hoort dit?", product_id: PRODUCT, items: ["Frisdrank", "Sodastream cola"] };
  const raw = JSON.stringify({ result: JSON.stringify({ run_ok: true, errors: [], fixed: [], decide: ["Moet dit bij Frisdrank of pepsi?", move, { text: "kapot", product_id: PRODUCT }] }), num_turns: 3, total_cost_usd: 0.1 });
  assert.deepEqual(readReport(raw).report.decide, [move]);
});

test("on D1: the move brings the purchase on the other item along, 'Laat staan' is a synced no_move decision, and a repeat is a no-op", async () => {
  const { default: worker } = await import("../worker/index.js");
  const { makeEnv } = await import("./d1-shim.mjs");
  const { bootstrapSql } = await import("../tools/admin.mjs");
  const HOST = "groceries.localhost:8787";
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const res = await worker.fetch(new Request(`http://${HOST}/api/pair`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: `http://${HOST}` }, body: JSON.stringify({ code: "123456", label: "test" }),
  }), env);
  const token = res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
  const send = async (ops) => (await worker.fetch(new Request(`http://${HOST}/api/ops`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ops }),
  }), env)).json();
  const sync = async () => (await worker.fetch(new Request(`http://${HOST}/api/sync?since=0`, { headers: { Authorization: `Bearer ${token}` } }), env)).json();
  let n = 0;
  const op = (o) => ({ op_id: `op-mv-${String(++n).padStart(6, "0")}`, ...o });
  const ok = async (ops) => { const out = await send(ops); assert.deepEqual(out.results.filter((r) => !r.ok), []); return out; };
  const product = { id: PRODUCT, name: "Pepsi Zero sugar cherry", brand: "AH", size: "1,5 l" };
  await ok([
    op({ type: "purchase.add", id: "purchase-mv-0001", item_id: FRIS, title: "Frisdrank", bought_on: "2026-10-20", source: "receipt", product }),
    op({ type: "purchase.add", id: "purchase-mv-0002", item_id: COLA, title: "Sodastream cola", bought_on: "2026-11-02", source: "receipt", product }),
  ]);
  // Laat staan first: a decision, nothing moved.
  await ok([op({ type: "product.keep", product_id: PRODUCT, item_ids: [FRIS, COLA] })]);
  let all = await sync();
  assert.ok(all.decisions.some((d) => d.kind === "no_move" && d.a === PRODUCT && d.b === COLA), "synced");
  assert.equal(all.purchases.find((p) => p.id === "purchase-mv-0002").item_id, COLA);
  // The button on Frisdrank: the purchase comes along.
  const moved = await ok([op({ type: "product.move", product_id: PRODUCT, item_id: FRIS, on: "2026-11-04" })]);
  assert.equal(moved.results[0].result.moved.purchases, 1);
  all = await sync();
  assert.deepEqual(all.purchases.map((p) => p.item_id), [FRIS, FRIS]);
  const again = await ok([op({ type: "product.move", product_id: PRODUCT, item_id: FRIS, on: "2026-11-04" })]);
  assert.equal(again.results[0].result.moved.purchases, 0);
});
