// Phase 2, product knowledge: the product per item, store and recipe. The
// resolution order on its own, the ops and their checks, the rows on D1 (only
// what changed, an idle poll still one read), the migration of the old
// column, the receipt's "keep as preferred", and offers on the preferred
// product.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import worker from "../worker/index.js";
import { makeEnv, applyMigration } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { applyOp, emptyState, OpError } from "../public/shared/ops.js";
import { resolveProduct, lastPrice, purchasesByProduct } from "../public/shared/preferences.js";
import { canonicalStore, sameStore, knownStores, storeChoice, STORE_CHOICE_HOURS } from "../public/shared/stores.js";
import { productOfferMatches, lineOffers, currentOffers, relevanceTest, productOfferName } from "../public/shared/offers.js";
import { amsterdamDay } from "../worker/offers.js";

const ctx = (memberId = "member-thomas-01") => ({ memberId, isAdmin: true, now: "2026-10-28T10:00:00.000Z" });

// The tortilla chips of Thomas's example (28-10-2026).
const CHIPS = "item-chips-0001";
const NACHOS = "recipe-nachos-01";
const CHILI = "recipe-chili-001";
const P = {
  brand: { id: "product-doritos", name: "Nacho Cheese", brand: "Doritos", size: "185 g", store: "" },
  sweet: { id: "product-sweetch", name: "Sweet Chili", brand: "Doritos", size: "185 g", store: "Dirk" },
  ah: { id: "product-ah-chip", name: "Tortilla chips naturel", brand: "AH", size: "200 g", store: "Albert Heijn" },
  dirk: { id: "product-dirk-ch", name: "Tortilla chips naturel", brand: "Dirk", size: "200 g", store: "Dirk" },
};

function chipsData() {
  const pref = (id, store, recipe_id, product_id, updated_at = "2026-10-28T10:00:00Z") =>
    ({ id, item_id: CHIPS, store, recipe_id, product_id, updated_at, deleted_at: null });
  return {
    products: Object.fromEntries(Object.values(P).map((p) => [p.id, { ...p, item_id: CHIPS, deleted_at: null }])),
    recipes: { [NACHOS]: { id: NACHOS, title: "Mexicaanse nachos lasagne" }, [CHILI]: { id: CHILI, title: "Chili con carne" } },
    preferences: {
      a: pref("pref-any-00001", "", "", P.brand.id),
      b: pref("pref-dirk-0001", "Dirk", "", P.sweet.id),
      c: pref("pref-nachos-01", "", NACHOS, P.ah.id),
      d: pref("pref-nachos-02", "Dirk", NACHOS, P.dirk.id),
    },
  };
}

const plain = { item_id: CHIPS, sources: [] };
const nachos = { item_id: CHIPS, sources: [{ recipe_id: NACHOS, title: "Mexicaanse nachos lasagne" }] };

// ------------------------------------------------------------- resolution

test("resolution: recipe at the store, recipe anywhere, item at the store, item anywhere", () => {
  const data = chipsData();
  const at = (entry, store) => {
    const r = resolveProduct(data, entry, store);
    return r && [r.product.id, r.why.recipe, r.why.store];
  };
  assert.deepEqual(at(nachos, "Dirk"), [P.dirk.id, "Mexicaanse nachos lasagne", "Dirk"], "1. recipe + store");
  assert.deepEqual(at(nachos, "Albert Heijn"), [P.ah.id, "Mexicaanse nachos lasagne", null], "2. recipe + any store");
  assert.deepEqual(at(plain, "Dirk"), [P.sweet.id, null, "Dirk"], "3. item + store");
  assert.deepEqual(at(plain, "Albert Heijn"), [P.brand.id, null, null], "4. item + any store");
  assert.deepEqual(at(nachos, "DIRK VAN DEN BROEK"), at(nachos, "Dirk"), "a receipt's spelling is the same store");
  assert.deepEqual(at({ ...nachos, sources: [{ recipe_id: CHILI, title: "Chili con carne" }, nachos.sources[0]] }, "Dirk"),
    [P.dirk.id, "Mexicaanse nachos lasagne", "Dirk"], "a merged line: any of its recipes");

  // Without a store: any store first; else what is known for one store.
  assert.deepEqual(at(nachos, null), [P.ah.id, "Mexicaanse nachos lasagne", null]);
  assert.deepEqual(at(plain, null), [P.brand.id, null, null]);
  // A new view object, as each phone render has (the index is kept per object).
  const { a, c, ...rest } = data.preferences;
  data.preferences = rest;
  assert.deepEqual(at(nachos, null), [P.dirk.id, "Mexicaanse nachos lasagne", "Dirk"], "the recipe's one-store product");
  assert.deepEqual(at(plain, null), [P.sweet.id, null, "Dirk"], "the item's one-store product");
  assert.equal(at(plain, "Lidl"), null, "at a store nothing is known for: nothing, not another store's product");

  // A product that is gone does not count: the next step holds.
  const again = chipsData();
  again.products[P.dirk.id].deleted_at = "2026-10-28T11:00:00Z";
  assert.equal(resolveProduct(again, nachos, "Dirk").product.id, P.ah.id);
  again.preferences = { ...again.preferences, c: { ...again.preferences.c, deleted_at: "2026-10-28T11:00:00Z" } };
  assert.equal(resolveProduct(again, nachos, "Dirk").product.id, P.sweet.id);
  assert.equal(resolveProduct(again, { item_id: null }, "Dirk"), null);
});

