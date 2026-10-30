// Two items of one thing become one (item.merge), and one product goes to
// another item (product.move). Thomas, 30-10-2026: the receipts put the cat's
// tuna under "Tonijn" while its rate sat on "Minoestuna", so the pantry and
// the learning saw nothing. The from-item's tombstone with merged_into is the
// alias: its name lands on the into-item from then on.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { applyOp, emptyState, findItem, aliasTarget, OpError } from "../public/shared/ops.js";
import { nameKey } from "../public/shared/ingredients.js";
import { importerMayApply } from "../worker/auth.js";
import { itemIdFor } from "../tools/import_ah.mjs";

const DAY = "2026-10-20";
const ctx = (day = DAY) => ({ memberId: "member-thomas-01", isAdmin: true, now: `${day}T10:00:00.000Z` });
const apply = (s, op, day = DAY) => applyOp(s, op, ctx(day));
const named = (s, name) => Object.values(s.items).find((i) => !i.deleted_at && i.name === name);
const TONIJN = itemIdFor("Tonijn");          // the import's own id for the item, as on the live data
const MINOES = "item-merge-minoestuna";
const tuna = { id: "ah-product-226264", name: "Zeeparel Tonijnstukken in water", brand: "Zeeparel", size: "145 g" };
const tuna3 = { id: "ah-product-368348", name: "Zeeparel Tonijn in water 3-pack", brand: "Zeeparel", size: "3 x 145 g" };

/** Tonijn with the receipts, the list line, a preference and rules; Minoestuna with the rate, its own line, preference and rule. */
function tunaHouse() {
  const s = emptyState();
  const ops = [
    { type: "item.rate", title: "Minoestuna", item_id: MINOES, use_per_day: 1 / 7, source: "person", on: "2026-10-01" },
    { type: "receipt.save", id: "receipt-merge-001", store: "Albert Heijn", bought_on: "2026-10-10", total_cents: 500, lines: [] },
    { type: "purchase.add", id: "purchase-merge-001", item_id: TONIJN, title: "Tonijn", bought_on: "2026-10-10", store: "Albert Heijn",
      qty: 1, price_cents: 189, source: "receipt", receipt_id: "receipt-merge-001", product: tuna, pantry: true },
    { type: "purchase.add", id: "purchase-merge-002", item_id: TONIJN, title: "Tonijn", bought_on: "2026-09-01", store: "Albert Heijn",
      qty: 1, price_cents: 499, source: "receipt", product: tuna3 },
    { type: "purchase.add", id: "purchase-merge-003", item_id: TONIJN, title: "Tonijn", bought_on: "2023-05-01", source: "history" },
    { type: "item.rate", item_id: TONIJN, use_per_day: 0, source: "person", on: "2026-10-01" },
    { type: "item.low", item_id: TONIJN, low_at: "2 st" },
    { type: "preference.set", id: "pref-merge-tonijn-ah", item_id: TONIJN, product_id: tuna.id, store: "Albert Heijn" },
    { type: "preference.set", id: "pref-merge-tonijn-any", item_id: TONIJN, product_id: tuna3.id, store: "" },
    { type: "preference.set", id: "pref-merge-minoes-any", item_id: MINOES, product_id: tuna.id, store: "" },
    { type: "deal_rule.set", id: "rule-merge-tonijn-any", item_id: TONIJN, offer_only: true },
    { type: "deal_rule.set", id: "rule-merge-tonijn-3pk", item_id: TONIJN, product_id: tuna3.id, max_price_cents: 450 },
    { type: "deal_rule.set", id: "rule-merge-minoes-any", item_id: MINOES, max_price_cents: 150 },
    { type: "entry.add", id: "entry-merge-tonijn1", item_id: TONIJN, title: "Tonijn", amounts: [{ qty: 2, unit: null }], note: "voor Minoes" },
    { type: "entry.add", id: "entry-merge-minoes1", item_id: MINOES, title: "Minoestuna", amounts: [{ qty: 1, unit: null }], source: { recipe_id: "recipe-merge-0001", title: "Kattenmaal" } },
  ];
  for (const op of ops) apply(s, op, op.on ?? op.bought_on ?? DAY);
  return { s, ops };
}

