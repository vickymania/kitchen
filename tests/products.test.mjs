// Phase 2: products, ratings, receipts, purchases and the "need it again"
// timers. The engine on its own, then the worker end to end on the D1 stand-in.
// The Claude API is never called: globalThis.fetch is replaced per test.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { applyOp, emptyState, OpError } from "../public/shared/ops.js";
import { dueItems, intervalOf, median, daysBetween } from "../public/shared/intervals.js";
import { reviewOf, DAILY_LIMIT, MODEL } from "../worker/receipts.js";
import { buildPurchases } from "../tools/import_history.mjs";

const ctx = (memberId = "member-thomas-01") => ({ memberId, isAdmin: true, now: "2026-10-27T10:00:00.000Z" });

// ------------------------------------------------------------------ engine

test("engine: one product per name, brand and size", () => {
  const s = emptyState();
  applyOp(s, { type: "product.put", id: "product-aaaa-01", product: { name: "Halfvolle melk", brand: "AH", size: "1 l" } }, ctx());
  const { result } = applyOp(s, { type: "product.put", id: "product-bbbb-02", product: { name: "halfvolle  MELK", brand: "ah", size: "1 L", store: "AH" } }, ctx());
  assert.equal(result.product_id, "product-aaaa-01");
  assert.deepEqual(Object.keys(s.products), ["product-aaaa-01"]);
  assert.equal(s.products["product-aaaa-01"].store, "Albert Heijn", "the store's one name (public/shared/stores.js)");
});

test("engine: a receipt purchase checks off the list line, sets the price and the preferred product", () => {
  const s = emptyState();
  applyOp(s, { type: "entry.add", id: "entry-melk-0001", item_id: "item-melk-00001", title: "Melk" }, ctx());
  applyOp(s, { type: "receipt.save", id: "receipt-0000001", store: "AH", bought_on: "2026-10-27", total_cents: 238,
    lines: [{ name: "Halfvolle melk", brand: "AH", size: "1 l", qty: 2, price_cents: 238 }] }, ctx());
  const { result, changed } = applyOp(s, {
    type: "purchase.add", id: "purchase-000001", source: "receipt", receipt_id: "receipt-0000001",
    title: "melk", item_id: "item-unused-0001", bought_on: "2026-10-27", store: "AH", qty: 2, price_cents: 238,
    product: { id: "product-melk-01", name: "Halfvolle melk", brand: "AH", size: "1 l" },
    entry_id: "entry-melk-0001", prefer: true,
  }, ctx());
  assert.equal(result.checked, "entry-melk-0001");
  assert.ok(s.entries["entry-melk-0001"].checked_at);
  const [pref] = Object.values(s.preferences);
  assert.deepEqual([pref.item_id, pref.store, pref.recipe_id, pref.product_id], ["item-melk-00001", "Albert Heijn", "", "product-melk-01"],
    "kept as preferred at the receipt's store");
  assert.equal(s.items["item-melk-00001"].preferred_product_id, undefined, "the old column is not written");
  assert.equal(s.products["product-melk-01"].last_price_cents, 119, "the price per unit");
  assert.equal(s.products["product-melk-01"].item_id, "item-melk-00001");
  assert.equal(s.purchases["purchase-000001"].item_id, "item-melk-00001");
  assert.deepEqual(changed.map(([k]) => k).sort(), ["entries", "preferences", "products", "purchases"]);
});

test("engine: ratings are per person and can be taken back", () => {
  const s = emptyState();
  applyOp(s, { type: "product.put", id: "product-kaas-01", product: { name: "Oude kaas" } }, ctx());
  applyOp(s, { type: "rating.set", id: "rating-thomas-1", product_id: "product-kaas-01", stars: 4, note: "lekker" }, ctx());
  applyOp(s, { type: "rating.set", id: "rating-thomas-2", product_id: "product-kaas-01", stars: 5 }, ctx());
  applyOp(s, { type: "rating.set", id: "rating-sam-0001", product_id: "product-kaas-01", stars: 2 }, ctx("member-sam-0001"));
  const live = Object.values(s.ratings).filter((r) => !r.deleted_at);
  assert.deepEqual(live.map((r) => [r.member_id, r.stars]).sort(), [["member-sam-0001", 2], ["member-thomas-01", 5]]);
  applyOp(s, { type: "rating.set", product_id: "product-kaas-01", stars: null }, ctx());
  assert.ok(s.ratings["rating-thomas-1"].deleted_at);
  assert.throws(() => applyOp(s, { type: "rating.set", id: "rating-thomas-3", product_id: "product-kaas-01", stars: 6 }, ctx()), OpError);
});

