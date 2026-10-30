// "Alleen bij deze winkel" (28-10-2026): the Lidl macaroni herbs for
// "Pastapotje HenkTorino" are sold only at Lidl. The flag on the product, its
// checks, the rows on D1, which product a line resolves to, the list's
// groups, no cheaper-store hint, and offers only from that store.
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { applyOp, emptyState, OpError } from "../public/shared/ops.js";
import { resolveProduct, storeGroups } from "../public/shared/preferences.js";
import { lineOffers, productOfferMatches } from "../public/shared/offers.js";
import { cheaperElsewhere, dealsFor } from "../public/shared/deals.js";
import { importerMayApply } from "../worker/auth.js";

const ctx = () => ({ memberId: "member-thomas-01", isAdmin: true, now: "2026-10-28T10:00:00.000Z" });

const HERBS = "item-herbs-00001";
const PASTA = "recipe-pastapot1";
const P = {
  lidl: { id: "product-lidl-hrb", name: "Macaroni kruiden", brand: "Kania", size: "40 g", store: "Lidl", store_only: 1 },
  ah: { id: "product-ah-herbs", name: "Kruidenmix macaroni", brand: "AH", size: "40 g", store: "Albert Heijn", store_only: 0 },
  dirk: { id: "product-dirk-hrb", name: "Kruidenmix macaroni", brand: "Dirk", size: "40 g", store: "Dirk", store_only: 0 },
};
const pref = (id, store, recipe_id, product_id, updated_at = "2026-10-28T10:00:00Z") =>
  ({ id, item_id: HERBS, store, recipe_id, product_id, updated_at, deleted_at: null });

function herbsView(preferences) {
  return {
    items: { [HERBS]: { id: HERBS, name: "Macaronikruiden", deleted_at: null } },
    products: Object.fromEntries(Object.values(P).map((p) => [p.id, { ...p, item_id: HERBS, deleted_at: null }])),
    recipes: { [PASTA]: { id: PASTA, title: "Pastapotje HenkTorino" } },
    preferences,
    purchases: {},
    offers: {},
    deal_rules: {},
    pantry: {},
    pantry_events: {},
  };
}
const forPasta = { id: "entry-herbs-001", item_id: HERBS, title: "Macaronikruiden", sources: [{ recipe_id: PASTA, title: "Pastapotje HenkTorino" }] };
const plain = { id: "entry-herbs-002", item_id: HERBS, title: "Macaronikruiden", sources: [] };

// ----------------------------------------------------------------- the op

function engine() {
  const s = emptyState();
  s.items[HERBS] = { id: HERBS, name: "Macaronikruiden", name_key: "macaronikruiden", deleted_at: null };
  return s;
}

test("op: store_only is set through product.put, a patch, stored as 0 / 1", () => {
  const s = engine();
  applyOp(s, { type: "product.put", id: P.lidl.id, product: { name: "Macaroni kruiden", brand: "Kania", store: "lidl", store_only: true } }, ctx());
  assert.deepEqual([s.products[P.lidl.id].store, s.products[P.lidl.id].store_only], ["Lidl", 1]);
  applyOp(s, { type: "product.put", id: P.lidl.id, product: { size: "40 g" } }, ctx());
  assert.equal(s.products[P.lidl.id].store_only, 1, "a patch without it keeps it");
  applyOp(s, { type: "product.put", id: P.lidl.id, product: { store_only: false } }, ctx());
  assert.equal(s.products[P.lidl.id].store_only, 0, "a person unticks it");
  applyOp(s, { type: "product.put", id: P.ah.id, product: { name: "Kruidenmix", brand: "AH" } }, ctx());
  assert.equal(s.products[P.ah.id].store_only, 0, "a new product is not store_only");
});

test("op: store_only is refused without a store, and must be a boolean", () => {
  const s = engine();
  const put = (product, id = P.lidl.id) => applyOp(s, { type: "product.put", id, product }, ctx());
  assert.throws(() => put({ name: "Macaroni kruiden", store_only: true }), (e) => e instanceof OpError && e.code === "store_required");
  assert.equal(s.products[P.lidl.id], undefined, "nothing written");
  put({ name: "Macaroni kruiden", store: "Lidl", store_only: true });
  assert.throws(() => put({ store: "" }), (e) => e.code === "store_required", "clearing the store of a store_only product");
  assert.throws(() => put({ store_only: "yes" }), (e) => e.code === "bad_field");
  assert.equal(s.products[P.lidl.id].store_only, 1);
});

