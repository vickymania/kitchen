// "Binnenkort nodig" (29-10-2026): under the list and in the widget,
// what runs out soon with how much is left. Pure: public/shared/needed-soon.js
// on states built through the op engine; the widget's payload on the real worker.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { applyOp, emptyState, OpError } from "../public/shared/ops.js";
import { neededSoon, leftAmount, notYetOp, tickOps, NEEDED_SOON_DAYS, NOT_YET_DAYS } from "../public/shared/needed-soon.js";
import { lowStock } from "../public/shared/low-stock.js";
import { withUsage } from "../public/shared/pantry.js";
import { parseIngredient } from "../public/shared/ingredients.js";
import { addDays } from "../public/shared/shelf-life.js";
import { amsterdamDay } from "../worker/offers.js";

const DAY = "2026-10-01";
const ctx = (day = DAY) => ({ memberId: "member-thomas-01", isAdmin: true, now: `${day}T10:00:00.000Z` });
let n = 0;
const uid = (kind) => `${kind}-soon-${String(++n).padStart(5, "0")}`;
const at = (d) => addDays(DAY, d);

/** Adds a pantry row (one item per call) and, with perDay, a person's rate. Returns the item id. */
function stock(s, title, amount, { pack_size = "", perDay = null, on = DAY } = {}) {
  const itemId = uid("item");
  applyOp(s, { type: "pantry.add", id: uid("pantry"), item_id: itemId, title, amount, pack_size, on }, ctx(on));
  if (perDay !== null) applyOp(s, { type: "item.rate", item_id: itemId, use_per_day: perDay, source: "person", on }, ctx(on));
  return itemId;
}
const names = (s, day) => neededSoon(s, day).map((x) => x.name);
const byName = (s, day) => Object.fromEntries(neededSoon(s, day).map((x) => [x.name, x]));

test("the cat's pouches: shown from two weeks before they run out, low in the last week", () => {
  const s = emptyState();
  stock(s, "Minoes eten", 33, { perDay: 6 / 7 });
  // 33 pouches at 6 a week last 38.5 days.
  assert.deepEqual(names(s, at(20)), [], "18 days left: not yet");
  const soon = byName(s, at(26))["Minoes eten"];
  assert.equal(soon.code, "soon", "12 days left: needed soon, not low yet");
  assert.equal(Math.floor(soon.days_left), 12);
  assert.ok(soon.days_left < NEEDED_SOON_DAYS);
  assert.deepEqual(soon.amount, { qty: 10.75, base: null }, "10,7 pouches shown to the quarter");
  const low = byName(s, at(33))["Minoes eten"];
  assert.equal(low.code, "below", "under a week: what Bijna op flags");
  assert.equal(Math.floor(low.days_left), 5);
  assert.equal(byName(s, at(40))["Minoes eten"].code, "empty", "ran out: still there for a week");
});

test("everything Bijna op flags, soonest run-out first; a low thing without a rate sits at a week", () => {
  const s = emptyState();
  stock(s, "Rijst", 0.1, { pack_size: "1 kg" });
  stock(s, "Minoestuna", 3, { perDay: 1 / 7 }); // 21 days: not shown
  stock(s, "Filters", 1, { perDay: 1 / 10 }); // 10 days
  stock(s, "Tandpasta", 0.3, { perDay: 1 / 60 }); // 18 days: not shown
  stock(s, "Wc-blokjes", 2, { perDay: 1 / 2 }); // 4 days
  const list = neededSoon(s, DAY);
  assert.deepEqual(list.map((x) => [x.name, x.code]), [["Wc-blokjes", "below"], ["Rijst", "below"], ["Filters", "soon"]]);
  const rice = list.find((x) => x.name === "Rijst");
  assert.deepEqual(rice.amount, { qty: 100, base: "g" }, "the pack size says grams");
  assert.equal(rice.days_left, null, "no rate: no days");
  assert.equal(rice.title, "Rijst", "the item to put on the list");
});

