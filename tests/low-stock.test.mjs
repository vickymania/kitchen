// "Bijna op" (28-10-2026): the low rule (a quarter pack by default,
// too little for a recipe, ran out through cooking or "op"), the per-item
// threshold (item.low: "rijst: waarschuw onder 300 g", or never), what is on
// the list already, never an excluded thing, and the op on D1 with its usage. The MCP
// tool is tested in tests/mcp.test.mjs.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { hashDevice } from "../worker/auth.js";
import { applyOp, emptyState, OpError } from "../public/shared/ops.js";
import { cookTakes, parseLowAt } from "../public/shared/pantry.js";
import { lowStock, lowByKey, leftOf, underThreshold, LOW_DEFAULT, EMPTY_DAYS } from "../public/shared/low-stock.js";
import { parseIngredient } from "../public/shared/ingredients.js";
import { addDays } from "../public/shared/shelf-life.js";

const DAY = "2026-10-28";
const ctx = (day = DAY) => ({ memberId: "member-thomas-01", isAdmin: true, now: `${day}T10:00:00.000Z` });
let n = 0;
const uid = (kind) => `${kind}-low-${String(++n).padStart(5, "0")}`;

/** A state with pantry rows added through the engine: [title, amount, pack_size, day?]. One item per name. */
function stocked(rows, s = emptyState()) {
  for (const [title, amount, pack_size, on = "2026-10-20"] of rows) {
    applyOp(s, { type: "pantry.add", id: uid("pantry"), item_id: uid("item"), title, amount, pack_size, on }, ctx(on));
  }
  return s;
}
const rowOf = (s, title) => Object.values(s.pantry).find((r) => r.title === title && !r.deleted_at)
  ?? Object.values(s.pantry).find((r) => r.title === title);
const use = (s, title, amount, reason = "used", day = DAY) =>
  applyOp(s, { type: "pantry.use", reason, on: day, takes: [{ event_id: uid("event"), pantry_id: rowOf(s, title).id, amount }] }, ctx(day));
const lows = (s, day = DAY, opts) => Object.fromEntries(lowStock(s, day, opts).map((l) => [l.name, l]));
const setLow = (s, title, patch) => applyOp(s, { type: "item.low", item_id: rowOf(s, title).item_id, ...patch }, ctx());

function cook(s, recipe, day) {
  const takes = cookTakes({ recipe, data: s, today: day });
  applyOp(s, { type: "pantry.use", reason: "cooked", recipe_id: recipe.id, on: day,
    takes: takes.map((t) => ({ event_id: uid("event"), pantry_id: t.pantry_id, amount: t.amount })) }, ctx(day));
}

const NASI = { id: "recipe-nasi-0001", title: "Nasi goreng", servings: 2, ingredients: [parseIngredient("300 g rijst"), parseIngredient("2 el sojasaus")] };
const SOUP = { id: "recipe-soup-0001", title: "Soep", servings: 2, ingredients: [parseIngredient("50 g rijst")] };

// ------------------------------------------------------------ the rule

test("rice: 1 kg, cooked 300 g three times, is low after the third, and too little for the recipe", () => {
  const s = stocked([["Rijst", 1, "1 kg"]]);
  s.recipes[NASI.id] = NASI;
  cook(s, NASI, "2026-10-21");
  assert.deepEqual(lowStock(s, "2026-10-21"), [], "700 g left");
  cook(s, NASI, "2026-10-22");
  assert.deepEqual(lowStock(s, "2026-10-22"), [], "400 g left: more than a quarter, enough for the 300 g");
  cook(s, NASI, "2026-10-23");
  const [rice, ...more] = lowStock(s, "2026-10-23");
  assert.equal(more.length, 0);
  assert.equal(rowOf(s, "Rijst").amount, 0.1);
  assert.deepEqual([rice.name, rice.code, rice.recipe.title, rice.need, rice.left], ["Rijst", "recipe", "Nasi goreng", 0.3, { packs: 0.1, qty: 100, base: "g" }]);
  assert.deepEqual([rice.item_id, rice.title, rice.pack_size], [rowOf(s, "Rijst").item_id, "Rijst", "1 kg"], "the item to put on the list, with its pack");
});

