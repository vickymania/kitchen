// Shelf life per item (28-10-2026): item.shelf and its precedence, estimates
// from the item's own days, opened packs, the lookup by Claude after a
// purchase (globalThis.fetch is replaced: no paid call in a test, ever), the
// daily limit, excluded, the batch route, the importer's limits, the fill tool,
// and usage.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { applyOp, emptyState, OpError } from "../public/shared/ops.js";
import { estimateUseBy, openedUseBy, KEEPS } from "../public/shared/shelf-life.js";
import { importerMayApply } from "../worker/auth.js";
import { SHELF_DAILY_LIMIT, SHELF_BATCH, shelfAnswers, shelfPrompt } from "../worker/shelf.js";
import { CHEAP_MODEL } from "../worker/claude.js";
import { estimateCost, fill } from "../tools/fill_shelf_life.mjs";

const ctx = (now = "2026-10-28T10:00:00.000Z") => ({ memberId: "member-thomas-01", isAdmin: true, now });

function withItem(fields = {}) {
  const s = emptyState();
  s.items["item-melk-00001"] = { id: "item-melk-00001", name: "Melk", name_key: "melk", created_at: "x", deleted_at: null, ...fields };
  return s;
}

// ------------------------------------------------------------ the estimate

test("estimate: the item's own shelf_days first, then the rules table, then nothing", () => {
  const item = { name: "Raar ding", shelf_days: 10 };
  assert.equal(estimateUseBy("2026-10-28", "Raar ding", item), "2026-11-07", "the item's days, wherever it stands");
  assert.equal(estimateUseBy("2026-10-28", "AH Kipfilet", { name: "Kip", shelf_days: 4 }), "2026-11-01", "the item beats a matching rule");
  assert.equal(estimateUseBy("2026-10-28", { name: "Jam", shelf_days: KEEPS }), null, "keeps: no date");
  assert.equal(estimateUseBy("2026-10-28", "AH Kipfilet", { name: "Raar", shelf_days: null }), "2026-10-30", "unknown: the rules on the names");
  assert.equal(estimateUseBy("2026-10-28", { name: "Melk" }), "2026-11-04", "an item without days counts by its name");
  assert.equal(estimateUseBy("2026-10-28", "Iets onbekends", { name: "Ook onbekend" }), null);
  assert.equal(estimateUseBy("2026-10-28", "Kipfilet"), "2026-10-30", "the old call still works");
});

test("opened: min(current, day + opened days); a keeps-row gets its first date", () => {
  assert.equal(openedUseBy("2026-11-20", "2026-10-28", 5), "2026-11-02");
  assert.equal(openedUseBy("2026-10-30", "2026-10-28", 5), "2026-10-30", "never later than it was");
  assert.equal(openedUseBy(null, "2026-10-28", 30), "2026-11-27");
  assert.equal(openedUseBy("2026-10-30", "2026-10-28", null), "2026-10-30");
});

// ------------------------------------------------------------ the op

test("item.shelf: validated, a patch, the same values write nothing", () => {
  const s = withItem();
  const set = (o) => applyOp(s, { type: "item.shelf", item_id: "item-melk-00001", ...o }, ctx());
  const bad = (o) => assert.throws(() => set(o), OpError);
  bad({ shelf_days: 7, source: "robot" });
  bad({ shelf_days: 0, source: "claude" });
  bad({ shelf_days: 9999, source: "claude" });
  bad({ shelf_days: 2.5, source: "claude" });
  bad({ shelf_days: "7", source: "claude" });
  bad({ shelf_days: 7, opened_days: -1, source: "claude" });
  bad({ source: "claude" });
  bad({ shelf_days: null, source: "claude" });
  assert.throws(() => applyOp(s, { type: "item.shelf", item_id: "item-nothere01", shelf_days: 7, source: "claude" }, ctx()), (e) => e.code === "not_found");

  assert.deepEqual(set({ shelf_days: 7, opened_days: 10, source: "claude" }).changed, [["items", "item-melk-00001"]]);
  const it = s.items["item-melk-00001"];
  assert.deepEqual([it.shelf_days, it.opened_days, it.shelf_source], [7, 7, "claude"], "opened never longer than closed");
  assert.deepEqual(set({ shelf_days: 7, opened_days: 7, source: "claude" }).changed, [], "the same again: nothing");
  set({ opened_days: 3, source: "claude" });
  assert.deepEqual([it.shelf_days, it.opened_days], [7, 3], "a patch: shelf_days stays");
  set({ shelf_days: KEEPS, opened_days: 30, source: "claude" });
  assert.deepEqual([it.shelf_days, it.opened_days], [-1, 30], "keeps for years, a month once open");
});