test("not on the list, not switched off, not excluded, not a recipe-only ingredient unless it has its own threshold", () => {
  const s = emptyState();
  stock(s, "Filters", 1, { perDay: 1 / 10 });
  const tuna = stock(s, "Minoestuna", 1, { perDay: 1 / 10 });
  const avocado = stock(s, "Avocado", 2, { perDay: 1 / 5 });
  s.recipes["recipe-soon-0001"] = { id: "recipe-soon-0001", title: "Guacamole", servings: 2, ingredients: [parseIngredient("2 avocado")] };
  // A sprouts counted down, written straight in: the op engine would refuse it.
  s.items["item-soon-sprt01"] = { id: "item-soon-sprt01", name: "Spruitjes", use_per_day: 1, rate_source: "person" };
  s.pantry["pantry-soon-sprt1"] = { id: "pantry-soon-sprt1", item_id: "item-soon-sprt01", title: "Spruitjes", amount: 3, pack_size: "", added_on: DAY, amount_on: DAY };
  applyOp(s, { type: "entry.add", id: uid("entry"), item_id: uid("item"), title: "Filters" }, ctx());
  applyOp(s, { type: "item.low", item_id: tuna, low_off: true }, ctx());
  assert.deepEqual(names(s, DAY), [], "listed, switched off, a recipe ingredient, excluded");
  applyOp(s, { type: "item.low", item_id: avocado, low_at: "1 st" }, ctx());
  assert.deepEqual(names(s, DAY), ["Avocado"], "its own threshold shows it");
});

test("leftAmount: grams and millilitres whole, pieces to the quarter, packs as the Voorraad tab", () => {
  assert.deepEqual(leftAmount({ packs: 0.12, qty: 123.4, base: "g" }), { qty: 123, base: "g" });
  assert.deepEqual(leftAmount({ packs: 0.3, qty: 2.6, base: "piece" }), { qty: 2.5, base: "piece" });
  assert.deepEqual(leftAmount({ packs: 0.1, qty: 0.1, base: null }), { qty: 0.25, base: null });
  assert.deepEqual(leftAmount({ packs: 0, qty: 0, base: null }), { qty: 0, base: null });
  assert.deepEqual(leftAmount({ packs: 1.4, qty: null, base: null, mixed: true }), { qty: 1.5, base: null });
});

// -------------------------------------------------------------- "Nog niet"

const live = (s, day) => withUsage(s, day);
const sumLeft = (s, day, title) => Object.values(live(s, day).pantry).filter((r) => !r.deleted_at && r.title === title).reduce((a, r) => a + r.amount, 0);
const entryOf = (s, day, name) => neededSoon(s, day).find((x) => x.name === name);

test("Nog niet on a countdown: what is left today plus three days of use, again on a second tap", () => {
  const s = emptyState();
  stock(s, "Minoes eten", 33, { perDay: 6 / 7 });
  const day = at(30); // 33 - 30 × 6/7 = 7,29 left
  const op = notYetOp(s, day, entryOf(s, day, "Minoes eten"), () => "unused-id-0001");
  assert.equal(op.type, "pantry.update");
  assert.equal(op.add_days, 3, "days, not an amount: the engine adds them to what is left when it applies the op");
  assert.equal(op.amount, undefined);
  assert.equal(op.on, day);
  applyOp(s, op, ctx(day));
  assert.equal(sumLeft(s, day, "Minoes eten"), 9.86, "7,29 + 3 × 6/7, two decimals");
  assert.equal(Math.floor(entryOf(s, day, "Minoes eten").days_left), 11, "the countdown starts again from 9,86");
  // It also taught the rate (rate-learning.js, "not_yet"): it lasts longer, so a bit slower than 6 a week.
  const learned = Object.values(s.items).find((i) => i.name === "Minoes eten").use_per_day;
  assert.ok(learned < 6 / 7 && learned > 6 / 7 / 1.25, `slower, at most 25% (${learned})`);
  applyOp(s, notYetOp(s, day, entryOf(s, day, "Minoes eten"), () => "unused-id-0002"), ctx(day));
  assert.equal(sumLeft(s, day, "Minoes eten"), 12.38, "a second tap: three more days at the learned rate (9,86 + 3 × 0,84)");
  assert.equal(sumLeft(s, at(31), "Minoes eten"), 11.59, "and it keeps counting down, a little slower again");
  assert.equal(NOT_YET_DAYS, 3);
});

