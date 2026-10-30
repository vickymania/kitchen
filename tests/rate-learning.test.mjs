// Usage rates that learn (30-10-2026: "zo min mogelijk zelf instellen
// en een zo slim mogelijke app"): public/shared/rate-learning.js and the op
// handlers that call it (public/shared/ops.js teach). Every rate learns, also
// a person's; setting one by hand restarts the learning from it.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { applyOp, emptyState } from "../public/shared/ops.js";
import { withUsage } from "../public/shared/pantry.js";
import { notYetOp, neededSoon } from "../public/shared/needed-soon.js";
import { addDays } from "../public/shared/shelf-life.js";
import {
  SIGNALS, WEIGHTS, MAX_STEP, MIN_SIGNAL_DAYS, LIST_LEAD_DAYS, LIST_SLACK_DAYS, REBUY_HIGH_DAYS, NOT_YET_DAYS,
  OFFER_DROP, OFFER_HISTORY, OFFER_MIN_HISTORY, stockSnapshot, impliedRate, blendRate, learnRate, onOffer,
} from "../public/shared/rate-learning.js";

const DAY = "2026-10-01";
const at = (d) => addDays(DAY, d);
const ctx = (day = DAY) => ({ memberId: "member-thomas-01", isAdmin: true, now: `${day}T10:00:00.000Z` });
let n = 0;
const uid = (kind) => `${kind}-learn-${String(++n).padStart(5, "0")}`;
const apply = (s, op, day) => applyOp(s, op, ctx(day));
const itemOf = (s, name) => Object.values(s.items).find((i) => i.name === name);

/** An item with one pantry row of `amount` on `day`, its rate set by a person. */
function stocked(name, { amount = 1, perDay = 1 / 7, day = DAY, s = emptyState(), source = "person" } = {}) {
  const itemId = uid("item");
  const pantryId = uid("pantry");
  apply(s, { type: "pantry.add", id: pantryId, item_id: itemId, title: name, amount, on: day }, day);
  if (perDay !== null) apply(s, { type: "item.rate", item_id: itemId, use_per_day: perDay, source, on: day }, day);
  return { s, itemId, pantryId };
}
const op = (s, pantryId, day, reason = "used") =>
  apply(s, { type: "pantry.use", reason, on: day, takes: [{ event_id: uid("event"), pantry_id: pantryId, amount: null }] }, day);

// ------------------------------------------------------------ the constants

test("the constants: weights per strength, a 25% cap, the windows", () => {
  assert.deepEqual(SIGNALS, { op: "strong", list: "middle", not_yet: "middle", rebuy: "light" });
  assert.deepEqual(WEIGHTS, { strong: 0.5, middle: 0.3, light: 0.15 });
  assert.equal(MAX_STEP, 0.25);
  assert.deepEqual([MIN_SIGNAL_DAYS, LIST_LEAD_DAYS, LIST_SLACK_DAYS, REBUY_HIGH_DAYS, NOT_YET_DAYS], [3, 3, 7, 14, 3]);
  assert.deepEqual([OFFER_DROP, OFFER_HISTORY, OFFER_MIN_HISTORY], [0.15, 10, 2]);
  // Blending: toward the implied rate by the weight, never more than x1.25 or /1.25.
  assert.equal(blendRate(1, 0.5, 0.5), 0.8, "half way would be 0.75: capped at 1/1.25");
  assert.equal(blendRate(1, 2, 0.5), 1.25, "half way would be 1.5: capped at 1.25");
  assert.equal(blendRate(1, 0.9, 0.5), 0.95, "a small step is the plain blend");
  assert.equal(blendRate(1 / 3650, 1e-9, 0.5), 1 / 3650, "never below RATE_MIN");
  assert.equal(blendRate(40, 100, 0.5), 50, "never above RATE_MAX");
});

// ------------------------------------------------------------ "op": strong

