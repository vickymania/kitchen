// Shelf life per PRODUCT (28-10-2026: "Melk 7 dagen? weet je wel hoe
// lang houdbare melk goed is?"): product.shelf and its precedence over the
// item, the estimates and opened packs that follow the product, the admin
// batch for the prepared map, and what that batch writes on D1.
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { applyOp, emptyState, OpError } from "../public/shared/ops.js";
import { estimateUseBy, openedDaysOf, shelfDaysOf, KEEPS } from "../public/shared/shelf-life.js";
import { importerMayApply } from "../worker/auth.js";

const ctx = (isAdmin = true) => ({ memberId: "member-thomas-01", isAdmin, now: "2026-10-28T10:00:00.000Z" });

function state() {
  const s = emptyState();
  s.items["item-melk-00001"] = { id: "item-melk-00001", name: "Melk", name_key: "melk", shelf_days: 7, opened_days: 5, shelf_source: "claude", created_at: "x", deleted_at: null };
  s.products["product-houdb-1"] = { id: "product-houdb-1", item_id: "item-melk-00001", name: "Houdbare halfvolle melk", brand: "AH", size: "1 l",
    store: "AH", store_only: 0, kind: "ingredient", product_key: "houdbare halfvolle melk|ah|1 l", created_at: "x", updated_at: "x", deleted_at: null };
  s.products["product-vers-01"] = { id: "product-vers-01", item_id: "item-melk-00001", name: "Verse halfvolle melk", brand: "AH", size: "1 l",
    store: "AH", store_only: 0, kind: "ingredient", product_key: "verse halfvolle melk|ah|1 l", created_at: "x", updated_at: "x", deleted_at: null };
  const row = (id, productId, fields = {}) => ({
    id, item_id: "item-melk-00001", product_id: productId, title: "Melk", amount: 1, taken: 0, pack_size: "1 l", added_on: "2026-10-28",
    amount_on: null, use_by: "2026-11-04", use_by_source: "estimate", source_entry_id: null, source_purchase_id: null,
    created_at: "x", updated_at: "x", deleted_at: null, ...fields,
  });
  s.pantry["pantry-houdb-01"] = row("pantry-houdb-01", "product-houdb-1");
  s.pantry["pantry-houdb-02"] = row("pantry-houdb-02", "product-houdb-1", { taken: 0.5, amount: 0.5 });
  s.pantry["pantry-houdb-03"] = row("pantry-houdb-03", "product-houdb-1", { use_by: "2026-12-01", use_by_source: "person" });
  s.pantry["pantry-vers-001"] = row("pantry-vers-001", "product-vers-01");
  return s;
}

test("estimate: the product's own days beat its item's, wherever they stand; then the item; then the rules", () => {
  const item = { name: "Melk", shelf_days: 7, opened_days: 5 };
  const product = { name: "Houdbare melk", shelf_days: 90, opened_days: 4 };
  assert.equal(estimateUseBy("2026-10-28", "AH Houdbare melk", "Melk", product, item), "2027-01-26", "90 days, not the item's 7");
  assert.equal(estimateUseBy("2026-10-28", "AH Houdbare melk", "Melk", { name: "Houdbare melk" }, item), "2026-11-04", "no own days: the item's");
  assert.equal(estimateUseBy("2026-10-28", "AH Melk", { name: "x", shelf_days: KEEPS }, item), null, "a product that keeps: no date");
  assert.equal(estimateUseBy("2026-10-28", "AH Melk", null, { name: "Melk" }), "2026-11-04", "nothing known: the rules table");
  assert.equal(shelfDaysOf(product, item), 90);
  assert.equal(shelfDaysOf({}, item), 7);
  assert.equal(openedDaysOf(product, item), 4);
  assert.equal(openedDaysOf({ shelf_days: 90 }, item), 5, "no open days of its own: the item's");
  assert.equal(openedDaysOf(null, null), null);
});

