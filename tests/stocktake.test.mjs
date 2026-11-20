// The stocktake walk, "Nalopen" (20-11-2026: "ik denk dat mn hele
// voorraad inmiddels uit balans is"): public/shared/stocktake.js, the op
// pantry.check, the "count" lesson, the household pack on a tick and
// tools/fill_pantry_sizes.mjs. Fictional names only.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { applyOp, emptyState } from "../public/shared/ops.js";
import { withUsage, sizeFor, packText, tickPackSize } from "../public/shared/pantry.js";
import { addDays } from "../public/shared/shelf-life.js";
import { impliedRate, SIGNALS } from "../public/shared/rate-learning.js";
import {
  CHECK_DAYS, TIERS, trustedOn, rowNeedsCheck, walkGroups, walkQueue, walkProgress, lessChoices, answerOp, amountParts,
} from "../public/shared/stocktake.js";
import { planSizes, sizeOps, simulate, sizeOpId } from "../tools/fill_pantry_sizes.mjs";

const DAY = "2026-10-28";
const at = (d) => addDays(DAY, d);
const ctx = (day = DAY, memberId = "member-walk-01") => ({ memberId, isAdmin: true, now: `${day}T10:00:00.000Z` });
let n = 0;
const uid = (kind) => `${kind}-walk-${String(++n).padStart(5, "0")}`;
const apply = (s, op, day = DAY) => applyOp(s, op, ctx(day));
const add = (s, title, { amount = 1, pack_size = "", day = DAY, itemId = uid("item") } = {}) => {
  const id = uid("pantry");
  apply(s, { type: "pantry.add", id, item_id: itemId, title, amount, pack_size, on: day }, day);
  return { id, itemId: s.pantry[id].item_id };
};
/** A line ticked: its row (pe-…) comes from a real shopping. */
const tick = (s, title, day = DAY) => {
  const id = uid("entry");
  apply(s, { type: "entry.add", id, item_id: uid("item"), title, on: day }, day);
  apply(s, { type: "entry.check", id, checked: true, on: day }, day);
  return `pe-${id}`;
};
const queueOf = (s, today, opts = {}) => walkQueue(walkGroups(withUsage(s, today), today, opts), opts.skip);

// ------------------------------------------------------------ the rules

test("trusted: a hand-put row only once checked, a tick or a receipt from the day it came in; CHECK_DAYS later it is asked again", () => {
  assert.equal(CHECK_DAYS, 60);
  assert.equal(trustedOn({ added_on: DAY }), null, "the setup's guess");
  assert.equal(trustedOn({ added_on: DAY, source_entry_id: "e" }), DAY);
  assert.equal(trustedOn({ added_on: DAY, source_purchase_id: "p", checked_on: at(5) }), at(5));
  assert.equal(trustedOn({ added_on: at(5), source_entry_id: "e", checked_on: DAY }), at(5));
  assert.equal(rowNeedsCheck({ added_on: DAY, checked_on: DAY }, at(CHECK_DAYS)), false);
  assert.equal(rowNeedsCheck({ added_on: DAY, checked_on: DAY }, at(CHECK_DAYS + 1)), true);
});

test("the order: setup guesses first, then rows without a size, then the rest, a learned or household rate last; by name within", () => {
  const s = emptyState();
  const rice = add(s, "Rijst", { pack_size: "1 kg" });                   // setup
  const beans = add(s, "Bonen", { pack_size: "400 g" });                 // setup
  const cat = add(s, "Kattenvoer", { amount: 12, pack_size: "85 g" });    // setup, own rate: last
  apply(s, { type: "item.rate", item_id: cat.itemId, use_per_day: 1 / 30, source: "person", on: DAY });
  const milk = tick(s, "Melk");                                          // a tick without a size, never checked: no size
  const tea = tick(s, "Thee");
  apply(s, { type: "pantry.update", id: tea, pack_size: "20 st", on: DAY });
  // A tick is trusted from its day: only asked after CHECK_DAYS.
  const today = at(CHECK_DAYS + 1);
  const q = queueOf(s, today);
  assert.deepEqual(q.map((g) => g.name), ["Bonen", "Rijst", "Melk", "Thee", "Kattenvoer"]);
  assert.deepEqual(q.map((g) => g.tier), [TIERS.setup, TIERS.setup, TIERS.no_size, TIERS.rest, TIERS.own_rate]);
  assert.deepEqual(queueOf(s, at(1)).map((g) => g.name), ["Bonen", "Rijst", "Kattenvoer"], "ticks are fresh");
  assert.ok(rice && beans && milk);
});