const MERGE = { type: "item.merge", from_item_id: TONIJN, into_item_id: MINOES, on: DAY };

test("item.merge moves purchases, products, pantry, list lines, preferences and rules; into's own wins; the from-item is an alias", () => {
  const { s } = tunaHouse();
  const pantryRow = Object.values(s.pantry).find((r) => r.item_id === TONIJN);
  assert.ok(pantryRow, "the receipt of these days filled the pantry");
  const { result, changed } = apply(s, MERGE);
  assert.equal(result.item_id, MINOES);
  assert.deepEqual(result.moved, { purchases: 3, products: 2, pantry: 1, pantry_events: 0, entries: 0, entries_merged: 1, preferences: 1, deal_rules: 1, pending_takes: 0 });
  for (const p of Object.values(s.purchases)) assert.deepEqual([p.item_id, p.title], [MINOES, "Minoestuna"], p.id);
  for (const p of Object.values(s.products)) assert.equal(p.item_id, MINOES, p.id);
  assert.deepEqual([s.pantry[pantryRow.id].item_id, s.pantry[pantryRow.id].title], [MINOES, "Minoestuna"]);
  // The open line joins Minoestuna's open line, as entry.add merges.
  const line = s.entries["entry-merge-minoes1"];
  assert.deepEqual(line.amounts, [{ qty: 3, unit: null }]);
  assert.equal(line.note, "voor Minoes");
  assert.ok(s.entries["entry-merge-tonijn1"].deleted_at, "the from-line is a tombstone");
  // Preferences: into's any-store row wins, Tonijn's AH row comes along.
  assert.equal(s.preferences["pref-merge-minoes-any"].product_id, tuna.id);
  assert.ok(s.preferences["pref-merge-tonijn-any"].deleted_at);
  assert.deepEqual([s.preferences["pref-merge-tonijn-ah"].item_id, s.preferences["pref-merge-tonijn-ah"].deleted_at], [MINOES, null]);
  // Rules: into's any-product rule wins, the 3-pack rule comes along.
  assert.equal(s.deal_rules["rule-merge-minoes-any"].max_price_cents, 150);
  assert.ok(s.deal_rules["rule-merge-tonijn-any"].deleted_at);
  assert.deepEqual([s.deal_rules["rule-merge-tonijn-3pk"].item_id, s.deal_rules["rule-merge-tonijn-3pk"].deleted_at], [MINOES, null]);
  // Settings: into's own rate stays (Tonijn's "niet aftellen" does not come); "Bijna op" at 2 st does.
  const into = s.items[MINOES];
  assert.deepEqual([into.use_per_day, into.rate_source, into.low_at], [1 / 7, "person", "2 st"]);
  // The from-item: a tombstone that points at the into-item.
  assert.ok(s.items[TONIJN].deleted_at);
  assert.equal(s.items[TONIJN].merged_into, MINOES);
  assert.equal(findItem(s, nameKey("Tonijn")).id, MINOES);
  assert.equal(aliasTarget(s.items, s.items[TONIJN]).id, MINOES);
  assert.ok(changed.some(([k, id]) => k === "items" && id === TONIJN));
});

test("item.merge: the same merge again writes nothing; a replay on the phone is a replay", () => {
  const { s } = tunaHouse();
  apply(s, MERGE);
  const before = structuredClone(s);
  const again = apply(s, { ...MERGE });
  assert.deepEqual(again.changed, [], "nothing written");
  assert.equal(again.result.already, true);
  assert.deepEqual(s, before);
  // Deterministic: the same ops on two copies give the same rows.
  const a = tunaHouse().s;
  const b = tunaHouse().s;
  apply(a, MERGE);
  apply(b, MERGE);
  assert.deepEqual(a, b);
});

