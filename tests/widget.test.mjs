// The Android widget 1.2 (28-10-2026): the open lines per store, each
// with its details, from GET /api/widget. The grouping is pure
// (public/shared/list-groups.js); the route is tested on the real worker.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { amsterdamDay } from "../worker/offers.js";
import { groupByStore, lineStore, compareStores } from "../public/shared/list-groups.js";

const HOST = "groceries.localhost:8787";

function call(env, method, path, { body, bearer } = {}) {
  const headers = {};
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`http://${HOST}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
}
const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
let n = 0;
const op = (o) => ({ op_id: `op-widget-${String(++n).padStart(6, "0")}`, ...o });
const day = (offset) => amsterdamDay(new Date(Date.now() + offset * 86400_000));

// ------------------------------------------------------------ the grouping

test("groups: AH, Dirk, the other stores A to Z, anywhere last; lines keep their order", () => {
  const lines = [
    { t: "uien", s: null }, { t: "kruiden", s: "Lidl" }, { t: "melk", s: "AH" },
    { t: "chips", s: "Dirk" }, { t: "kaas", s: "Albert Heijn" }, { t: "brood", s: "Jumbo" },
  ];
  const groups = groupByStore(lines, (l) => l.s);
  assert.deepEqual(groups.map(([s, ls]) => [s, ls.map((l) => l.t)]), [
    ["Albert Heijn", ["melk", "kaas"]], ["Dirk", ["chips"]], ["Jumbo", ["brood"]], ["Lidl", ["kruiden"]], [null, ["uien"]],
  ]);
  assert.ok(compareStores("ALDI", "Lidl") < 0);
  assert.deepEqual(groupByStore([], (l) => l), []);
});

test("groups: a line's store is store_only first, then the chosen store, then its preference's or product's store", () => {
  const lidlOnly = { onlyAt: "Lidl", why: { store: null }, product: { store: "Lidl" } };
  const atDirk = { onlyAt: null, why: { store: "Dirk" }, product: { store: "Albert Heijn" } };
  const lastAtAh = { onlyAt: null, why: { store: null }, product: { store: "AH" } };
  assert.equal(lineStore(lidlOnly, "Dirk"), "Lidl", "store_only beats the choice");
  assert.equal(lineStore(atDirk, "ah"), "Albert Heijn", "the choice beats the preference");
  assert.equal(lineStore(atDirk), "Dirk", "the preference's own store");
  assert.equal(lineStore(lastAtAh), "Albert Heijn", "where the product was bought");
  assert.equal(lineStore(null), null, "no product: anywhere");
  assert.equal(lineStore({ onlyAt: null, why: { store: null }, product: { store: "" } }), null);
});

// ---------------------------------------------------------------- the route

async function household() {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  // The pairing route is open and checks same origin, like a browser sends.
  const thomas = tokenOf(await worker.fetch(new Request(`http://${HOST}/api/pair`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: `http://${HOST}` }, body: JSON.stringify({ code: "123456", label: "widget" }),
  }), env));
  assert.ok(thomas);
  const send = async (ops) => {
    const out = await (await call(env, "POST", "/api/ops", { bearer: thomas, body: { ops } })).json();
    assert.deepEqual(out.results.filter((r) => !r.ok), []);
  };
  await send([
    op({ type: "recipe.put", id: "recipe-widget-01", recipe: { title: "Pastapotje", servings: 2, ingredients: [], steps: [] } }),
    op({ type: "entry.add", id: "entry-widget-melk", item_id: "item-widget-melk", title: "Melk", amounts: [{ qty: 2, unit: "pack" }], note: "halfvol" }),
    op({ type: "entry.add", id: "entry-widget-krui", item_id: "item-widget-krui", title: "Macaronikruiden",
      source: { recipe_id: "recipe-widget-01", title: "Pastapotje" } }),
    op({ type: "entry.add", id: "entry-widget-uien", item_id: "item-widget-uien", title: "Uien" }),
    op({ type: "entry.add", id: "entry-widget-sprt", item_id: "item-widget-sprt", title: "Spruitjes" }),
    op({ type: "entry.add", id: "entry-widget-done", item_id: "item-widget-done", title: "Kaas" }),
    op({ type: "entry.check", id: "entry-widget-done", checked: true }),
    op({ type: "product.put", id: "product-widget-melk", product: { name: "Halfvolle melk", brand: "AH", size: "1 l", store: "AH", last_price_cents: 119, item_id: "item-widget-melk" } }),
    op({ type: "product.put", id: "product-widget-krui", product: { name: "Macaroni kruiden", brand: "Kania", size: "40 g", store: "Lidl", store_only: true, item_id: "item-widget-krui" } }),
    op({ type: "preference.set", id: "pref-widget-melk01", item_id: "item-widget-melk", product_id: "product-widget-melk" }),
    op({ type: "preference.set", id: "pref-widget-krui01", item_id: "item-widget-krui", recipe_id: "recipe-widget-01", store: "Lidl", product_id: "product-widget-krui" }),
  ]);
  // Offers as the sync route stores them; an excluded one written straight in
  // to prove the route filters on its own as well.
  const offer = (id, o) => env.DB.prepare(`INSERT INTO offers (id, household_id, store, name, brand, size, deal, price_cents, valid_from, valid_until, category, created_at, updated_at, deleted_at, rev)
    VALUES (?, (SELECT id FROM households LIMIT 1), ?, ?, ?, NULL, ?, ?, ?, ?, NULL, 'x', 'x', NULL, 1)`)
    .bind(id, o.store, o.name, o.brand ?? null, o.deal, o.price_cents, day(-1), o.until ?? day(4)).run();
  await offer("of-widget-melk", { store: "Albert Heijn", name: "Halfvolle melk", brand: "AH", deal: "2e halve prijs", price_cents: 119 });
  await offer("of-widget-uien", { store: "Dirk", name: "Uien", deal: "1+1 gratis", price_cents: 99 });
  await offer("of-widget-uiej", { store: "Jumbo", name: "Uien", deal: "-50%", price_cents: 60, until: day(1) });
  await offer("of-widget-sprt", { store: "Albert Heijn", name: "Spruitjes", brand: "Groene Ster", deal: "1+1 gratis", price_cents: 899 });
  await offer("of-widget-old", { store: "Dirk", name: "Halfvolle melk", deal: "-10%", price_cents: 99, until: day(-1) });
  return { env, thomas };
}