test("excluded: never a purchase, product or preference; dropped from a stored receipt", () => {
  const s = emptyState();
  const refuse = (op) => assert.throws(() => applyOp(s, op, ctx()), (e) => e.code === "excluded");
  refuse({ type: "purchase.add", id: "purchase-sprt-01", source: "history", title: "Groenhof", bought_on: "2026-10-01" });
  refuse({ type: "purchase.add", id: "purchase-sprt-02", source: "receipt", title: "drinken", item_id: "item-drink-0001",
    bought_on: "2026-10-01", product: { id: "product-sprx-01", name: "Verse spruitjes", brand: "Jacob's Creek" } });
  refuse({ type: "product.put", id: "product-sprt-01", product: { name: "Spruiten", brand: "Groene Ster" } });
  applyOp(s, { type: "entry.add", id: "entry-sprx-0001", item_id: "item-sprx-00001", title: "Spruiten" }, ctx());
  applyOp(s, { type: "product.put", id: "product-juice-1", product: { name: "Druivensap" } }, ctx());
  refuse({ type: "item.prefer", item_id: "item-sprx-00001", product_id: "product-juice-1" });
  applyOp(s, { type: "receipt.save", id: "receipt-0000002", bought_on: "2026-10-27", total_cents: 1000,
    lines: [{ name: "Brood", price_cents: 250 }, { name: "Groenhof", brand: "", price_cents: 750 }] }, ctx());
  assert.deepEqual(s.receipts["receipt-0000002"].lines.map((l) => l.name), ["Brood"]);
  assert.equal(Object.keys(s.purchases).length, 0);
});

// --------------------------------------------------------------- intervals

test("intervals: median of the gaps, only from 3 purchase days", () => {
  assert.equal(median([7, 1, 30]), 7);
  assert.equal(median([4, 10]), 7);
  assert.equal(daysBetween("2026-02-27", "2026-03-01"), 2);
  assert.equal(intervalOf(["2026-10-01", "2026-10-08"]).interval, null, "two purchases are not a habit");
  assert.equal(intervalOf(["2026-10-01", "2026-10-08", "2026-10-08", "2026-10-15"]).interval, 7, "same day counts once");
  assert.equal(intervalOf(["2026-01-01", "2026-01-08", "2026-01-15", "2026-06-01"]).interval, 7, "one long gap moves a median little");
});

test("intervals: due items first, excluded and long-gone items left out", () => {
  const items = {
    melk: { id: "melk", name: "Melk" }, kaas: { id: "kaas", name: "Kaas" },
    sprt: { id: "sprt", name: "Spruitjes" }, oud: { id: "oud", name: "Kattengrind" },
    zelden: { id: "zelden", name: "Paracetamol" }, gemist: { id: "gemist", name: "Kattenvoer" },
  };
  const purchases = {};
  let n = 0;
  const buy = (item, ...days) => days.forEach((d) => { purchases[`p${++n}`] = { id: `p${n}`, item_id: item, title: items[item].name, bought_on: d }; });
  buy("melk", "2026-10-01", "2026-10-08", "2026-10-15");             // every 7, last 12 days ago: due
  buy("kaas", "2026-09-01", "2026-09-21", "2026-10-11", "2026-10-25"); // every 20, last 2 days ago: later
  buy("sprt", "2026-10-01", "2026-10-08", "2026-10-15");
  buy("oud", "2024-01-01", "2024-02-01", "2024-03-01");
  buy("zelden", "2025-01-01", "2025-06-01", "2025-11-01", "2026-04-01");  // every ~150 days: not a regular
  buy("gemist", "2026-05-01", "2026-05-31", "2026-06-30");             // every 30, last 119 days ago: missed twice
  const entries = { e1: { id: "e1", item_id: "kaas", checked_at: null, deleted_at: null } };
  const out = dueItems({ items, purchases, entries }, "2026-10-27");
  assert.deepEqual(out.map((d) => [d.item.name, d.due, d.interval, d.since]), [["Melk", true, 7, 12], ["Kaas", false, 20, 2]]);
  assert.equal(out[1].on_list, true);
});