test("item.merge: refused for the same item, an unknown one, a missing day; a merged-away item cannot be merged elsewhere", () => {
  const { s } = tunaHouse();
  const code = (op) => {
    try {
      apply(s, op);
      return "ok";
    } catch (e) {
      assert.ok(e instanceof OpError);
      return e.code;
    }
  };
  assert.equal(code({ ...MERGE, into_item_id: TONIJN }), "same_item");
  assert.equal(code({ ...MERGE, into_item_id: "item-merge-nothing" }), "not_found");
  assert.equal(code({ ...MERGE, on: undefined }), "bad_field");
  assert.equal(code(MERGE), "ok");
  apply(s, { type: "entry.add", id: "entry-merge-other1", item_id: "item-merge-other01", title: "Sardines" });
  assert.equal(code({ ...MERGE, into_item_id: "item-merge-other01" }), "not_found", "Tonijn went into Minoestuna already");
});

test("the alias: a receipt, a list line, a preference, a rate or the pantry that says the old name lands on the into-item", () => {
  const { s } = tunaHouse();
  apply(s, MERGE);
  // The AH import's op as buildOps makes it: title "Tonijn", item_id = itemIdFor("Tonijn") = the tombstone's own id.
  const r = apply(s, { type: "purchase.add", id: "purchase-merge-later", item_id: TONIJN, title: "Tonijn", bought_on: "2026-10-25",
    store: "Albert Heijn", qty: 1, price_cents: 189, source: "receipt", product: tuna, pantry: true }, "2026-10-25");
  assert.equal(s.purchases["purchase-merge-later"].item_id, MINOES);
  assert.equal(s.pantry[r.result.pantry_id].item_id, MINOES, "the pantry counts the cat's tuna now");
  assert.ok(s.items[TONIJN].deleted_at, "the tombstone stays a tombstone: no new Tonijn");
  assert.equal(Object.values(s.items).filter((i) => i.name_key === "tonijn").length, 1);
  // A tick on the list: "Tonijn" typed in joins the open Minoestuna line.
  const added = apply(s, { type: "entry.add", id: "entry-merge-later1", item_id: "item-merge-newone1", title: "tonijn" });
  assert.equal(added.result.merged_into, "entry-merge-minoes1");
  apply(s, { type: "entry.check", id: "entry-merge-minoes1", checked: true });
  apply(s, { type: "entry.add", id: "entry-merge-later2", item_id: "item-merge-newone2", title: "Tonijn" });
  assert.deepEqual([s.entries["entry-merge-later2"].item_id, s.entries["entry-merge-later2"].title], [MINOES, "Minoestuna"]);
  // By name (the MCP tools send a title).
  assert.equal(apply(s, { type: "preference.set", id: "pref-merge-later", title: "Tonijn", item_id: "item-merge-newone3", product_id: tuna3.id, store: "Dirk" }).result.item_id, MINOES);
  assert.equal(apply(s, { type: "item.rate", title: "Tonijn", item_id: "item-merge-newone4", use_per_day: 1 / 6, source: "claude", on: DAY }).result.kept, true,
    "the person's rate on Minoestuna stays");
  assert.equal(apply(s, { type: "deal_rule.set", id: "rule-merge-later", title: "Tonijn", product_id: tuna.id, max_price_cents: 140 }).result.item_id, MINOES);
  apply(s, { type: "pantry.add", id: "pantry-merge-later1", title: "Tonijn", amount: 2, on: DAY });
  assert.equal(s.pantry["pantry-merge-later1"].item_id, MINOES);
  // A chain: Minoestuna merged on into "Kattentonijn" takes "Tonijn" along.
  apply(s, { type: "item.merge", from_item_id: MINOES, into_title: "Kattentonijn", into_item_id: "item-merge-kattonijn", on: DAY });
  assert.equal(findItem(s, nameKey("Tonijn")).name, "Kattentonijn");
});

