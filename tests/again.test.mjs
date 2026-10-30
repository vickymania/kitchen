// "Weer nodig" without recipe ingredients (28-10-2026), the per-item
// override (item.again, synced), and the cook deduction that goes with it:
// the nachos lasagne against a pantry of Chips, Tortillachips, Uien, Rode ui,
// Bosui and Puntpaprika.
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { applyOp, emptyState, OpError } from "../public/shared/ops.js";
import { BASICS, isBasic, isHidden, recipeIngredientKeys } from "../public/shared/again-scope.js";
import { dueItems } from "../public/shared/intervals.js";
import { cookTakes, sameStuff } from "../public/shared/pantry.js";
import { parseIngredient, nameKey } from "../public/shared/ingredients.js";

// ------------------------------------------------------------------ scope

test("basics: oils, butter, sauces and condiments stay, ingredients like cheese do not", () => {
  for (const name of ["Olijfolie", "Roomboter", "Ketchup", "Sojasaus", "Pastasaus", "Pindakaas", "Zout", "Bloem", "Honing", "Mayonaise", "Sambal"]) {
    assert.equal(isBasic(name), true, name);
  }
  for (const name of ["Kaas", "Uien", "Focaccia", "Tortillachips", "Kipfilet", "Melk", "Pasta"]) assert.equal(isBasic(name), false, name);
  assert.ok(BASICS.has("olie") && BASICS.has("boter") && BASICS.has("saus"));
});

const recipes = {
  r1: { id: "r1", ingredients: [{ name: "focaccia" }, { name: "geraspte kaas" }, { name: "olijfolie" }, { name: "Sauzen", heading: true }, { name: "boter" }] },
  r2: { id: "r2", deleted_at: "2026-10-01", ingredients: [{ name: "wc papier" }] },
};

function history(names, extra = {}) {
  const items = {};
  const purchases = {};
  let n = 0;
  for (const name of names) {
    const id = `item-${name.toLowerCase().replace(/\W+/g, "-")}`;
    items[id] = { id, name, name_key: nameKey(name), ...(extra[name] ?? {}) };
    for (const d of ["2026-09-30", "2026-10-07", "2026-10-14"]) purchases[`p${++n}`] = { id: `p${n}`, item_id: id, title: name, bought_on: d };
  }
  return { items, purchases, entries: {}, recipes };
}

test("again scope: recipe ingredients are hidden, basics and the rest stay", () => {
  const view = history(["Focaccia", "Kaas", "Olijfolie", "Boter", "Toiletpapier", "Wc papier", "Cola"]);
  const all = dueItems(view, "2026-10-28");
  const hidden = Object.fromEntries(all.map((d) => [d.name, d.hidden]));
  assert.deepEqual(hidden, { Focaccia: true, Kaas: true, Olijfolie: false, Roomboter: false, Toiletpapier: false, "Wc papier": false, Cola: false },
    "a deleted recipe has no say (wc papier); Boter is Roomboter");
  assert.deepEqual(dueItems(view, "2026-10-28", { visibleOnly: true }).map((d) => d.name).sort(),
    ["Cola", "Olijfolie", "Roomboter", "Toiletpapier", "Wc papier"]);
  assert.equal(all.length, 7, "the full list (deals, aanbevolen) still has everything");
});

test("again scope: the override beats the rule both ways", () => {
  const view = history(["Focaccia", "Kaas", "Cola"], { Focaccia: { again: "hide" }, Kaas: { again: "show" }, Cola: { again: "hide" } });
  const by = Object.fromEntries(dueItems(view, "2026-10-28").map((d) => [d.name, d.hidden]));
  assert.deepEqual(by, { Focaccia: true, Kaas: false, Cola: true }, "show keeps a recipe ingredient, hide hides any");
  assert.equal(isHidden({ again: null, key: "kaas", name: "Kaas", ingredientKeys: recipeIngredientKeys(recipes) }), true);
});

test("again scope: item.again sets, clears and refuses", () => {
  const s = emptyState();
  s.items["item-focaccia"] = { id: "item-focaccia", name: "Focaccia", name_key: "focaccia", deleted_at: null };
  const c = () => ({ memberId: "member-thomas-01", isAdmin: true, now: "2026-10-28T10:00:00.000Z" });
  const out = applyOp(s, { type: "item.again", item_id: "item-focaccia", again: "hide" }, c());
  assert.equal(s.items["item-focaccia"].again, "hide");
  assert.deepEqual(out.changed, [["items", "item-focaccia"]]);
  assert.equal(applyOp(s, { type: "item.again", item_id: "item-focaccia", again: "hide" }, c()).changed.length, 0, "no change, no write");
  applyOp(s, { type: "item.again", item_id: "item-focaccia", again: null }, c());
  assert.equal(s.items["item-focaccia"].again, null);
  assert.throws(() => applyOp(s, { type: "item.again", item_id: "item-focaccia", again: "maybe" }, c()), (e) => e instanceof OpError && e.code === "bad_field");
  assert.throws(() => applyOp(s, { type: "item.again", item_id: "item-nothing-1", again: "hide" }, c()), (e) => e.code === "not_found");
});

