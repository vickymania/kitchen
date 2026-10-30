// Things used at a steady rate (28-10-2026): the cat's pouches (6 a
// week), the cat's tuna (1 a week), the fountain filters (1 a month), and
// household goods by a default table. The countdown is computed on read
// (withUsage in public/shared/pantry.js), never written daily; a correction,
// an "op" or cooking settles it. The MCP tools are tested in tests/mcp.test.mjs.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { applyOp, emptyState } from "../public/shared/ops.js";
import { withUsage, drainRows, currentAmount, rowRate, cookTakes, supplyDays, liveRows, RATE_WARN_DAYS } from "../public/shared/pantry.js";
import { ruleRate, rateRule, piecesIn, RATES } from "../public/shared/usage-rates.js";
import { lowStock } from "../public/shared/low-stock.js";
import { lowReason } from "../public/shared/deals.js";
import { dueItems } from "../public/shared/intervals.js";
import { parseIngredient } from "../public/shared/ingredients.js";
import { addDays } from "../public/shared/shelf-life.js";

const DAY = "2026-10-28";
const ctx = (day = DAY) => ({ memberId: "member-thomas-01", isAdmin: true, now: `${day}T10:00:00.000Z` });
let n = 0;
const uid = (kind) => `${kind}-rate-${String(++n).padStart(5, "0")}`;
const at = (d) => addDays(DAY, d);

/** A state with one item and one pantry row, the item's rate set by a person. */
function cat({ title = "Minoes eten", amount = 33, perDay = 6 / 7, on = DAY, s = emptyState() } = {}) {
  const itemId = uid("item");
  const pantryId = uid("pantry");
  applyOp(s, { type: "pantry.add", id: pantryId, item_id: itemId, title, amount, on }, ctx(on));
  if (perDay !== null) applyOp(s, { type: "item.rate", item_id: itemId, use_per_day: perDay, source: "person", on }, ctx(on));
  return { s, itemId, pantryId };
}
const left = (s, id, day) => withUsage(s, day).pantry[id].amount;

// ------------------------------------------------------------ the countdown

test("the cat food: 33 pouches at 6 a week, 27 after a week, warned under a week of supply, op on the day it runs out", () => {
  const { s, pantryId, itemId } = cat();
  assert.equal(s.items[itemId].use_per_day, 6 / 7, "stored per day as sent");
  assert.equal(left(s, pantryId, DAY), 33);
  assert.equal(left(s, pantryId, at(7)), 27);
  assert.equal(s.pantry[pantryId].amount, 33, "nothing written: the stored amount stays");
  const today = withUsage(s, DAY).pantry[pantryId];
  assert.equal(Math.round(today.days_left * 10) / 10, 38.5, "33 / (6/7)");
  assert.equal(today.rate_source, "person");

  assert.deepEqual(lowStock(s, at(31)), [], "day 31: 6,4 pouches, 7,5 days: not yet");
  const [low] = lowStock(s, at(32));
  assert.deepEqual([low.name, low.code, low.left.packs, Math.floor(low.days_left)], ["Minoes eten", "below", 5.57, 6]);
  assert.ok(low.days_left < RATE_WARN_DAYS);
  // Ran out on day 39 (38,5 days): "op" for a week, then history.
  const gone = lowStock(s, at(40));
  assert.deepEqual(gone.map((l) => [l.code, l.on, l.via]), [["empty", at(39), "used"]]);
  assert.deepEqual(lowStock(s, at(39 + 8)), []);
  assert.deepEqual(liveRows(withUsage(s, at(40)).pantry), [], "nothing left in the house");
});

test("the cat's tuna: 1 tin a week", () => {
  const { s, pantryId } = cat({ title: "Minoestuna", amount: 4, perDay: 1 / 7 });
  assert.deepEqual([0, 7, 14, 21, 27, 28].map((d) => left(s, pantryId, at(d))), [4, 3, 2, 1, 0.14, 0]);
});

test("the fountain filters: 12 at 30 days each last 360 days", () => {
  const { s, pantryId } = cat({ title: "Waterfilter kattenfontein", amount: 12, perDay: 1 / 30 });
  assert.equal(left(s, pantryId, at(30)), 11);
  assert.equal(left(s, pantryId, at(345)), 0.5);
  assert.equal(Math.round(withUsage(s, DAY).pantry[pantryId].days_left), 360);
  assert.equal(left(s, pantryId, at(360)), 0);
});