test("the rate: into's own (a person's or learned) stays, else from's own, else into's; other settings only where into has none", () => {
  const run = (into, from) => {
    const s = emptyState();
    s.items["item-merge-rate-a"] = { id: "item-merge-rate-a", name: "A", name_key: "a", deleted_at: null, ...from };
    s.items["item-merge-rate-b"] = { id: "item-merge-rate-b", name: "B", name_key: "b", deleted_at: null, ...into };
    apply(s, { type: "item.merge", from_item_id: "item-merge-rate-a", into_item_id: "item-merge-rate-b", on: DAY });
    const b = s.items["item-merge-rate-b"];
    return [b.use_per_day ?? null, b.rate_source ?? null];
  };
  const r = (use_per_day, rate_source, rate_samples = 0) => ({ use_per_day, rate_source, rate_samples });
  assert.deepEqual(run(r(1 / 7, "person"), r(0, "person")), [1 / 7, "person"], "Minoestuna's rate, not Tonijn's 'niet aftellen'");
  assert.deepEqual(run(r(1 / 7, "learned", 3), r(1 / 2, "person")), [1 / 7, "learned"]);
  assert.deepEqual(run({}, r(1 / 30, "claude")), [1 / 30, "claude"], "into has none: from's");
  assert.deepEqual(run(r(1 / 30, "claude"), r(1 / 9, "learned", 2)), [1 / 9, "learned"], "from's own beats into's guess");
  assert.deepEqual(run(r(1 / 30, "claude"), r(1 / 9, "claude")), [1 / 30, "claude"], "two guesses: into's");
  assert.deepEqual(run(r(1 / 7, "person"), {}), [1 / 7, "person"]);
  // Settings into lacks come; what it has stays.
  const s = emptyState();
  s.items["item-merge-set-a"] = { id: "item-merge-set-a", name: "Waspods", name_key: "waspods", deleted_at: null, again: "hide", low_off: 1, shelf_days: 365, opened_days: null, shelf_source: "person", not_yet_until: "2026-10-25" };
  s.items["item-merge-set-b"] = { id: "item-merge-set-b", name: "Wasmiddel", name_key: "wasmiddel", deleted_at: null, again: "show", low_off: null, shelf_days: -1, shelf_source: "claude" };
  apply(s, { type: "item.merge", from_item_id: "item-merge-set-a", into_item_id: "item-merge-set-b", on: DAY });
  const b = s.items["item-merge-set-b"];
  assert.deepEqual([b.again, b.low_off, b.shelf_days, b.shelf_source, b.not_yet_until], ["show", 1, -1, "claude", "2026-10-25"]);
});

test("item.merge settles a counted-down item on the op's day first (never the clock)", () => {
  const s = emptyState();
  apply(s, { type: "pantry.add", id: "pantry-merge-pods1", item_id: "item-merge-pods01", title: "Waspods", amount: 10, on: "2026-10-01" }, "2026-10-01");
  apply(s, { type: "item.rate", item_id: "item-merge-pods01", use_per_day: 1 / 2, source: "person", on: "2026-10-01" }, "2026-10-01");
  apply(s, { type: "pantry.add", id: "pantry-merge-was01", item_id: "item-merge-wasmid1", title: "Wasmiddel", amount: 1, on: "2026-10-01" }, "2026-10-01");
  // Merged on the 11th, applied (on the server) a week later: 10 days at 1/2 a day is 5 left.
  apply(s, { type: "item.merge", from_item_id: "item-merge-pods01", into_item_id: "item-merge-wasmid1", on: "2026-10-11" }, "2026-10-18");
  const row = s.pantry["pantry-merge-pods1"];
  assert.deepEqual([row.item_id, row.amount, row.amount_on], ["item-merge-wasmid1", 5, "2026-10-11"]);
  assert.deepEqual([s.items["item-merge-wasmid1"].use_per_day, s.items["item-merge-wasmid1"].rate_source], [1 / 2, "person"]);
});

test("excluded is nothing special: two items of sprouts merge like any others", () => {
  const s = emptyState();
  apply(s, { type: "entry.add", id: "entry-merge-sprt01", item_id: "item-merge-sprt001", title: "Groene Ster" });
  apply(s, { type: "entry.check", id: "entry-merge-sprt01", checked: true });
  apply(s, { type: "entry.add", id: "entry-merge-sprt02", item_id: "item-merge-sprt002", title: "Spruitjes" });
  const { result } = apply(s, { type: "item.merge", from_item_id: "item-merge-sprt001", into_item_id: "item-merge-sprt002", on: DAY });
  assert.equal(result.moved.entries, 1);
  assert.equal(Object.values(s.pantry).length, 0, "a ticked sprouts never was a pantry row, and the merge makes none");
  assert.equal(Object.values(s.preferences).length, 0);
});

