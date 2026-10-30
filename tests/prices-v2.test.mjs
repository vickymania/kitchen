// Prices v2 (30-10-2026: "Ik zie de prijzen nog steeds niet in mijn
// lijstje. En als ik naar de verschillende winkels kijk ontbreekt bij bijna
// alles nog steeds de prijs per item."): the comparable product per item and
// store (public/shared/comparable-prices.js, the op prices.sync), the price on
// a list line and the totals per store (public/shared/line-prices.js).
// Fictional household and rows; the store brands are made up ("Huis").
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { applyOp, emptyState } from "../public/shared/ops.js";
import { packSize, pricesOf, storePriceId } from "../public/shared/store-prices.js";
import {
  unitPrice, packRatio, comparableTarget, comparableTargets, matchComparables, rowComparable, referenceProduct, comparablePriceId, PACK_TOLERANCE,
} from "../public/shared/comparable-prices.js";
import { linePrices, productPrices, lineQty, pickLinePrice, homeStore, listPrices, storeTotal, compareStores } from "../public/shared/line-prices.js";
import { hiddenOf, rowHidden } from "../worker/privacy.js";

const DAY = "2026-10-29";
const TODAY = "2026-10-30";
const ctx = { memberId: "m1", isAdmin: true, now: "2026-10-30T05:20:00.000Z" };

const EGGS = { id: "item-eggs-000001", name: "Eieren" };
const MILK = { id: "item-milk-000001", name: "Melk" };
const ROLLS = { id: "item-roll-000001", name: "Broodjes" };
const SPROUTS = { id: "item-sprt-000001", name: "Spruitjes" };
const PEPPER = { id: "item-pepr-000001", name: "Peper" };
const AH_EGGS = { id: "ah-product-910001", item_id: EGGS.id, brand: "AH", name: "AH Scharrel eieren", size: "10 stuks", store: "Albert Heijn", updated_at: "2026-10-20" };
const AH_MILK = { id: "ah-product-910002", item_id: MILK.id, brand: "AH", name: "AH Houdbare halfvolle melk", size: "1 l", store: "Albert Heijn", updated_at: "2026-10-20" };
const AH_ROLLS = { id: "ah-product-910003", item_id: ROLLS.id, brand: "AH", name: "AH Schnittbroodjes", size: "6 stuks", store: "Albert Heijn", updated_at: "2026-10-20" };
const AH_SPROUTS = { id: "ah-product-910004", item_id: SPROUTS.id, brand: "AH", name: "AH Spruitjes", size: "500 g", store: "Albert Heijn" };

// Dirk's rows as Checkjebon writes them: [name, size, cents, ref].
const DIRK = [
  ["Dirk Scharreleieren M 10 stuks", "10 stuks", 239, ""],
  ["Huis Uitloop eieren", "12 stuks", 259, ""],                 // 21.6 per egg: cheaper than 23.9
  ["Dirk Eieren 30 stuks", "30 stuks", 549, ""],                // far pack: 3 times as many
  ["Dirk Bio scharreleieren", "10 stuks", 199, ""],             // a variant he does not buy
  ["Paaseieren chocolade", "10 stuks", 149, ""],                // another kind of thing (a snack)
  ["Kipfilet met eieren", "10 stuks", 99, ""],                  // what it is comes first: chicken
  ["Dirk Houdbare halfvolle melk", "1 liter", 105, ""],
  ["Dirk Houdbare halfvolle melk", "1,5 liter", 149, ""],       // 99.3 per l: the cheaper one per litre
  ["Dirk Houdbare halfvolle melk lactosevrij", "1 liter", 89, ""],
  ["Dirk Halfvolle chocolademelk", "1 liter", 99, ""],
  ["Dirk Spruitjes", "500 g", 129, ""],                         // never: excluded
  ["Dirk Zwarte peper gemalen", "50 g", 159, ""],
  ["Dirk Peper", "35 g", 99, ""],
];

// ----------------------------------------------------------- unit prices