test("intervals: merged names count together, generic lines are hidden, aliases match the list", () => {
  const items = {
    ei: { id: "ei", name: "Ei" }, eieren: { id: "eieren", name: "Eieren" },
    eten: { id: "eten", name: "Eten" }, koffie: { id: "koffie", name: "Koffie?" },
    nrg: { id: "nrg", name: "Nrg" },
  };
  const purchases = {};
  let n = 0;
  const buy = (item, ...days) => days.forEach((d) => { purchases[`p${++n}`] = { id: `p${n}`, item_id: item, title: items[item].name, bought_on: d }; });
  // alone, neither name has 3 days; together they are bought every 10 days
  buy("ei", "2026-09-17", "2026-09-27");
  buy("eieren", "2026-10-07", "2026-10-17");
  buy("eten", "2026-10-01", "2026-10-08", "2026-10-15");
  buy("koffie", "2026-09-01", "2026-09-11", "2026-09-21", "2026-10-01");
  buy("nrg", "2026-10-01", "2026-10-11", "2026-10-21");
  const entries = { e1: { id: "e1", item_id: "eieren", checked_at: null, deleted_at: null } };
  const out = dueItems({ items, purchases, entries }, "2026-10-27");
  const by = Object.fromEntries(out.map((d) => [d.name, d]));
  assert.deepEqual(Object.keys(by).sort(), ["Eieren", "Energy drink", "Koffie"], "Eten hidden, Koffie? shown without the question mark");
  assert.equal(by.Eieren.interval, 10);
  assert.equal(by.Eieren.last, "2026-10-17");
  assert.equal(by.Eieren.on_list, true);
  // a line for the alias "Ei" puts the merged product on the list too
  const viaAlias = dueItems({ items, purchases, entries: { e2: { id: "e2", item_id: "ei", checked_at: null, deleted_at: null } } }, "2026-10-27");
  assert.equal(viaAlias.find((d) => d.name === "Eieren").on_list, true);
  assert.equal(viaAlias.find((d) => d.name === "Koffie").on_list, false);
  // the stored rows are untouched
  assert.equal(Object.keys(purchases).length, n);
});

test("history import: excluded out, ids the same on every run", () => {
  const files = [["history.json", [
    { title: "2 Melk", completed: "2026-10-01T00:00:00.0000000" },
    { title: "Melk", completed: "2026-10-01T00:00:00.0000000" },
    { title: "Groenhof light", completed: "2026-10-01T00:00:00.0000000" },
    { title: "Groenhof", completed: "2026-10-02T00:00:00.0000000" },
    { title: "", completed: "2026-10-02T00:00:00.0000000" },
  ]]];
  const a = buildPurchases(files);
  const b = buildPurchases(files);
  assert.deepEqual(a.ops.map((o) => o.title), ["Melk", "Melk"]);
  assert.deepEqual(a.skipped, { excluded: 2, empty: 1 });
  assert.deepEqual(a.ops.map((o) => o.id), b.ops.map((o) => o.id));
  assert.notEqual(a.ops[0].id, a.ops[1].id, "the same line twice on one day is two purchases");
  assert.ok(a.ops.every((o) => o.source === "history" && o.bought_on === "2026-10-01"));
});

// ------------------------------------------------------------------ worker

const HOST = "groceries.localhost:8787";

function call(env, method, path, { body, cookie, raw, type } = {}) {
  const headers = { Origin: `http://${HOST}` };
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (body !== undefined || raw !== undefined) headers["Content-Type"] = type ?? "application/json";
  return worker.fetch(new Request(`http://${HOST}${path}`, {
    method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  }), env);
}

async function household(extra = {}) {
  const env = { ...(await makeEnv()), ...extra };
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const res = await call(env, "POST", "/api/pair", { body: { code: "123456" } });
  const token = res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
  return { env, thomas: token };
}

let counter = 0;
const op = (o) => ({ op_id: `op-prod-${String(++counter).padStart(6, "0")}`, ...o });
const send = async (env, cookie, ops) => (await (await call(env, "POST", "/api/ops", { cookie, body: { ops } })).json()).results;