test("Ontbijtgranen at 1 pack a week, 'op' after 9 days three times: the rate moves toward 1/9 in bounded steps", () => {
  const { s, itemId, pantryId } = stocked("Ontbijtgranen", { perDay: 1 / 7 });
  const rates = [s.items[itemId].use_per_day];
  let row = pantryId;
  let day = DAY;
  for (let i = 1; i <= 3; i++) {
    day = addDays(day, 9);
    op(s, row, day);
    const it = s.items[itemId];
    assert.equal(it.rate_source, "learned");
    assert.equal(it.rate_samples, i);
    rates.push(it.use_per_day);
    // Bought again that day.
    row = uid("pantry");
    apply(s, { type: "pantry.add", id: row, item_id: itemId, title: "Ontbijtgranen", amount: 1, on: day }, day);
  }
  for (let i = 1; i < rates.length; i++) {
    assert.ok(rates[i] < rates[i - 1], "slower every time");
    assert.ok(rates[i] > 1 / 9, "never past what it learns from");
    assert.ok(rates[i - 1] / rates[i] <= 1 + MAX_STEP + 1e-9, "at most 25% a step");
  }
  // 1/7 -> 1/7 + 0.5 x (1/9 - 1/7) each time: 0.127, 0.119, 0.115.
  assert.deepEqual(rates.slice(1).map((r) => Math.round(r * 1000) / 1000), [0.127, 0.119, 0.115]);
});

test("'op' the day after it was filled teaches nothing; a partial 'op' that leaves some teaches nothing", () => {
  const a = stocked("Ontbijtgranen");
  op(a.s, a.pantryId, at(1));
  assert.deepEqual([a.s.items[a.itemId].rate_source, a.s.items[a.itemId].rate_samples], ["person", 0], "1 day < MIN_SIGNAL_DAYS");
  const b = stocked("Minoes eten", { amount: 12, perDay: 6 / 7 });
  apply(b.s, { type: "pantry.use", reason: "used", on: at(5), takes: [{ event_id: uid("event"), pantry_id: b.pantryId, amount: 2 }] }, at(5));
  assert.equal(b.s.items[b.itemId].rate_source, "person", "pouches left: not empty, no lesson");
});

test("thrown away and cooked teach nothing: waste is not use, a recipe is not the steady use", () => {
  const a = stocked("Ontbijtgranen");
  op(a.s, a.pantryId, at(9), "thrown");
  assert.deepEqual([a.s.items[a.itemId].use_per_day, a.s.items[a.itemId].rate_source], [1 / 7, "person"]);
  const b = stocked("Ontbijtgranen");
  op(b.s, b.pantryId, at(9), "cooked");
  assert.deepEqual([b.s.items[b.itemId].use_per_day, b.s.items[b.itemId].rate_source], [1 / 7, "person"]);
});

test("the default rule learns too: toilet paper by the table becomes a learned rate", () => {
  const { s, itemId, pantryId } = stocked("Toiletpapier", { perDay: null, amount: 1 });
  assert.equal(withUsage(s, DAY).pantry[pantryId].rate_source, "rule");
  op(s, pantryId, at(14));
  const it = s.items[itemId];
  assert.equal(it.rate_source, "learned");
  assert.equal(it.rate_samples, 1);
  assert.equal(it.use_per_day, 1 / 28 * 1.25, "28 days by the table, gone in 14: up by the 25% cap");
});

test("'niet aftellen' (0) and excluded never learn", () => {
  const { s, itemId, pantryId } = stocked("Ontbijtgranen", { perDay: 0 });
  op(s, pantryId, at(9));
  assert.deepEqual([s.items[itemId].use_per_day, s.items[itemId].rate_source], [0, "person"]);
  assert.equal(learnRate("op", { id: "x", name: "Groene Ster spruitjes", use_per_day: 1 / 7 },
    [{ id: "r", item_id: "x", title: "Groene Ster spruitjes", amount: 1, added_on: DAY }], at(9)), null);
});

test("undoing the 'op' (the toast) undoes the lesson too", () => {
  const { s, itemId, pantryId } = stocked("Ontbijtgranen", { amount: 2 });       // 14 days, 'op' on day 9
  const eid = uid("event");
  apply(s, { type: "pantry.use", reason: "used", on: at(9), takes: [{ event_id: eid, pantry_id: pantryId, amount: null }] }, at(9));
  assert.equal(s.items[itemId].rate_source, "learned");
  assert.deepEqual(s.pantry_events[eid].rate_before, { use_per_day: 1 / 7, rate_source: "person", rate_samples: 0 });
  apply(s, { type: "pantry.unuse", event_ids: [eid] }, at(9));
  assert.deepEqual([s.items[itemId].use_per_day, s.items[itemId].rate_source, s.items[itemId].rate_samples], [1 / 7, "person", 0]);
});