test("item.shelf: person > claude > rule, never the other way", () => {
  const s = withItem();
  const set = (o) => applyOp(s, { type: "item.shelf", item_id: "item-melk-00001", ...o }, ctx());
  set({ shelf_days: 5, source: "rule" });
  set({ shelf_days: 7, source: "claude" });
  assert.equal(s.items["item-melk-00001"].shelf_days, 7, "Claude over a rule");
  assert.deepEqual(set({ shelf_days: 3, source: "rule" }), { result: { kept: true }, changed: [] }, "a rule never over Claude");
  set({ shelf_days: 6, opened_days: 4, source: "person" });
  for (const source of ["claude", "rule"]) {
    assert.deepEqual(set({ shelf_days: 9, opened_days: 1, source }), { result: { kept: true }, changed: [] }, `${source} never over a person`);
  }
  assert.deepEqual([s.items["item-melk-00001"].shelf_days, s.items["item-melk-00001"].opened_days], [6, 4]);
  set({ shelf_days: 8, source: "person" });
  assert.equal(s.items["item-melk-00001"].shelf_days, 8, "a person may change their own");
  set({ shelf_days: null, opened_days: null, source: "person" });
  assert.deepEqual([s.items["item-melk-00001"].shelf_days, s.items["item-melk-00001"].shelf_source], [null, null], "cleared: back to the rules");
  set({ shelf_days: 7, source: "claude" });
  assert.equal(s.items["item-melk-00001"].shelf_source, "claude", "after a clear Claude may fill it again");
});

test("item.shelf: the item's estimated, unopened pantry rows follow; a person's date and an opened row never", () => {
  const s = withItem();
  const row = (id, extra) => ({ id, item_id: "item-melk-00001", title: "Melk", amount: 1, taken: 0, added_on: "2026-10-26",
    use_by: "2026-11-02", use_by_source: "estimate", deleted_at: null, ...extra });
  s.pantry = {
    "pantry-a-000001": row("pantry-a-000001"),
    "pantry-b-000001": row("pantry-b-000001", { use_by: "2026-12-01", use_by_source: "person" }),
    "pantry-c-000001": row("pantry-c-000001", { amount: 0.5, taken: 0.5, use_by: "2026-10-29" }),
    "pantry-d-000001": row("pantry-d-000001", { deleted_at: "2026-10-27" }),
  };
  const out = applyOp(s, { type: "item.shelf", item_id: "item-melk-00001", shelf_days: 10, opened_days: 4, source: "claude" }, ctx());
  assert.deepEqual(out.changed, [["items", "item-melk-00001"], ["pantry", "pantry-a-000001"]]);
  assert.deepEqual(Object.values(s.pantry).map((r) => r.use_by), ["2026-11-05", "2026-12-01", "2026-10-29", "2026-11-02"]);
  // Only opened_days changed: no row moves.
  assert.deepEqual(applyOp(s, { type: "item.shelf", item_id: "item-melk-00001", opened_days: 2, source: "claude" }, ctx()).changed, [["items", "item-melk-00001"]]);
});