test("rows of one item are one thing; what the app thinks reads '¾ pak · 1 l'; never an excluded thing; private only to its owner", () => {
  const s = emptyState();
  const a = add(s, "Melk", { amount: 1, pack_size: "1 l" });
  add(s, "Melk", { amount: 0.75, pack_size: "1 l", itemId: a.itemId, day: at(1) });
  // An excluded thing never gets a row; one written before the list knew it is still never walked.
  s.pantry["pantry-walk-old"] = { ...s.pantry[a.id], id: "pantry-walk-old", item_id: "item-walk-old", title: "Spruitjes" };
  const own = add(s, "Geheime koek");
  s.items[own.itemId].private_to = "member-walk-02";
  const view = withUsage(s, at(2));
  const groups = walkGroups(view, at(2), { memberId: "member-walk-01" });
  assert.deepEqual(groups.map((g) => [g.name, g.rows.length, g.amount]), [["Melk", 2, 1.75]]);
  assert.deepEqual(amountParts(groups[0]), [{ amount: 1.75, size: "1 l" }]);
  const theirs = walkGroups(view, at(2), { memberId: "member-walk-02" });
  assert.deepEqual(theirs.map((g) => g.name).sort(), ["Geheime koek", "Melk"]);
});

test("'Minder' choices: under one pack ¾ ½ ¼, more: the last pack's quarters then whole packs; never 0", () => {
  assert.deepEqual(lessChoices(1), [0.75, 0.5, 0.25]);
  assert.deepEqual(lessChoices(0.75), [0.5, 0.25]);
  assert.deepEqual(lessChoices(0.25), []);
  assert.deepEqual(lessChoices(2), [1.75, 1.5, 1.25, 1]);
  assert.deepEqual(lessChoices(2.5), [2.25, 2, 1]);
  assert.deepEqual(lessChoices(12), [11.75, 11.5, 11.25, 11, 10, 9, 8, 7]);
});

// ------------------------------------------------------------ the op

test("pantry.check: 'Klopt' confirms every row as shown, 'Minder' comes off the oldest first, 'Meer' on the newest; a replay changes nothing", () => {
  const s = emptyState();
  const a = add(s, "Pasta", { amount: 1, pack_size: "500 g" });
  const b = add(s, "Pasta", { amount: 1, pack_size: "500 g", itemId: a.itemId, day: at(1) });
  const group = () => walkGroups(withUsage(s, at(2)), at(2))[0];
  apply(s, answerOp(group(), "right", at(2)), at(2));
  assert.deepEqual([s.pantry[a.id].checked_on, s.pantry[b.id].checked_on], [at(2), at(2)]);
  assert.deepEqual([s.pantry[a.id].amount, s.pantry[b.id].amount], [1, 1], "Klopt changes no amount");
  assert.equal(queueOf(s, at(2)).length, 0, "checked: out of the walk");
  apply(s, answerOp(group(), "less", at(3), 0.5), at(3));
  assert.ok(s.pantry[a.id].deleted_at, "the oldest goes first");
  assert.equal(s.pantry[b.id].amount, 0.5);
  assert.equal(s.pantry[b.id].checked_on, at(3));
  const more = answerOp(group(), "more", at(4));
  apply(s, more, at(4));
  assert.equal(s.pantry[b.id].amount, 1.5);
  apply(s, more, at(4));
  assert.equal(s.pantry[b.id].amount, 1.5, "an absolute total: the same op again is a replay");
  assert.throws(() => apply(s, { type: "pantry.check", ids: [b.id], on: at(4), amount: 0 }, at(4)), /bad_field/, "0 is 'Op' (pantry.use)");
  const other = add(s, "Rijst");
  assert.throws(() => apply(s, { type: "pantry.check", ids: [b.id, other.id], on: at(4) }, at(4)), /bad_field/, "one item per check");
  assert.deepEqual(apply(s, { type: "pantry.check", ids: ["pantry-walk-gone"], on: at(4) }, at(4)).result, {}, "gone on another phone: nothing");
});

test("resume: stopping halfway and walking again asks only what is left, the passed-over ones too", () => {
  const s = emptyState();
  for (const name of ["Anijs", "Bloem", "Cacao", "Dille"]) add(s, name, { pack_size: "100 g" });
  const today = at(1);
  let q = queueOf(s, today);
  assert.equal(walkProgress(walkGroups(withUsage(s, today), today)).done, 0);
  apply(s, answerOp(q[0], "right", today), today);
  apply(s, answerOp(q[1], "less", today, 0.5), today);
  const skip = new Set([queueOf(s, today)[0].item_id]);
  q = queueOf(s, today, { skip });
  assert.deepEqual(q.map((g) => g.name), ["Dille"], "Cacao passed over in this walk");
  // A new walk (the page opened again): the skip is gone.
  assert.deepEqual(queueOf(s, today).map((g) => g.name), ["Cacao", "Dille"]);
  assert.deepEqual(walkProgress(walkGroups(withUsage(s, today), today)), { done: 2, total: 4 });
});