// ------------------------------------------------------- a person and Claude

test("a hand-set rate resets the samples and the learning goes on from it; Claude's estimate never replaces a learned rate", () => {
  const { s, itemId, pantryId } = stocked("Ontbijtgranen");
  op(s, pantryId, at(9));
  assert.equal(s.items[itemId].rate_samples, 1);
  const kept = apply(s, { type: "item.rate", item_id: itemId, use_per_day: 1 / 3, source: "claude", on: at(9) }, at(9));
  assert.equal(kept.result.kept, true, "a learned rate outranks an estimate");
  apply(s, { type: "item.rate", item_id: itemId, use_per_day: 1 / 10, source: "person", on: at(9) }, at(9));
  assert.deepEqual([s.items[itemId].use_per_day, s.items[itemId].rate_source, s.items[itemId].rate_samples], [1 / 10, "person", 0]);
  const row = uid("pantry");
  apply(s, { type: "pantry.add", id: row, item_id: itemId, title: "Ontbijtgranen", amount: 1, on: at(9) }, at(9));
  op(s, row, at(17));
  assert.equal(s.items[itemId].rate_source, "learned");
  assert.equal(s.items[itemId].rate_samples, 1, "counting again from the person's value");
  assert.equal(s.items[itemId].use_per_day, 0.1125, "1/10 toward 1/8 by half");
  // Back to the default: no rate of its own, no samples.
  apply(s, { type: "item.rate", item_id: itemId, use_per_day: null, source: "person", on: at(17) }, at(17));
  assert.deepEqual([s.items[itemId].use_per_day, s.items[itemId].rate_source, s.items[itemId].rate_samples], [null, null, 0]);
});

// ------------------------------------------------------- the list: middle

test("on the list while the countdown said 3 more weeks: it goes faster; near the predicted end: nothing; for a recipe: nothing", () => {
  const { s, itemId } = stocked("Minoes eten", { amount: 30, perDay: 6 / 7 });   // 35 days of pouches
  apply(s, { type: "entry.add", id: uid("entry"), item_id: uid("item"), title: "Minoes eten", on: at(10) }, at(10));
  const it = s.items[itemId];
  assert.equal(it.rate_source, "learned");
  // Predicted to last 35 days, on the list on day 10 (~3 days left): implied 6/7 x 35 / 13, capped at +25%.
  assert.equal(it.use_per_day, (6 / 7) * 1.25);
  assert.equal(withUsage(s, at(10)).pantry[Object.keys(s.pantry)[0]].amount, 21.43, "today's amount stays what it showed");

  const near = stocked("Minoes eten", { amount: 6, perDay: 6 / 7 });             // 7 days of pouches
  apply(near.s, { type: "entry.add", id: uid("entry"), item_id: uid("item"), title: "Minoes eten", on: at(4) }, at(4));
  assert.equal(near.s.items[near.itemId].rate_source, "person", "3 days left as predicted: the countdown was right");

  const recipe = stocked("Minoes eten", { amount: 30, perDay: 6 / 7 });
  apply(recipe.s, { type: "entry.add", id: uid("entry"), item_id: uid("item"), title: "Minoes eten", on: at(10),
    source: { recipe_id: "recipe-learn-00001", title: "Kattenmaal" } }, at(10));
  assert.equal(recipe.s.items[recipe.itemId].rate_source, "person", "a recipe's ingredient on the list says nothing about the steady use");
});

test("on the list long after the countdown said it ran out: it lasts longer", () => {
  const { s, itemId } = stocked("Tandpasta", { perDay: 1 / 42 });
  apply(s, { type: "entry.add", id: uid("entry"), item_id: uid("item"), title: "Tandpasta", on: at(70) }, at(70));
  const r = s.items[itemId].use_per_day;
  assert.ok(r < 1 / 42 && r >= 1 / 42 / 1.25, `slower, at most 25% (${r})`);
});

