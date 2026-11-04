// The receipt leads (29-10-2026): a receipt purchase (the AH and Lidl
// imports, a photo read by Claude) clears the basket lines of the same thing
// ticked around the shopping day, as entry.clear_checked does. Never an open
// line, never a line from another trip. In the engine and on D1.
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { applyOp, emptyState, BASKET_BEFORE_DAYS, BASKET_AFTER_DAYS } from "../public/shared/ops.js";
import { addDays } from "../public/shared/shelf-life.js";

const DAY = "2026-10-29";
const ctx = (day = DAY, hour = "10") => ({ memberId: "member-thomas-01", isAdmin: true, now: `${day}T${hour}:00:00.000Z` });

/** A line added and, with `on`, ticked on that day. */
function line(s, id, title, on = null) {
  applyOp(s, { type: "entry.add", id, item_id: `item-${id}`.slice(0, 64), title }, ctx(on ?? DAY, "08"));
  if (on) applyOp(s, { type: "entry.check", id, checked: true }, ctx(on, "09"));
}
const buy = (s, id, title, opts = {}) => applyOp(s, {
  type: "purchase.add", id, source: "receipt", title, bought_on: DAY, item_id: `item-${id}`.slice(0, 64), ...opts,
}, ctx(DAY, "18")).result;
const gone = (s, id) => Boolean(s.entries[id].deleted_at);

test("a receipt clears the ticked line of the same item, and of an item with the same canonical name", () => {
  const s = emptyState();
  line(s, "entry-rb-melk01", "Melk", DAY);
  line(s, "entry-rb-ei0001", "Ei", DAY);
  line(s, "entry-rb-kaas01", "Kaas", DAY);
  const out = buy(s, "purchase-rb-0001", "Melk");
  assert.deepEqual(out.cleared, ["entry-rb-melk01"]);
  assert.ok(gone(s, "entry-rb-melk01"));
  assert.ok(!gone(s, "entry-rb-kaas01"), "another thing stays in the basket");
  buy(s, "purchase-rb-0002", "Eieren");
  assert.ok(gone(s, "entry-rb-ei0001"), "Ei and Eieren are one (item-names.js SAME)");
});

test("never an open line; the line the purchase ticks itself leaves the basket too", () => {
  const s = emptyState();
  line(s, "entry-rb-open01", "Melk");
  const out = buy(s, "purchase-rb-0003", "Melk");
  assert.equal(out.cleared, undefined);
  assert.ok(!gone(s, "entry-rb-open01"), "open: still on the list");
  line(s, "entry-rb-brood1", "Brood");
  const own = buy(s, "purchase-rb-0004", "Brood", { entry_id: "entry-rb-brood1" });
  assert.equal(own.checked, "entry-rb-brood1");
  assert.ok(gone(s, "entry-rb-brood1"), "ticked by the receipt itself: bought, so out of the basket");
});

test("only lines ticked from a week before up to a day after the shopping day", () => {
  const s = emptyState();
  line(s, "entry-rb-old001", "Melk", addDays(DAY, -BASKET_BEFORE_DAYS - 1));
  line(s, "entry-rb-week01", "Kaas", addDays(DAY, -BASKET_BEFORE_DAYS));
  line(s, "entry-rb-next01", "Brood", addDays(DAY, BASKET_AFTER_DAYS));
  line(s, "entry-rb-late01", "Appels", addDays(DAY, BASKET_AFTER_DAYS + 1));
  buy(s, "purchase-rb-0005", "Melk");
  buy(s, "purchase-rb-0006", "Kaas");
  buy(s, "purchase-rb-0007", "Brood");
  buy(s, "purchase-rb-0008", "Appels");
  assert.deepEqual(["entry-rb-old001", "entry-rb-week01", "entry-rb-next01", "entry-rb-late01"].map((id) => gone(s, id)), [false, true, true, false]);
});