test("Nog niet sent late (the widget's op from its last refresh): a change made elsewhere in between is kept, the days are added to it", () => {
  const s = emptyState();
  stock(s, "Minoes eten", 33, { perDay: 6 / 7 });
  const day = at(30);
  const op = notYetOp(s, day, entryOf(s, day, "Minoes eten"), () => "unused-id-0004");
  // Before the widget's tap arrives, someone counts the bag on another phone: 2 left.
  const row = Object.values(s.pantry).find((r) => r.title === "Minoes eten");
  applyOp(s, { type: "pantry.update", id: row.id, amount: 2, on: day }, ctx(day));
  applyOp(s, op, ctx(day));
  assert.equal(sumLeft(s, day, "Minoes eten"), 4.57, "2 + 3 × 6/7: the count is kept, not overwritten with 9,86");
  assert.throws(() => applyOp(s, { ...op, amount: 5 }, ctx(day)), /bad_field/, "add_days and an amount together are refused");
});

test("Nog niet on a countdown with two rows: the newest row gets it, the older one is settled at what it showed", () => {
  const s = emptyState();
  const item = stock(s, "Minoestuna", 2, { perDay: 1 });
  applyOp(s, { type: "pantry.add", id: "pantry-soon-new01", item_id: item, title: "Minoestuna", amount: 3, pack_size: "", on: at(1) }, ctx(at(1)));
  // Day 3: the old row ran out on day 2, the new one has 2 left.
  assert.equal(sumLeft(s, at(3), "Minoestuna"), 2);
  const op = notYetOp(s, at(3), entryOf(s, at(3), "Minoestuna"), () => "unused-id-0003");
  assert.deepEqual([op.type, op.id, op.add_days], ["pantry.update", "pantry-soon-new01", 3]);
  applyOp(s, op, ctx(at(3)));
  assert.equal(sumLeft(s, at(3), "Minoestuna"), 5);
  assert.equal(sumLeft(s, at(4), "Minoestuna"), 4.11, "a day later: it learned it lasts longer (1 a day became 0,89)");
});

test("Nog niet on a countdown that ran out and was put away: a new row with three days of use", () => {
  const s = emptyState();
  const item = stock(s, "Filters", 1, { perDay: 1 / 10 });
  const row = Object.values(s.pantry).find((r) => r.item_id === item);
  applyOp(s, { type: "pantry.use", reason: "used", on: at(1), takes: [{ event_id: "event-soon-filt1", pantry_id: row.id, amount: 1 }] }, ctx(at(1)));
  const entry = entryOf(s, at(2), "Filters");
  assert.equal(entry.code, "empty");
  const op = notYetOp(s, at(2), entry, () => "pantry-soon-nn001");
  assert.deepEqual([op.type, op.id, op.item_id, op.amount], ["pantry.add", "pantry-soon-nn001", item, 0.3]);
  applyOp(s, op, ctx(at(2)));
  assert.equal(entryOf(s, at(2), "Filters").code, "below", "3 days left: still low, no longer empty");
});

test("Nog niet without a countdown: out of Al nodig? for three days, still in Bijna op", () => {
  const s = emptyState();
  stock(s, "Rijst", 0.1, { pack_size: "1 kg" });
  const op = notYetOp(s, DAY, entryOf(s, DAY, "Rijst"), () => "unused-id-0004");
  assert.deepEqual(op, { type: "item.not_yet", item_id: entryOf(s, DAY, "Rijst").item_id, until: at(NOT_YET_DAYS) });
  applyOp(s, op, ctx());
  assert.deepEqual(names(s, DAY), []);
  assert.deepEqual(names(s, at(2)), []);
  assert.deepEqual(names(s, at(3)), ["Rijst"], "back on the third day");
  assert.deepEqual(lowStock(s, DAY).map((l) => l.name), ["Rijst"], "Bijna op does not hear of it");
});