// ------------------------------------------------------------ teaching

test("'Minder' on a counted-down thing teaches its rate (count, middle); 'Klopt' and 'Meer' never; a thing without a rate learns nothing", () => {
  assert.equal(SIGNALS.count, "middle");
  // Predicted ¾ left after 10 days, really ¼: 0.75 used in 10 days.
  assert.equal(impliedRate("count", { per_day: 0.025, days: 10, stored: 1, left: 0.75 }, { counted: 0.25 }), 0.075);
  assert.equal(impliedRate("count", { per_day: 0.025, days: 10, stored: 1, left: 0.75 }, { counted: 0.75 }), null, "as predicted");
  assert.equal(impliedRate("count", { per_day: 0.025, days: 2, stored: 1, left: 0.95 }, { counted: 0.25 }), null, "too young");
  const s = emptyState();
  const soap = add(s, "Handzeep", { amount: 1, pack_size: "250 ml" });
  apply(s, { type: "item.rate", item_id: soap.itemId, use_per_day: 1 / 40, source: "claude", on: DAY });
  const g = (day) => walkGroups(withUsage(s, day), day)[0];
  apply(s, answerOp(g(at(10)), "right", at(10)), at(10));
  assert.equal(s.items[soap.itemId].rate_source, "claude", "Klopt on an estimate teaches nothing");
  assert.equal(s.pantry[soap.id].amount_on, at(10), "but settles: the next lesson counts from the confirmed amount");
  apply(s, answerOp(g(at(20)), "more", at(20)), at(20));
  assert.equal(s.items[soap.itemId].rate_source, "claude", "Meer teaches nothing (a forgotten pack)");
  apply(s, answerOp(g(at(30)), "less", at(30), 0.5), at(30));
  const it = s.items[soap.itemId];
  assert.equal(it.rate_source, "learned");
  assert.equal(it.rate_samples, 1);
  assert.ok(it.use_per_day > 1 / 40 && it.use_per_day <= (1 / 40) * 1.25 + 1e-12, "faster, at most 25%");
  const plain = add(s, "Bloem", { amount: 1, pack_size: "1 kg" });
  apply(s, { type: "pantry.check", ids: [plain.id], amount: 0.25, on: at(30) }, at(30));
  assert.equal(s.items[plain.itemId].rate_source ?? null, null, "no rate, no lesson");
});

test("'Op' in the walk is pantry.use: the strong lesson as everywhere", () => {
  const s = emptyState();
  const tp = add(s, "Wc-papier", { amount: 1, pack_size: "8 rollen" });
  apply(s, { type: "item.rate", item_id: tp.itemId, use_per_day: 1 / 20, source: "claude", on: DAY });
  apply(s, { type: "pantry.use", reason: "used", on: at(10), takes: [{ event_id: uid("event"), pantry_id: tp.id, amount: null }] }, at(10));
  assert.equal(s.items[tp.itemId].rate_source, "learned");
});

// ------------------------------------------------------------ sizes

/** An item with a product of `size` bought twice. */
function bought(s, title, size) {
  apply(s, { type: "purchase.add", id: uid("purchase"), item_id: uid("item"), title, bought_on: at(-30), store: "Albert Heijn", qty: 1, price_cents: 100,
    source: "receipt", product: { id: uid("product"), name: title, brand: "AH", size } });
  return Object.values(s.items).find((i) => i.name === title).id;
}

test("a tick without a size gets the household's pack; pieces on the line keep none; a size on the line wins", () => {
  assert.equal(packText({ qty: 1000, base: "ml" }), "1 l");
  assert.equal(packText({ qty: 1500, base: "ml" }), "1500 ml");
  assert.equal(packText({ qty: 500, base: "g" }), "500 g");
  assert.equal(packText({ qty: 10, base: "piece" }), "10 st");
  const s = emptyState();
  const milk = bought(s, "Melk", "1 l");
  const eggs = bought(s, "Eieren", "10 st");
  const line = (title, amounts) => {
    const id = uid("entry");
    apply(s, { type: "entry.add", id, item_id: title === "Melk" ? milk : eggs, title, ...(amounts ? { amounts } : {}), on: DAY });
    apply(s, { type: "entry.check", id, checked: true, on: DAY });
    return s.pantry[`pe-${id}`];
  };
  assert.equal(line("Melk").pack_size, "1 l");
  assert.equal(line("Melk", [{ qty: 2, unit: null }]).pack_size, "1 l", "2 melk: two cartons of 1 l");
  assert.equal(line("Melk", [{ qty: 500, unit: "ml" }]).pack_size, "500 ml", "the line's own size");
  assert.equal(line("Eieren", [{ qty: 6, unit: null }]).pack_size, "", "6 eieren are pieces, not 6 boxes");
  assert.equal(line("Eieren").pack_size, "10 st");
  assert.equal(tickPackSize(s, { amounts: [{ qty: 3, unit: "piece" }] }, { item_id: milk, amount: 3, pack_size: "" }), "");
});