test("again scope: the override travels through D1 and the delta sync", async () => {
  const HOST = "groceries.localhost:8787";
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const call = (method, p, { body, cookie } = {}) => worker.fetch(new Request(`http://${HOST}${p}`, {
    method,
    headers: { Origin: `http://${HOST}`, ...(cookie ? { Cookie: `kd=${cookie}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  const cookie = (await call("POST", "/api/pair", { body: { code: "123456" } })).headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
  const send = async (ops) => (await (await call("POST", "/api/ops", { cookie, body: { ops } })).json()).results;
  const add = await send([{ op_id: "op-again-000001", type: "entry.add", id: "entry-focac-01", item_id: "item-focaccia-1", title: "Focaccia" }]);
  assert.equal(add[0].ok, true);
  const head = (await (await call("GET", "/api/sync?since=0", { cookie })).json()).rev;
  const hide = await send([{ op_id: "op-again-000002", type: "item.again", item_id: "item-focaccia-1", again: "hide" }]);
  assert.equal(hide[0].ok, true);
  const delta = await (await call("GET", `/api/sync?since=${head}`, { cookie })).json();
  assert.deepEqual(delta.items.map((i) => [i.id, i.again]), [["item-focaccia-1", "hide"]]);
  const full = await (await call("GET", "/api/sync?since=0", { cookie })).json();
  assert.equal(full.items.find((i) => i.id === "item-focaccia-1").again, "hide");
  const bad = await send([{ op_id: "op-again-000003", type: "item.again", item_id: "item-focaccia-1", again: "x" }]);
  assert.equal(bad[0].error, "bad_field");
});

// --------------------------------------------------------------- cooking

const pantryOf = (rows) => Object.fromEntries(rows.map((r, i) => [r.id, { item_id: `item-${i}`, taken: 0, pack_size: "", added_on: "2026-10-26", use_by: null, deleted_at: null, amount: 1, ...r }]));

const NACHOS = {
  id: "recipe-nachos-01",
  ingredients: ["1 pak nacho of tortilla chips", "1 rode ui", "2 lente-uien", "1 rode paprika"].map((l) => parseIngredient(l)),
};

function takesFor(rows, recipe = NACHOS) {
  const data = { pantry: pantryOf(rows), items: {}, pantry_events: {} };
  return Object.fromEntries(cookTakes({ recipe, data, today: "2026-10-28" }).map((t) => [t.pantry_id, t.amount]));
}

const PANTRY = [
  { id: "p-chips", title: "Chips" },
  { id: "p-tortilla", title: "Tortillachips" },
  { id: "p-uien", title: "Uien", amount: 3 },
  { id: "p-rodeui", title: "Rode ui", amount: 2 },
  { id: "p-bosui", title: "Bosui" },
  { id: "p-puntpaprika", title: "Puntpaprika" },
];

test("cooking: the nachos lasagne takes Tortillachips, Rode ui, Bosui and Puntpaprika, never Chips or yellow Uien", () => {
  const takes = takesFor(PANTRY);
  assert.equal(takes["p-chips"], undefined, "tortilla chips never take plain Chips");
  assert.equal(takes["p-tortilla"], 1);
  assert.equal(takes["p-uien"], undefined, "rode ui never takes the yellow Uien");
  assert.equal(takes["p-rodeui"], 1, "the red onion is used, one piece");
  assert.ok(takes["p-bosui"] > 0, "lente-uien is Bosui");
  assert.ok(takes["p-puntpaprika"] > 0, "rode paprika takes a Puntpaprika");
});

test("cooking: without the specific row, nothing is taken from a less specific one", () => {
  const takes = takesFor(PANTRY.filter((r) => !["p-tortilla", "p-rodeui"].includes(r.id)));
  assert.equal(takes["p-chips"], undefined, "no Tortillachips in the house: Chips stays");
  assert.equal(takes["p-uien"], undefined, "no red onion in the house: the yellow ones stay");
});

test("cooking: plain ui takes Uien, and the explicit synonyms agree", () => {
  const takes = takesFor(PANTRY, { id: "recipe-ui-000001", ingredients: [parseIngredient("2 uien")] });
  assert.equal(takes["p-uien"], 2, "an ingredient without a colour takes the row without one first");
  assert.equal(takes["p-rodeui"], undefined);
  for (const [ingredient, row] of [["lenteui", "bosui"], ["lente ui", "bosui"], ["bosui", "bosui"], ["paprika", "puntpaprika"], ["rode paprika", "puntpaprika"],
    ["nacho chips", "tortillachips"], ["tortilla chips", "tortillachips"], ["rode ui", "rode ui"], ["ui", "rode ui"]]) {
    assert.equal(sameStuff(ingredient, row), true, `${ingredient} = ${row}`);
  }
  for (const [ingredient, row] of [["tortilla chips", "chips"], ["nacho chips", "chips"], ["rode ui", "uien"], ["gele ui", "rode ui"], ["witte ui", "rode ui"]]) {
    assert.equal(sameStuff(ingredient, row), false, `${ingredient} != ${row}`);
  }
});