test("unit prices: per kg, per l, per piece; packs compared on the measure they share", () => {
  assert.deepEqual(unitPrice(239, packSize("10 stuks")), { per: "piece", cents: 24 });
  assert.deepEqual(unitPrice(149, packSize("1,5 liter")), { per: "l", cents: 99 });
  assert.deepEqual(unitPrice(159, packSize("50 g")), { per: "kg", cents: 3180 });
  assert.deepEqual(unitPrice(500, packSize("6 x 85 g")), { per: "kg", cents: 980 }, "weight before count");
  assert.equal(unitPrice(100, null), null);
  assert.equal(unitPrice(0, packSize("1 l")), null);
  assert.equal(packRatio(packSize("10 stuks"), packSize("12 stuks")), 1.2);
  assert.equal(packRatio(packSize("1 l"), packSize("1500 ml")), 1.5);
  assert.equal(packRatio(packSize("500 g"), packSize("1 l")), Infinity, "weight and volume do not compare");
  assert.ok(packRatio(packSize("10 stuks"), packSize("30 stuks")) > PACK_TOLERANCE);
});

// --------------------------------------------------------------- matching

test("comparable: same kind of thing in a similar pack, the cheapest per unit", () => {
  const t = comparableTarget(EGGS, AH_EGGS);
  assert.deepEqual(t.required, ["scharrel"]);
  assert.equal(t.needItem, true, "scharrel alone is not eggs");
  assert.ok(rowComparable(t, "Dirk Scharreleieren M 10 stuks"));
  assert.equal(rowComparable(t, "Huis Uitloop eieren"), false, "uitloop is no scharrel");
  const loose = comparableTarget(EGGS, { ...AH_EGGS, name: "AH Eieren" });
  assert.ok(rowComparable(loose, "Huis Uitloop eieren"), "two words in front (a brand) are fine");
  assert.equal(rowComparable(loose, "Huis Grote vrije uitloop eieren"), false, "four are not");
  const got = matchComparables([loose], DIRK).get(EGGS.id);
  assert.deepEqual(got, { product_id: AH_EGGS.id, name: "Huis Uitloop eieren", size: "12 stuks", cents: 259 }, "21.6 cents an egg beats 23.9");
  const milk = matchComparables([comparableTarget(MILK, AH_MILK)], DIRK).get(MILK.id);
  assert.deepEqual([milk.name, milk.size, milk.cents], ["Dirk Houdbare halfvolle melk", "1,5 liter", 149], "per litre, within the tolerance");
});

test("comparable negatives: another kind, a far pack, a variant, a head that is something else, excluded", () => {
  const t = comparableTarget(EGGS, { ...AH_EGGS, name: "AH Eieren" });
  assert.equal(rowComparable(t, "Paaseieren chocolade"), false, "chocolate eggs are a snack");
  assert.equal(rowComparable(t, "Kipfilet met eieren"), false, "chicken with eggs is chicken");
  assert.equal(rowComparable(t, "Dirk Bio scharreleieren"), false, "bio is another product");
  const only30 = matchComparables([t], [["Dirk Eieren 30 stuks", "30 stuks", 549, ""]]);
  assert.equal(only30.size, 0, "three times the pack: nothing");
  const m = comparableTarget(MILK, AH_MILK);
  assert.equal(rowComparable(m, "Dirk Houdbare halfvolle melk lactosevrij"), false);
  assert.equal(rowComparable(m, "Dirk Halfvolle chocolademelk"), false, "chocolate milk is no milk");
  assert.equal(comparableTarget(SPROUTS, AH_SPROUTS), null, "an excluded item never gets one");
  assert.equal(matchComparables([comparableTarget({ id: "x", name: "Groente" }, null)], [["Dirk Spruitjes", "500 g", 129, ""]]).size, 0, "an excluded row is never a comparable");
  // A product without a size never compares to a sized pack it cannot measure against.
  const unsized = comparableTarget(ROLLS, { ...AH_ROLLS, size: "" });
  assert.equal(unsized.size, null);
});

test("comparable: an item without a product of his compares by its name, the cheapest pack", () => {
  const t = comparableTarget(PEPPER, null);
  assert.deepEqual([t.product_id, t.size], ["", null]);
  const got = matchComparables([t], DIRK).get(PEPPER.id);
  assert.deepEqual([got.name, got.cents], ["Dirk Peper", 99]);
});