test("too little for a recipe: under 300 g left is low before the quarter is reached", () => {
  const s = stocked([["Rijst", 1, "1 kg"]]);
  Object.assign(s.recipes, { [NASI.id]: NASI, [SOUP.id]: SOUP });
  cook(s, NASI, "2026-10-21");
  cook(s, NASI, "2026-10-22");
  use(s, "Rijst", 0.12, "used", "2026-10-23");
  assert.equal(rowOf(s, "Rijst").amount, 0.28, "280 g: above a quarter pack");
  const [rice] = lowStock(s, "2026-10-23");
  assert.deepEqual([rice.code, rice.recipe.title], ["recipe", "Nasi goreng"], "the recipe cooked with it counts, not the soup that still fits");

  // Never cooked from: low only when no recipe that uses it fits any more.
  const t = stocked([["Rijst", 0.28, "1 kg"]]);
  Object.assign(t.recipes, { [NASI.id]: NASI, [SOUP.id]: SOUP });
  assert.deepEqual(lowStock(t, DAY), [], "the soup still fits");
  delete t.recipes[SOUP.id];
  assert.deepEqual(lowStock(t, DAY).map((l) => [l.code, l.recipe.title]), [["recipe", "Nasi goreng"]]);
  t.recipes[NASI.id] = { ...NASI, deleted_at: "2026-10-27T10:00:00.000Z" };
  assert.deepEqual(lowStock(t, DAY), [], "a deleted recipe needs nothing");
  t.recipes[NASI.id] = { ...NASI, ingredients: [parseIngredient("2 el rijst")] };
  assert.deepEqual(lowStock(t, DAY), [], "spoons need nothing countable");
});

test("the default: under a quarter pack, summed over the rows of one thing", () => {
  const s = stocked([["Kaas", 0.3, "400 g"], ["Melk", 0.2, ""], ["Eieren", 3, ""], ["Ei", 0.1, ""],
    ["Pasta", 0.1, "500 g"], ["Pasta", 0.1, "500 g"], ["Koffie", 0.2, "250 g"], ["Koffie", 0.2, "250 g"]]);
  const got = lows(s);
  assert.equal(LOW_DEFAULT, 0.25);
  assert.equal(got.Kaas, undefined, "0,3 of a cheese");
  assert.deepEqual([got.Melk.code, got.Melk.low_at, got.Melk.left.packs], ["below", null, 0.2]);
  assert.equal(got.Eieren, undefined, "Ei and Eieren are one thing: 3,1 left");
  assert.deepEqual([got.Pasta.code, got.Pasta.left], ["below", { packs: 0.2, qty: 100, base: "g" }], "two rows of 0,1 are 0,2");
  assert.equal(got.Koffie, undefined, "two rows of 0,2 are 0,4");
  assert.deepEqual(leftOf([{ amount: 1, pack_size: "1 kg" }, { amount: 1, pack_size: "" }]), { packs: 2, qty: null, base: null, mixed: true });
});

test("per item: 'waarschuw onder 300 g' against the pack, packs, pieces, and a weight it cannot compare", () => {
  const s = stocked([["Rijst", 0.35, "1 kg"], ["Melk", 0.6, ""], ["Eieren", 3, ""], ["Kaas", 0.2, "400 g"]]);
  s.recipes[NASI.id] = NASI;
  setLow(s, "Rijst", { low_at: "300 g" });
  assert.equal(lows(s).Rijst, undefined, "350 g left");
  use(s, "Rijst", 0.1);
  assert.deepEqual([lows(s).Rijst.code, lows(s).Rijst.low_at], ["below", "300 g"], "250 g left: under 300 g");
  assert.equal(lows(s).Rijst.recipe, null, "his own threshold replaces the default rule");

  setLow(s, "Kaas", { low_at: "50 g" });
  assert.equal(lows(s).Kaas, undefined, "80 g of cheese: under a quarter, but above his 50 g");
  setLow(s, "Melk", { low_at: "0,75" });
  assert.equal(lows(s).Melk.code, "below", "0,6 under 0,75 packs");
  setLow(s, "Eieren", { low_at: "4 st" });
  assert.deepEqual([lows(s).Eieren.code, lows(s).Eieren.low_at], ["below", "4 st"], "3 eggs counted, under 4");
  setLow(s, "Melk", { low_at: "300 ml" });
  assert.deepEqual([lows(s).Melk, underThreshold(leftOf([rowOf(s, "Melk")]), parseLowAt("300 ml"))], [undefined, null],
    "no pack size: millilitres cannot be compared, the quarter-pack default applies");
  setLow(s, "Melk", { low_at: null });
  assert.equal(rowOf(s, "Melk").item_id in s.items && s.items[rowOf(s, "Melk").item_id].low_at, null);
});