test("a correction is the new anchor: amount and day", () => {
  const { s, pantryId } = cat();
  assert.equal(left(s, pantryId, at(7)), 27);
  // He counts 30 on day 7.
  applyOp(s, { type: "pantry.update", id: pantryId, amount: 30, on: at(7) }, ctx(at(7)));
  assert.deepEqual([s.pantry[pantryId].amount, s.pantry[pantryId].amount_on], [30, at(7)]);
  assert.equal(left(s, pantryId, at(7)), 30);
  assert.equal(left(s, pantryId, at(14)), 24);
  // Without `on` the server's day counts.
  applyOp(s, { type: "pantry.update", id: pantryId, amount: 20 }, ctx(at(21)));
  assert.equal(s.pantry[pantryId].amount_on, at(21));
});

test("several rows of one item drain oldest first, and a correction of one keeps what the others showed", () => {
  const s = emptyState();
  applyOp(s, { type: "pantry.add", id: "pantry-rate-old01", item_id: "item-rate-tuna01", title: "Minoestuna", amount: 2, on: DAY }, ctx());
  applyOp(s, { type: "item.rate", item_id: "item-rate-tuna01", use_per_day: 1, source: "person", on: DAY }, ctx());
  applyOp(s, { type: "pantry.add", id: "pantry-rate-new01", item_id: "item-rate-tuna01", title: "Minoestuna", amount: 3, on: at(1) }, ctx(at(1)));
  const day = (d) => [left(s, "pantry-rate-old01", at(d)), left(s, "pantry-rate-new01", at(d))];
  assert.deepEqual(day(1), [1, 3], "the new row waits until the old one is empty");
  assert.deepEqual(day(2), [0, 3]);
  assert.deepEqual(day(4), [0, 1]);
  assert.deepEqual(day(6), [0, 0]);
  const v = withUsage(s, at(1)).pantry;
  assert.deepEqual([v["pantry-rate-old01"].days_left, v["pantry-rate-new01"].days_left], [1, 4], "days left count the older row first");
  assert.equal(supplyDays(Object.values(v)), 4);

  // Gaps: an empty pantry uses nothing; the next row starts on its own day.
  const g = emptyState();
  applyOp(g, { type: "pantry.add", id: "pantry-rate-gap01", item_id: "item-rate-gap001", title: "Minoestuna", amount: 1, on: DAY }, ctx());
  applyOp(g, { type: "item.rate", item_id: "item-rate-gap001", use_per_day: 1, source: "person", on: DAY }, ctx());
  applyOp(g, { type: "pantry.add", id: "pantry-rate-gap02", item_id: "item-rate-gap001", title: "Minoestuna", amount: 3, on: at(5) }, ctx(at(5)));
  assert.equal(left(g, "pantry-rate-gap02", at(6)), 2);

  // An older row whose amount was set later still goes first once it is there.
  const rows = [
    { id: "pantry-rate-ord-a", item_id: "x", title: "Minoestuna", amount: 4, added_on: DAY, amount_on: at(5), pack_size: "" },
    { id: "pantry-rate-ord-b", item_id: "x", title: "Minoestuna", amount: 3, added_on: at(3), amount_on: null, pack_size: "" },
  ];
  const drained = drainRows(rows, { use_per_day: 1 }, at(6));
  assert.deepEqual([drained.get("pantry-rate-ord-a").amount, drained.get("pantry-rate-ord-b").amount], [3, 1]);

  // He corrects the old row on day 1 (it said 1, there are 2): the new one keeps its 3.
  applyOp(s, { type: "pantry.update", id: "pantry-rate-old01", amount: 2, on: at(1) }, ctx(at(1)));
  assert.deepEqual([s.pantry["pantry-rate-new01"].amount, s.pantry["pantry-rate-new01"].added_on], [3, at(1)], "untouched: it was true that day already");
  assert.deepEqual(day(1), [2, 3]);
  assert.deepEqual(day(3), [0, 3]);
  assert.deepEqual(day(4), [0, 2]);
});