// ------------------------------------------------------------ "Nog niet"

test("Nog niet: it lasts longer than predicted, the rate goes down a little", () => {
  const { s, itemId } = stocked("Minoes eten", { amount: 33, perDay: 6 / 7 });
  const day = at(30);
  const entry = neededSoon(s, day).find((x) => x.name === "Minoes eten");
  const nn = notYetOp(s, day, entry, () => uid("pantry"));
  assert.equal(nn.why, "not_yet");
  apply(s, nn, day);
  const it = s.items[itemId];
  assert.equal(it.rate_source, "learned");
  assert.equal(it.rate_samples, 1);
  // Predicted 38.5 days, at least 41.5: 6/7 x 38.5 / 41.5, blended by 0.3.
  const implied = (6 / 7) * 38.5 / 41.5;
  assert.ok(Math.abs(it.use_per_day - ((6 / 7) + 0.3 * (implied - 6 / 7))) < 1e-6);
  // A plain correction teaches nothing (it may be a restock).
  apply(s, { type: "pantry.update", id: nn.id, amount: 40, on: at(31) }, at(31));
  assert.equal(s.items[itemId].rate_samples, 1);
  assert.throws(() => apply(s, { type: "pantry.update", id: nn.id, amount: 40, why: "because" }, at(31)), (e) => e.code === "bad_field");
});

// ------------------------------------------------------------ rebuy: light

/** Earlier priced purchases of `title` at `cents` each, a week apart before DAY. */
function history(s, title, cents, count = 4) {
  for (let i = count; i >= 1; i--) {
    apply(s, { type: "purchase.add", id: uid("purchase"), title, bought_on: addDays(DAY, -7 * i), store: "Albert Heijn", qty: 1,
      price_cents: cents, source: "receipt", product: { id: "product-learn-oats", name: "Havermout", brand: "AH", size: "500 g" } }, DAY);
  }
}
const receipt = (s, title, day, { qty = 1, cents = 199 } = {}) =>
  apply(s, { type: "purchase.add", id: uid("purchase"), title, bought_on: day, store: "Albert Heijn", qty, price_cents: cents * qty,
    source: "receipt", pantry: true, product: { id: "product-learn-oats", name: "Havermout", brand: "AH", size: "500 g" } }, day);

test("a rebuy of 3 packs on offer does nothing; one on offer does nothing; several at once do nothing", () => {
  const a = stocked("Havermout", { perDay: 1 / 14 });
  history(a.s, "Havermout", 199);
  receipt(a.s, "Havermout", at(40), { qty: 3, cents: 129 });
  assert.equal(a.s.items[a.itemId].rate_source, "person");
  const b = stocked("Havermout", { perDay: 1 / 14 });
  history(b.s, "Havermout", 199);
  receipt(b.s, "Havermout", at(40), { cents: 149 });
  assert.equal(b.s.items[b.itemId].rate_source, "person", "1,49 against a usual 1,99: on offer");
  const c = stocked("Havermout", { perDay: 1 / 14 });
  history(c.s, "Havermout", 199);
  receipt(c.s, "Havermout", at(40), { qty: 2 });
  assert.equal(c.s.items[c.itemId].rate_source, "person", "two at once: stocking up");
});

test("a rebuy at the usual price, long after the countdown ran out: it lasts longer, by the light weight", () => {
  const { s, itemId } = stocked("Havermout", { perDay: 1 / 14 });
  history(s, "Havermout", 199);
  const out = receipt(s, "Havermout", at(40));
  assert.equal(out.result.learned, true);
  const it = s.items[itemId];
  assert.equal(it.rate_samples, 1);
  // Predicted 14 days, really ~43: 1/14 x 14 / 43 = 1/43, blended by 0.15.
  assert.ok(Math.abs(it.use_per_day - (1 / 14 + 0.15 * (1 / 43 - 1 / 14))) < 1e-6);
});