test("item.low: a patch, checked, writing only what changed", () => {
  const s = stocked([["Rijst", 1, "1 kg"]]);
  const item = rowOf(s, "Rijst").item_id;
  const c = (o) => applyOp(s, { type: "item.low", item_id: item, ...o }, ctx());
  assert.deepEqual(c({ low_at: "  300   g " }).changed, [["items", item]]);
  assert.equal(s.items[item].low_at, "300 g", "spaces tidied, the text kept as typed");
  assert.equal(c({ low_at: "300 g" }).changed.length, 0, "the same again writes nothing");
  assert.deepEqual(c({ low_off: true }).changed, [["items", item]]);
  assert.deepEqual([s.items[item].low_off, s.items[item].low_at], [1, "300 g"], "stored 0 / 1; the threshold stays for later");
  assert.equal(c({ low_off: 1 }).changed.length, 0);
  for (const bad of ["rijst", "300", "0", "-1 kg", "5-6 g", 300, "x".repeat(21) + " g"]) {
    assert.throws(() => c({ low_at: bad }), (e) => e instanceof OpError && e.code === "bad_field", String(bad));
  }
  assert.throws(() => c({ low_off: "yes" }), (e) => e.code === "bad_field");
  assert.throws(() => c({}), (e) => e.code === "bad_field", "nothing to set");
  assert.throws(() => applyOp(s, { type: "item.low", item_id: "item-nothing-01", low_at: null }, ctx()), (e) => e.code === "not_found");
  for (const ok of ["1,5 kg", "½ pak", "0,5", "2 st", "1 l", "300 gram"]) assert.ok(parseLowAt(ok), ok);
  c({ low_at: null, low_off: false });
  assert.deepEqual([s.items[item].low_at, s.items[item].low_off], [null, 0]);
});

test("low_off: never warned about, also when it runs out", () => {
  const s = stocked([["Zout", 0.1, "1 kg"], ["Peper", 1, ""]]);
  setLow(s, "Zout", { low_off: true });
  setLow(s, "Peper", { low_off: true });
  use(s, "Peper", null);
  assert.deepEqual(lowStock(s, DAY), []);
  setLow(s, "Zout", { low_off: false });
  assert.deepEqual(Object.keys(lows(s)), ["Zout"]);
  // Off on either item of one thing switches it off ("Ei" and "Eieren").
  const t = stocked([["Eieren", 0.1, "10 st"], ["Ei", 0.05, "10 st"]]);
  assert.equal(lows(t).Eieren.code, "below");
  setLow(t, "Ei", { low_off: true });
  assert.deepEqual(lowStock(t, DAY), []);
});

test("on the list already: left out, unless the Voorraad tab asks", () => {
  const s = stocked([["Rijst", 0.1, "1 kg"], ["Melk", 0.1, ""]]);
  applyOp(s, { type: "entry.add", id: "entry-low-rijst", item_id: uid("item"), title: "Rijst" }, ctx());
  applyOp(s, { type: "entry.add", id: "entry-low-melk1", item_id: uid("item"), title: "Melk" }, ctx());
  applyOp(s, { type: "entry.check", id: "entry-low-melk1", checked: true, on: DAY }, ctx());
  delete s.pantry[`pe-entry-low-melk1`];
  assert.deepEqual(Object.keys(lows(s)), ["Melk"], "Rijst is open on the list; Melk is in the cart, not on the list");
  const all = lowByKey(s, DAY);
  assert.deepEqual([all.get("rijst").listed, all.get("melk").listed], [true, false]);
  applyOp(s, { type: "entry.add", id: "entry-low-eier1", item_id: uid("item"), title: "Eieren" }, ctx());
  const t = stocked([["Ei", 0.1, "10 st"]], s);
  assert.equal(lows(t).Eieren, undefined, "a line \"Eieren\" covers the row \"Ei\"");
});