test("item.not_yet: sets, the same day again writes nothing, null clears, refuses a bad day or a missing item", () => {
  const s = emptyState();
  const item = stock(s, "Rijst", 0.1, { pack_size: "1 kg" });
  assert.deepEqual(applyOp(s, { type: "item.not_yet", item_id: item, until: at(3) }, ctx()).changed, [["items", item]]);
  assert.equal(s.items[item].not_yet_until, at(3));
  assert.equal(applyOp(s, { type: "item.not_yet", item_id: item, until: at(3) }, ctx()).changed.length, 0);
  applyOp(s, { type: "item.not_yet", item_id: item, until: null }, ctx());
  assert.equal(s.items[item].not_yet_until, null);
  assert.throws(() => applyOp(s, { type: "item.not_yet", item_id: item, until: "soon" }, ctx()), (e) => e instanceof OpError && e.code === "bad_field");
  assert.throws(() => applyOp(s, { type: "item.not_yet", item_id: "item-soon-none01", until: at(3) }, ctx()), (e) => e.code === "not_found");
});

// ---------------------------------------------------------------- the widget

const HOST = "groceries.localhost:8787";
const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
function call(env, method, path, { body, bearer } = {}) {
  const headers = {};
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`http://${HOST}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}

test("widget route: needed soon with what is left and the day it is true for", async () => {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const thomas = tokenOf(await worker.fetch(new Request(`http://${HOST}/api/pair`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: `http://${HOST}` }, body: JSON.stringify({ code: "123456", label: "widget" }),
  }), env));
  const today = amsterdamDay();
  const ops = [
    { type: "pantry.add", id: "pantry-soon-cat01", item_id: "item-soon-cat001", title: "Minoes eten", amount: 5, pack_size: "", on: today },
    { type: "item.rate", item_id: "item-soon-cat001", use_per_day: 6 / 7, source: "person", on: today },
    { type: "pantry.add", id: "pantry-soon-rice1", item_id: "item-soon-rice01", title: "Rijst", amount: 0.1, pack_size: "1 kg", on: today },
    { type: "pantry.add", id: "pantry-soon-milk1", item_id: "item-soon-milk01", title: "Melk", amount: 0.1, pack_size: "1 l", on: today },
    { type: "entry.add", id: "entry-soon-milk01", item_id: "item-soon-milk01", title: "Melk" },
  ].map((o, i) => ({ op_id: `op-soon-${String(i).padStart(6, "0")}`, ...o }));
  const sent = await (await call(env, "POST", "/api/ops", { bearer: thomas, body: { ops } })).json();
  assert.deepEqual(sent.results.filter((r) => !r.ok), []);
  const body = await (await call(env, "GET", "/api/widget", { bearer: thomas })).json();
  assert.equal(body.day, today);
  const shown = body.needed_soon.map(({ not_yet, tick, ...rest }) => rest);
  assert.deepEqual(body.needed_soon.map((x) => x.tick), [{ title: "Minoes eten", amounts: [] }, { title: "Rijst", amounts: [{ qty: 1, unit: "kg" }] }]);
  assert.deepEqual(shown, [
    { key: "minoes eten", name: "Minoes eten", code: "below", amount: { qty: 5, base: null }, days_left: 5, on: null },
    { key: "rijst", name: "Rijst", code: "below", amount: { qty: 100, base: "g" }, days_left: null, on: null },
  ], "milk is on the list");
  assert.equal(body.count, 1);
  const [cat, rice] = body.needed_soon;
  assert.deepEqual(cat.not_yet, { type: "pantry.update", id: "pantry-soon-cat01", add_days: 3, on: today, why: "not_yet" });
  assert.deepEqual(rice.not_yet, { type: "item.not_yet", item_id: "item-soon-rice01", until: addDays(today, 3) });

  // The widget sends them as they are, with its own op_id.
  const tap = await (await call(env, "POST", "/api/ops", { bearer: thomas, body: { ops: [
    { op_id: "op-soon-tap-cat01", ...cat.not_yet }, { op_id: "op-soon-tap-rice1", ...rice.not_yet },
  ] } })).json();
  assert.deepEqual(tap.results.filter((r) => !r.ok), []);
  const after = await (await call(env, "GET", "/api/widget", { bearer: thomas })).json();
  assert.deepEqual(after.needed_soon.map((x) => [x.name, x.amount.qty, x.days_left]), [["Minoes eten", 7.5, 9]], "rice put off on D1, the pouches counted up (and their rate learned it lasts longer: 9 days, not 8)");
  const row = await env.DB.prepare("SELECT not_yet_until FROM items WHERE id = 'item-soon-rice01'").first();
  assert.equal(row.not_yet_until, addDays(today, 3));

  // The row's tick box, as the widget sends it: entry.add + entry.check in one batch.
  const [still] = after.needed_soon;
  const ticked = await (await call(env, "POST", "/api/ops", { bearer: thomas, body: { ops: [
    { op_id: "op-soon-tick-add01", type: "entry.add", id: "entry-soon-tick01", item_id: "item-soon-tick01", ...still.tick },
    { op_id: "op-soon-tick-chk01", type: "entry.check", id: "entry-soon-tick01", checked: true },
  ] } })).json();
  assert.deepEqual(ticked.results.filter((r) => !r.ok), []);
  const line = await env.DB.prepare("SELECT item_id, checked_at FROM list_entries WHERE id = 'entry-soon-tick01'").first();
  assert.equal(line.item_id, "item-soon-cat001", "the existing item, not a new one");
  assert.ok(line.checked_at, "in the basket");
  const last = await (await call(env, "GET", "/api/widget", { bearer: thomas })).json();
  assert.deepEqual(last.needed_soon, [], "ticked: a basket line now, no hint");
  assert.equal(last.count, 1, "the open list did not grow");
});