test("cooking takes from what is left today, and the countdown goes on from there", () => {
  const { s, pantryId } = cat({ title: "Tonijn in blik", amount: 4, perDay: 1 / 7 });
  const recipe = { id: "recipe-rate-tuna1", title: "Tonijnsalade", servings: 2, ingredients: [parseIngredient("2 blikken tonijn")] };
  s.recipes[recipe.id] = recipe;
  const takes = cookTakes({ recipe, data: s, today: at(7) });
  assert.deepEqual(takes.map((t) => [t.pantry_id, t.amount]), [[pantryId, 2]], "2 of the 3 left on day 7");
  applyOp(s, { type: "pantry.use", reason: "cooked", recipe_id: recipe.id, on: at(7),
    takes: takes.map((t) => ({ event_id: uid("event"), pantry_id: t.pantry_id, amount: t.amount })) }, ctx(at(7)));
  assert.deepEqual([s.pantry[pantryId].amount, s.pantry[pantryId].amount_on, s.pantry[pantryId].taken], [1, at(7), 2]);
  assert.equal(left(s, pantryId, at(14)), 0);
  // "Op" for all of it takes what is left, not what was stored.
  const t = cat({ title: "Minoestuna", amount: 4, perDay: 1 / 7 });
  const eid = uid("event");
  const out = applyOp(t.s, { type: "pantry.use", reason: "used", on: at(14), takes: [{ event_id: eid, pantry_id: t.pantryId, amount: null }] }, ctx(at(14)));
  assert.deepEqual(out.result.events, [eid]);
  assert.deepEqual([t.s.pantry_events[eid].amount, Boolean(t.s.pantry[t.pantryId].deleted_at)], [2, true]);
  // Undo puts the 2 back, as of that day.
  applyOp(t.s, { type: "pantry.unuse", event_ids: [eid] }, ctx(at(14)));
  assert.equal(left(t.s, t.pantryId, at(21)), 1);
});

test("a countdown that ran out before an 'op' is settled as 'op' on the day it ran out", () => {
  const { s, pantryId } = cat({ title: "Minoestuna", amount: 1, perDay: 1 / 7 });
  applyOp(s, { type: "pantry.use", reason: "used", on: at(10), takes: [{ event_id: uid("event"), pantry_id: pantryId, amount: null }] }, ctx(at(10)));
  const row = s.pantry[pantryId];
  assert.ok(row.deleted_at);
  const ev = s.pantry_events[`ru-${pantryId}`];
  assert.deepEqual([ev.reason, ev.happened_on, ev.amount], ["used", at(7), 1], "it ran out on day 7, through its countdown");
  assert.equal(Object.values(s.pantry_events).length, 1, "the take found nothing left: no second event");
});

// ------------------------------------------------------------ item.rate

test("item.rate: checked, a person beats Claude, the same again writes nothing, title makes the item, never an excluded thing", () => {
  const { s, itemId, pantryId } = cat({ perDay: null });
  const run = (o, day = DAY) => applyOp(s, { type: "item.rate", item_id: itemId, ...o }, ctx(day));
  for (const bad of [-1, 51, "6", 1e-6, NaN]) {
    assert.throws(() => run({ use_per_day: bad, source: "person" }), (e) => e.code === "bad_field", String(bad));
  }
  assert.throws(() => run({ use_per_day: 1, source: "rule" }), (e) => e.code === "bad_field");
  assert.throws(() => run({ source: "person" }), (e) => e.code === "bad_field");
  assert.throws(() => run({ use_per_day: 0, source: "claude" }), (e) => e.code === "bad_field", "Claude cannot switch it off");
  assert.deepEqual(run({ use_per_day: 1 / 7, source: "claude" }).changed, [["items", itemId]], "no countdown before: nothing to settle");
  assert.deepEqual(run({ use_per_day: 6 / 7, source: "person" }, at(7)).changed.map(([k]) => k).sort(), ["items", "pantry"], "settled at Claude's rate first");
  assert.equal(s.pantry[pantryId].amount, 32, "a week at 1 a week");
  assert.deepEqual(run({ use_per_day: 1, source: "claude" }).result, { kept: true, item_id: itemId });
  assert.deepEqual(run({ use_per_day: 6 / 7, source: "person" }, at(7)).changed, [], "the same again: nothing");
  // 0: no countdown at all, also no default; null: back to the default.
  run({ use_per_day: 0, source: "person" }, at(7));
  assert.equal(rowRate(s.pantry[pantryId], s.items[itemId]), null);
  run({ use_per_day: null, source: "person" }, at(7));
  assert.deepEqual([s.items[itemId].use_per_day, s.items[itemId].rate_source], [null, null]);

  const out = applyOp(s, { type: "item.rate", title: "Waterfilter kattenfontein", item_id: "item-rate-filter1", use_per_day: 1 / 30, source: "person" }, ctx());
  assert.equal(out.result.item_id, "item-rate-filter1");
  assert.equal(s.items["item-rate-filter1"].name, "Waterfilter kattenfontein");
  assert.throws(() => applyOp(s, { type: "item.rate", title: "Groenhof", item_id: "item-rate-sprt01", use_per_day: 1, source: "person" }, ctx()),
    (e) => e.code === "excluded");
});