test("resolution: the last price at the chosen store", () => {
  const purchases = {
    a: { product_id: P.brand.id, store: "AH", bought_on: "2026-10-01", price_cents: 298, qty: 2 },
    b: { product_id: P.brand.id, store: "DIRK", bought_on: "2026-10-20", price_cents: 219, qty: 1 },
    c: { product_id: P.brand.id, store: "Dirk", bought_on: "2026-09-01", price_cents: 250, qty: 1 },
  };
  const by = purchasesByProduct(purchases);
  const brand = { ...P.brand, store: "Dirk", last_price_cents: 219 };
  assert.equal(lastPrice(brand, "Albert Heijn", by), 149, "per piece, at AH");
  assert.equal(lastPrice(brand, "Dirk", by), 219, "the newest at Dirk");
  assert.equal(lastPrice(brand, "Lidl", by), null);
  assert.equal(lastPrice(brand, null, by), 219, "no store: the last price");
  assert.equal(lastPrice({ ...P.ah, last_price_cents: 189 }, "Albert Heijn", new Map()), 189, "the product's own price where it was bought");
});

// ---------------------------------------------------------------- stores

test("stores: one name per store; the choice holds for one trip", () => {
  assert.equal(canonicalStore(" ah "), "Albert Heijn");
  assert.equal(canonicalStore("DIRK VAN DEN BROEK"), "Dirk");
  assert.equal(canonicalStore("Marqt"), "Marqt", "an unknown store keeps its name");
  assert.equal(canonicalStore(null), "");
  assert.ok(sameStore("AH", "Albert Heijn") && !sameStore("", "") && !sameStore("Dirk", "Lidl"));
  assert.deepEqual(knownStores(["Lidl", "DIRK", "Jumbo"], ["Albert Heijn", "lidl"]), ["Albert Heijn", "Dirk", "Jumbo", "Lidl"]);

  const now = Date.parse("2026-10-28T18:00:00Z");
  const hour = 3_600_000;
  assert.equal(storeChoice({ store: "DIRK", at: now - hour }, now), "Dirk");
  assert.equal(storeChoice({ store: "Dirk", at: now - (STORE_CHOICE_HOURS * hour - 1000) }, now), "Dirk");
  assert.equal(storeChoice({ store: "Dirk", at: now - (STORE_CHOICE_HOURS * hour + 1000) }, now), null, "the next trip starts fresh");
  assert.equal(storeChoice({ store: "Dirk", at: now + 2 * hour }, now), null, "a clock from the future");
  assert.equal(storeChoice({ store: "", at: now }, now), null, "no store");
  for (const bad of [null, "Dirk", { store: 3, at: now }, { store: "Dirk" }]) assert.equal(storeChoice(bad, now), null);
});

// ------------------------------------------------------------------- ops

function engineWithChips() {
  const s = emptyState();
  applyOp(s, { type: "entry.add", id: "entry-chips-001", item_id: CHIPS, title: "Tortilla chips" }, ctx());
  applyOp(s, { type: "recipe.put", id: NACHOS, recipe: { title: "Mexicaanse nachos lasagne" } }, ctx());
  for (const p of Object.values(P)) applyOp(s, { type: "product.put", id: p.id, product: { ...p, item_id: CHIPS } }, ctx());
  return s;
}