test("product.move: one product with its purchases, pantry rows and the rows that name it; both items stay", () => {
  const s = emptyState();
  const punch = { id: "ah-product-466977", name: "Fernandes Green punch", brand: "Fernandes", size: "1,5 l" };
  const pine = { id: "ah-product-466976", name: "Fernandes Super pineapple", brand: "Fernandes", size: "1,5 l" };
  const aloe = { id: "ah-product-369301", name: "Tropical aloe vera zero suikervrij", brand: "Tropical", size: "0,5 l" };
  const buy = (id, product, day, pantry = false) => apply(s, { type: "purchase.add", id, item_id: "item-merge-frisdrnk", title: "Frisdrank",
    bought_on: day, store: "Albert Heijn", qty: 1, price_cents: 199, source: "receipt", product, ...(pantry ? { pantry: true } : {}) }, day);
  buy("purchase-merge-pine1", pine, "2026-09-01");
  buy("purchase-merge-pine2", pine, "2026-10-19", true);
  buy("purchase-merge-punc1", punch, "2026-09-02");
  buy("purchase-merge-aloe1", aloe, "2026-09-03");
  apply(s, { type: "preference.set", id: "pref-merge-fris-ah", item_id: "item-merge-frisdrnk", product_id: aloe.id, store: "Albert Heijn" });
  apply(s, { type: "deal_rule.set", id: "rule-merge-pine001", item_id: "item-merge-frisdrnk", product_id: pine.id, max_price_cents: 150 });
  const move = { type: "product.move", product_id: pine.id, title: "Fernandes super pineapple", item_id: "item-merge-superpin", on: DAY };
  const { result } = apply(s, move);
  assert.equal(result.item_id, "item-merge-superpin");
  assert.deepEqual(result.moved, { purchases: 2, products: 1, pantry: 1, pantry_events: 0, entries: 0, entries_merged: 0, preferences: 0, deal_rules: 1, pending_takes: 0 });
  assert.equal(s.items["item-merge-superpin"].name, "Fernandes super pineapple", "made by the move");
  for (const id of ["purchase-merge-pine1", "purchase-merge-pine2"]) assert.equal(s.purchases[id].item_id, "item-merge-superpin");
  assert.equal(Object.values(s.pantry).find((r) => r.product_id === pine.id).item_id, "item-merge-superpin");
  assert.equal(s.deal_rules["rule-merge-pine001"].item_id, "item-merge-superpin");
  assert.equal(s.purchases["purchase-merge-aloe1"].item_id, "item-merge-frisdrnk", "the rest of Frisdrank stays");
  assert.equal(s.preferences["pref-merge-fris-ah"].item_id, "item-merge-frisdrnk");
  assert.ok(!s.items["item-merge-frisdrnk"].deleted_at, "no alias: Frisdrank is still an item");
  // Again: nothing.
  assert.deepEqual(apply(s, { ...move }).changed, []);
  // A preference naming the moved product goes along unless the target has that scope.
  apply(s, { type: "preference.set", id: "pref-merge-punc-ah", item_id: "item-merge-frisdrnk", product_id: punch.id, store: "Dirk" });
  apply(s, { type: "product.move", product_id: punch.id, title: "Fernandes green punch", item_id: "item-merge-greenpun", on: DAY });
  assert.equal(s.preferences["pref-merge-punc-ah"].item_id, "item-merge-greenpun");
  // product.put with item_id only relinks the product (kept as it was).
  apply(s, { type: "product.put", id: aloe.id, product: { item_id: "item-merge-greenpun" } });
  assert.equal(s.purchases["purchase-merge-aloe1"].item_id, "item-merge-frisdrnk");
});