test("ran out: through 'op' or cooking it is low for a week; thrown away or removed it is not", () => {
  const s = stocked([["Mosterd", 1, ""], ["Sla", 1, ""], ["Kipfilet", 1, "500 g"], ["Pindakaas", 1, ""], ["Brood", 1, ""]]);
  use(s, "Mosterd", null, "used", "2026-10-27");
  use(s, "Sla", null, "thrown", "2026-10-27");
  s.recipes["recipe-kip-00001"] = { id: "recipe-kip-00001", title: "Kip", servings: 2, ingredients: [parseIngredient("500 g kipfilet")] };
  cook(s, s.recipes["recipe-kip-00001"], DAY);
  applyOp(s, { type: "pantry.remove", id: rowOf(s, "Pindakaas").id }, ctx());
  use(s, "Brood", 0.5, "used", "2026-10-26");
  use(s, "Brood", null, "thrown", "2026-10-27");
  const got = lows(s);
  // Kipfilet is a recipe-only ingredient: cooked up, it is bought for the next cook, no news.
  assert.deepEqual(Object.keys(got).sort(), ["Mosterd"]);
  assert.deepEqual([got.Mosterd.code, got.Mosterd.on, got.Mosterd.via, got.Mosterd.left.packs], ["empty", "2026-10-27", "used", 0]);
  assert.equal(lowStock(s, DAY)[0].code, "empty", "what ran out comes first");
  assert.deepEqual(Object.keys(lows(s, addDays("2026-10-27", EMPTY_DAYS))), ["Mosterd"]);
  assert.deepEqual(Object.keys(lows(s, addDays("2026-10-27", EMPTY_DAYS + 1))), [], "after a week it is history");
  // With a setting ("waarschuw onder…") a recipe ingredient that ran out does count.
  const kipItem = Object.values(s.items).find((i) => i.name === "Kipfilet").id;
  applyOp(s, { type: "item.low", item_id: kipItem, low_at: "200 g" }, ctx());
  assert.deepEqual([lows(s).Kipfilet?.code, lows(s).Kipfilet?.via], ["empty", "cooked"]);
  applyOp(s, { type: "item.low", item_id: kipItem, low_at: null }, ctx());
  // The undo brings the row back, and with it no "ran out".
  const ev = Object.values(s.pantry_events).find((e) => e.pantry_id === rowOf(s, "Mosterd").id);
  applyOp(s, { type: "pantry.unuse", event_ids: [ev.id] }, ctx());
  assert.equal(lows(s).Mosterd, undefined);
  // Bought again: a live row, the ordinary rule.
  stocked([["Kipfilet", 1, "500 g", DAY]], s);
  assert.equal(lows(s).Kipfilet, undefined);
});

test("emptied rows count as 'op': typed down to zero, or the row's last bit used", () => {
  const s = stocked([["Hagelslag", 1, ""]]);
  use(s, "Hagelslag", 0.75);
  assert.equal(lows(s).Hagelslag, undefined, "0,25 is not under a quarter");
  use(s, "Hagelslag", 0.25);
  assert.ok(rowOf(s, "Hagelslag").deleted_at, "a row at zero is a tombstone");
  assert.equal(lows(s).Hagelslag.code, "empty");
  // A phone forgets tombstones (store.js): the events alone are enough.
  delete s.pantry[rowOf(s, "Hagelslag").id];
  assert.equal(lows(s).Hagelslag.code, "empty");
  assert.equal(lows(s).Hagelslag.title, "Hagelslag");
});

test("never an excluded thing: no row, no event, no recipe makes sprouts or sprouts low", () => {
  const s = stocked([["Rijst", 1, "1 kg"]]);
  s.items["item-low-sprt01"] = { id: "item-low-sprt01", name: "Groene Ster spruitjes", name_key: "groene ster spruitjes", deleted_at: null };
  s.pantry["pantry-low-sprt1"] = { id: "pantry-low-sprt1", item_id: "item-low-sprt01", title: "Groene Ster spruitjes", amount: 0.1, taken: 0, pack_size: "6 st", added_on: "2026-10-20", use_by: null, deleted_at: null };
  s.items["item-low-sprx01"] = { id: "item-low-sprx01", name: "Verse spruitjes", name_key: "verse spruitjes", deleted_at: null };
  s.pantry_events["event-low-sprx1"] = { id: "event-low-sprx1", pantry_id: "pantry-low-gone1", item_id: "item-low-sprx01", reason: "used", amount: 1, happened_on: DAY, deleted_at: null };
  s.recipes["recipe-sprx-0001"] = { id: "recipe-sprx-0001", title: "Stoof", servings: 2, ingredients: [parseIngredient("1 l verse spruitjes"), parseIngredient("1,5 kg rijst")] };
  assert.deepEqual(lowStock(s, DAY, { includeListed: true }).map((l) => l.name), ["Rijst"], "only the rice, too little for the stew");
  assert.throws(() => applyOp(s, { type: "pantry.add", id: "pantry-low-sprt2", item_id: "item-low-sprt02", title: "Groenhof", amount: 1, on: DAY }, ctx()),
    (e) => e.code === "excluded", "and the engine never lets sprouts into the pantry");
});

// --------------------------------------------------------------- on D1