test("ops: a preference per store and recipe, one row per scope, the same again changes nothing", () => {
  const s = engineWithChips();
  const set = (o) => applyOp(s, { type: "preference.set", item_id: CHIPS, ...o }, ctx());
  const r1 = set({ id: "pref-new-00001", store: "ah", recipe_id: NACHOS, product_id: P.ah.id });
  assert.deepEqual(r1.changed, [["preferences", "pref-new-00001"]]);
  const row = s.preferences["pref-new-00001"];
  assert.deepEqual([row.store, row.recipe_id, row.product_id, row.created_by], ["Albert Heijn", NACHOS, P.ah.id, "member-thomas-01"]);

  assert.deepEqual(set({ id: "pref-new-00002", store: "Albert Heijn", recipe_id: NACHOS, product_id: P.ah.id }).changed, [], "the same: nothing written");
  set({ id: "pref-new-00003", store: "AH", recipe_id: NACHOS, product_id: P.brand.id });
  assert.deepEqual(Object.keys(s.preferences), ["pref-new-00001"], "another product: the same row");
  assert.equal(s.preferences["pref-new-00001"].product_id, P.brand.id);

  const cleared = applyOp(s, { type: "preference.clear", item_id: CHIPS, store: "AH", recipe_id: NACHOS }, ctx());
  assert.deepEqual(cleared.changed, [["preferences", "pref-new-00001"]]);
  assert.ok(s.preferences["pref-new-00001"].deleted_at, "a tombstone");
  assert.deepEqual(applyOp(s, { type: "preference.clear", item_id: CHIPS, store: "AH", recipe_id: NACHOS }, ctx()).changed, []);
  set({ id: "pref-new-00004", store: "AH", recipe_id: NACHOS, product_id: P.ah.id });
  assert.equal(s.preferences["pref-new-00001"].deleted_at, null, "setting it again revives the row");
  assert.equal(Object.keys(s.preferences).length, 1);

  set({ id: "pref-new-00005", product_id: P.brand.id });
  assert.equal(s.preferences["pref-new-00005"].store, "", "'' is any store");
  assert.equal(s.preferences["pref-new-00005"].recipe_id, "", "'' is any recipe");

  // A recipe's ingredient that was never on the list gets its item.
  const made = applyOp(s, { type: "preference.set", id: "pref-new-00006", title: "Geraspte kaas", item_id: "item-kaas-00001", recipe_id: NACHOS, product_id: P.brand.id }, ctx());
  assert.equal(made.result.item_id, "item-kaas-00001");
  assert.equal(s.items["item-kaas-00001"].name, "Geraspte kaas");
});

test("ops: a preference is checked like any op; never an excluded thing", () => {
  const s = engineWithChips();
  applyOp(s, { type: "product.put", id: "product-juice-1", product: { name: "Druivensap" } }, ctx());
  applyOp(s, { type: "entry.add", id: "entry-sprx-0001", item_id: "item-sprx-00001", title: "Spruiten" }, ctx());
  const refused = (o, code) => assert.throws(() => applyOp(s, { type: "preference.set", id: "pref-bad-00001", item_id: CHIPS, product_id: P.brand.id, ...o }, ctx()),
    (e) => e instanceof OpError && e.code === code, JSON.stringify(o));
  refused({ id: "x" }, "bad_id");
  refused({ item_id: "item-none-00001" }, "not_found");
  refused({ product_id: "product-none-01" }, "not_found");
  refused({ recipe_id: "recipe-none-001" }, "not_found");
  refused({ recipe_id: "../etc" }, "bad_id");
  refused({ store: 12 }, "bad_field");
  refused({ item_id: "item-sprx-00001", product_id: "product-juice-1" }, "excluded");
  refused({ item_id: undefined, title: "Spruitjes", product_id: "product-juice-1" }, "excluded");
  assert.equal(Object.keys(s.preferences).length, 0);
  assert.throws(() => applyOp(s, { type: "preference.clear", item_id: "../x" }, ctx()), OpError);
});