test("sync: the new rows arrive in a delta, a rating change brings only itself", async () => {
  const { env, thomas } = await household();
  const r = await send(env, thomas, [
    op({ type: "entry.add", id: "entry-sync-0001", item_id: "item-sync-00001", title: "Pindakaas" }),
    op({ type: "product.put", id: "product-sync-01", product: { name: "Pindakaas", brand: "Calvé", size: "350 g" } }),
    op({ type: "item.prefer", item_id: "item-sync-00001", product_id: "product-sync-01" }),
    op({ type: "rating.set", id: "rating-sync-001", product_id: "product-sync-01", stars: 5, note: "de beste" }),
    op({ type: "purchase.add", id: "purchase-sync-1", source: "history", title: "Pindakaas", bought_on: "2025-02-01" }),
  ]);
  assert.deepEqual(r.map((x) => x.ok), [true, true, true, true, true], JSON.stringify(r));
  const full = await (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();
  assert.equal(full.products[0].brand, "Calvé");
  assert.equal(full.items[0].preferred_product_id, null, "an old phone's item.prefer becomes a preference");
  assert.deepEqual(full.preferences.map((p) => [p.item_id, p.store, p.recipe_id, p.product_id]), [["item-sync-00001", "", "", "product-sync-01"]]);
  assert.equal(full.ratings[0].stars, 5);
  assert.equal(full.purchases[0].source, "history");
  assert.deepEqual(full.receipts, []);

  await send(env, thomas, [op({ type: "rating.set", id: "rating-sync-002", product_id: "product-sync-01", stars: 3 })]);
  const delta = await (await call(env, "GET", `/api/sync?since=${full.rev}`, { cookie: thomas })).json();
  assert.deepEqual([delta.ratings.length, delta.products.length, delta.items.length, delta.purchases.length], [1, 0, 0, 0]);
  assert.equal(delta.ratings[0].id, "rating-sync-001", "one rating per person, updated in place");
});

test("usage: saving a receipt line writes only its rows, an idle poll still reads only the counter", async () => {
  const { env, thomas } = await household();
  await send(env, thomas, [
    op({ type: "entry.add", id: "entry-use-00001", item_id: "item-use-000001", title: "Eieren" }),
    op({ type: "receipt.save", id: "receipt-use-001", store: "Dirk", bought_on: "2026-10-27", total_cents: 289, lines: [{ name: "Eieren", price_cents: 289 }] }),
  ]);
  const batches = [];
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = (stmts) => {
    batches.push(stmts.map((s) => s.sql));
    return batch(stmts);
  };
  const [res] = await send(env, thomas, [op({
    type: "purchase.add", id: "purchase-use-01", source: "receipt", receipt_id: "receipt-use-001", title: "Eieren",
    item_id: "item-use-unused", bought_on: "2026-10-27", store: "Dirk", qty: 1, price_cents: 289,
    product: { id: "product-use-001", name: "Scharreleieren", size: "10 st" }, entry_id: "entry-use-00001", prefer: true,
  })]);
  assert.equal(res.ok, true, JSON.stringify(res));
  const writes = batches.find((b) => b.some((sql) => sql.startsWith("INSERT INTO purchases")));
  const tables = writes.map((sql) => sql.match(/^(?:INSERT INTO|UPDATE) (\w+)/)[1]);
  assert.deepEqual(tables.sort(), ["applied_ops", "households", "list_entries", "preferences", "products", "purchases"],
    "rev bump + product + preference + checked line + purchase + applied_ops");

  const head = await (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();
  const queries = [];
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    queries.push(sql);
    return prepare(sql);
  };
  const idle = await (await call(env, "GET", `/api/sync?since=${head.rev}`, { cookie: thomas })).json();
  assert.equal(idle.purchases.length, 0);
  assert.equal(queries.filter((sql) => /FROM (products|ratings|purchases|receipts|recipes|items|list_entries|preferences)\b/.test(sql)).length, 0);
});

// ---------------------------------------------------------- receipt route

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function mockClaude(answer, { status = 200, stop = "end_turn" } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ stop_reason: stop, content: [{ type: "text", text: JSON.stringify(answer) }] }), { status });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const ANSWER = {
  store: "Albert Heijn", date: "2026-10-26", total: 6.47,
  lines: [
    { name: "Halfvolle melk", brand: "AH", size: "1 l", quantity: 2, price: 2.38, kind: "product" },
    { name: "Groene Ster spruitjes", brand: "Groene Ster", size: "6x30 cl", quantity: 1, price: 5.49, kind: "product" },
    { name: "Bonus Groene Ster", brand: "", size: "", quantity: 1, price: -1.5, kind: "discount" },
    { name: "Statiegeld", brand: "", size: "", quantity: 1, price: 0.1, kind: "deposit" },
  ],
};