const HOST = "groceries.localhost";
function call(env, method, p, { body, cookie } = {}) {
  const headers = { Origin: `http://${HOST}` };
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`http://${HOST}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
let counter = 0;
const op = (o) => ({ op_id: `op-low-${String(++counter).padStart(6, "0")}`, ...o });
const send = async (env, cookie, ops) => (await (await call(env, "POST", "/api/ops", { cookie, body: { ops } })).json()).results;
const pull = async (env, cookie, since) => (await call(env, "GET", `/api/sync?since=${since}`, { cookie })).json();

test("D1: item.low travels in the delta, writes only the item, and an idle poll reads only the counter", async () => {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const thomas = tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456" } }));
  const added = await send(env, thomas, [op({ type: "pantry.add", id: "pantry-d1-rijst", item_id: "item-d1-rijst-01", title: "Rijst", amount: 0.25, pack_size: "1 kg", on: DAY })]);
  assert.equal(added[0].ok, true);
  const head = await pull(env, thomas, 0);
  assert.deepEqual([head.items[0].low_at, head.items[0].low_off], [null, null], "migration 0012: the columns are there, empty");

  const batches = [];
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = (stmts) => {
    batches.push(stmts.map((x) => x.sql));
    return batch(stmts);
  };
  const set = await send(env, thomas, [op({ type: "item.low", item_id: "item-d1-rijst-01", low_at: "300 g" })]);
  assert.equal(set[0].ok, true, JSON.stringify(set));
  const tables = batches.at(-1).map((sql) => sql.match(/^(?:INSERT INTO|UPDATE) (\w+)/)[1]).sort();
  assert.deepEqual(tables, ["applied_ops", "households", "items"], "rev + the item + applied_ops");
  const delta = await pull(env, thomas, head.rev);
  assert.deepEqual(delta.items.map((i) => [i.id, i.low_at]), [["item-d1-rijst-01", "300 g"]]);
  assert.deepEqual([delta.pantry.length, delta.entries.length, delta.pantry_events.length], [0, 0, 0], "only what changed");
  assert.deepEqual(lowStock({ ...emptyState(), items: Object.fromEntries(delta.items.map((i) => [i.id, i])),
    pantry: Object.fromEntries(head.pantry.map((r) => [r.id, r])) }, DAY).map((l) => [l.name, l.code, l.low_at]), [["Rijst", "below", "300 g"]],
  "the phone's view after the delta: 250 g is under his 300 g");

  // The same setting again: applied_ops only, no rev, nothing new to pull.
  await send(env, thomas, [op({ type: "item.low", item_id: "item-d1-rijst-01", low_at: "300 g" })]);
  assert.deepEqual(batches.at(-1).map((sql) => sql.match(/^(?:INSERT INTO|UPDATE) (\w+)/)[1]), ["applied_ops"]);
  const off = await send(env, thomas, [op({ type: "item.low", item_id: "item-d1-rijst-01", low_off: true })]);
  assert.equal(off[0].ok, true);
  const full = await pull(env, thomas, 0);
  assert.deepEqual([full.items[0].low_at, full.items[0].low_off], ["300 g", 1]);
  const bad = await send(env, thomas, [op({ type: "item.low", item_id: "item-d1-rijst-01", low_at: "veel" })]);
  assert.equal(bad[0].error, "bad_field", "the worker checks it the same way");

  const queries = [];
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    queries.push(sql);
    return prepare(sql);
  };
  const idle = await pull(env, thomas, full.rev);
  assert.deepEqual([idle.items.length, idle.pantry.length], [0, 0]);
  assert.equal(queries.filter((sql) => /FROM (pantry|pantry_events|list_entries|items|recipes)\b/.test(sql)).length, 0,
    "the idle poll touches no data table");
});

test("D1: another household's item is never changed by item.low", async () => {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const thomas = tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456" } }));
  await send(env, thomas, [op({ type: "pantry.add", id: "pantry-own-rijst", item_id: "item-own-rijst-1", title: "Rijst", amount: 1, on: DAY })]);
  const now = new Date().toISOString();
  await env.DB.exec(`INSERT INTO households (id, name, rev, created_at) VALUES ('hh-other-000', 'Buren', 0, '${now}');
    INSERT INTO members (id, household_id, name, is_admin, created_at, rev) VALUES ('member-other-1', 'hh-other-000', 'Buur', 1, '${now}', 0);
    INSERT INTO devices (id, member_id, token_hash, created_at) VALUES ('device-other-1', 'member-other-1', '${await hashDevice("t".repeat(43))}', '${now}');`);
  const res = await send(env, "t".repeat(43), [op({ type: "item.low", item_id: "item-own-rijst-1", low_at: "300 g" })]);
  assert.equal(res[0].error, "not_found", "their phone sees no such item");
  const mine = await pull(env, thomas, 0);
  assert.equal(mine.items[0].low_at, null);
});