test("ops: the receipt keeps its product at its store, or only for the line's recipe", () => {
  const s = engineWithChips();
  applyOp(s, { type: "purchase.add", id: "purchase-chip-01", source: "receipt", title: "Tortilla chips", item_id: "item-unused-0001",
    bought_on: "2026-10-28", store: "DIRK", qty: 1, price_cents: 119, product: { id: P.dirk.id, ...P.dirk }, prefer: true }, ctx());
  applyOp(s, { type: "purchase.add", id: "purchase-chip-02", source: "receipt", title: "Tortilla chips", item_id: "item-unused-0001",
    bought_on: "2026-10-28", store: "AH", qty: 1, price_cents: 139, product: { id: P.ah.id, ...P.ah }, prefer_recipe_id: NACHOS }, ctx());
  const rows = Object.values(s.preferences).map((p) => [p.store, p.recipe_id, p.product_id]).sort();
  assert.deepEqual(rows, [["Albert Heijn", NACHOS, P.ah.id], ["Dirk", "", P.dirk.id]]);
  assert.throws(() => applyOp(s, { type: "purchase.add", id: "purchase-chip-03", source: "receipt", title: "Tortilla chips",
    bought_on: "2026-10-28", product: { id: P.ah.id, ...P.ah }, prefer_recipe_id: "recipe-none-001" }, ctx()), (e) => e.code === "not_found");
});

// ---------------------------------------------------------------- worker

const HOST = "groceries.localhost:8787";