test("targets: the items he has a product of and the open list lines; the product to compare with", () => {
  const s = emptyState();
  Object.assign(s.items, { [EGGS.id]: EGGS, [MILK.id]: MILK, [PEPPER.id]: PEPPER, "item-none-000001": { id: "item-none-000001", name: "Kaas" } });
  const newer = { ...AH_MILK, id: "p-milk-newer", name: "AH Verse halfvolle melk", updated_at: "2026-10-28" };
  Object.assign(s.products, { [AH_EGGS.id]: AH_EGGS, [AH_MILK.id]: AH_MILK, [newer.id]: newer });
  s.entries["e-pepper"] = { id: "e-pepper", item_id: PEPPER.id, title: "Peper", created_at: "x" };
  s.entries["e-done"] = { id: "e-done", item_id: "item-none-000001", title: "Kaas", checked_at: "x", created_at: "x" };
  assert.deepEqual(comparableTargets(s).map((t) => t.item_id).sort(), [EGGS.id, MILK.id, PEPPER.id].sort(), "not a ticked line's item");
  assert.equal(referenceProduct(s, MILK.id).id, newer.id, "the newest product");
  s.items[MILK.id] = { ...MILK, preferred_product_id: AH_MILK.id };
  assert.equal(referenceProduct(s, MILK.id).id, AH_MILK.id, "the preferred one first");
  s.preferences = { pr: { id: "pr", item_id: MILK.id, store: "", recipe_id: "", product_id: newer.id } };
  assert.equal(referenceProduct(s, MILK.id).id, newer.id, "a preference for any store beats it");
});

// ------------------------------------------------------------------ the op

function priceState() {
  const s = emptyState();
  Object.assign(s.items, { [EGGS.id]: EGGS, [MILK.id]: MILK, [ROLLS.id]: ROLLS, [SPROUTS.id]: SPROUTS, [PEPPER.id]: PEPPER });
  for (const p of [AH_EGGS, AH_MILK, AH_ROLLS, AH_SPROUTS]) s.products[p.id] = { ...p };
  s.entries["e-pepper"] = { id: "e-pepper", item_id: PEPPER.id, title: "Peper", created_at: "x" };
  return s;
}

test("op prices.sync: one comparable row per item and store, none where the store sells his product, none for excluded", () => {
  const s = priceState();
  const r = applyOp(s, { type: "prices.sync", store: "Dirk", day: DAY, rows: DIRK }, ctx);
  assert.equal(r.result.matched, 0);
  const rows = Object.values(s.store_prices);
  assert.deepEqual(rows.map((x) => [x.id, x.item_id, x.comparable, x.price_cents]).sort(), [
    [comparablePriceId("Dirk", EGGS.id), EGGS.id, 1, 239],
    [comparablePriceId("Dirk", MILK.id), MILK.id, 1, 149],
    [comparablePriceId("Dirk", PEPPER.id), PEPPER.id, 1, 99],
  ].sort(), "no sprouts, no rolls (Dirk has none)");
  assert.equal(s.store_prices[comparablePriceId("Dirk", MILK.id)].product_id, AH_MILK.id, "compared with his product");
  assert.equal(r.result.comparable, 3);
  // The same day again writes nothing; his own product appearing at Dirk replaces the comparable.
  assert.equal(applyOp(s, { type: "prices.sync", store: "Dirk", day: DAY, rows: DIRK }, ctx).changed.length, 0);
  const withOwn = [...DIRK, ["AH Scharrel eieren", "10 stuks", 249, ""]];
  const own = { ...AH_EGGS, id: "p-eggs-dirk", name: "Huis Scharrel eieren", brand: "Huis", store: "" };
  s.products[own.id] = own;
  applyOp(s, { type: "prices.sync", store: "Dirk", day: "2026-10-30", rows: [...withOwn, ["Huis Scharrel eieren", "10 stuks", 245, ""]] }, ctx);
  assert.equal(s.store_prices[storePriceId("Dirk", own.id)].price_cents, 245, "his own product's exact price");
  assert.ok(s.store_prices[comparablePriceId("Dirk", EGGS.id)].deleted_at, "the comparable goes: there is an exact price now");
  // pricesOf (the MCP server's exact prices) never shows a comparable row as his product.
  assert.deepEqual(pricesOf(s.store_prices, AH_MILK, TODAY), []);
  // Rows gone from the store: tombstones.
  applyOp(s, { type: "prices.sync", store: "Dirk", day: "2026-10-31", rows: [["Dirk Appels", "1 kg", 199, ""]] }, ctx);
  assert.ok(s.store_prices[comparablePriceId("Dirk", MILK.id)].deleted_at);
});

// ------------------------------------------------------------ on the list