test("receipt route: Claude reads it, the lines come back for review, nothing is stored", async () => {
  const { env, thomas } = await household({ ANTHROPIC_API_KEY: "test-key-not-real" });
  const before = await (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();
  const claude = mockClaude(ANSWER);
  let res;
  try {
    res = await call(env, "POST", "/api/receipts/read", { cookie: thomas, raw: JPEG, type: "image/jpeg" });
  } finally {
    claude.restore();
  }
  assert.equal(res.status, 200);
  const review = await res.json();
  assert.equal(claude.calls.length, 1);
  assert.equal(claude.calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(claude.calls[0].body.model, MODEL);
  assert.equal(claude.calls[0].body.model, "claude-sonnet-5-5");
  assert.equal(claude.calls[0].body.output_config.format.type, "json_schema");
  assert.equal(claude.calls[0].body.messages[0].content[0].source.media_type, "image/jpeg");
  assert.equal(claude.calls[0].init.headers["x-api-key"], "test-key-not-real");
  assert.ok(!JSON.stringify(review).includes("test-key"), "the key never comes back");

  assert.deepEqual(review.lines.map((l) => l.name), ["Halfvolle melk", "Statiegeld"], "sprouts and its bonus line never reach the phone");
  assert.deepEqual(review.skipped, { count: 2, cents: 399 });
  assert.equal(review.sum_cents, 647, "the left-out lines still count for the sum");
  assert.equal(review.sum_ok, true);
  assert.deepEqual([review.store, review.bought_on, review.total_cents], ["Albert Heijn", "2026-10-26", 647]);

  const after = await (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();
  assert.equal(after.rev, before.rev, "reading stores nothing");
  assert.deepEqual([after.receipts.length, after.purchases.length, after.products.length], [0, 0, 0]);
});

test("receipt route: lines that do not add up to the total are flagged", () => {
  const review = reviewOf({ store: "Dirk", date: "", total: 10, lines: [{ name: "Brood", brand: "", size: "", quantity: 1, price: 2.5, kind: "product" }] });
  assert.equal(review.sum_ok, false);
  assert.deepEqual([review.sum_cents, review.total_cents, review.bought_on], [250, 1000, null]);
  assert.equal(reviewOf({ total: 2.51, lines: [{ name: "Brood", price: 2.5 }] }).sum_ok, true, "a cent of rounding is fine");
});

test("receipt route: no key, wrong type, no device, refusal, API error", async () => {
  const off = await household();
  assert.equal((await call(off.env, "POST", "/api/receipts/read", { cookie: off.thomas, raw: JPEG, type: "image/jpeg" })).status, 503);

  const { env, thomas } = await household({ ANTHROPIC_API_KEY: "test-key-not-real" });
  const claude = mockClaude(ANSWER);
  try {
    assert.equal((await call(env, "POST", "/api/receipts/read", { raw: JPEG, type: "image/jpeg" })).status, 401);
    assert.equal((await call(env, "POST", "/api/receipts/read", { cookie: thomas, raw: "hello", type: "text/plain" })).status, 415);
    const cross = await worker.fetch(new Request(`http://${HOST}/api/receipts/read`, {
      method: "POST", headers: { Origin: "https://evil.example", Cookie: `kd=${thomas}`, "Content-Type": "image/jpeg" }, body: JPEG,
    }), env);
    assert.equal(cross.status, 403);
    assert.equal(claude.calls.length, 0, "no paid call for a refused request");
  } finally {
    claude.restore();
  }
  const refusal = mockClaude({}, { stop: "refusal" });
  try {
    const res = await call(env, "POST", "/api/receipts/read", { cookie: thomas, raw: JPEG, type: "image/jpeg" });
    assert.deepEqual([res.status, (await res.json()).error], [422, "receipt_unreadable"]);
  } finally {
    refusal.restore();
  }
  const broken = mockClaude({ error: "overloaded" }, { status: 529 });
  try {
    const res = await call(env, "POST", "/api/receipts/read", { cookie: thomas, raw: JPEG, type: "image/jpeg" });
    const body = await res.json();
    assert.deepEqual([res.status, body.error], [502, "receipt_failed"]);
    assert.ok(!JSON.stringify(body).includes("test-key"));
  } finally {
    broken.restore();
  }
});

test("receipt route: limited per household per day", async () => {
  const { env, thomas } = await household({ ANTHROPIC_API_KEY: "test-key-not-real" });
  const claude = mockClaude(ANSWER);
  try {
    const statuses = [];
    for (let i = 0; i < DAILY_LIMIT + 1; i++) {
      statuses.push((await call(env, "POST", "/api/receipts/read", { cookie: thomas, raw: JPEG, type: "image/jpeg" })).status);
    }
    assert.deepEqual([statuses.slice(0, DAILY_LIMIT).every((s) => s === 200), statuses.at(-1)], [true, 429]);
    assert.equal(claude.calls.length, DAILY_LIMIT);
  } finally {
    claude.restore();
  }
});

test("item names: every tuna line counts as the cat's tuna item", async () => {
  const { canonicalName, SAME } = await import("../public/shared/item-names.js");
  const catTuna = SAME.tonijn; // the cat's name is household data, kept in the code's table
  assert.notEqual(catTuna, "Tonijn");
  for (const n of ["Tonijn", "Tuna", "Tonijn in olie", "tuna olijfolie", catTuna]) {
    assert.equal(canonicalName(n).name, catTuna, n);
  }
});