test("estimates use the item's days: a tick, a pantry add, a receipt", () => {
  const s = withItem({ shelf_days: 10, shelf_source: "claude" });
  applyOp(s, { type: "entry.add", id: "entry-melk-0001", item_id: "item-melk-00001", title: "Melk" }, ctx());
  applyOp(s, { type: "entry.check", id: "entry-melk-0001", checked: true, on: "2026-10-28" }, ctx());
  assert.equal(s.pantry["pe-entry-melk-0001"].use_by, "2026-11-07", "10 days, not the 7 of the milk rule");
  applyOp(s, { type: "pantry.add", id: "pantry-melk-001", item_id: "item-xx-0000001", title: "Melk", on: "2026-10-28" }, ctx());
  assert.equal(s.pantry["pantry-melk-001"].use_by, "2026-11-07");
  applyOp(s, { type: "purchase.add", id: "purchase-melk-1", source: "receipt", pantry: true, title: "Melk", item_id: "item-yy-0000001",
    bought_on: "2026-10-28", qty: 1, product: { id: "product-melk-01", name: "Halfvolle melk", brand: "AH", size: "1 l" } }, ctx());
  assert.equal(s.pantry["pe-entry-melk-0001"].use_by, "2026-11-07", "the receipt filled in the tick, the item's days still decide");
});

test("opened pack: part taken sets min(current, today + opened_days), whole packs and a person's date stay", () => {
  const s = withItem({ shelf_days: 10, opened_days: 3, shelf_source: "claude" });
  applyOp(s, { type: "pantry.add", id: "pantry-melk-001", item_id: "item-melk-00001", title: "Melk", amount: 2, on: "2026-10-28" }, ctx());
  applyOp(s, { type: "pantry.add", id: "pantry-melk-002", item_id: "item-melk-00001", title: "Melk", amount: 1, use_by: "2026-11-20", on: "2026-10-28" }, ctx());
  const use = (pid, amount, on, n) => applyOp(s, { type: "pantry.use", reason: "used", on, takes: [{ event_id: `event-melk-00${n}`, pantry_id: pid, amount }] }, ctx());
  use("pantry-melk-001", 1, "2026-10-29", 1);
  assert.equal(s.pantry["pantry-melk-001"].use_by, "2026-11-07", "one whole pack left: unopened");
  use("pantry-melk-001", 0.25, "2026-10-30", 2);
  assert.deepEqual([s.pantry["pantry-melk-001"].use_by, s.pantry["pantry-melk-001"].use_by_source], ["2026-11-02", "estimate"], "opened on the 30th: 3 days");
  use("pantry-melk-002", 0.5, "2026-10-30", 3);
  assert.equal(s.pantry["pantry-melk-002"].use_by, "2026-11-20", "a person's date stays");
});

test("importer: may not send item.shelf (the worker writes Claude's answers itself)", () => {
  assert.equal(importerMayApply({ type: "item.shelf", item_id: "item-melk-00001", shelf_days: 7, source: "claude" }), false);
  assert.equal(importerMayApply({ type: "purchase.add", source: "receipt", title: "Melk" }), true, "the import's own ops still pass");
});

// ------------------------------------------------------------ Claude's answer

test("answer: checked per row, by number, wrong rows left out", () => {
  const items = [{ id: "a", name: "Melk", products: ["AH Halfvolle melk"] }, { id: "b", name: "Pasta", products: [] }, { id: "c", name: "Kaas", products: [] }];
  const got = shelfAnswers(items, { items: [
    { n: 1, shelf_days: 7, opened_days: 9, kind: "zuivel" },
    { n: 2, shelf_days: -1, opened_days: 0, kind: "droog" },
    { n: 3, shelf_days: 0, opened_days: 3, kind: "?" },
    { n: 4, shelf_days: 5, opened_days: 1, kind: "?" },
    { n: 1, shelf_days: 99, opened_days: 1, kind: "twice" },
  ] });
  assert.deepEqual([...got], [["a", { shelf_days: 7, opened_days: 7, kind: "zuivel" }], ["b", { shelf_days: -1, opened_days: null, kind: "droog" }]]);
  assert.match(shelfPrompt(items), /1\. Melk \(AH Halfvolle melk\)\n2\. Pasta\n3\. Kaas$/);
});

