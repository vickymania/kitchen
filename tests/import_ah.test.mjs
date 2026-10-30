// tools/import_ah.mjs on a made-up fixture: no network, no personal data.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { applyOp, emptyState } from "../public/shared/ops.js";
import { dueItems } from "../public/shared/intervals.js";
import { stableId } from "../tools/import_todo.mjs";
import {
  normaliseReceipt, vocabulary, mapProduct, buildOps, discountTarget, itemIdFor, localDay, guessName, isOwn, OTHER_PEOPLE_CITIES, OWNERS,
} from "../tools/import_ah.mjs";

const POS = { 101: 543345, 102: 526385, 103: 9001, 104: 450535, 105: -1, 106: 9002, 107: 9003, 108: 467677, 109: 9006, 110: 9007, 111: 9008 };
const CARDS = {
  543345: { title: "AH Beenham", brand: "AH", size: "150 g" },
  526385: { title: "Pringles Naturel value pack", brand: "Pringles", size: "300 g" },
  9001: { title: "Groenhof Spruitjes", brand: "Groenhof", size: "6 x 330 ml" },
  450535: { title: "AH Houdbare volle melk", brand: "AH", size: "1 l" },
  9002: { title: "AH Avocado", brand: "AH", size: "2 stuks" },
  9003: { title: "AH Schouderham", brand: "AH", size: "150 g" },
  467677: { title: "AH Kip börek rol", brand: "AH", size: "per stuk" },
  9006: { title: "AH Bulgur", brand: "AH", size: "500 g" },
  9007: { title: "AH Halfvolle melk", brand: "AH", size: "1 l" },
  9008: { title: "AH Biologisch Groenhof", brand: "AH Biologisch", size: "0,75 l" },
};
const line = (id, name, amount, quantity = 1) => ({ id, quantity, name, price: null, amount: { amount } });
const RAW = [
  [{ id: "AH0000000000000000000000000001", dateTime: "2026-09-30T22:30:00.000Z", total: 16.0 }, {
    products: [line(101, "AH BEENHAM", 1.65), line(102, "PRINGLES CHIPS", 2.69), line(103, "GROENHOF", 9.49),
      line(0, "STATIEGELD", 0.15), line(0, "DRAAGTAS", 0.25), line(106, "AH AVOCADO", 3.29), line(110, "AH HV MELK", 1.09),
      line(111, "AH BIO GROENHOF", 6.99)],
    discounts: [{ name: "AH AVOCADO", amount: { amount: -1.15 } }, { name: "ALLEMORACLAS", amount: { amount: -2.17 } }],
  }],
  [{ id: "AH0000000000000000000000000002", dateTime: "2026-10-05T10:00:00.000Z", total: 6.03 }, {
    products: [line(107, "SCHOUDERHAM", 1.89), line(101, "AH BEENHAM", 1.65), line(105, "MONSTER", 2.49), line(110, "AH HV MELK", 1.09), line(102, "PRINGLES CHIPS", 2.69)],
    discounts: [],
  }],
  [{ id: "AH0000000000000000000000000003", dateTime: "2026-10-09T10:00:00.000Z", total: 6.0 }, {
    products: [line(107, "SCHOUDERHAM", 3.78, 2), line(104, "AH VOL MELK", 0.98), line(108, "BOREK KIP", 1.19), line(109, "AH BULGUR", 1.79)],
    discounts: [],
  }],
];
// The account also holds Noor's receipts, paid in the towns of
// OTHER_PEOPLE_CITIES (household data in the private table tools/ah_items.mjs);
// every other town is Thomas's, and so is a receipt without one.
const [TOWN_A, TOWN_B] = OTHER_PEOPLE_CITIES;
const CITY = ["Groningen", "ZEIST UTR", null, TOWN_A.toUpperCase()];
RAW.push([{ id: "AH0000000000000000000000000004", dateTime: "2026-10-10T10:00:00.000Z", total: 2.49 }, {
  products: [line(112, "AH TOFU", 2.49), line(101, "AH BEENHAM", 1.65)],
  discounts: [],
}]);
POS[112] = 9009;
CARDS[9009] = { title: "AH Tofu naturel", brand: "AH", size: "375 g" };
const everyReceipt = () => RAW.map(([s, raw], i) => normaliseReceipt(s, raw, POS, CARDS, CITY[i]));
const receipts = () => everyReceipt().filter((r) => isOwn(r));
const VOCAB = vocabulary(["Ham", "ham", "Melk", "Chips", "Avocado", "Eten"]);