function listView() {
  const s = priceState();
  applyOp(s, { type: "prices.sync", store: "Dirk", day: DAY, rows: DIRK }, ctx);
  applyOp(s, { type: "prices.sync", store: "Albert Heijn", day: DAY, rows: [
    ["AH Scharrel eieren", "10 stuks", 279, "910001"], ["AH Houdbare halfvolle melk", "1 l", 115, "910002"], ["AH Schnittbroodjes", "6 stuks", 189, "910003"],
  ] }, ctx);
  applyOp(s, { type: "prices.sync", store: "Jumbo", day: DAY, rows: [["Jumbo Scharreleieren", "10 stuks", 229, ""], ["Jumbo Peper", "40 g", 89, ""]] }, ctx);
  const entry = (id, item, title, amounts = []) => ({ id, item_id: item.id, title, amounts, created_at: "x" });
  s.entries = {
    "e-eggs": entry("e-eggs", EGGS, "Eieren"),
    "e-milk": entry("e-milk", MILK, "Melk", [{ qty: 3, unit: null }]),
    "e-rolls": entry("e-rolls", ROLLS, "Broodjes"),
    "e-pepper": entry("e-pepper", PEPPER, "Peper"),
    "e-new": { id: "e-new", item_id: "item-new-0000001", title: "Iets nieuws", amounts: [], created_at: "x" },
  };
  return s;
}

test("a line's prices per store: his product's exact price, else the comparable one, marked", () => {
  const v = listView();
  const eggs = linePrices(v, v.entries["e-eggs"], TODAY);
  assert.deepEqual(eggs.map((x) => [x.store, x.cents, x.comparable]), [["Jumbo", 229, true], ["Dirk", 239, true], ["Albert Heijn", 279, false]]);
  assert.deepEqual(linePrices(v, v.entries["e-new"], TODAY), [], "nothing known: nothing");
  assert.deepEqual(linePrices(v, v.entries["e-pepper"], TODAY).map((x) => x.store), ["Jumbo", "Dirk"]);
  // The product screen: the comparable rows compared with this very product.
  assert.deepEqual(productPrices(v, AH_EGGS, TODAY).map((x) => [x.store, x.comparable]), [["Jumbo", true], ["Dirk", true], ["Albert Heijn", false]]);
  assert.deepEqual(productPrices(v, { ...AH_EGGS, id: "p-other-eggs" }, TODAY), [], "another product of the item: not its comparables");
  // Old prices are not shown.
  assert.deepEqual(linePrices(v, v.entries["e-eggs"], "2026-11-20"), []);
});

test("the line's price: the chosen store, else where he buys it, else the cheapest; packs counted", () => {
  const v = listView();
  const prices = (id) => linePrices(v, v.entries[id], TODAY);
  assert.equal(pickLinePrice(v, v.entries["e-eggs"], prices("e-eggs"), { store: "Dirk" }).cents, 239);
  assert.equal(pickLinePrice(v, v.entries["e-rolls"], prices("e-rolls"), { store: "Dirk" }), null, "no price at the chosen store: nothing");
  assert.equal(homeStore(v, v.entries["e-eggs"]), "Albert Heijn", "his product is an AH one");
  assert.equal(pickLinePrice(v, v.entries["e-eggs"], prices("e-eggs")).store, "Albert Heijn", "where he buys it, not the cheapest");
  assert.equal(pickLinePrice(v, v.entries["e-eggs"], prices("e-eggs")).home, true, "his usual store: the line needs no store name");
  assert.deepEqual(["store", "home"].map((k) => pickLinePrice(v, v.entries["e-pepper"], prices("e-pepper"))[k]), ["Jumbo", false], "no product of his: the cheapest, named");
  assert.equal(pickLinePrice(v, v.entries["e-eggs"], prices("e-eggs"), { store: "Dirk" }).home, false);
  const milk = pickLinePrice(v, v.entries["e-milk"], prices("e-milk"));
  assert.deepEqual([milk.store, milk.cents, milk.qty, milk.total], ["Albert Heijn", 115, 3, 345]);
  // A preference for a store beats the product's own store.
  v.preferences.p = { id: "p", item_id: EGGS.id, store: "Jumbo", recipe_id: "", product_id: AH_EGGS.id, updated_at: "x" };
  assert.equal(homeStore({ ...v, preferences: { ...v.preferences } }, v.entries["e-eggs"]), "Jumbo");
});

test("packs: a count of pieces, packs or tins; weights and ranges count once", () => {
  assert.equal(lineQty({ amounts: [{ qty: 3, unit: null }] }), 3);
  assert.equal(lineQty({ amounts: [{ qty: 2, unit: "pack" }] }), 2);
  assert.equal(lineQty({ amounts: [{ qty: 4, unit: "can" }] }), 4);
  assert.equal(lineQty({ amounts: [{ qty: 500, unit: "g" }] }), 1);
  assert.equal(lineQty({ amounts: [{ qty: 2, unit: null, qty_max: 3 }] }), 1);
  assert.equal(lineQty({ amounts: [{ qty: 1.5, unit: null }] }), 1);
  assert.equal(lineQty({ amounts: [{ qty: 2, unit: null }, { qty: 1, unit: null }] }), 1);
  assert.equal(lineQty({ amounts: [{ qty: 100, unit: null }] }), 1, "a hundred is no count of packs");
  assert.equal(lineQty({}), 1);
});

