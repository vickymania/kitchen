// "Laatst gekocht" (30-10-2026): purchases newest first per trip, the
// store filter, the price per piece, no excluded, no To Do history, and
// "beste koop": the most stars per euro (per kg / l / piece when sizes allow).
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { recentTrips, tripStores, bestBuys, unitCents, productStars } from "../public/shared/recent-purchases.js";

const item = (id, name) => ({ id, name, name_key: name.toLowerCase(), deleted_at: null });
const product = (id, item_id, name, brand, size, store, last_price_cents) => ({ id, item_id, name, brand, size, store, last_price_cents, deleted_at: null });
const purchase = (id, o) => ({ id, source: "receipt", receipt_id: null, qty: 1, deleted_at: null, ...o });

function view() {
  return {
    items: {
      "item-melk": item("item-melk", "Melk"),
      "item-sprt": item("item-sprt", "Spruitjes"),
      "item-ui": item("item-ui", "Ui"),
      "item-kaas": item("item-kaas", "Kaas"),
    },
    products: {
      "p-melk-ah": product("p-melk-ah", "item-melk", "Halfvolle melk", "AH", "1 l", "Albert Heijn", 109),
      "p-melk-cb": product("p-melk-cb", "item-melk", "Halfvolle melk", "Campina", "1,5 l", "Albert Heijn", 219),
      "p-sprt": product("p-sprt", "item-sprt", "Spruitjes", "Groene Ster", "6 x 30 cl", "Albert Heijn", 599),
      "p-kaas-a": product("p-kaas-a", "item-kaas", "Jong belegen", "AH", "500 g", "Albert Heijn", 499),
      "p-kaas-b": product("p-kaas-b", "item-kaas", "Jong belegen", "Beemster", "", "Dirk", 399),
    },
    receipts: { "rc-1": { id: "rc-1", store: "Albert Heijn", bought_on: "2026-10-28", total_cents: 9999 } },
    purchases: {
      a: purchase("a", { item_id: "item-melk", product_id: "p-melk-ah", receipt_id: "rc-1", title: "Melk", store: "Albert Heijn", bought_on: "2026-10-28", qty: 2, price_cents: 218 }),
      b: purchase("b", { item_id: "item-sprt", product_id: "p-sprt", receipt_id: "rc-1", title: "Spruitjes", store: "Albert Heijn", bought_on: "2026-10-28", price_cents: 599 }),
      c: purchase("c", { item_id: "item-ui", product_id: null, title: "Ui", store: "Dirk", bought_on: "2026-10-29", price_cents: 89 }),
      d: purchase("d", { item_id: "item-kaas", product_id: "p-kaas-b", title: "Kaas", store: "dirk", bought_on: "2026-10-29", price_cents: 399 }),
      e: purchase("e", { item_id: "item-ui", product_id: null, title: "Ui", store: "", bought_on: "2023-01-04", source: "history", price_cents: null }),
      f: purchase("f", { item_id: "item-melk", product_id: "p-melk-cb", title: "Melk", store: "AH", bought_on: "2026-10-20", price_cents: 219 }),
      gone: purchase("gone", { item_id: "item-melk", product_id: "p-melk-ah", title: "Melk", store: "AH", bought_on: "2026-10-30", price_cents: 109, deleted_at: "2026-10-30T10:00:00Z" }),
    },
    ratings: {},
  };
}

test("recentTrips: per receipt, else per store and day; newest first; the history and deleted lines left out", () => {
  const trips = recentTrips(view());
  assert.deepEqual(trips.map((t) => [t.store, t.day, t.lines.map((l) => l.purchase.id)]), [
    ["Dirk", "2026-10-29", ["d", "c"]],
    ["Albert Heijn", "2026-10-28", ["a"]],
    ["Albert Heijn", "2026-10-20", ["f"]],
  ]);
  assert.equal(trips[0].key, "d:Dirk|2026-10-29", "\"dirk\" and \"Dirk\" are one store on one day");
  assert.equal(trips[1].receipt_id, "rc-1");
  assert.equal(trips[1].total_cents, 218, "the shown lines add up, never the receipt's own total (it holds the sprouts)");
  assert.equal(trips[0].lines.find((l) => l.purchase.id === "c").product, null, "a line without a product: no stars to give");
});