test("op: a receipt or import from another store never clears it or moves the product", () => {
  const s = engine();
  applyOp(s, { type: "product.put", id: P.lidl.id, product: { name: "Macaroni kruiden", brand: "Kania", store: "Lidl", store_only: true } }, ctx());
  applyOp(s, { type: "product.put", id: P.lidl.id, product: { name: "Macaroni kruiden", brand: "Kania", store: "Albert Heijn", last_price_cents: 129 } }, ctx());
  assert.deepEqual([s.products[P.lidl.id].store, s.products[P.lidl.id].store_only, s.products[P.lidl.id].last_price_cents], ["Lidl", 1, 129]);
  applyOp(s, {
    type: "purchase.add", id: "purchase-herbs-1", item_id: HERBS, title: "Macaronikruiden", bought_on: "2026-10-28",
    store: "AH", price_cents: 129, source: "receipt", product: { id: P.lidl.id, name: "Macaroni kruiden", brand: "Kania" },
  }, ctx());
  assert.deepEqual([s.products[P.lidl.id].store, s.products[P.lidl.id].store_only], ["Lidl", 1], "the receipt review's purchase.add");
  // A person who moves it says so: store and store_only together.
  applyOp(s, { type: "product.put", id: P.lidl.id, product: { store: "ALDI", store_only: true } }, ctx());
  assert.equal(s.products[P.lidl.id].store, "ALDI");
});

test("importer: may not set store_only; its own product.put passes", () => {
  assert.equal(importerMayApply({ type: "product.put", id: "p", product: { name: "x", store: "Albert Heijn" } }), true);
  assert.equal(importerMayApply({ type: "product.put", id: "p", product: { name: "x", store: "Albert Heijn", store_only: false } }), false);
});

// ------------------------------------------------------------- D1 and sync