test("fill_pantry_sizes: only rows without a size whose pack is known; the amount stays; stable ids; never an excluded thing", () => {
  const s = emptyState();
  const tea = bought(s, "Thee", "20 st");
  const oil = bought(s, "Olie", "1 l");
  add(s, "Thee", { amount: 1, itemId: tea });
  add(s, "Thee", { amount: 3, itemId: tea, day: at(1) });             // 3 of a 20 st pack: pieces, left alone
  const o = add(s, "Olie", { amount: 0.5, itemId: oil });
  add(s, "Olie", { amount: 1, itemId: oil, pack_size: "500 ml" });   // has one
  add(s, "Zout", { amount: 1 });                                     // nothing known
  s.pantry["pantry-walk-old2"] = { ...s.pantry[o.id], id: "pantry-walk-old2", title: "Spruitjes", item_id: "item-walk-old2" };
  const plan = planSizes(s);
  assert.deepEqual(plan.map((x) => [x.row.title, x.row.amount, x.pack_size]), [["Olie", 0.5, "1 l"], ["Thee", 1, "20 st"]]);
  assert.equal(sizeFor(s, s.pantry[o.id]), "1 l");
  const ops = sizeOps(plan, at(1));
  assert.equal(ops[0].op_id, sizeOpId(o.id, "1 l"));
  assert.deepEqual(simulate(s, ops).map((x) => [x.ok, x.amount]), [[true, 0.5], [true, 1]]);
  for (const op of ops) apply(s, op, at(1));
  assert.equal(s.pantry[o.id].pack_size, "1 l");
  assert.equal(s.pantry[o.id].amount, 0.5);
  assert.equal(planSizes(s).length, 0, "a second run finds nothing");
  assert.throws(() => apply(s, { type: "pantry.update", id: o.id, pack_size: "los", on: at(1) }, at(1)), /bad_field/);
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
const withId = (o) => ({ op_id: `op-walk-${String(++counter).padStart(6, "0")}`, ...o });

test("D1: the server does what the phone does (check, count lesson, tick with the household pack), and checked_on travels", async () => {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const thomas = tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456" } }));
  const today = new Date().toISOString().slice(0, 10);
  const ago = (d) => addDays(today, -d);
  const ops = [
    { type: "purchase.add", id: "purchase-walk-d1-01", item_id: "item-walk-d1-milk", title: "Melk", bought_on: ago(40), store: "Albert Heijn", qty: 1, price_cents: 120,
      source: "receipt", product: { id: "product-walk-d1-milk", name: "Melk", brand: "AH", size: "1 l" } },
    { type: "pantry.add", id: "pantry-walk-d1-01", item_id: "item-walk-d1-soap", title: "Handzeep", amount: 1, pack_size: "250 ml", on: ago(30) },
    { type: "item.rate", item_id: "item-walk-d1-soap", use_per_day: 1 / 80, source: "claude", on: ago(30) },
    { type: "pantry.check", ids: ["pantry-walk-d1-01"], on: ago(20) },
    { type: "pantry.check", ids: ["pantry-walk-d1-01"], amount: 0.25, on: today },
    { type: "entry.add", id: "entry-walk-d1-01", item_id: "item-walk-d1-x", title: "Melk", on: today },
    { type: "entry.check", id: "entry-walk-d1-01", checked: true, on: today },
  ];
  for (const o of ops) {
    const [res] = (await (await call(env, "POST", "/api/ops", { cookie: thomas, body: { ops: [withId(o)] } })).json()).results;
    assert.equal(res.ok, true, `${o.type}: ${JSON.stringify(res)}`);
  }
  const phone = emptyState();
  for (const o of ops) applyOp(phone, o, { memberId: "member-x", isAdmin: true, now: `${today}T10:00:00.000Z` });
  const all = await (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();
  const soap = all.items.find((i) => i.id === "item-walk-d1-soap");
  const pick = (i) => [i.use_per_day, i.rate_source, i.rate_samples];
  assert.deepEqual(pick(soap), pick(phone.items["item-walk-d1-soap"]));
  assert.equal(soap.rate_source, "learned");
  const row = all.pantry.find((r) => r.id === "pantry-walk-d1-01");
  assert.deepEqual([row.amount, row.checked_on], [0.25, today]);
  const ticked = all.pantry.find((r) => r.id === "pe-entry-walk-d1-01");
  assert.equal(ticked.pack_size, "1 l", "the server found the household pack too");
  assert.equal(phone.pantry["pe-entry-walk-d1-01"].pack_size, "1 l");
});
