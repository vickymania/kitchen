// The web list grouped per store like the widget, with the basket on top
// (28-10-2026). Pure: public/shared/list-groups.js listLayout,
// orderGroups, basketOpen.
import assert from "node:assert/strict";
import { test } from "node:test";
import { listLayout, orderGroups, basketOpen, BASKET_OPEN_MAX } from "../public/shared/list-groups.js";

const P = {
  milkAh: { id: "p-milk-ah", name: "Halfvolle melk", brand: "AH", store: "Albert Heijn", store_only: 0 },
  milkDirk: { id: "p-milk-dirk", name: "Halfvolle melk", brand: "Dirk", store: "Dirk", store_only: 0 },
  herbs: { id: "p-herbs-lidl", name: "Macaroni kruiden", brand: "Kania", store: "Lidl", store_only: 1 },
  chips: { id: "p-chips", name: "Tortilla chips", brand: "Jumbo", store: "Jumbo", store_only: 0 },
};
const pref = (id, item_id, store, product_id) => ({ id, item_id, store, recipe_id: "", product_id, updated_at: "2026-10-28T10:00:00Z", deleted_at: null });
const data = {
  products: Object.fromEntries(Object.values(P).map((p) => [p.id, { ...p, deleted_at: null }])),
  preferences: {
    a: pref("a", "milk", "Albert Heijn", P.milkAh.id),
    b: pref("b", "milk", "Dirk", P.milkDirk.id),
    c: pref("c", "herbs", "Lidl", P.herbs.id),
    d: pref("d", "chips", "", P.chips.id),
  },
  recipes: {},
};
const entry = (id, item_id, created_at, checked_at = null) => ({ id, title: id, item_id, sources: [], created_at, checked_at });
const entries = [
  entry("melk", "milk", "2026-10-28T09:00:00Z"),
  entry("kruiden", "herbs", "2026-10-28T08:00:00Z"),
  entry("chips", "chips", "2026-10-28T07:00:00Z"),
  entry("uien", "onions", "2026-10-28T06:00:00Z"),
  entry("brood", null, "2026-10-28T05:00:00Z", "2026-10-28T10:00:00Z"),
  entry("kaas", null, "2026-10-28T04:00:00Z", "2026-10-28T11:00:00Z"),
];
const shape = (layout) => layout.map((s) => s.kind === "basket"
  ? ["basket", s.lines.map((l) => l.entry.id)]
  : [s.store, s.away, s.lines.map((l) => l.entry.id)]);

test("web list: the basket first, last ticked on top; no store chosen, groups as the widget", () => {
  assert.deepEqual(shape(listLayout(data, entries)), [
    ["basket", ["kaas", "brood"]],
    ["Albert Heijn", false, ["melk"]],
    ["Jumbo", false, ["chips"]],
    ["Lidl", false, ["kruiden"]],
    [null, false, ["uien"]],
  ]);
});

test("web list: with a store chosen its group comes first with its own product, then Overal, the rest are 'Andere winkel'", () => {
  const layout = listLayout(data, entries, "dirk");
  assert.deepEqual(shape(layout), [
    ["basket", ["kaas", "brood"]],
    ["Dirk", false, ["melk"]],
    [null, false, ["uien"]],
    ["Jumbo", true, ["chips"]],
    ["Lidl", true, ["kruiden"]],
  ]);
  assert.equal(layout[1].lines[0].resolved.product.id, P.milkDirk.id, "the product for the chosen store");
  assert.equal(layout.at(-1).lines[0].resolved.onlyAt, "Lidl", "store_only stays at its own store");
});

test("web list: at the store_only product's own store it is not 'away'", () => {
  const layout = listLayout(data, entries, "Lidl");
  assert.deepEqual(layout[1].store, "Lidl");
  assert.equal(layout[1].away, false);
});

test("web list: nothing ticked, no basket; nothing at all, nothing", () => {
  assert.equal(listLayout(data, entries.filter((e) => !e.checked_at))[0].kind, "store");
  assert.deepEqual(listLayout(data, []), []);
});

test("web list: orderGroups puts the chosen store first and Overal right after it", () => {
  const groups = [["Albert Heijn", []], ["Dirk", []], ["Lidl", []], [null, []]];
  assert.deepEqual(orderGroups(groups, "Lidl").map(([s]) => s), ["Lidl", null, "Albert Heijn", "Dirk"]);
  assert.deepEqual(orderGroups(groups, "AH").map(([s]) => s), ["Albert Heijn", null, "Dirk", "Lidl"]);
  assert.deepEqual(orderGroups([[null, []], ["Lidl", []], ["Albert Heijn", []]]).map(([s]) => s), ["Albert Heijn", "Lidl", null]);
});

test("web list: the basket starts open while short, folded when long, and the person's choice wins", () => {
  assert.equal(basketOpen(1), true);
  assert.equal(basketOpen(BASKET_OPEN_MAX), true);
  assert.equal(basketOpen(BASKET_OPEN_MAX + 1), false);
  assert.equal(basketOpen(20, true), true);
  assert.equal(basketOpen(1, false), false);
});