test("the tick box: one tap is an open line ticked into the basket; it leaves Al nodig?, also when unticked", () => {
  const s = emptyState();
  stock(s, "Rijst", 0.1, { pack_size: "1 kg" });
  stock(s, "Minoes eten", 5, { perDay: 6 / 7 });
  const rice = entryOf(s, DAY, "Rijst");
  const ops = tickOps(rice, "entry-soon-tickr1", "item-soon-unused1");
  assert.deepEqual(ops, [
    { type: "entry.add", id: "entry-soon-tickr1", item_id: "item-soon-unused1", title: "Rijst", amounts: [{ qty: 1, unit: "kg" }] },
    { type: "entry.check", id: "entry-soon-tickr1", checked: true },
  ]);
  for (const op of ops) applyOp(s, op, ctx());
  const line = s.entries["entry-soon-tickr1"];
  assert.ok(line.checked_at, "in the basket");
  assert.equal(line.item_id, rice.item_id, "on the existing item");
  assert.deepEqual(names(s, DAY), ["Minoes eten"], "rice is a basket line now");
  applyOp(s, { type: "entry.check", id: "entry-soon-tickr1", checked: false }, ctx());
  assert.deepEqual(names(s, DAY), ["Minoes eten"], "unticked: an open line like any other");
  applyOp(s, { type: "entry.check", id: "entry-soon-tickr1", checked: true }, ctx());
  applyOp(s, { type: "entry.clear_checked", ids: ["entry-soon-tickr1"] }, ctx());
  assert.ok(!names(s, DAY).includes("Rijst"), "the tick filled the pantry: rice is no longer low");
  assert.deepEqual(tickOps(entryOf(s, DAY, "Minoes eten"), "e1-soon-x", "i1-soon-x")[0].amounts, undefined, "no weight: no amount");
});