test("AH import: a receipt's day is the day in Amsterdam", () => {
  assert.equal(localDay("2026-09-30T22:30:00.000Z"), "2026-10-01");
  assert.equal(receipts()[0].day, "2026-10-01");
});

test("AH import: receipts paid in Noor's towns are left out, unless owners.json says otherwise", () => {
  assert.ok(OTHER_PEOPLE_CITIES.length >= 2 && OTHER_PEOPLE_CITIES.every((c) => c === c.toLowerCase()), "nameKeys");
  const all = everyReceipt();
  assert.deepEqual(all.map((r) => isOwn(r)), [true, true, true, false], "the town in any case; no town is Thomas's");
  assert.equal(isOwn({ id: "x", city: TOWN_B[0].toUpperCase() + TOWN_B.slice(1) }), false);
  assert.equal(isOwn(all[3], { [all[3].id]: OWNERS.own }), true);
  assert.equal(isOwn(all[0], { [all[0].id]: OWNERS.others[0] }), false);
  assert.equal(isOwn(all[1], { [all[1].id]: "skip" }), false);
  const { ops, preferred } = buildOps(all.filter((r) => isOwn(r)), VOCAB);
  const text = JSON.stringify(ops);
  assert.ok(!text.includes("Tofu") && !text.includes("AH0000000000000000000000000004"), "nothing of Noor's receipt");
  assert.equal(preferred.get("ham").id, "ah-product-9003", "Noor's beenham does not count for the preference");
});

test("AH import: mapping rules (table, brand, exact, compound, guess)", () => {
  const [r1, r2, r3] = receipts();
  const by = (r, name) => mapProduct(r.lines.find((l) => l.receiptName === name), VOCAB);
  assert.deepEqual(by(r1, "AH AVOCADO"), { item: "Avocado", how: "exact" });
  assert.deepEqual(by(r1, "AH BEENHAM"), { item: "Ham", how: "rule" }, "beenham is ham");
  assert.deepEqual(by(r1, "AH HV MELK"), { item: "Melk", how: "rule" });
  assert.deepEqual(by(r1, "PRINGLES CHIPS"), { item: "Chips", how: "rule" }, "Pringles is chips by brand");
  assert.deepEqual(by(r2, "MONSTER"), { item: "Energy drink", how: "rule" }, "no product card: the till name's first word");
  assert.deepEqual(by(r3, "BOREK KIP"), { item: "Börek", how: "rule", table: true });
  assert.deepEqual(by(r3, "AH BULGUR"), { item: "Bulgur", how: "guess" });
  assert.equal(guessName("Kersencake met banketbakkersroom"), "Kersencake");
  assert.equal(guessName("Gezouten pinda's"), "Gezouten pindas");
  assert.equal(VOCAB.get("ham").name, "Ham", "the capitalised spelling wins");
  assert.equal(VOCAB.has("eten"), false, "generic lines are no item");
});

test("AH import: excluded is dropped before anything is built", () => {
  const rs = receipts();
  assert.equal(rs[0].dropped.excluded, 2, "Groenhof and a sprouts named only by its grape");
  const { ops } = buildOps(rs, VOCAB);
  const text = JSON.stringify(ops).toLowerCase();
  assert.ok(!text.includes("groenhof") && !text.includes("groenhof"));
});