test("recentTrips: excluded is never shown", () => {
  const all = recentTrips(view()).flatMap((t) => t.lines.map((l) => l.purchase.title));
  assert.equal(all.includes("Spruitjes"), false);
  // Also when only the product says it.
  const v = view();
  v.purchases.x = purchase("x", { item_id: "item-ui", product_id: "p-sprt", title: "Drinken", store: "Albert Heijn", bought_on: "2026-10-30", price_cents: 599 });
  assert.equal(recentTrips(v).some((t) => t.lines.some((l) => l.purchase.id === "x")), false);
});

test("recentTrips: the store filter; tripStores most trips first", () => {
  const v = view();
  assert.deepEqual(recentTrips(v, { store: "AH" }).map((t) => t.day), ["2026-10-28", "2026-10-20"], "AH is Albert Heijn");
  assert.deepEqual(recentTrips(v, { store: "Dirk" }).map((t) => t.day), ["2026-10-29"]);
  assert.deepEqual(tripStores(recentTrips(v)), ["Albert Heijn", "Dirk"]);
});

test("unitCents: the price of one when more than one was bought", () => {
  assert.equal(unitCents({ price_cents: 218, qty: 2 }), 109);
  assert.equal(unitCents({ price_cents: 199, qty: 1 }), 199);
  assert.equal(unitCents({ price_cents: 150, qty: 0.5 }), 150, "a weight under one is the line's price");
  assert.equal(unitCents({ price_cents: null, qty: 3 }), null);
});

test("bestBuys: the most stars per euro, per litre when every pack says it", () => {
  const v = view();
  const rate = (id, member_id, product_id, stars) => { v.ratings[id] = { id, member_id, product_id, stars, deleted_at: null }; };
  rate("r1", "m1", "p-melk-ah", 3);
  assert.equal(bestBuys(v).size, 0, "one rated product: nothing to compare");
  rate("r2", "m1", "p-melk-cb", 5);
  // AH: 3 stars for €1,09/l = 2,75 per euro; Campina: 5 stars for €1,46/l = 3,42 per euro.
  const melk = bestBuys(v).get("item-melk");
  assert.deepEqual([melk.product.id, melk.stars, melk.cents, melk.measure, melk.candidates], ["p-melk-cb", 5, 146, "l", 2]);
  // Sam thinks Campina is a 1: the household average decides (3 for €1,46 loses to 3 for €1,09).
  rate("r3", "m2", "p-melk-cb", 1);
  assert.equal(productStars(v.ratings).get("p-melk-cb").average, 3);
  assert.equal(bestBuys(v).get("item-melk").product.id, "p-melk-ah");
  // A pack without a size: compared per pack.
  rate("r4", "m1", "p-kaas-a", 4);
  rate("r5", "m1", "p-kaas-b", 4);
  const kaas = bestBuys(v).get("item-kaas");
  assert.deepEqual([kaas.product.id, kaas.measure, kaas.cents], ["p-kaas-b", "pack", 399]);
  // Cleared and deleted ratings do not count.
  v.ratings.r5.deleted_at = "2026-10-30T10:00:00Z";
  assert.equal(bestBuys(v).has("item-kaas"), false);
});

test("bestBuys: never an excluded thing, and only products with a price", () => {
  const v = view();
  v.products["p-sprt-2"] = product("p-sprt-2", "item-sprt", "Spruiten", "Groenhof", "6 x 30 cl", "Albert Heijn", 549);
  for (const [i, p] of ["p-sprt", "p-sprt-2"].entries()) v.ratings[`b${i}`] = { id: `b${i}`, member_id: "m1", product_id: p, stars: 5 };
  assert.equal(bestBuys(v).has("item-sprt"), false);
  v.ratings.k1 = { id: "k1", member_id: "m1", product_id: "p-kaas-a", stars: 5 };
  v.ratings.k2 = { id: "k2", member_id: "m1", product_id: "p-kaas-b", stars: 5 };
  v.products["p-kaas-b"].last_price_cents = null;
  assert.equal(bestBuys(v).has("item-kaas"), false, "without a price there is nothing per euro");
});