test("product.shelf: validated like item.shelf, person > claude > rule, the same again writes nothing", () => {
  const s = state();
  const set = (o) => applyOp(s, { type: "product.shelf", product_id: "product-houdb-1", ...o }, ctx());
  const bad = (o) => assert.throws(() => set(o), OpError);
  bad({ shelf_days: 7, source: "robot" });
  bad({ shelf_days: 0, source: "claude" });
  bad({ shelf_days: 2.5, source: "claude" });
  bad({ source: "claude" });
  bad({ shelf_days: null, source: "claude" });
  assert.throws(() => applyOp(s, { type: "product.shelf", product_id: "product-none-01", shelf_days: 7, source: "claude" }, ctx()), (e) => e.code === "not_found");

  set({ shelf_days: 90, opened_days: 120, source: "claude" });
  const p = s.products["product-houdb-1"];
  assert.deepEqual([p.shelf_days, p.opened_days, p.shelf_source], [90, 90, "claude"], "opened never longer than closed");
  assert.deepEqual(set({ shelf_days: 90, opened_days: 90, source: "claude" }).changed, [], "the same again: nothing");
  assert.deepEqual(set({ shelf_days: 30, source: "rule" }).result, { kept: true }, "a rule never over Claude");
  set({ shelf_days: 60, opened_days: 4, source: "person" });
  assert.deepEqual(set({ shelf_days: 99, source: "claude" }).result, { kept: true }, "Claude never over a person");
  assert.deepEqual([p.shelf_days, p.opened_days, p.shelf_source], [60, 4, "person"]);
  set({ shelf_days: null, opened_days: null, source: "person" });
  assert.equal(p.shelf_source, null, "a person clearing both: back to the item");
  assert.equal(s.items["item-melk-00001"].shelf_days, 7, "the item is never touched");
});

test("product.shelf: its untouched estimate rows follow; a taken, a person's and another product's row never", () => {
  const s = state();
  const out = applyOp(s, { type: "product.shelf", product_id: "product-houdb-1", shelf_days: 90, opened_days: 4, source: "claude" }, ctx());
  assert.deepEqual(out.changed.map(([k, id]) => `${k}:${id}`).sort(), ["pantry:pantry-houdb-01", "products:product-houdb-1"]);
  assert.equal(s.pantry["pantry-houdb-01"].use_by, "2027-01-26");
  assert.equal(s.pantry["pantry-houdb-02"].use_by, "2026-11-04", "opened: taken from");
  assert.equal(s.pantry["pantry-houdb-03"].use_by, "2026-12-01", "a person's date");
  assert.equal(s.pantry["pantry-vers-001"].use_by, "2026-11-04", "the fresh milk is another product");

  // The item changes: the fresh milk's row follows it, the long-life milk's row stays with its product.
  applyOp(s, { type: "item.shelf", item_id: "item-melk-00001", shelf_days: 6, source: "person" }, ctx());
  assert.equal(s.pantry["pantry-vers-001"].use_by, "2026-11-03");
  assert.equal(s.pantry["pantry-houdb-01"].use_by, "2027-01-26", "the product wins over the item");
});

test("opened pack: the product's opened_days before the item's", () => {
  const s = state();
  applyOp(s, { type: "product.shelf", product_id: "product-houdb-1", shelf_days: 90, opened_days: 3, source: "claude" }, ctx());
  s.pantry["pantry-houdb-01"].amount = 2;
  applyOp(s, { type: "pantry.use", reason: "used", on: "2026-11-10", takes: [{ event_id: "event-open-0001", pantry_id: "pantry-houdb-01", amount: 0.5 }] }, ctx());
  assert.equal(s.pantry["pantry-houdb-01"].use_by, "2026-11-13", "opened on the 10th, 3 days (the item says 5)");
  s.pantry["pantry-vers-001"].amount = 2;
  applyOp(s, { type: "pantry.use", reason: "used", on: "2026-10-29", takes: [{ event_id: "event-open-0002", pantry_id: "pantry-vers-001", amount: 0.5 }] }, ctx());
  assert.equal(s.pantry["pantry-vers-001"].use_by, "2026-11-03", "no own open days: the item's 5");
});

test("a receipt purchase dates its row by the product, not the item", () => {
  const s = state();
  applyOp(s, { type: "product.shelf", product_id: "product-houdb-1", shelf_days: 90, source: "claude" }, ctx());
  applyOp(s, {
    type: "purchase.add", id: "purchase-houdb-1", source: "receipt", pantry: true, title: "Melk", item_id: "item-melk-xxxx1",
    bought_on: "2026-10-28", qty: 1, product: { id: "product-houdb-1", name: "Houdbare halfvolle melk", brand: "AH", size: "1 l" },
  }, ctx());
  assert.equal(s.pantry["pp-purchase-houdb-1"].use_by, "2027-01-26");
  assert.equal(s.products["product-houdb-1"].shelf_days, 90, "a receipt's product.put keeps the shelf life");
});