test("widget route: open lines per store with amount, note, recipes, product, store_only and the offer", async () => {
  const { env, thomas } = await household();
  const res = await call(env, "GET", "/api/widget", { bearer: thomas });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.count, 4, "the checked line is not there");
  assert.ok(body.rev > 0);
  assert.deepEqual(body.groups.map((g) => g.store), ["Albert Heijn", "Lidl", null]);
  const line = (title) => body.groups.flatMap((g) => g.lines).find((l) => l.title === title);

  assert.deepEqual(line("Melk"), {
    id: "entry-widget-melk", title: "Melk", amounts: [{ qty: 2, unit: "pack" }], note: "halfvol", recipes: [],
    product: { name: "Halfvolle melk", brand: "AH", size: "1 l", store: "Albert Heijn", store_only: false, last_price_cents: 119, for_recipe: null },
    only_at: null,
    offer: { store: "Albert Heijn", name: "AH Halfvolle melk", deal: "2e halve prijs", price_cents: 119, until: day(4), mine: true },
  });
  const herbs = line("Macaronikruiden");
  assert.equal(herbs.only_at, "Lidl");
  assert.deepEqual(herbs.recipes, ["Pastapotje"]);
  assert.equal(herbs.product.for_recipe, "Pastapotje");
  assert.equal(herbs.product.store_only, true);
  // No product: anywhere, with the line's name on offer at Dirk (not the Jumbo one, which ends sooner).
  const onions = line("Uien");
  assert.equal(onions.product, null);
  assert.deepEqual([onions.offer.store, onions.offer.deal, onions.offer.mine], ["Dirk", "1+1 gratis", false]);
  assert.deepEqual(body.groups.at(-1).lines.map((l) => l.title).sort(), ["Spruitjes", "Uien"]);
});

test("widget route: never an excluded offer, also when one is stored", async () => {
  const { env, thomas } = await household();
  const body = await (await call(env, "GET", "/api/widget", { bearer: thomas })).json();
  const text = JSON.stringify(body);
  assert.equal(line(body, "Spruitjes").offer, null);
  assert.ok(!/Groene Ster/.test(text), "the sprouts offer is nowhere in the payload");

  function line(b, title) {
    return b.groups.flatMap((g) => g.lines).find((l) => l.title === title);
  }
});

test("widget route: a paired device only, and only the rows the open lines need", async () => {
  const { env, thomas } = await household();
  assert.equal((await call(env, "GET", "/api/widget")).status, 401);
  const queries = [];
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    queries.push(sql);
    return prepare(sql);
  };
  await call(env, "GET", "/api/widget", { bearer: thomas });
  const reads = queries.filter((sql) => /FROM (list_entries|preferences|products|purchases|offers|recipes|items)\b/.test(sql));
  // "Binnenkort nodig" (1.4): the items the pantry, its events and the open lines name, and the live recipes' ingredients only.
  const own = reads.filter((sql) => /^SELECT .* FROM (recipes|items)\b/s.test(sql));
  assert.equal(own.length, 2);
  assert.ok(own.some((sql) => /^SELECT id, title, servings, ingredients FROM recipes WHERE .*deleted_at IS NULL/s.test(sql)), "recipes: four columns, live ones");
  assert.ok(own.some((sql) => /^SELECT \* FROM items WHERE .*id IN \(SELECT item_id FROM pantry WHERE/s.test(sql)), "items: only the ones named");
  assert.equal(queries.filter((sql) => /^SELECT \* FROM (list_entries|preferences|products|offers)/.test(sql)).length, 4);
});

test("widget route: ?since=<rev> with nothing new reads only the household counter", async () => {
  const { env, thomas } = await household();
  const { rev } = await (await call(env, "GET", "/api/widget", { bearer: thomas })).json();
  const queries = [];
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    queries.push(sql);
    return prepare(sql);
  };
  const idle = await (await call(env, "GET", `/api/widget?since=${rev}`, { bearer: thomas })).json();
  assert.deepEqual(idle, { rev, unchanged: true });
  assert.equal(queries.filter((sql) => /FROM (list_entries|preferences|products|purchases|offers)/.test(sql)).length, 0);
  env.DB.prepare = prepare;
  await call(env, "POST", "/api/quick-add", { bearer: thomas, body: { text: "2 ui", op_id: "quick-widget-0001" } });
  const after = await (await call(env, "GET", `/api/widget?since=${rev}`, { bearer: thomas })).json();
  assert.ok(after.rev > rev);
  assert.equal(after.count, 5, "a change: the whole (small) list again");
});