test("subtotal per store: the lines it has a price for, and how many have none", () => {
  const v = listView();
  const entries = Object.values(v.entries);
  const prices = listPrices(v, entries, TODAY);
  assert.deepEqual(storeTotal(entries, prices, "Dirk"), { store: "Dirk", cents: 239 + 3 * 149 + 99, priced: 3, missing: 2 });
  assert.deepEqual(storeTotal(entries, prices, "Albert Heijn"), { store: "Albert Heijn", cents: 279 + 3 * 115 + 189, priced: 3, missing: 2 });
  assert.deepEqual(storeTotal(entries, prices, "Lidl"), { store: "Lidl", cents: 0, priced: 0, missing: 5 });
});

test("no store chosen: the stores compared over the lines they all have a price for", () => {
  const v = listView();
  const entries = Object.values(v.entries);
  const cmp = compareStores(entries, listPrices(v, entries, TODAY));
  // 4 of 5 lines have a price somewhere; AH and Dirk share eggs and milk (half of 4); Jumbo would leave one.
  assert.deepEqual(cmp.stores.map((x) => [x.store, x.cents, x.cheapest]), [["Albert Heijn", 279 + 3 * 115, true], ["Dirk", 239 + 3 * 149, false]]);
  assert.deepEqual([cmp.lines, cmp.of], [2, 5]);
  assert.equal(compareStores([entries[0]], listPrices(v, [entries[0]], TODAY)), null, "one line compares nothing");
  assert.equal(compareStores(entries, new Map()), null, "no prices: no row");
});

// ----------------------------------------------------------------- privacy

test("privacy: a comparable row of a private item is hidden from the others, on the server", async () => {
  const ORIGIN = "http://groceries.localhost:8787";
  const call = (env, method, p, { body, cookie, bearer } = {}) => {
    const headers = { Origin: ORIGIN };
    if (cookie) headers.Cookie = `kd=${cookie}`;
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return worker.fetch(new Request(`${ORIGIN}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  };
  const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
  let n = 0;
  const op = (o) => ({ op_id: `op-pv2-${String(++n).padStart(6, "0")}`, ...o });
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const thomas = tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456", label: "phone" } }));
  const pairCode = async (body, label) => {
    const code = (await (await call(env, "POST", "/api/codes", { cookie: thomas, body })).json()).code;
    return tokenOf(await call(env, "POST", "/api/pair", { body: { code, label } }));
  };
  const sam = await pairCode({ for: "new_member", name: "Sam" }, "sam phone");
  const importer = await pairCode({ for: "importer" }, "Thuisserver AH");
  const send = async (who, ops) => {
    const res = await call(env, "POST", "/api/ops", { ...who, body: { ops } });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(body.results.filter((r) => !r.ok), []);
  };
  await send({ cookie: thomas }, [
    op({ type: "entry.add", id: "entry-pv2-zalf01", item_id: "item-pv2-zalf001", title: "Voetzalf" }),
    op({ type: "entry.add", id: "entry-pv2-peper1", item_id: PEPPER.id, title: "Peper" }),
    op({ type: "item.private", item_id: "item-pv2-zalf001", private: true }),
  ]);
  await send({ bearer: importer }, [op({ type: "prices.sync", store: "Dirk", day: DAY, rows: [...DIRK, ["Huis Voetzalf", "75 ml", 459, ""]] })]);
  const synced = async (cookie) => (await (await call(env, "GET", "/api/sync?since=0", { cookie })).json()).store_prices.map((r) => r.item_id).sort();
  assert.deepEqual(await synced(thomas), [PEPPER.id, "item-pv2-zalf001"].sort(), "the owner sees both");
  assert.deepEqual(await synced(sam), [PEPPER.id], "Sam never sees the private item's price");
  // The rule itself: a row with the item's id is hidden.
  const hidden = hiddenOf([{ k: "i", id: "item-pv2-zalf001", a: "voetzalf" }]);
  assert.ok(rowHidden("store_prices", { id: "spc-dirk-item-pv2-zalf001", item_id: "item-pv2-zalf001", product_id: "", comparable: 1 }, hidden));
});