test("a re-import changes nothing; the old history never clears", () => {
  const s = emptyState();
  line(s, "entry-rb-melk02", "Melk", DAY);
  buy(s, "purchase-rb-0009", "Melk");
  const at = s.entries["entry-rb-melk02"].deleted_at;
  assert.deepEqual(buy(s, "purchase-rb-0009", "Melk"), {}, "the same purchase again: a replay");
  assert.equal(s.entries["entry-rb-melk02"].deleted_at, at);
  line(s, "entry-rb-kaas02", "Kaas", DAY);
  applyOp(s, { type: "purchase.add", id: "purchase-rb-0010", source: "history", title: "Kaas", bought_on: DAY, item_id: "item-rb-hist01" }, ctx());
  assert.ok(!gone(s, "entry-rb-kaas02"));
});

test("on D1: the import's purchase clears the basket line every phone then pulls; a re-import does nothing", async () => {
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
  const today = new Date().toISOString().slice(0, 10);
  let n = 0;
  const op = (o) => ({ op_id: `op-rb-d1-${String(++n).padStart(5, "0")}`, ...o });
  await send([
    op({ type: "entry.add", id: "entry-rb-d1melk", item_id: "item-rb-d1melk", title: "Melk" }),
    op({ type: "entry.check", id: "entry-rb-d1melk", checked: true }),
    op({ type: "entry.add", id: "entry-rb-d1eier", item_id: "item-rb-d1eier", title: "Ei" }),
    op({ type: "entry.check", id: "entry-rb-d1eier", checked: true }),
    op({ type: "entry.add", id: "entry-rb-d1open", item_id: "item-rb-d1open", title: "Kaas" }),
  ]);
  const purchases = [
    op({ type: "receipt.save", id: "receipt-rb-d1-01", store: "AH", bought_on: today, lines: [] }),
    op({ type: "purchase.add", id: "purchase-rb-d101", source: "receipt", receipt_id: "receipt-rb-d1-01", title: "Melk", bought_on: today, item_id: "item-rb-d1new1" }),
    op({ type: "purchase.add", id: "purchase-rb-d102", source: "receipt", receipt_id: "receipt-rb-d1-01", title: "Eieren", bought_on: today, item_id: "item-rb-d1new2" }),
    op({ type: "purchase.add", id: "purchase-rb-d103", source: "receipt", receipt_id: "receipt-rb-d1-01", title: "Kaas", bought_on: today, item_id: "item-rb-d1new3" }),
  ];
  const out = await send(purchases);
  assert.deepEqual(out.results.filter((r) => !r.ok), []);
  const rows = async () => Object.fromEntries((await env.DB.prepare("SELECT id, deleted_at FROM list_entries").all()).results.map((r) => [r.id, Boolean(r.deleted_at)]));
  assert.deepEqual(await rows(), { "entry-rb-d1melk": true, "entry-rb-d1eier": true, "entry-rb-d1open": false });
  // A re-import with new op ids: the purchases exist, nothing moves.
  const again = await send(purchases.map((p) => ({ ...p, op_id: `${p.op_id}-again` })));
  assert.deepEqual(again.results.filter((r) => !r.ok), []);
  assert.deepEqual(await rows(), { "entry-rb-d1melk": true, "entry-rb-d1eier": true, "entry-rb-d1open": false });
});

// Fixed later (04-11-2026): a receipt that landed on the wrong item and is
// merged or moved confirms the target's basket line, like purchase.add.
const opCtx = ctx(DAY, "19");
const bought = (s, id, itemId, title, opts = {}) => applyOp(s, {
  type: "purchase.add", id, source: "receipt", title, bought_on: DAY, item_id: itemId, ...opts,
}, ctx(DAY, "18"));

test("item.merge: the moved receipt clears the target's checked line in the window, not outside it", () => {
  const s = emptyState();
  line(s, "entry-rb-mrg001", "Gezichtsreiniger", DAY);
  line(s, "entry-rb-mrg002", "Gezichtsreiniger", addDays(DAY, -BASKET_BEFORE_DAYS - 3));
  const into = s.entries["entry-rb-mrg001"].item_id;
  bought(s, "purchase-rb-mrg1", "item-rb-mrgnew", "Gezichtsreiniger gel");
  assert.ok(!gone(s, "entry-rb-mrg001"));
  const out = applyOp(s, { type: "item.merge", from_item_id: "item-rb-mrgnew", into_item_id: into, on: DAY }, opCtx).result;
  assert.ok(out.cleared.includes("entry-rb-mrg001"));
  assert.ok(gone(s, "entry-rb-mrg001"));
  assert.ok(!gone(s, "entry-rb-mrg002"), "ticked weeks before: untouched");
});