const HOST = "groceries.localhost:8787";
function call(env, method, p, { body, cookie } = {}) {
  const headers = { Origin: `http://${HOST}` };
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`http://${HOST}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
let counter = 0;
const op = (o) => ({ op_id: `op-store-only-${String(++counter).padStart(6, "0")}`, ...o });
const send = async (env, cookie, ops) => (await (await call(env, "POST", "/api/ops", { cookie, body: { ops } })).json()).results;
const pull = async (env, cookie, since) => (await call(env, "GET", `/api/sync?since=${since}`, { cookie })).json();

test("sync: the flag reaches D1 and the other phones as one product row; refused without a store", async () => {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const res = await call(env, "POST", "/api/pair", { body: { code: "123456" } });
  const thomas = res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
  const [made] = await send(env, thomas, [op({ type: "product.put", id: P.lidl.id, product: { name: "Macaroni kruiden", brand: "Kania", store: "Lidl" } })]);
  assert.equal(made.ok, true, JSON.stringify(made));
  const head = await pull(env, thomas, 0);
  assert.equal(head.products[0].store_only, 0, "the column's default");

  const [set] = await send(env, thomas, [op({ type: "product.put", id: P.lidl.id, product: { store_only: true } })]);
  assert.equal(set.ok, true, JSON.stringify(set));
  const delta = await pull(env, thomas, head.rev);
  assert.deepEqual(delta.products.map((p) => [p.id, p.store, p.store_only]), [[P.lidl.id, "Lidl", 1]]);
  assert.deepEqual([delta.items.length, delta.entries.length, delta.preferences.length], [0, 0, 0], "only the change");

  const [bad] = await send(env, thomas, [op({ type: "product.put", id: "product-nostore1", product: { name: "Kruiden", store_only: true } })]);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "store_required");
  assert.equal((await pull(env, thomas, delta.rev)).rev, delta.rev, "nothing written");
});

// -------------------------------------------------------------- resolution

test("resolution: a recipe's store_only product wins over the item at the chosen store", () => {
  // recipe + any = Lidl store_only beats item + AH (the order already says so).
  let v = herbsView({ a: pref("pref-pasta-any1", "", PASTA, P.lidl.id), b: pref("pref-item-ah001", "Albert Heijn", "", P.ah.id) });
  let r = resolveProduct(v, forPasta, "AH");
  assert.deepEqual([r.product.id, r.onlyAt, r.why.recipe], [P.lidl.id, "Lidl", "Pastapotje HenkTorino"]);
  assert.equal(resolveProduct(v, plain, "AH").product.id, P.ah.id, "without the recipe: the item at AH");
  assert.equal(resolveProduct(v, plain, "AH").onlyAt, null);

  // recipe + Lidl (store_only) at AH: still the Lidl one, before item + AH and item + any.
  v = herbsView({
    a: pref("pref-pasta-lidl", "Lidl", PASTA, P.lidl.id),
    b: pref("pref-item-ah001", "Albert Heijn", "", P.ah.id),
    c: pref("pref-item-any01", "", "", P.dirk.id),
  });
  r = resolveProduct(v, forPasta, "AH");
  assert.deepEqual([r.product.id, r.onlyAt], [P.lidl.id, "Lidl"], "recipe + other store, store_only, beats item + AH");
  assert.equal(resolveProduct(v, forPasta, null).product.id, P.lidl.id, "no store: beats item + any");
  assert.equal(resolveProduct(v, forPasta, "Lidl").product.id, P.lidl.id, "at Lidl: recipe + store");
  assert.equal(resolveProduct(v, forPasta, "Lidl").onlyAt, "Lidl");

  // The recipe at the chosen store, or at any store, still comes first.
  v = herbsView({ a: pref("pref-pasta-lidl", "Lidl", PASTA, P.lidl.id), b: pref("pref-pasta-ah01", "Albert Heijn", PASTA, P.ah.id), c: pref("pref-pasta-any1", "", PASTA, P.dirk.id) });
  assert.equal(resolveProduct(v, forPasta, "AH").product.id, P.ah.id, "recipe + AH");
  assert.equal(resolveProduct(v, forPasta, "Jumbo").product.id, P.dirk.id, "recipe + any");

  // A store-specific preference whose product is not store_only stays at its store.
  v = herbsView({ a: pref("pref-pasta-dirk", "Dirk", PASTA, P.dirk.id), b: pref("pref-item-ah001", "Albert Heijn", "", P.ah.id) });
  assert.equal(resolveProduct(v, forPasta, "AH").product.id, P.ah.id);
});

test("resolution: an item's store_only product for another store only when nothing else holds", () => {
  let v = herbsView({ a: pref("pref-item-lidl1", "Lidl", "", P.lidl.id), b: pref("pref-item-ah001", "Albert Heijn", "", P.ah.id) });
  assert.equal(resolveProduct(v, plain, "AH").product.id, P.ah.id, "item + AH wins");
  v = herbsView({ a: pref("pref-item-lidl1", "Lidl", "", P.lidl.id), b: pref("pref-item-any01", "", "", P.dirk.id) });
  assert.equal(resolveProduct(v, plain, "AH").product.id, P.dirk.id, "item + any wins");
  v = herbsView({ a: pref("pref-item-lidl1", "Lidl", "", P.lidl.id) });
  assert.deepEqual([resolveProduct(v, plain, "AH").product.id, resolveProduct(v, plain, "AH").onlyAt], [P.lidl.id, "Lidl"], "alone: still said, haal bij Lidl");
  v = herbsView({ a: pref("pref-item-dirk1", "Dirk", "", P.dirk.id) });
  assert.equal(resolveProduct(v, plain, "AH"), null, "a Dirk product that is sold elsewhere too: nothing at AH, as before");
});

// ------------------------------------------------------------------- list

test("list: under another chosen store such lines go to a group per store at the bottom", () => {
  const v = herbsView({ a: pref("pref-pasta-any1", "", PASTA, P.lidl.id) });
  v.products["product-aldi-oil"] = { id: "product-aldi-oil", item_id: "item-oil-000001", name: "Olijfolie", brand: "", size: "", store: "ALDI", store_only: 1, deleted_at: null };
  v.preferences.b = { id: "pref-oil-any001", item_id: "item-oil-000001", store: "", recipe_id: "", product_id: "product-aldi-oil", updated_at: "2026-10-28T10:00:00Z", deleted_at: null };
  const milk = { id: "entry-milk-0001", item_id: "item-milk-00001", title: "Melk", sources: [] };
  const oil = { id: "entry-oil-00001", item_id: "item-oil-000001", title: "Olijfolie", sources: [] };
  const lines = [milk, forPasta, oil];

  const atAh = storeGroups(v, lines, "AH");
  assert.deepEqual(atAh.here.map((e) => e.id), [milk.id]);
  assert.deepEqual(atAh.away.map(([s, ls]) => [s, ls.map((e) => e.id)]), [["ALDI", [oil.id]], ["Lidl", [forPasta.id]]], "sorted by store");

  const atLidl = storeGroups(v, lines, "Lidl");
  assert.deepEqual(atLidl.here.map((e) => e.id), [milk.id, forPasta.id], "at Lidl the herbs are here");
  assert.deepEqual(atLidl.away.map(([s]) => s), ["ALDI"]);

  const none = storeGroups(v, lines, null);
  assert.deepEqual([none.here.map((e) => e.id), none.away], [[milk.id, forPasta.id, oil.id], []], "no store: the normal order");
  assert.equal(resolveProduct(v, forPasta, null).onlyAt, "Lidl", "and the line still says haal bij Lidl");

  const inCart = storeGroups(v, [{ ...forPasta, checked_at: "2026-10-28T11:00:00Z" }], "AH");
  assert.equal(inCart.here.length, 1, "a checked line stays in the cart");
});

// ------------------------------------------------------------ hint, offers

const offer = (store, name, brand = "", extra = {}) => ({
  id: `offer-${store}-${name}`, store, name, brand, size: "", deal: "-50%", price_cents: 99,
  valid_from: "2026-10-26", valid_until: "2026-11-01", category: "", deleted_at: null, ...extra,
});

test("hint: no cheaper-store hint on a line that resolves to a store_only product", () => {
  // Both regular stores know a price, but the line is the Lidl herbs.
  const v = herbsView({ a: pref("pref-pasta-any1", "", PASTA, P.lidl.id), b: pref("pref-item-ah001", "Albert Heijn", "", P.ah.id), c: pref("pref-item-dirk1", "Dirk", "", P.dirk.id) });
  v.products[P.ah.id].last_price_cents = 249;
  v.products[P.dirk.id].last_price_cents = 99;
  assert.ok(cheaperElsewhere(v, plain, []), "the plain line gets its hint");
  assert.equal(cheaperElsewhere(v, forPasta, []), null, "no store chosen");
  assert.equal(cheaperElsewhere(v, forPasta, [], "Albert Heijn"), null, "at AH");
});

test("offers: a store_only product only matches offers from its store", () => {
  const lidl = { ...P.lidl, item_id: HERBS, deleted_at: null };
  const atLidl = offer("Lidl", "Kania macaroni kruiden", "Kania");
  const atAh = offer("Albert Heijn", "Kania macaroni kruiden", "Kania");
  assert.equal(productOfferMatches(lidl, atLidl), true);
  assert.equal(productOfferMatches(lidl, atAh), false, "a real brand, but sold at Lidl only");
  assert.equal(productOfferMatches({ ...lidl, store_only: 0 }, atAh), true, "without the flag: a brand is everywhere");

  const named = offer("Albert Heijn", "Macaronikruiden");
  const { mine, named: byName } = lineOffers("Macaronikruiden", lidl, [atLidl, atAh, named], "Albert Heijn");
  assert.deepEqual(mine, [atLidl], "Lidl's offer, also with AH chosen");
  assert.deepEqual(byName, [], "no AH offer by name");
});

test("deals: a rule on a store_only product only sees its store, and that is no detour", () => {
  const v = herbsView({ a: pref("pref-item-any01", "", "", P.lidl.id) });
  v.offers = Object.fromEntries([
    offer("Lidl", "Kania macaroni kruiden", "Kania"),
    offer("Albert Heijn", "Kania macaroni kruiden", "Kania"),
    offer("Dirk", "Macaronikruiden"),
  ].map((o) => [o.id, o]));
  for (const rule of [
    { id: "rule-herbs-item1", item_id: HERBS, product_id: "", offer_only: 1, detour: 0 },
    { id: "rule-herbs-prod1", item_id: HERBS, product_id: P.lidl.id, offer_only: 1, detour: 0 },
  ]) {
    v.deal_rules = { [rule.id]: { max_price_cents: null, min_discount_pct: null, max_unit_price_cents: null, unit: null, deleted_at: null, ...rule } };
    const hits = dealsFor(v, "2026-10-28");
    assert.deepEqual(hits.map((h) => [h.offer.store, h.detour]), [["Lidl", false]], rule.product_id ? "product rule" : "item rule");
  }
});