test("a rebuy teaches nothing while it was on the list, while plenty was predicted left, or without price history", () => {
  const listed = stocked("Havermout", { perDay: 1 / 14 });
  history(listed.s, "Havermout", 199);
  apply(listed.s, { type: "entry.add", id: "entry-learn-oats1", item_id: uid("item"), title: "Havermout", on: at(13) }, at(13));
  const before = { ...listed.s.items[listed.itemId] };
  receipt(listed.s, "Havermout", at(40));
  assert.deepEqual([listed.s.items[listed.itemId].use_per_day, listed.s.items[listed.itemId].rate_samples], [before.use_per_day, before.rate_samples],
    "an open line: no rebuy");
  const high = stocked("Havermout", { amount: 4, perDay: 1 / 14 });           // 56 days
  history(high.s, "Havermout", 199);
  receipt(high.s, "Havermout", at(10));
  assert.equal(high.s.items[high.itemId].rate_source, "person", "46 days predicted left: stocking up");
  // onOffer itself: too little history is no offer; the same product's prices first.
  assert.equal(onOffer({ id: "p", item_id: "i", bought_on: DAY, qty: 1, price_cents: 100 }, [{ id: "q", item_id: "i", bought_on: at(-7), qty: 1, price_cents: 200 }]), false);
  const earlier = [
    { id: "a", item_id: "i", product_id: "big", bought_on: at(-21), qty: 1, price_cents: 400 },
    { id: "b", item_id: "i", product_id: "small", bought_on: at(-14), qty: 1, price_cents: 200 },
    { id: "c", item_id: "i", product_id: "small", bought_on: at(-7), qty: 1, price_cents: 200 },
  ];
  assert.equal(onOffer({ id: "p", item_id: "i", bought_on: DAY, qty: 1, price_cents: 199 }, earlier, "small"), false, "the small pack's own price");
  assert.equal(onOffer({ id: "p", item_id: "i", bought_on: DAY, qty: 1, price_cents: 160 }, earlier, "small"), true);
});

// ------------------------------------------------------- pure and replayable

test("snapshot and implied rate: pure, by the op's day", () => {
  const item = { id: "i", name: "Ontbijtgranen", use_per_day: 1 / 7, rate_source: "person" };
  const rows = [{ id: "r", item_id: "i", title: "Ontbijtgranen", amount: 1, added_on: DAY }];
  const snap = stockSnapshot(rows, item, at(9));
  assert.deepEqual([snap.days, snap.stored, snap.left, snap.empty_on, snap.lasts], [9, 1, 0, at(7), 7]);
  assert.equal(impliedRate("op", snap), 1 / 9);
  assert.equal(impliedRate("list", snap), null, "2 days past the predicted end: within the slack");
  assert.equal(stockSnapshot([{ ...rows[0], amount_on: at(10) }], item, at(9)), null, "a row set after the day says nothing");
});

test("op replay gives the same result: two phones applying the same ops agree, and an op applied twice teaches once", () => {
  const run = () => {
    const s = emptyState();
    apply(s, { type: "pantry.add", id: "pantry-learn-rp01", item_id: "item-learn-rp0001", title: "Ontbijtgranen", amount: 1, on: DAY }, DAY);
    apply(s, { type: "item.rate", item_id: "item-learn-rp0001", use_per_day: 1 / 7, source: "person", on: DAY }, DAY);
    const take = { type: "pantry.use", reason: "used", on: at(9), takes: [{ event_id: "event-learn-rp01", pantry_id: "pantry-learn-rp01", amount: null }] };
    apply(s, take, at(9));
    apply(s, take, at(10));                                                          // replayed later: already applied
    apply(s, { type: "pantry.add", id: "pantry-learn-rp02", item_id: "item-learn-rp0001", title: "Ontbijtgranen", amount: 1, on: at(9) }, at(9));
    apply(s, { type: "entry.add", id: "entry-learn-rp01", item_id: "item-learn-rpx01", title: "Ontbijtgranen", on: at(30) }, at(30));
    apply(s, { type: "entry.add", id: "entry-learn-rp01", item_id: "item-learn-rpx01", title: "Ontbijtgranen", on: at(30) }, at(31));
    return s.items["item-learn-rp0001"];
  };
  const a = run();
  const b = run();
  assert.deepEqual(a, b);
  assert.equal(a.rate_samples, 2, "the op once, the list once");
});