// ------------------------------------------------------------ on the worker

const HOST = "groceries.localhost";
function call(env, method, p, { body, cookie, waits } = {}) {
  const headers = { Origin: `http://${HOST}` };
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const execCtx = waits ? { waitUntil: (pr) => waits.push(pr) } : undefined;
  return worker.fetch(new Request(`http://${HOST}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, execCtx);
}
const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
async function household(extra = {}) {
  const env = { ...(await makeEnv()), ...extra };
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  return { env, thomas: tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456" } })) };
}
let counter = 0;
const op = (o) => ({ op_id: `op-shelf-${String(++counter).padStart(6, "0")}`, ...o });
async function send(env, cookie, ops) {
  const waits = [];
  const res = await call(env, "POST", "/api/ops", { cookie, body: { ops }, waits });
  const out = (await res.json()).results;
  await Promise.all(waits);
  return out;
}
const pull = async (env, cookie, since) => (await call(env, "GET", `/api/sync?since=${since}`, { cookie })).json();

/** Claude answers from `table` (name -> [shelf_days, opened_days]) for the numbered lines it was sent. */
function mockShelf(table, { status = 200 } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    // Only shelf requests count here; a new item's English name alone (0029) goes in its own Haiku request.
    const shelf = Boolean(body.output_config.format.schema.properties.items?.items?.properties?.shelf_days);
    if (!shelf) return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "{\"items\":[]}" }] }), { status });
    calls.push({ url: String(url), init, body });
    const lines = body.messages[0].content[0].text.split("\n").map((l) => l.match(/^(\d+)\. ([^(]+?)(?: \(|$)/)).filter(Boolean);
    const items = lines.map(([, n, name]) => ({ n: Number(n), shelf_days: table[name]?.[0] ?? 3, opened_days: table[name]?.[1] ?? 0, kind: "test" }));
    return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ items }) }] }), { status });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("lookup: a purchase of an unknown item asks Haiku once, after the answer, and the item knows from then on", async () => {
  const { env, thomas } = await household({ ANTHROPIC_API_KEY: "test-key-not-real" });
  const head = await pull(env, thomas, 0);
  const claude = mockShelf({ Kwark: [10, 4], "AH Magere kwark 500 g": [12, 5] });
  try {
    const r = await send(env, thomas, [
      op({ type: "receipt.save", id: "receipt-shelf-01", store: "AH", bought_on: "2026-10-28", total_cents: 199, lines: [] }),
      op({ type: "purchase.add", id: "purchase-shelf-1", source: "receipt", receipt_id: "receipt-shelf-01", pantry: true, title: "Kwark",
        item_id: "item-kwark-00001", bought_on: "2026-10-28", qty: 1, product: { id: "product-kwark-1", name: "Magere kwark", brand: "AH", size: "500 g" } }),
    ]);
    assert.ok(r.every((x) => x.ok), JSON.stringify(r));
    assert.equal(claude.calls.length, 1, "one request");
    const sent = claude.calls[0];
    assert.equal(sent.body.model, CHEAP_MODEL);
    assert.equal(sent.body.model, "claude-haiku-5-5");
    assert.equal(sent.body.fallbacks, undefined, "Haiku has no server-side fallback");
    assert.equal(sent.init.headers["anthropic-beta"], undefined);
    assert.equal(sent.body.output_config.format.type, "json_schema");
    assert.match(sent.body.messages[0].content[0].text, /1\. Kwark \(AH Magere kwark\)/, "the item and its product go along");
    assert.match(sent.body.messages[0].content[0].text, /2\. AH Magere kwark 500 g \(Kwark\)/, "the product itself, in the same request");

    const delta = await pull(env, thomas, head.rev);
    const item = delta.items.find((i) => i.id === "item-kwark-00001");
    assert.deepEqual([item.shelf_days, item.opened_days, item.shelf_source], [10, 4, "claude"], "the answer arrives in the delta");
    const product = delta.products.find((p) => p.id === "product-kwark-1");
    assert.deepEqual([product.shelf_days, product.opened_days, product.shelf_source], [12, 5, "claude"], "the product's own answer arrives too");
    const row = delta.pantry.find((p) => p.item_id === "item-kwark-00001");
    assert.deepEqual([row.use_by, row.use_by_source], [addDaysTo("2026-10-28", 12), "estimate"],
      "the row it came with gets its product's estimate, which wins over the item's");

    // Bought again: known now, no second paid call, and the date from the start.
    await send(env, thomas, [op({ type: "pantry.add", id: "pantry-kwark-002", item_id: "item-kwark-xxxx2", title: "Kwark", on: "2026-10-29" })]);
    assert.equal(claude.calls.length, 1);
    const all = await pull(env, thomas, 0);
    assert.equal(all.pantry.find((p) => p.id === "pantry-kwark-002").use_by, "2026-11-08");
    assert.ok(!JSON.stringify(all).includes("test-key"), "the key never comes back");
  } finally {
    claude.restore();
  }
});

function addDaysTo(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

test("lookup: no key, a ticked line of an unknown item, history purchases, a person's value", async () => {
  const off = await household();
  const c0 = mockShelf({});
  try {
    await send(off.env, off.thomas, [op({ type: "pantry.add", id: "pantry-off-0001", item_id: "item-off-000001", title: "Tofu" })]);
    assert.equal(c0.calls.length, 0, "no key: no call");
  } finally {
    c0.restore();
  }

  const { env, thomas } = await household({ ANTHROPIC_API_KEY: "test-key-not-real" });
  const claude = mockShelf({ Tofu: [6, 3] });
  try {
    await send(env, thomas, [
      op({ type: "entry.add", id: "entry-tofu-0001", item_id: "item-tofu-00001", title: "Tofu" }),
      op({ type: "entry.check", id: "entry-tofu-0001", checked: true, on: "2026-10-28" }),
    ]);
    assert.equal(claude.calls.length, 1, "a tick fills the pantry: looked up");
    await send(env, thomas, [op({ type: "purchase.add", id: "purchase-hist-01", source: "history", title: "Zeep", item_id: "item-zeep-00001", bought_on: "2025-01-01" })]);
    assert.equal(claude.calls.length, 1, "the old history is no shopping: no lookup");
    await send(env, thomas, [
      op({ type: "entry.add", id: "entry-ham-00001", item_id: "item-ham-000001", title: "Ham" }),
      op({ type: "item.shelf", item_id: "item-ham-000001", shelf_days: 4, source: "person" }),
      op({ type: "entry.check", id: "entry-ham-00001", checked: true, on: "2026-10-28" }),
    ]);
    assert.equal(claude.calls.length, 1, "a person's value: nothing to look up");
    const all = await pull(env, thomas, 0);
    assert.equal(all.pantry.find((p) => p.item_id === "item-ham-000001").use_by, "2026-11-01", "the tick used the person's 4 days");
  } finally {
    claude.restore();
  }
});

test("lookup: the daily limit per household stops it before the call", async () => {
  const { env, thomas } = await household({ ANTHROPIC_API_KEY: "test-key-not-real" });
  const hh = (await env.DB.prepare("SELECT id FROM households").first()).id;
  await env.DB.prepare("INSERT INTO usage_limits (bucket, count) VALUES (?, ?)")
    .bind(`shelf:${hh}:${new Date().toISOString().slice(0, 10)}`, SHELF_DAILY_LIMIT - 1).run();
  const claude = mockShelf({});
  try {
    await send(env, thomas, [
      op({ type: "pantry.add", id: "pantry-lim-0001", item_id: "item-lim-000001", title: "Hummus" }),
      op({ type: "pantry.add", id: "pantry-lim-0002", item_id: "item-lim-000002", title: "Pesto" }),
    ]);
    assert.equal(claude.calls.length, 1);
    assert.equal((claude.calls[0].body.messages[0].content[0].text.match(/^\d+\. /gm) ?? []).length, 1, "only what fits under the limit is asked");
    await send(env, thomas, [op({ type: "pantry.add", id: "pantry-lim-0003", item_id: "item-lim-000003", title: "Salsa" })]);
    assert.equal(claude.calls.length, 1, "over the limit: no call");
  } finally {
    claude.restore();
  }
});

test("batch route: 25 items in one request, a cursor, excluded and decided items never sent, admins only, 503 without key", async () => {
  const off = await household();
  assert.equal((await call(off.env, "POST", "/api/items/shelf-fill", { cookie: off.thomas, body: {} })).status, 503);
  assert.equal((await call(off.env, "POST", "/api/items/shelf-fill", { body: {} })).status, 401);

  const { env, thomas } = await household({ ANTHROPIC_API_KEY: "test-key-not-real" });
  const names = Array.from({ length: 30 }, (_, i) => `Ding ${String(i).padStart(2, "0")}`);
  await send(env, thomas, [
    ...names.map((title, i) => op({ type: "entry.add", id: `entry-fill-${String(i).padStart(4, "0")}`, item_id: `item-fill-${String(i).padStart(4, "0")}`, title })),
    op({ type: "entry.add", id: "entry-fill-sprt", item_id: "item-fill-sprt1", title: "Groenhof spruitjes" }),
    op({ type: "entry.add", id: "entry-fill-mine", item_id: "item-fill-mine1", title: "Eigen ding" }),
    op({ type: "item.shelf", item_id: "item-fill-mine1", shelf_days: 9, source: "person" }),
  ]);
  const preview = await (await call(env, "POST", "/api/items/shelf-fill", { cookie: thomas, body: { dry_run: true } })).json();
  assert.deepEqual([preview.todo, preview.excluded, preview.person, preview.claude, preview.batch], [30, 1, 1, 0, SHELF_BATCH]);

  const claude = mockShelf({});
  try {
    const first = await (await call(env, "POST", "/api/items/shelf-fill", { cookie: thomas, body: {} })).json();
    assert.equal(claude.calls.length, 1, "one Claude request for the batch");
    assert.equal(first.next, "item-fill-0024");
    assert.deepEqual([first.written, first.asked], [25, 25]);
    const second = await (await call(env, "POST", "/api/items/shelf-fill", { cookie: thomas, body: { after: first.next } })).json();
    assert.equal(second.next, null);
    assert.deepEqual([second.written, second.excluded], [5, 1], "the sprouts is in this batch and is skipped");
    const prompts = claude.calls.map((c) => c.body.messages[0].content[0].text).join("\n");
    assert.doesNotMatch(prompts, /Groenhof|spruitjes/i, "no excluded name goes to Claude");
    assert.doesNotMatch(prompts, /Eigen ding/, "a person's value is never asked again");
    const again = await (await call(env, "POST", "/api/items/shelf-fill", { cookie: thomas, body: {} })).json();
    assert.equal(again.next, null);
    assert.equal(claude.calls.length, 2, "run twice: nothing new is sent");
    const after = await (await call(env, "POST", "/api/items/shelf-fill", { cookie: thomas, body: { dry_run: true } })).json();
    assert.deepEqual([after.todo, after.claude, after.person], [0, 30, 1]);
  } finally {
    claude.restore();
  }
});

test("usage: an item.shelf writes rev + item + applied_ops, the same again no rev, an idle poll reads only the counter", async () => {
  const { env, thomas } = await household();
  await send(env, thomas, [op({ type: "entry.add", id: "entry-use-shelf", item_id: "item-use-shelf1", title: "Yoghurt" })]);
  const head = await pull(env, thomas, 0);
  const batches = [];
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = (stmts) => {
    batches.push(stmts.map((x) => x.sql));
    return batch(stmts);
  };
  await send(env, thomas, [op({ type: "item.shelf", item_id: "item-use-shelf1", shelf_days: 12, opened_days: 4, source: "claude" })]);
  assert.deepEqual(batches.at(-1).map((sql) => sql.match(/^(?:INSERT INTO|UPDATE) (\w+)/)[1]).sort(), ["applied_ops", "households", "items"]);
  const delta = await pull(env, thomas, head.rev);
  assert.deepEqual([delta.items.length, delta.entries.length, delta.pantry.length], [1, 0, 0], "only what changed");
  await send(env, thomas, [op({ type: "item.shelf", item_id: "item-use-shelf1", shelf_days: 12, opened_days: 4, source: "claude" })]);
  assert.deepEqual(batches.at(-1).map((sql) => sql.match(/^(?:INSERT INTO|UPDATE) (\w+)/)[1]), ["applied_ops"], "the same again: no rev");

  const queries = [];
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    queries.push(sql);
    return prepare(sql);
  };
  const idle = await pull(env, thomas, delta.rev);
  assert.equal(idle.items.length, 0);
  assert.equal(queries.filter((sql) => /FROM (items|pantry|list_entries|recipes)\b/.test(sql)).length, 0, "the idle poll touches no data table");
});

test("fill tool: follows the cursor, stops on the limit, cost is a small overestimate", async () => {
  const pages = [{ status: 200, out: { results: [{ name: "Melk", shelf_days: 7, opened_days: 4, kind: "zuivel" }], written: 1, failed: 0, next: "item-b" } },
    { status: 200, out: { results: [], written: 0, failed: 1, next: null } }];
  const sent = [];
  const lines = [];
  const done = await fill(async (body) => { sent.push(body); return pages.shift(); }, (l) => lines.push(l));
  assert.deepEqual(sent, [{}, { after: "item-b" }]);
  assert.deepEqual(done, { written: 1, failed: 1 });
  assert.ok(lines.some((l) => l.startsWith("Melk -> 7 d, open 4 d")));
  const stopped = await fill(async () => ({ status: 429, out: { error: "too_many_shelf" } }), () => {});
  assert.deepEqual(stopped, { written: 0, failed: 0 });
  const cost = estimateCost(1219);
  assert.equal(cost.requests, 49);
  assert.ok(cost.dollars > 0.05 && cost.dollars < 0.25, String(cost.dollars));
});

test("opened: a jar put in partly used, or typed down to a fraction, gets its open shelf life", () => {
  const s = emptyState();
  applyOp(s, { type: "pantry.add", id: "pantry-mayo-0001", title: "Mayonaise", item_id: "item-mayo-00001", on: "2026-10-28", amount: 1 }, ctx());
  applyOp(s, { type: "item.shelf", item_id: "item-mayo-00001", shelf_days: 180, opened_days: 30, source: "claude" }, ctx());
  assert.equal(s.pantry["pantry-mayo-0001"].use_by, "2027-04-26", "a full jar: closed shelf life");
  applyOp(s, { type: "pantry.update", id: "pantry-mayo-0001", amount: 0.3 }, ctx());
  assert.equal(s.pantry["pantry-mayo-0001"].use_by, "2026-11-27", "typed down to 0,3: open, 30 days");
  assert.equal(s.pantry["pantry-mayo-0001"].use_by_source, "estimate");
  applyOp(s, { type: "pantry.add", id: "pantry-mayo-0002", title: "Mayonaise", item_id: "item-mayo-00001", on: "2026-10-28", amount: 0.3 }, ctx());
  assert.equal(s.pantry["pantry-mayo-0002"].use_by, "2026-11-27", "put in at 0,3: open from the start");
  applyOp(s, { type: "pantry.add", id: "pantry-mayo-0003", title: "Mayonaise", item_id: "item-mayo-00001", on: "2026-10-28", amount: 2 }, ctx());
  assert.equal(s.pantry["pantry-mayo-0003"].use_by, "2027-04-26", "whole jars stay closed");
});