test("the importer may never merge or move", () => {
  assert.equal(importerMayApply(MERGE), false);
  assert.equal(importerMayApply({ type: "product.move", product_id: "ah-product-1", item_id: MINOES, on: DAY }), false);
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
const withId = (o) => ({ op_id: `op-merge-${String(++counter).padStart(6, "0")}`, ...o });

test("D1: the server merges and moves what the phone does, the alias holds for a later receipt and list line, twice is once", async () => {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const thomas = tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456" } }));
  const send = async (o) => {
    const [res] = (await (await call(env, "POST", "/api/ops", { cookie: thomas, body: { ops: [withId(o)] } })).json()).results;
    assert.equal(res.ok, true, `${o.type}: ${JSON.stringify(res)}`);
    return res;
  };
  const { ops } = tunaHouse();
  const pine = { id: "ah-product-466976", name: "Fernandes Super pineapple", brand: "Fernandes", size: "1,5 l" };
  const more = [
    { type: "pantry.add", id: "pantry-merge-d1-tij", item_id: MINOES, title: "Minoestuna", amount: 4, on: "2026-10-01" },
    { type: "purchase.add", id: "purchase-merge-d1-p1", item_id: "item-merge-d1-fris", title: "Frisdrank", bought_on: "2026-10-19", store: "Albert Heijn",
      qty: 1, price_cents: 199, source: "receipt", product: pine, pantry: true },
    MERGE,
    { type: "product.move", product_id: pine.id, title: "Fernandes super pineapple", item_id: "item-merge-d1-pine", on: DAY },
  ];
  // The recipe the Minoestuna line names, so the source survives on both sides.
  const all = [...ops, ...more];
  for (const o of all) await send(o);
  const phone = emptyState();
  for (const o of all) applyOp(phone, o, ctx(o.on ?? o.bought_on ?? DAY));
  const sync = await (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();
  const pick = (rows, fields) => Object.fromEntries(rows.filter((r) => !r.deleted_at).map((r) => [r.id, fields.map((f) => r[f] ?? null)]));
  const same = (kind, fields) => assert.deepEqual(pick(sync[kind], fields), pick(Object.values(phone[kind]), fields), kind);
  same("items", ["name", "use_per_day", "rate_source", "low_at", "merged_into"]);
  same("purchases", ["item_id", "title", "product_id"]);
  same("products", ["item_id"]);
  same("pantry", ["item_id", "title", "amount", "amount_on"]);
  same("entries", ["item_id", "title", "amounts", "note"]);
  same("preferences", ["item_id", "store", "product_id"]);
  same("deal_rules", ["item_id", "product_id", "max_price_cents"]);
  // The tombstone, with its alias, on D1.
  const tomb = await env.DB.prepare("SELECT deleted_at, merged_into FROM items WHERE id = ?").bind(TONIJN).first();
  assert.ok(tomb.deleted_at);
  assert.equal(tomb.merged_into, MINOES);
  // The same merge again (another op id): nothing written, not even the rev.
  const rev = (await env.DB.prepare("SELECT rev FROM households").first()).rev;
  const again = await send({ ...MERGE });
  assert.equal(again.result.already, true);
  assert.equal((await env.DB.prepare("SELECT rev FROM households").first()).rev, rev);
  // A later AH receipt as the import sends it, and a line typed on the list: both on Minoestuna.
  await send({ type: "purchase.add", id: "purchase-merge-d1-late", item_id: TONIJN, title: "Tonijn", bought_on: "2026-10-26", store: "Albert Heijn",
    qty: 1, price_cents: 189, source: "receipt", product: tuna, pantry: true });
  await send({ type: "entry.check", id: "entry-merge-minoes1", checked: true });
  await send({ type: "entry.add", id: "entry-merge-d1-late", item_id: "item-merge-d1-new1", title: "Tonijn" });
  const late = await (await call(env, "GET", `/api/sync?since=${rev}`, { cookie: thomas })).json();
  assert.equal(late.purchases.find((p) => p.id === "purchase-merge-d1-late").item_id, MINOES);
  assert.deepEqual(late.entries.filter((e) => e.id === "entry-merge-d1-late").map((e) => [e.item_id, e.title]), [[MINOES, "Minoestuna"]]);
  assert.equal(late.items.filter((i) => i.name_key === "tonijn").length, 0, "no new Tonijn item");
  assert.ok(late.pantry.some((r) => r.source_purchase_id === "purchase-merge-d1-late" && r.item_id === MINOES), "the pantry counts it");
});