test("batch: admins only, at most 100, unknown and lower-ranked products are reported, not refused", () => {
  const s = state();
  const batch = (products, admin = true, source = "claude") => applyOp(s, { type: "product.shelf", source, products }, ctx(admin));
  assert.throws(() => batch([{ product_id: "product-houdb-1", shelf_days: 90 }], false), (e) => e.code === "forbidden");
  assert.throws(() => batch([]), (e) => e.code === "bad_field");
  assert.throws(() => batch(Array.from({ length: 101 }, () => ({ product_id: "product-houdb-1", shelf_days: 90 }))), (e) => e.code === "bad_field");
  assert.throws(() => batch([{ product_id: "product-houdb-1", shelf_days: 0 }]), OpError, "a bad value refuses the batch");
  applyOp(s, { type: "product.shelf", product_id: "product-vers-01", shelf_days: 8, source: "person" }, ctx());
  const out = batch([
    { product_id: "product-houdb-1", shelf_days: 90, opened_days: 4 },
    { product_id: "product-vers-01", shelf_days: 7, opened_days: 4 },
    { product_id: "product-none-01", shelf_days: 7 },
  ]);
  assert.deepEqual(out.result, { changed: 1, kept: ["product-vers-01"], missing: ["product-none-01"] });
  assert.equal(s.products["product-houdb-1"].shelf_days, 90);
  assert.equal(s.products["product-vers-01"].shelf_days, 8, "the person's value stays");
});

test("importer: may not send product.shelf; product.put cannot carry a shelf life", () => {
  assert.equal(importerMayApply({ type: "product.shelf", product_id: "product-houdb-1", shelf_days: 9, source: "claude" }), false);
  const s = state();
  applyOp(s, { type: "product.put", id: "product-houdb-1", product: { name: "Houdbare halfvolle melk", brand: "AH", size: "1 l", shelf_days: 3 } }, ctx());
  assert.equal(s.products["product-houdb-1"].shelf_days, undefined, "not a product.put field");
});

// ------------------------------------------------------------ on the worker

const HOST = "groceries.localhost";
function call(env, method, p, { body, cookie } = {}) {
  const headers = { Origin: `http://${HOST}` };
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`http://${HOST}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
let counter = 0;
const op = (o) => ({ op_id: `op-pshelf-${String(++counter).padStart(6, "0")}`, ...o });
const send = async (env, cookie, ops) => (await (await call(env, "POST", "/api/ops", { cookie, body: { ops } })).json()).results;
const pull = async (env, cookie, since) => (await call(env, "GET", `/api/sync?since=${since}`, { cookie })).json();

test("D1: the prepared map as batches of 100 from an admin device, one op each, a replay writes nothing", async () => {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const thomas = tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456" } }));
  const ids = Array.from({ length: 100 }, (_, i) => `product-map-${String(i).padStart(4, "0")}`);
  const made = await send(env, thomas, ids.map((id, i) => op({ type: "product.put", id, product: { name: `Ding ${i}`, brand: "AH", size: "1 st" } })));
  assert.ok(made.every((r) => r.ok), JSON.stringify(made.find((r) => !r.ok)));
  await send(env, thomas, [
    op({ type: "pantry.add", id: "pantry-map-0001", item_id: "item-map-000001", title: "Ding nul", on: "2026-10-28" }),
  ]);
  const head = await pull(env, thomas, 0);

  const batches = [];
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = (stmts) => { batches.push(stmts.length); return batch(stmts); };
  const mapOp = op({
    type: "product.shelf", source: "claude",
    products: [...ids.map((product_id, i) => ({ product_id, shelf_days: 10 + i, opened_days: 3 })), { product_id: "product-gone-0001", shelf_days: 5 }].slice(0, 100),
  });
  const [res] = await send(env, thomas, [mapOp]);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.result, { changed: 100, kept: [], missing: [] });
  assert.deepEqual(batches, [102], "one atomic batch: rev + 100 products + applied_ops");

  const delta = await pull(env, thomas, head.rev);
  assert.equal(delta.products.length, 100);
  assert.deepEqual(delta.products.find((p) => p.id === "product-map-0042"), { ...delta.products.find((p) => p.id === "product-map-0042"), shelf_days: 52, opened_days: 3, shelf_source: "claude" });

  batches.length = 0;
  const [again] = await send(env, thomas, [mapOp]);
  assert.deepEqual(again.result, res.result, "a replayed op_id answers its first result");
  assert.deepEqual(batches, [], "and writes nothing");
  const [person] = await send(env, thomas, [op({ type: "product.shelf", product_id: "product-map-0001", shelf_days: 4, source: "person" })]);
  assert.equal(person.ok, true);
  const [later] = await send(env, thomas, [op({ type: "product.shelf", source: "claude", products: [{ product_id: "product-map-0001", shelf_days: 30 }] })]);
  assert.deepEqual(later.result.kept, ["product-map-0001"], "a second push never replaces a person's value");
});