// ------------------------------------------------------------ the default table

test("default rates for household goods: only without a person's value, never food, never an excluded thing", () => {
  assert.equal(ruleRate("Tandpasta"), 1 / 42);
  assert.equal(ruleRate("Toiletblokken", "2 st"), 1 / 42, "a pack of two blocks, 3 weeks each");
  assert.equal(ruleRate("Edet toiletpapier 3-laags", "8 rollen"), 1 / 32, "8 rolls, 4 days each");
  assert.equal(ruleRate("Vochtig toiletpapier"), 1 / 14, "the wipes above toilet paper");
  assert.equal(ruleRate("Vaatwastabletten All in 1", "30 st"), 1 / 45);
  assert.equal(ruleRate("Ariel Pods 3in1", "20 stuks"), 1 / 40);
  assert.equal(rateRule("Deodorant spray").kind, "deodorant");
  assert.equal(rateRule("Waterfilter kattenfontein").kind, "water filter");
  assert.deepEqual([piecesIn("8 rollen"), piecesIn("20 stuks"), piecesIn("400 g"), piecesIn("")], [8, 20, null, null]);
  // Never food: the cat's food, food the shelf-life table knows, coffee pods.
  for (const food of ["Minoes eten", "Minoestuna", "Rijst", "Melk", "Koffiepads", "Koffie pods", "Kipfilet", "Pasta"]) {
    assert.equal(ruleRate(food), null, food);
  }
  for (const drink of ["Groenhof", "Verse spruitjes", "Groene Ster spruitjes"]) assert.equal(ruleRate(drink), null, drink);
  for (const [pattern] of RATES) assert.ok(pattern instanceof RegExp);

  const s = emptyState();
  applyOp(s, { type: "pantry.add", id: "pantry-rate-tand1", item_id: "item-rate-tand01", title: "Tandpasta", amount: 2, on: DAY }, ctx());
  assert.deepEqual(rowRate(s.pantry["pantry-rate-tand1"], s.items["item-rate-tand01"]), { per_day: 1 / 42, source: "rule" });
  assert.equal(left(s, "pantry-rate-tand1", at(42)), 1);
  applyOp(s, { type: "item.rate", item_id: "item-rate-tand01", use_per_day: 1 / 30, source: "person", on: at(42) }, ctx(at(42)));
  assert.equal(s.pantry["pantry-rate-tand1"].amount, 1, "settled at the default first");
  assert.equal(left(s, "pantry-rate-tand1", at(57)), 0.5, "then his own rate");
  applyOp(s, { type: "item.rate", item_id: "item-rate-tand01", use_per_day: 0, source: "person", on: at(57) }, ctx(at(57)));
  assert.equal(left(s, "pantry-rate-tand1", at(400)), 0.5, "switched off: no default either");

  const food = cat({ title: "Rijst", amount: 1, perDay: null });
  assert.equal(left(food.s, food.pantryId, at(400)), 1, "rice is never counted down by itself");
  assert.equal(withUsage(food.s, at(400)), food.s, "nothing counted down: the same view");
});

// ------------------------------------------------------------ the readers

test("'Bijna op', 'aanbevolen' and 'Weer nodig' read what is left today", () => {
  const { s, itemId, pantryId } = cat();
  const item = s.items[itemId];
  // Aanbevolen: runs out before the offer ends plus a week.
  assert.equal(lowReason(s, item, at(7), DAY, []), null, "38 days left, the offer ends in 7");
  assert.equal(lowReason(s, item, at(30), at(20), []), null, "18,5 days left, the offer ends in 10: enough past it");
  assert.deepEqual(lowReason(s, item, at(35), at(25), []), { code: "pantry_runs_out", days: 13 }, "13,5 days left, the offer ends in 10");
  assert.deepEqual(lowReason(s, item, at(45), at(40), []), { code: "pantry_empty" });
  // Weer nodig: bought every 14 days; in the house while pouches are left, due once they ran out.
  for (const d of [-42, -28, -14, 0]) {
    s.purchases[uid("purchase")] = { id: `p${d}`, item_id: itemId, title: "Minoes eten", bought_on: at(d), deleted_at: null };
  }
  const due = (day) => dueItems(s, day).find((x) => x.item.id === itemId);
  assert.deepEqual([due(at(20)).in_pantry, due(at(20)).due], [true, false]);
  assert.deepEqual([due(at(40)).in_pantry, due(at(40)).due], [false, true]);
  // An idle read writes nothing: the stored row is unchanged after every reader.
  assert.deepEqual([s.pantry[pantryId].amount, s.pantry[pantryId].amount_on], [33, null]);
});