test("AH import: deposits, bags and discounts", () => {
  const [r1] = receipts();
  const kinds = Object.fromEntries(r1.lines.map((l) => [l.receiptName, l.kind]));
  assert.equal(kinds.STATIEGELD, "deposit");
  assert.equal(kinds.DRAAGTAS, "other");
  assert.equal(kinds.ALLEMORACLAS, "discount", "a discount that fits no line clearly stays its own line");
  assert.equal(kinds["AH AVOCADO"], "product", "the clear discount is folded into its product");
  assert.equal(r1.lines.find((l) => l.receiptName === "AH AVOCADO").price_cents, 214);
  const { ops } = buildOps([r1], VOCAB);
  const titles = ops.filter((o) => o.type === "purchase.add").map((o) => o.title);
  assert.deepEqual(titles.sort(), ["Avocado", "Chips", "Ham", "Melk"]);
  const coolbest = [{ receiptName: "COOLBEST", posId: 1 }, { receiptName: "COOLBEST", posId: 1 }, { receiptName: "FOCACCIA PEP", posId: 2 }];
  assert.equal(discountTarget("COOLBEST100%", coolbest).length, 2, "two lines of one product");
  assert.equal(discountTarget("ALLEMORACLAS", [{ receiptName: "MORA CRISPY", posId: 1 }, { receiptName: "MORA VIANDEL", posId: 2 }]), null);
});

test("AH import: the preferred product is the one on most receipts, then the most recent, and on 2 or more", () => {
  const { preferred, ops } = buildOps(receipts(), VOCAB);
  assert.deepEqual([...preferred.keys()].sort(), ["chips", "ham", "melk"], "avocado, Monster, börek and bulgur: one receipt each");
  // Ham: beenham on 2 receipts, schouderham on 2 with the later day.
  assert.equal(preferred.get("ham").id, "ah-product-9003");
  // Melk: halfvolle on 2 receipts beats volle on 1, although volle is newer.
  assert.equal(preferred.get("melk").id, "ah-product-9007");
  const pref = ops.find((o) => o.type === "preference.set" && o.title === "Ham");
  assert.equal(pref.store, "Albert Heijn");
  assert.equal(pref.only_if_unset, true);
  assert.equal(pref.recipe_id, undefined, "any recipe");
});

test("AH import: never overwrites a preference someone set or cleared", () => {
  const ctx = { memberId: "member-thomas-01", isAdmin: true, now: "2026-10-28T10:00:00.000Z" };
  const s = emptyState();
  const ham = itemIdFor("Ham");
  const melk = itemIdFor("Melk");
  applyOp(s, { type: "product.put", id: "prod-thomas-01", product: { name: "Zandvoortse ham", store: "AH" } }, ctx);
  applyOp(s, { type: "preference.set", id: "pref-thomas-01", title: "Ham", item_id: ham, store: "AH", product_id: "prod-thomas-01" }, ctx);
  applyOp(s, { type: "preference.set", id: "pref-thomas-02", title: "Melk", item_id: melk, store: "Albert Heijn", product_id: "prod-thomas-01" }, ctx);
  applyOp(s, { type: "preference.clear", item_id: melk, store: "Albert Heijn" }, ctx);
  for (const op of buildOps(receipts(), VOCAB).ops) applyOp(s, op, ctx);
  const live = Object.values(s.preferences);
  assert.equal(live.find((p) => p.item_id === ham).product_id, "prod-thomas-01");
  assert.ok(live.find((p) => p.item_id === melk).deleted_at, "a cleared preference stays cleared");
  assert.equal(live.find((p) => p.item_id === itemIdFor("Chips")).product_id, "ah-product-526385", "an item without one gets it");
  assert.ok(!live.some((p) => p.item_id === itemIdFor("Avocado")), "bought on one receipt: no preference");
});

test("AH import: op ids are stable and unique, and only new receipts are sent", () => {
  const a = buildOps(receipts(), VOCAB).ops;
  const b = buildOps(receipts(), VOCAB).ops;
  assert.deepEqual(a, b);
  assert.equal(new Set(a.map((o) => o.op_id)).size, a.length);
  assert.equal(a.find((o) => o.type === "receipt.save").id, "ah-AH0000000000000000000000000001");
  assert.equal(itemIdFor("Ham"), stableId("item", "history:ham"), "the same item id as the To Do history import");
  const only = buildOps(receipts(), VOCAB, { only: new Set(["AH0000000000000000000000000003"]) }).ops;
  assert.deepEqual(only.filter((o) => o.type === "receipt.save").map((o) => o.id), ["ah-AH0000000000000000000000000003"]);
  assert.ok(only.filter((o) => o.type === "purchase.add").every((o) => o.receipt_id === "ah-AH0000000000000000000000000003"));
  assert.ok(!only.some((o) => o.type === "product.put" && o.id === "ah-product-526385"), "chips were not on that receipt");
});