// ------------------------------------------------------------------- D1

const HOST = "groceries.localhost";
function call(env, method, p, { body, cookie } = {}) {
  const headers = { Origin: `http://${HOST}` };
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`http://${HOST}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
let counter = 0;
const withId = (o) => ({ op_id: `op-learn-${String(++counter).padStart(6, "0")}`, ...o });

test("D1: the server learns what the phone learns (op, list, rebuy, undo), and the columns travel in the delta", async () => {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const thomas = tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456" } }));
  const today = new Date().toISOString().slice(0, 10);
  const ago = (d) => addDays(today, -d);
  const oats = { id: "product-learn-d1oat", name: "Havermout", brand: "AH", size: "500 g" };
  const ops = [
    { type: "pantry.add", id: "pantry-learn-d1-01", item_id: "item-learn-d1-oats", title: "Ontbijtgranen", amount: 1, on: ago(60) },
    { type: "item.rate", item_id: "item-learn-d1-oats", use_per_day: 1 / 7, source: "person", on: ago(60) },
    { type: "pantry.use", reason: "used", on: ago(51), takes: [{ event_id: "event-learn-d1-01", pantry_id: "pantry-learn-d1-01", amount: null }] },
    { type: "pantry.add", id: "pantry-learn-d1-02", item_id: "item-learn-d1-oats", title: "Ontbijtgranen", amount: 2, on: ago(51) },
    { type: "pantry.use", reason: "used", on: ago(42), takes: [{ event_id: "event-learn-d1-02", pantry_id: "pantry-learn-d1-02", amount: null }] },
    { type: "pantry.unuse", event_ids: ["event-learn-d1-02"] },
    // Undone, then "op" again 4 days later: it counts from what the undo put back, as of the first "op" (the last settled day).
    { type: "pantry.use", reason: "used", on: ago(38), takes: [{ event_id: "event-learn-d1-03", pantry_id: "pantry-learn-d1-02", amount: null }] },
    { type: "pantry.add", id: "pantry-learn-d1-03", item_id: "item-learn-d1-hav", title: "Havermout", amount: 1, on: ago(60) },
    ...[4, 3, 2].map((w) => ({ type: "purchase.add", id: `purchase-learn-d1-h${w}`, title: "Havermout", bought_on: ago(100 + 7 * w), store: "Albert Heijn",
      qty: 1, price_cents: 199, source: "receipt", product: oats })),
    { type: "item.rate", item_id: "item-learn-d1-hav", use_per_day: 1 / 14, source: "person", on: ago(60) },
    { type: "purchase.add", id: "purchase-learn-d1-new", title: "Havermout", bought_on: ago(2), store: "Albert Heijn", qty: 1, price_cents: 199,
      source: "receipt", pantry: true, product: oats },
    { type: "pantry.add", id: "pantry-learn-d1-04", item_id: "item-learn-d1-tij", title: "Minoes eten", amount: 30, on: ago(10) },
    { type: "item.rate", item_id: "item-learn-d1-tij", use_per_day: 6 / 7, source: "person", on: ago(10) },
    { type: "entry.add", id: "entry-learn-d1-01", item_id: "item-learn-d1-tjx", title: "Minoes eten", on: today },
  ];
  // Sent one by one, as phones do.
  for (const o of ops) {
    const [res] = (await (await call(env, "POST", "/api/ops", { cookie: thomas, body: { ops: [withId(o)] } })).json()).results;
    assert.equal(res.ok, true, `${o.type}: ${JSON.stringify(res)}`);
  }
  // The phone holds everything and applies the same ops.
  const phone = emptyState();
  for (const o of ops) applyOp(phone, o, { memberId: "member-x", isAdmin: true, now: `${today}T10:00:00.000Z` });
  const all = await (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();
  const server = Object.fromEntries(all.items.map((i) => [i.id, i]));
  for (const id of ["item-learn-d1-oats", "item-learn-d1-hav", "item-learn-d1-tij"]) {
    const pick = (i) => [i.use_per_day, i.rate_source, i.rate_samples];
    assert.deepEqual(pick(server[id]), pick(phone.items[id]), id);
    assert.equal(server[id].rate_source, "learned", id);
  }
  assert.equal(server["item-learn-d1-oats"].rate_samples, 2, "two ops; the undone one undone");
  assert.equal(server["item-learn-d1-hav"].rate_samples, 1, "the rebuy at the usual price");
  assert.equal(server["item-learn-d1-tij"].rate_samples, 1, "on the list with ~25 days predicted left");
  const ev = all.pantry_events.find((e) => e.id === "event-learn-d1-03");
  assert.deepEqual(ev.rate_before, phone.pantry_events["event-learn-d1-03"].rate_before, "the event keeps the rate before, as JSON");
  assert.deepEqual([ev.rate_before.rate_source, ev.rate_before.rate_samples], ["learned", 1]);
});

// ------------------------------------------------- tools/seed_rates.mjs

test("seed_rates: proposals from the purchase history; never an excluded thing, hidden, low_off or recipe-only; Claude's estimates only", async () => {
  const { proposeRates, seedOps, historyRate, MIN_PURCHASES, WINDOW_DAYS } = await import("../tools/seed_rates.mjs");
  assert.deepEqual([MIN_PURCHASES, WINDOW_DAYS], [4, 365]);
  const today = "2026-10-30";
  const items = {};
  const purchases = {};
  const add = (id, name, extra = {}) => { items[id] = { id, name, deleted_at: null, ...extra }; };
  const buy = (itemId, days, qty = 1) => days.forEach((d) => {
    const id = `purchase-${itemId}-${d}`;
    purchases[id] = { id, item_id: itemId, title: items[itemId].name, bought_on: addDays(today, -d), qty, deleted_at: null };
  });
  add("item-cereal", "Ontbijtgranen"); buy("item-cereal", [5, 15, 24, 35, 44]);            // every ~10 days
  add("item-tp", "Toiletpapier"); buy("item-tp", [10, 30, 50, 70, 90]);                  // the default rule: 1 per 28 d
  add("item-cat", "Minoes eten", { use_per_day: 6 / 7, rate_source: "person" }); buy("item-cat", [7, 14, 21, 28], 3);
  add("item-sprt", "Groene Ster spruitjes"); buy("item-sprt", [5, 15, 25, 35]);
  add("item-hide", "Chips", { again: "hide" }); buy("item-hide", [5, 15, 25, 35]);
  add("item-off", "Yoghurt", { low_off: 1 }); buy("item-off", [5, 15, 25, 35]);
  add("item-gehakt", "Gehakt"); buy("item-gehakt", [5, 15, 25, 35]);
  add("item-odd", "Pindakaas"); buy("item-odd", [1, 2, 3, 200]);                         // irregular
  add("item-few", "Thee"); buy("item-few", [10, 20, 30]);                                // 3 times only
  add("item-old", "Koffie"); buy("item-old", [400, 410, 420, 430, 440]);                 // outside the window
  const recipes = { r1: { id: "r1", title: "Spaghetti", ingredients: [{ name: "gehakt", qty: 500, unit: "g" }], deleted_at: null } };
  const out = proposeRates({ items, purchases, recipes, pantry: {} }, today);
  assert.deepEqual(out.map((p) => [p.item.name, p.action]), [["Toiletpapier", "update"], ["Ontbijtgranen", "new"], ["Minoes eten", "keep"]]);
  const cereal = out.find((p) => p.item.name === "Ontbijtgranen");
  assert.equal(cereal.proposed, 4 / 39, "4 packs before the last shopping day, over 39 days");
  const ops = seedOps(out, today);
  assert.deepEqual(ops.map((o) => [o.type, o.item_id, o.source]), [["item.rate", "item-tp", "claude"], ["item.rate", "item-cereal", "claude"]], "the person's rate is not written");
  assert.equal(new Set(seedOps(out, today).map((o) => o.op_id)).size, 2);
  assert.deepEqual(seedOps(out, today).map((o) => o.op_id), ops.map((o) => o.op_id), "stable op ids: a second run is a replay");
  assert.equal(historyRate([], today).per_day, null);
});