test("withUsage: safe twice, a day later counts on from the earlier result", () => {
  const { s, pantryId } = cat();
  const v1 = withUsage(s, at(7));
  assert.equal(withUsage(v1, at(7)), v1, "the same day again: the same view");
  assert.equal(withUsage(v1, at(14)).pantry[pantryId].amount, 21, "from 27 on day 7, a week more");
  assert.equal(currentAmount(s.pantry[pantryId], s.items[s.pantry[pantryId].item_id], at(14)), 21);
  assert.equal(drainRows([s.pantry[pantryId]], { use_per_day: 1 }, at(-5)).get(pantryId).amount, 33, "a day before it came in: as stored");
});

test("never an excluded thing: no rate on a sprouts row, even with a rate on its item", () => {
  const s = emptyState();
  s.items["item-rate-sprt01"] = { id: "item-rate-sprt01", name: "Groene Ster spruitjes", name_key: "groene ster spruitjes", use_per_day: 1, rate_source: "person", deleted_at: null };
  s.pantry["pantry-rate-sprt1"] = { id: "pantry-rate-sprt1", item_id: "item-rate-sprt01", title: "Groene Ster spruitjes", amount: 6, taken: 0, pack_size: "", added_on: DAY, deleted_at: null };
  assert.deepEqual(lowStock(s, at(10), { includeListed: true }), [], "never named");
  assert.equal(rowRate(s.pantry["pantry-rate-sprt1"], { name: "Groene Ster spruitjes" }), null);
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
const op = (o) => ({ op_id: `op-rate-${String(++counter).padStart(6, "0")}`, ...o });
const send = async (env, cookie, ops) => (await (await call(env, "POST", "/api/ops", { cookie, body: { ops } })).json()).results;
const pull = async (env, cookie, since) => (await call(env, "GET", `/api/sync?since=${since}`, { cookie })).json();
const tables = (sqls) => sqls.map((sql) => sql.match(/^(?:INSERT INTO|UPDATE) (\w+)/)[1]).sort();

test("D1: the rate travels in the delta, time writes nothing, the idle poll stays one read; a correction writes the item's rows", async () => {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const thomas = tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456" } }));
  const today = new Date().toISOString().slice(0, 10);
  const ago = (d) => addDays(today, -d);
  assert.ok((await send(env, thomas, [op({ type: "pantry.add", id: "pantry-d1-minoes", item_id: "item-d1-minoes-01", title: "Minoes eten", amount: 33, on: ago(7) })]))[0].ok);
  const head = await pull(env, thomas, 0);
  assert.deepEqual([head.items[0].use_per_day, head.items[0].rate_source, head.pantry[0].amount_on], [null, null, null], "migration 0014: the columns are there, empty");

  const batches = [];
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = (stmts) => {
    batches.push(stmts.map((x) => x.sql));
    return batch(stmts);
  };
  const set = await send(env, thomas, [op({ type: "item.rate", item_id: "item-d1-minoes-01", use_per_day: 6 / 7, source: "person", on: ago(7) })]);
  assert.equal(set[0].ok, true, JSON.stringify(set));
  assert.deepEqual(tables(batches.at(-1)), ["applied_ops", "households", "items"], "rev + the item + applied_ops (the row was put in that day)");
  const delta = await pull(env, thomas, head.rev);
  assert.deepEqual(delta.items.map((i) => [i.id, i.use_per_day, i.rate_source]), [["item-d1-minoes-01", 6 / 7, "person"]]);
  assert.deepEqual([delta.pantry.length, delta.pantry_events.length], [0, 0], "only what changed");
  const view = { ...emptyState(), items: Object.fromEntries(delta.items.map((i) => [i.id, i])), pantry: Object.fromEntries(head.pantry.map((r) => [r.id, r])) };
  assert.equal(withUsage(view, today).pantry["pantry-d1-minoes"].amount, 27, "the phone's view: 27 left after a week");

  // Time passes: nothing is written, the idle poll reads only the counter.
  const queries = [];
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    queries.push(sql);
    return prepare(sql);
  };
  const before = batches.length;
  const idle = await pull(env, thomas, delta.rev);
  assert.deepEqual([idle.items.length, idle.pantry.length, idle.pantry_events.length], [0, 0, 0]);
  assert.equal(queries.filter((sql) => /FROM (pantry|pantry_events|list_entries|items|recipes)\b/.test(sql)).length, 0,
    "the idle poll touches no data table");
  assert.equal(batches.length, before, "no write");
  env.DB.prepare = prepare;

  // He counts 30 today: the row gets the amount and today.
  const fixed = await send(env, thomas, [op({ type: "pantry.update", id: "pantry-d1-minoes", amount: 30, on: today })]);
  assert.equal(fixed[0].ok, true, JSON.stringify(fixed));
  assert.deepEqual(tables(batches.at(-1)), ["applied_ops", "households", "pantry"]);
  const after = await pull(env, thomas, delta.rev);
  assert.deepEqual(after.pantry.map((r) => [r.amount, r.amount_on]), [[30, today]]);

  // "Op" on a non-counted item still loads and writes no more than before.
  await send(env, thomas, [op({ type: "pantry.add", id: "pantry-d1-kaas01", item_id: "item-d1-kaas-0001", title: "Kaas", on: today })]);
  await send(env, thomas, [op({ type: "pantry.use", reason: "used", on: today, takes: [{ event_id: "event-d1-kaas01", pantry_id: "pantry-d1-kaas01", amount: 0.5 }] })]);
  assert.deepEqual(tables(batches.at(-1)), ["applied_ops", "households", "pantry", "pantry_events"]);
  const bad = await send(env, thomas, [op({ type: "item.rate", item_id: "item-d1-minoes-01", use_per_day: 99, source: "person" })]);
  assert.equal(bad[0].error, "bad_field", "the worker checks it the same way");
});

test("D1: a take settles every row of a counted-down item, oldest first, on the server as on the phone", async () => {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const thomas = tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456" } }));
  const today = new Date().toISOString().slice(0, 10);
  const ago = (d) => addDays(today, -d);
  const res = await send(env, thomas, [
    op({ type: "pantry.add", id: "pantry-d1-tuna-a1", item_id: "item-d1-tuna-0001", title: "Minoestuna", amount: 2, on: ago(10) }),
    op({ type: "item.rate", item_id: "item-d1-tuna-0001", use_per_day: 1 / 7, source: "person", on: ago(10) }),
    op({ type: "pantry.add", id: "pantry-d1-tuna-b1", item_id: "item-d1-tuna-0001", title: "Minoestuna", amount: 3, on: ago(3) }),
  ]);
  assert.ok(res.every((r) => r.ok), JSON.stringify(res));
  const phone = await pull(env, thomas, 0);
  const state = { ...emptyState(), items: Object.fromEntries(phone.items.map((i) => [i.id, i])), pantry: Object.fromEntries(phone.pantry.map((r) => [r.id, r])) };
  const takeOp = { type: "pantry.use", reason: "used", on: today, takes: [{ event_id: "event-d1-tuna-01", pantry_id: "pantry-d1-tuna-b1", amount: 1 }] };
  applyOp(state, takeOp, ctx(today));
  const used = await send(env, thomas, [op(takeOp)]);
  assert.equal(used[0].ok, true, JSON.stringify(used));
  const server = await pull(env, thomas, 0);
  const rows = Object.fromEntries(server.pantry.map((r) => [r.id, [r.amount, r.amount_on]]));
  assert.deepEqual(rows, {
    "pantry-d1-tuna-a1": [0.57, today],
    "pantry-d1-tuna-b1": [2, today],
  }, "the old row went first (10 days at 1 a week), the new one gave the tin");
  assert.deepEqual(rows, Object.fromEntries(Object.values(state.pantry).map((r) => [r.id, [r.amount, r.amount_on]])), "the phone agrees");
});

test("snacks: chips, biscuits, sweets, chocolate and nuts last a week a pack; recipe tortilla chips and other food do not count down", async () => {
  const { ruleRate } = await import("../public/shared/usage-rates.js");
  for (const n of ["Chips", "Doritos nacho cheese", "Koekjes", "Stroopwafels", "Kaneelkrakelingen", "Snoep", "Chocolade", "Noten"]) {
    assert.equal(ruleRate([n]), 1 / 7, n);
  }
  for (const n of ["Tortillachips", "Melk", "Kaas", "Hagelslag", "Pindakaas"]) assert.equal(ruleRate([n]), null, n);
});

test("a single pod counts as one piece", () => {
  assert.equal(piecesIn("1 pod"), 1);
  assert.equal(piecesIn("1 capsule"), 1);
});