test("AH import: a To Do purchase and an AH purchase on one day count as one day", () => {
  const items = { [itemIdFor("Ham")]: { id: itemIdFor("Ham"), name: "Ham" } };
  const purchases = {};
  const add = (id, day) => { purchases[id] = { id, item_id: itemIdFor("Ham"), title: "Ham", bought_on: day }; };
  for (const d of ["2026-09-01", "2026-09-11", "2026-09-21"]) add(`history-${d}`, d);
  for (const d of ["2026-09-11", "2026-09-21"]) add(`ah-${d}`, d);
  const [ham] = dueItems({ items, purchases, entries: {} }, "2026-09-25");
  assert.equal(ham.interval, 10, "with both counted the gaps would be 10, 0, 10, 0");
});

test("AH import: the ops pass the real worker, and a second run changes nothing", async () => {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const host = "groceries.localhost:8787";
  const call = (method, p, body, cookie) => worker.fetch(new Request(`http://${host}${p}`, {
    method,
    headers: { Origin: `http://${host}`, ...(cookie ? { Cookie: `kd=${cookie}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  const res = await call("POST", "/api/pair", { code: "123456" });
  const cookie = res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
  const { ops } = buildOps(receipts(), VOCAB);
  const push = async () => {
    const out = [];
    for (let i = 0; i < ops.length; i += 50) out.push(...(await (await call("POST", "/api/ops", { ops: ops.slice(i, i + 50) }, cookie)).json()).results);
    return out;
  };
  const first = await push();
  assert.deepEqual(first.filter((r) => !r.ok), []);
  const { rev } = await (await call("GET", "/api/sync?since=0", undefined, cookie)).json();
  await push();
  const after = await (await call("GET", `/api/sync?since=${rev}`, undefined, cookie)).json();
  assert.equal(after.rev, rev, "nothing changed on the second run");
  const all = await (await call("GET", "/api/sync?since=0", undefined, cookie)).json();
  assert.equal(all.receipts.length, 3);
  assert.equal(all.purchases.length, 13);
  assert.ok(all.purchases.every((p) => p.store === "Albert Heijn" && p.source === "receipt" && p.receipt_id));
  const ham = all.preferences.find((p) => p.item_id === itemIdFor("Ham"));
  assert.deepEqual([ham.store, ham.recipe_id, ham.product_id], ["Albert Heijn", "", "ah-product-9003"]);
  assert.equal(all.products.find((p) => p.id === "ah-product-9003").last_price_cents, 189);
});

test("AH import: a later run keeps a product's 'alleen bij deze winkel' and its store", async () => {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const host = "groceries.localhost:8787";
  const call = (method, p, body, cookie) => worker.fetch(new Request(`http://${host}${p}`, {
    method,
    headers: { Origin: `http://${host}`, ...(cookie ? { Cookie: `kd=${cookie}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  const res = await call("POST", "/api/pair", { code: "123456" });
  const cookie = res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
  const { ops } = buildOps(receipts(), VOCAB);
  const push = async (list) => (await (await call("POST", "/api/ops", { ops: list }, cookie)).json()).results;
  assert.deepEqual((await push(ops)).filter((r) => !r.ok), []);
  // Thomas ticks "alleen bij Albert Heijn te koop" on the ham.
  assert.equal((await push([{ op_id: "op-ham-store-only", type: "product.put", id: "ah-product-9003", product: { store_only: true } }]))[0].ok, true);
  // A newer receipt with the same products: the import's product.put ops again.
  const again = ops.filter((o) => o.type === "product.put").map((o) => ({ ...o, op_id: `${o.op_id}-later` }));
  assert.ok(again.some((o) => o.id === "ah-product-9003"));
  assert.ok(again.every((o) => !("store_only" in o.product)), "the import never sends the flag");
  assert.deepEqual((await push(again)).filter((r) => !r.ok), []);
  const ham = (await (await call("GET", "/api/sync?since=0", undefined, cookie)).json()).products.find((p) => p.id === "ah-product-9003");
  assert.deepEqual([ham.store, ham.store_only], ["Albert Heijn", 1]);
});