test("product.move: the moved receipt clears the target's checked line; a history purchase does not", () => {
  const s = emptyState();
  line(s, "entry-rb-mov001", "Minoes brokken", DAY);
  line(s, "entry-rb-mov002", "Kippenborst", DAY);
  const target = s.entries["entry-rb-mov001"].item_id;
  bought(s, "purchase-rb-mov1", "item-rb-wrong1", "Minoes eten", { product: { id: "product-rb-whiskas", name: "Whiskas brokken" } });
  assert.ok(!gone(s, "entry-rb-mov001"));
  const out = applyOp(s, { type: "product.move", product_id: "product-rb-whiskas", item_id: target, on: DAY }, opCtx).result;
  assert.deepEqual(out.cleared, ["entry-rb-mov001"]);
  assert.ok(gone(s, "entry-rb-mov001"));
  assert.ok(!gone(s, "entry-rb-mov002"), "another thing stays");
  // A purchase that is no receipt (the old history) does not clear.
  line(s, "entry-rb-mov003", "Kattenbak", DAY);
  bought(s, "purchase-rb-mov2", "item-rb-wrong2", "Oud", { product: { id: "product-rb-oud", name: "Oud" } });
  s.purchases["purchase-rb-mov2"].source = "history";
  applyOp(s, { type: "product.move", product_id: "product-rb-oud", item_id: s.entries["entry-rb-mov003"].item_id, on: DAY }, opCtx);
  assert.ok(!gone(s, "entry-rb-mov003"));
});

test("on D1: merge and product.move clear the basket line (the loader fetches it)", async () => {
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
  const today = new Date().toISOString().slice(0, 10);
  let n = 0;
  const op = (o) => ({ op_id: `op-rb-mv-${String(++n).padStart(5, "0")}`, ...o });
  const ok = async (ops) => { const out = await send(ops); assert.deepEqual(out.results.filter((r) => !r.ok), []); };
  await ok([
    op({ type: "entry.add", id: "entry-rb-mvcat", item_id: "item-rb-mvcat", title: "Minoes brokken" }),
    op({ type: "entry.check", id: "entry-rb-mvcat", checked: true }),
    op({ type: "entry.add", id: "entry-rb-mvface", item_id: "item-rb-mvface", title: "Gezichtsreiniger" }),
    op({ type: "entry.check", id: "entry-rb-mvface", checked: true }),
    op({ type: "entry.add", id: "entry-rb-mvkeep", item_id: "item-rb-mvkeep", title: "Brood" }),
    op({ type: "entry.check", id: "entry-rb-mvkeep", checked: true }),
    op({ type: "receipt.save", id: "receipt-rb-mv-01", store: "AH", bought_on: today, lines: [] }),
    op({ type: "purchase.add", id: "purchase-rb-mv01", source: "receipt", receipt_id: "receipt-rb-mv-01", title: "Minoes eten", bought_on: today, item_id: "item-rb-mvwrong", product: { id: "product-rb-mvwhis", name: "Whiskas brokken" } }),
    op({ type: "purchase.add", id: "purchase-rb-mv02", source: "receipt", receipt_id: "receipt-rb-mv-01", title: "Gezichtsreiniger gel", bought_on: today, item_id: "item-rb-mvgel" }),
  ]);
  const rows = async () => Object.fromEntries((await env.DB.prepare("SELECT id, deleted_at FROM list_entries").all()).results.map((r) => [r.id, Boolean(r.deleted_at)]));
  assert.deepEqual(await rows(), { "entry-rb-mvcat": false, "entry-rb-mvface": false, "entry-rb-mvkeep": false });
  await ok([
    op({ type: "product.move", product_id: "product-rb-mvwhis", item_id: "item-rb-mvcat", on: today }),
    op({ type: "item.merge", from_item_id: "item-rb-mvgel", into_item_id: "item-rb-mvface", on: today }),
  ]);
  assert.deepEqual(await rows(), { "entry-rb-mvcat": true, "entry-rb-mvface": true, "entry-rb-mvkeep": false });
});