function call(env, method, p, { body, cookie, bearer } = {}) {
  const headers = { Origin: `http://${HOST}` };
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`http://${HOST}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}

const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);

async function household(env) {
  env ??= await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  return { env, thomas: tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456" } })) };
}

let counter = 0;
const op = (o) => ({ op_id: `op-pref-${String(++counter).padStart(6, "0")}`, ...o });
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

async function chipsHousehold() {
  const { env, thomas } = await household();
  const r = await send(env, thomas, [
    op({ type: "recipe.put", id: NACHOS, recipe: { title: "Mexicaanse nachos lasagne", ingredients: [{ name: "tortilla chips", qty: 200, unit: "g" }] } }),
    op({ type: "entry.add", id: "entry-chips-001", item_id: CHIPS, title: "Tortilla chips", source: { recipe_id: NACHOS, title: "Mexicaanse nachos lasagne" } }),
    ...Object.values(P).map((p) => op({ type: "product.put", id: p.id, product: { ...p, item_id: CHIPS } })),
  ]);
  assert.ok(r.every((x) => x.ok), JSON.stringify(r));
  return { env, thomas };
}

test("sync: a preference goes out as one row; the same again writes nothing; an idle poll is one read", async () => {
  const { env, thomas } = await chipsHousehold();
  const head = await pull(env, thomas, 0);
  assert.deepEqual(head.preferences, []);

  let seen = spy(env);
  const [set] = await send(env, thomas, [op({ type: "preference.set", id: "pref-wrk-00001", item_id: CHIPS, store: "Dirk", recipe_id: NACHOS, product_id: P.dirk.id })]);
  assert.equal(set.ok, true, JSON.stringify(set));
  const tables = seen.batches.flat().map((sql) => sql.match(/^(?:INSERT INTO|UPDATE) (\w+)/)?.[1]).sort();
  assert.deepEqual(tables, ["applied_ops", "households", "preferences"], "rev bump + the preference + applied_ops");

  const delta = await pull(env, thomas, head.rev);
  assert.deepEqual(delta.preferences.map((p) => [p.id, p.store, p.recipe_id, p.product_id]), [["pref-wrk-00001", "Dirk", NACHOS, P.dirk.id]]);
  assert.deepEqual([delta.items.length, delta.products.length, delta.entries.length], [0, 0, 0], "only the change");

  seen = spy(env);
  const [same] = await send(env, thomas, [op({ type: "preference.set", id: "pref-wrk-00002", item_id: CHIPS, store: "DIRK", recipe_id: NACHOS, product_id: P.dirk.id })]);
  assert.equal(same.ok, true);
  assert.equal(same.result.preference_id, "pref-wrk-00001");
  assert.deepEqual(seen.batches.flat().map((sql) => sql.match(/^(?:INSERT INTO|UPDATE) (\w+)/)?.[1]), ["applied_ops"], "nothing but the op's receipt");
  const after = await pull(env, thomas, delta.rev);
  assert.equal(after.rev, delta.rev, "no new rev: the phones fetch nothing");

  seen = spy(env);
  const idle = await pull(env, thomas, delta.rev);
  assert.equal(idle.preferences.length, 0);
  assert.deepEqual(seen.queries.filter((sql) => !/FROM devices d JOIN members/.test(sql)), ["SELECT rev FROM households WHERE id = ?"], "one row: the counter");

  // Cleared: a tombstone in the delta, gone from a full load.
  await send(env, thomas, [op({ type: "preference.clear", item_id: CHIPS, store: "Dirk", recipe_id: NACHOS })]);
  const cleared = await pull(env, thomas, delta.rev);
  assert.ok(cleared.preferences[0].deleted_at);
  assert.deepEqual((await pull(env, thomas, 0)).preferences, []);
});

test("sync: a second phone setting the same scope (another spelling, another id) updates the one row", async () => {
  const { env, thomas } = await chipsHousehold();
  // A true race ends in the UNIQUE index preferences_scope and the reload in
  // applyOps (as for list lines); this checks the scope lookup that reload relies on.
  await send(env, thomas, [op({ type: "preference.set", id: "pref-race-0001", item_id: CHIPS, store: "AH", product_id: P.ah.id })]);
  const [second] = await send(env, thomas, [op({ type: "preference.set", id: "pref-race-0002", item_id: CHIPS, store: "Albert Heijn", product_id: P.brand.id })]);
  assert.equal(second.ok, true);
  const { preferences } = await pull(env, thomas, 0);
  assert.deepEqual(preferences.map((p) => [p.id, p.product_id]), [["pref-race-0001", P.brand.id]]);
});

test("sync: the receipt's 'only for the recipe' reaches D1 (the loader fetches the recipe and the rows)", async () => {
  const { env, thomas } = await chipsHousehold();
  await send(env, thomas, [op({ type: "preference.set", id: "pref-rcp-00001", item_id: CHIPS, store: "Dirk", recipe_id: NACHOS, product_id: P.brand.id })]);
  const r = await send(env, thomas, [
    op({ type: "receipt.save", id: "receipt-pref-01", store: "Dirk", bought_on: "2026-10-28", total_cents: 119, lines: [{ name: "Tortilla chips naturel", brand: "Dirk", price_cents: 119 }] }),
    op({ type: "purchase.add", id: "purchase-pref-1", source: "receipt", receipt_id: "receipt-pref-01", title: "Tortilla chips", item_id: "item-unused-0001",
      bought_on: "2026-10-28", store: "Dirk", qty: 1, price_cents: 119, product: { id: P.dirk.id, name: P.dirk.name, brand: "Dirk", size: "200 g" },
      entry_id: "entry-chips-001", prefer_recipe_id: NACHOS }),
  ]);
  assert.ok(r.every((x) => x.ok), JSON.stringify(r));
  const { preferences } = await pull(env, thomas, 0);
  assert.deepEqual(preferences.map((p) => [p.id, p.store, p.recipe_id, p.product_id]), [["pref-rcp-00001", "Dirk", NACHOS, P.dirk.id]], "the existing row of that scope");
});

test("migration: every old preferred product becomes a preference at its store, and reaches the phones", async () => {
  const env = await makeEnv({ before: "0006" });
  const { thomas } = await household(env);
  const { id: hh } = await env.DB.prepare("SELECT id FROM households").first();
  const at = "2026-10-27T10:00:00.000Z";
  // The worker of this branch already syncs the new table: read the rev directly.
  const head = await env.DB.prepare("SELECT rev FROM households").first();
  await env.DB.exec(`
    INSERT INTO items (id, household_id, name, name_key, preferred_product_id, created_at, rev) VALUES
      ('item-melk-00001', '${hh}', 'Melk', 'melk', 'product-melk-01', '${at}', 1),
      ('item-eier-00001', '${hh}', 'Eieren', 'eieren', 'product-eier-01', '${at}', 1),
      ('item-kaas-00001', '${hh}', 'Kaas', 'kaas', 'product-kaas-01', '${at}', 1),
      ('item-gone-00001', '${hh}', 'Weg', 'weg', 'product-gone-01', '${at}', 1),
      ('item-none-00001', '${hh}', 'Brood', 'brood', NULL, '${at}', 1);
    INSERT INTO products (id, household_id, item_id, name, brand, size, store, product_key, created_at, updated_at, deleted_at, rev) VALUES
      ('product-melk-01', '${hh}', 'item-melk-00001', 'Halfvolle melk', 'AH', '1 l', 'AH', 'k1', '${at}', '${at}', NULL, 1),
      ('product-eier-01', '${hh}', 'item-eier-00001', 'Scharreleieren', '', '10 st', 'DIRK VAN DEN BROEK', 'k2', '${at}', '${at}', NULL, 1),
      ('product-kaas-01', '${hh}', 'item-kaas-00001', 'Oude kaas', 'Beemster', '', '', 'k3', '${at}', '${at}', NULL, 1),
      ('product-gone-01', '${hh}', 'item-gone-00001', 'Weg', '', '', 'AH', 'k4', '${at}', '${at}', '${at}', 1);`);
  applyMigration(env, "0006");
  // The later tables (0007 pantry onward) exist on a real database before the next pull.
  applyMigration(env, "0007");
  applyMigration(env, "0008");
  applyMigration(env, "0016");     // pending_takes and cook_prompts are synced too
  applyMigration(env, "0020");
  applyMigration(env, "0021");     // recipe_ratings is synced too
  applyMigration(env, "0022");     // item_aliases is synced too
  applyMigration(env, "0023");
  applyMigration(env, "0024");     // store_prices is synced too
  applyMigration(env, "0025");     // reviews is synced too
  const delta = await pull(env, thomas, head.rev);
  assert.ok(delta.rev > head.rev, "the household's rev moved, so phones ask");
  assert.deepEqual(delta.preferences.map((p) => [p.item_id, p.store, p.recipe_id, p.product_id]).sort(), [
    ["item-eier-00001", "Dirk", "", "product-eier-01"],
    ["item-kaas-00001", "", "", "product-kaas-01"],
    ["item-melk-00001", "Albert Heijn", "", "product-melk-01"],
  ], "store from the product (canonical), any store when unknown; a deleted product is left out");
  const items = await env.DB.prepare("SELECT id, preferred_product_id FROM items WHERE id = 'item-melk-00001'").first();
  assert.equal(items.preferred_product_id, "product-melk-01", "the old column stays readable");

  // The new engine writes the table, not the column.
  await send(env, thomas, [op({ type: "item.prefer", item_id: "item-melk-00001", product_id: null })]);
  const after = await env.DB.prepare("SELECT preferred_product_id FROM items WHERE id = 'item-melk-00001'").first();
  assert.equal(after.preferred_product_id, "product-melk-01");
  const melk = resolveProduct({ preferences: Object.fromEntries((await pull(env, thomas, 0)).preferences.map((p) => [p.id, p])),
    products: { "product-melk-01": { id: "product-melk-01" } } }, { item_id: "item-melk-00001", sources: [] }, "AH");
  assert.equal(melk.product.id, "product-melk-01", "clearing 'any store' leaves the AH preference");
});

// ---------------------------------------------------------------- offers

const day = (offset) => amsterdamDay(new Date(Date.now() + offset * 86400_000));
const TODAY = day(0);
const offer = (o) => ({ id: `of-${o.store}-${o.name}`, brand: null, size: null, deal: "-25%", price_cents: 199, valid_from: TODAY, valid_until: day(5), category: null, ...o });

test("offers: the preferred product first, then the name; only the chosen store's folder; never an excluded thing", () => {
  const offers = Object.fromEntries([
    offer({ store: "Dirk", name: "Doritos Nacho cheese tortilla chips", brand: "Doritos" }),
    offer({ store: "Albert Heijn", name: "Doritos Nacho Cheese", valid_until: day(2) }),
    offer({ store: "Albert Heijn", name: "Doritos Sweet chili" }),
    offer({ store: "Lidl", name: "Tortilla chips paprika" }),
    offer({ store: "Albert Heijn", name: "AH Tortilla chips naturel" }),
    offer({ store: "Dirk", name: "Tortilla chips naturel" }),
    offer({ store: "Dirk", name: "Groene Ster spruitjes tortilla chips", category: "Spruitjes" }),
  ].map((o) => [o.id, o]));
  const current = currentOffers(offers, TODAY);
  assert.ok(!current.some((o) => /Groene Ster/.test(o.name)), "excluded never counts");

  const brand = P.brand;
  assert.ok(productOfferMatches(brand, offers["of-Dirk-Doritos Nacho cheese tortilla chips"]));
  assert.ok(!productOfferMatches(brand, offers["of-Albert Heijn-Doritos Sweet chili"]), "another flavour is not his product");
  assert.ok(!productOfferMatches(P.ah, offers["of-Dirk-Tortilla chips naturel"]), "a store brand only in its own store");
  assert.ok(productOfferMatches(P.ah, offers["of-Albert Heijn-AH Tortilla chips naturel"]));
  assert.ok(productOfferMatches({ ...brand, store: "Dirk" }, offers["of-Albert Heijn-Doritos Nacho Cheese"]),
    "a real brand last bought at Dirk is still his product at AH");
  const plainDirk = { name: "Tortilla chips naturel", brand: "", store: "Dirk" };
  assert.ok(productOfferMatches(plainDirk, offers["of-Dirk-Tortilla chips naturel"]));
  assert.ok(!productOfferMatches(plainDirk, offers["of-Albert Heijn-AH Tortilla chips naturel"]), "without a brand: the store it was bought at");

  const names = (r) => [r.mine.map((o) => `${o.store}: ${o.name}`), r.named.map((o) => `${o.store}: ${o.name}`)];
  assert.deepEqual(names(lineOffers("Tortilla chips", brand, current)), [
    ["Albert Heijn: Doritos Nacho Cheese", "Dirk: Doritos Nacho cheese tortilla chips"],
    ["Albert Heijn: AH Tortilla chips naturel", "Dirk: Tortilla chips naturel", "Lidl: Tortilla chips paprika"],
  ], "no store: his product anywhere first, the rest after");
  assert.deepEqual(names(lineOffers("Tortilla chips", P.dirk, current, "DIRK")), [
    ["Dirk: Tortilla chips naturel"],
    ["Dirk: Doritos Nacho cheese tortilla chips"],
  ], "at Dirk: only Dirk's folder");
  assert.deepEqual(names(lineOffers("Tortilla chips", null, current, "Lidl")), [[], ["Lidl: Tortilla chips paprika"]]);
});

test("offers: the worker keeps an offer on a preferred product whose name the item does not have", async () => {
  const { env, thomas } = await chipsHousehold();
  await send(env, thomas, [op({ type: "preference.set", id: "pref-off-00001", item_id: CHIPS, product_id: P.brand.id })]);
  const code = await (await call(env, "POST", "/api/codes", { cookie: thomas, body: { for: "fetcher" } })).json();
  const server = tokenOf(await call(env, "POST", "/api/pair", { body: { code: code.code, label: "Thuisserver" } }));
  const set = [
    { store: "Dirk", name: "Doritos Nacho Cheese 185g", brand: "Doritos", valid_until: day(3) },
    { store: "Lidl", name: "Dames broek", valid_until: day(3) },
  ];
  const res = await (await call(env, "POST", "/api/offers/sync", { bearer: server, body: { offers: set } })).json();
  assert.equal(res.added, 1, JSON.stringify(res));
  const { offers } = await pull(env, thomas, 0);
  assert.deepEqual(offers.map((o) => o.name), ["Doritos Nacho Cheese 185g"]);
  // Without the preference the same offer is not about anything the household buys.
  assert.equal(relevanceTest(["Tortilla chips"])({ name: "Doritos Nacho Cheese 185g", brand: "Doritos" }), false);
  assert.equal(relevanceTest([productOfferName(P.brand)])({ name: "Doritos Nacho Cheese 185g", brand: "Doritos" }), true);
});

test("fetcher files: every shared file the copied files import goes along", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  // fetcher/deploy.mjs runs when imported (it deploys), so its list is read as text.
  const list = fs.readFileSync(path.join(root, "fetcher/deploy.mjs"), "utf8").match(/const FILES = \[([\s\S]*?)\n\];/)[1];
  const copied = new Set([...list.matchAll(/\["([^"]+)", "[^"]+"\]/g)].map((m) => m[1]));
  assert.ok(copied.has("public/shared/offers.js"));
  // The two entry points run.sh starts (the deals and the AH receipts).
  assert.ok(copied.has("fetcher/fetch.mjs") && copied.has("fetcher/ah_import.mjs"));
  for (const from of [...copied].filter((f) => /\.m?js$/.test(f))) {
    const src = fs.readFileSync(path.join(root, from), "utf8");
    // Static imports and relative dynamic ones (import_ah.mjs loads ah_pull.mjs so).
    for (const [, rel] of src.matchAll(/(?:from |import\()"(\.{1,2}\/[^"]+)"/g)) {
      const target = path.relative(root, path.resolve(path.dirname(path.join(root, from)), rel)).replace(/\\/g, "/");
      assert.ok(copied.has(target), `${from} imports ${target}, which fetcher/deploy.mjs does not copy`);
    }
  }
});
