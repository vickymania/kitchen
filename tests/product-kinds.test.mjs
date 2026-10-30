// Product kinds (28-10-2026): a snack, cup or ready meal is never the
// product for an ingredient item. The AH import had put "Knorr Goodpasta" (a
// snack cup) under "Pasta" and made it the AH preference behind "500 g
// pasta". Covers the kind rules, item kinds, the import's guard and its
// preference choice, the op engine's fields, the picker's order, the Haiku
// lookup (globalThis.fetch replaced: no paid call in a test, ever) and the
// audit tool with its fix ops through the real worker.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { applyOp, emptyState, OpError } from "../public/shared/ops.js";
import {
  KINDS, kindFromCategory, kindFromName, productKind, kindFits, itemKinds, itemKind, orderByFit, recipeUse, categoryText,
} from "../public/shared/product-kinds.js";
import { mapProduct, buildOps, vocabulary, importItemKinds } from "../tools/import_ah.mjs";
import { AH_ITEMS } from "../tools/ah_items.mjs";
import { kindAnswers, kindPrompt, KIND_DAILY_LIMIT } from "../worker/kinds.js";
import { importerMayApply } from "../worker/auth.js";
import { auditItems, withKinds, fixOps, importPreferenceId, reportText, targetItem } from "../tools/audit_items.mjs";
import { CHEAP_MODEL } from "../worker/claude.js";

// ------------------------------------------------------------ the rules

test("kinds: AH's category first, sub before main", () => {
  assert.equal(kindFromCategory({ main: "Pasta, rijst, wereldkeuken", sub: "Farfalle" }), "ingredient");
  assert.equal(kindFromCategory("Soepen, sauzen, kruiden, olie > Noedelsoep kip"), "ready_meal", "a noodle cup");
  assert.equal(kindFromCategory("Pasta, rijst, wereldkeuken > Italiaanse maaltijdpakketten, mixen"), "ingredient", "a seasoning mix");
  assert.equal(kindFromCategory("Borrel, chips, snacks > Naturel chips"), "snack");
  assert.equal(kindFromCategory("Borrel, chips, snacks > Pijnboompitten"), "ingredient", "pine nuts are cooked with");
  assert.equal(kindFromCategory("Borrel, chips, snacks > Tortilla chips"), "ingredient", "the nachos lasagne");
  assert.equal(kindFromCategory("Bakkerij > Cake (vers)"), "snack", "brackets are words, not dropped");
  assert.equal(kindFromCategory("Pasta, rijst, wereldkeuken > Seroendeng, gebakken uitjes"), "ingredient", "gebakken is no gebak");
  assert.equal(kindFromCategory("Zuivel, eieren > Halfvolle melk"), "ingredient");
  assert.equal(kindFromCategory("Zuivel, eieren > Chocolademelk"), "drink");
  assert.equal(kindFromCategory("Diepvries > Friet (oven)"), "ingredient");
  assert.equal(kindFromCategory("Diepvries > Pizza (dunne bodem)"), "ready_meal");
  assert.equal(kindFromCategory("Huisdier > Kattenbakvulling"), "pet");
  assert.equal(kindFromCategory("Drogisterij > Tandpasta witte tanden"), "personal_care");
  assert.equal(kindFromCategory("Iets nieuws > Onbekend"), null);
  assert.equal(kindFromCategory(null), null);
  assert.equal(categoryText("Kaas", "Geraspte kaas"), "Kaas > Geraspte kaas");
});

test("kinds: the name rules, exceptions above the rule they override", () => {
  const cases = {
    "Knorr Goodpasta carbonara": "ready_meal", "Unox pasta": "ready_meal", "Pasta beker": "ready_meal",
    "AH Farfalle": "ingredient", Pasta: "ingredient", Tandpasta: "personal_care", "Knorr Maaltijdmix macaroni": "ingredient",
    "Pringles Naturel chips": "snack", "Energy drink": "drink", Kattenbrokken: "pet", "Vochtig toiletpapier": "household",
    "Zeeparel Tonijn in water": "ingredient", Citroensap: "ingredient", Appelsap: "drink", "Unox noodles": "ready_meal",
  };
  for (const [name, kind] of Object.entries(cases)) assert.equal(kindFromName(name), kind, name);
  assert.equal(kindFromName("Raar ding"), null);
  assert.deepEqual(KINDS, ["ingredient", "ready_meal", "snack", "drink", "household", "personal_care", "pet", "other"]);
  assert.equal(productKind({ name: "Goodpasta", brand: "Knorr", kind: null, category: null }), "ready_meal");
  assert.equal(productKind({ name: "Goodpasta", kind: "other" }), "other", "a stored kind wins");
});

test("fits: an ingredient item takes no snack, cup, drink or household; other items are lenient", () => {
  for (const k of ["ready_meal", "snack", "drink", "household", "personal_care", "pet"]) assert.equal(kindFits("ingredient", k), false, k);
  assert.equal(kindFits("ingredient", "ingredient"), true);
  assert.equal(kindFits("ingredient", null), true, "unknown fits");
  assert.equal(kindFits(null, "snack"), true);
  assert.equal(kindFits("snack", "ingredient"), true, "nuts under Nootjes");
  assert.equal(kindFits("snack", "household"), false);
});

// ------------------------------------------------------------ item kinds

function household() {
  const items = {};
  const products = {};
  const purchases = {};
  const item = (id, name) => { items[id] = { id, name, name_key: name.toLowerCase(), deleted_at: null }; };
  const product = (id, name, brand, extra = {}) => { products[id] = { id, name, brand, size: "", store: "Albert Heijn", deleted_at: null, ...extra }; };
  let n = 0;
  const buy = (itemId, productId, times, day = "2026-10-01") => {
    for (let i = 0; i < times; i++) {
      const id = `purchase-${String(++n).padStart(4, "0")}`;
      purchases[id] = { id, item_id: itemId, product_id: productId, receipt_id: `ah-r${n}`, title: items[itemId].name, bought_on: day, store: "Albert Heijn", qty: 1, price_cents: 199, source: "receipt", deleted_at: null };
    }
  };
  return { items, products, purchases, item, product, buy };
}

test("item kind: a recipe's own word makes it an ingredient; a bigger word only when not bought as a snack", () => {
  const h = household();
  h.item("item-pasta", "Pasta");
  h.item("item-chips", "Chips");
  h.item("item-beker", "Pasta beker");
  h.item("item-ijs", "IJs");
  h.product("p-good", "Goodpasta", "Knorr");
  h.product("p-pringles", "Pringles Naturel", "Pringles", { category: "Borrel, chips, snacks > Naturel chips" });
  h.product("p-magnum", "Magnum", "Ola", { category: "Diepvries > Room handijs" });
  h.buy("item-pasta", "p-good", 5);
  h.buy("item-chips", "p-pringles", 4);
  h.buy("item-beker", "p-good", 1);
  h.buy("item-ijs", "p-magnum", 3);
  const recipes = { r1: { id: "r1", title: "Pasta pesto", deleted_at: null, ingredients: [{ name: "pasta" }, { name: "tortilla chips" }, { name: "ijsblokjes" }] } };
  const kinds = itemKinds({ ...h, recipes });
  assert.deepEqual([kinds.get("item-pasta").kind, kinds.get("item-pasta").why], ["ingredient", "recipe"], "5 cups do not outvote the recipe");
  assert.deepEqual([kinds.get("item-chips").kind, kinds.get("item-chips").why], ["snack", "products"]);
  assert.equal(kinds.get("item-beker").kind, "ready_meal", "\"pasta\" does not make Pasta beker an ingredient");
  assert.equal(kinds.get("item-ijs").kind, "snack");
  assert.equal(recipeUse("pasta", ["pasta"]), "exact");
  assert.equal(recipeUse("kaas", ["geraspte kaas"]), "part");
  assert.equal(recipeUse("pasta beker", ["pasta"]), null);
  const data = { ...h, recipes };
  assert.equal(itemKind(data, "item-pasta"), "ingredient");
  assert.equal(itemKind(data, "item-nothere"), null);
});

test("picker: candidates of the wrong kind go last, marked", () => {
  const good = { id: "p-good", name: "Goodpasta", brand: "Knorr" };
  const farfalle = { id: "p-farf", name: "AH Farfalle", brand: "AH", category: "Pasta, rijst, wereldkeuken > Farfalle" };
  const odd = { id: "p-odd", name: "Raar ding", brand: "" };
  const out = orderByFit([good, farfalle, odd], "ingredient");
  assert.deepEqual(out.map((o) => [o.product.id, o.misfit]), [["p-farf", false], ["p-odd", false], ["p-good", true]]);
  assert.deepEqual(orderByFit([good], null).map((o) => o.misfit), [false], "an item of unknown kind: nothing moves");
});

// ------------------------------------------------------------ the AH import

const VOCAB = vocabulary(["Pasta", "Pasta", "Macaroni", "Maaltijdmix", "Chips"], []);
const line = (o) => ({ kind: "product", posId: o.posId ?? 1, webshopId: o.webshopId ?? null, receiptName: o.receiptName ?? o.name.toUpperCase(),
  fullName: o.name, name: o.name, bare: o.bare, brand: o.brand ?? "", size: "", category: o.category ?? "", productKind: o.productKind ?? null, qty: 1, price_cents: 199 });

test("mapping: Goodpasta is never Pasta; AH Farfalle is; the maaltijdmix stays a maaltijdmix", () => {
  const good = line({ name: "Knorr Goodpasta carbonara", bare: "Goodpasta carbonara", brand: "Knorr", webshopId: 777001, productKind: "ready_meal" });
  assert.equal(mapProduct(good, VOCAB, {}).item, "Pasta beker", "a cup gets its own item");
  const noKind = line({ name: "Knorr Goodpasta carbonara", bare: "Goodpasta carbonara", brand: "Knorr", webshopId: 777001 });
  assert.equal(mapProduct(noKind, VOCAB, {}).item, "Pasta beker", "the name rules say so too, without a category");
  const unox = line({ name: "Unox Pasta bolognese", bare: "Pasta bolognese", brand: "Unox", webshopId: 777002 });
  assert.notEqual(mapProduct(unox, VOCAB, {}).item, "Pasta");

  const farfalle = line({ name: "AH Farfalle", bare: "Farfalle", brand: "AH", webshopId: 62025, category: "Pasta, rijst, wereldkeuken > Farfalle", productKind: "ingredient" });
  assert.equal(AH_ITEMS["62025"], "Pasta");
  assert.equal(mapProduct(farfalle, VOCAB).item, "Pasta", "the reviewed table");
  const penne = line({ name: "AH Pasta penne", bare: "Pasta penne", brand: "AH", webshopId: 777003, productKind: "ingredient" });
  assert.equal(mapProduct(penne, VOCAB, {}).item, "Pasta", "an ingredient still maps by its name");

  const mix = line({ name: "Knorr Maaltijdmix macaroni", bare: "Maaltijdmix macaroni", brand: "Knorr", webshopId: 777004,
    category: "Pasta, rijst, wereldkeuken > Italiaanse maaltijdpakketten, mixen", productKind: "ingredient" });
  assert.equal(mapProduct(mix, VOCAB, {}).item, "Maaltijdmix", "not the ingredient Macaroni");
  assert.equal(mapProduct(mix, VOCAB).item, "Maaltijdmix", "and the table agrees (164101 is another id)");

  const pringles = line({ name: "Pringles Naturel", bare: "Naturel", brand: "Pringles", webshopId: 777005, productKind: "snack" });
  assert.equal(mapProduct(pringles, VOCAB, {}).item, "Chips", "a snack under a snack item is fine");
});

const receipt = (id, day, lines) => ({ id, day, city: "Groningen", total_cents: 0, lines, dropped: { excluded: 0, other: 0 } });

test("preference: the import never picks a snack or cup for Pasta, even when bought most", () => {
  const good = () => line({ name: "Goodpasta", bare: "Goodpasta", brand: "Knorr", webshopId: 200183, productKind: "ready_meal" });
  const farfalle = () => line({ name: "AH Farfalle", bare: "Farfalle", brand: "AH", webshopId: 62025, productKind: "ingredient", posId: 2 });
  // The worst case: a table line that still says Goodpasta is Pasta.
  const table = { ...AH_ITEMS, 200183: "Pasta" };
  const rs = [
    receipt("r1", "2026-01-01", [good(), farfalle()]),
    receipt("r2", "2026-02-01", [good()]),
    receipt("r3", "2026-03-01", [good(), farfalle()]),
    receipt("r4", "2026-04-01", [good()]),
  ];
  const built = buildOps(rs, VOCAB, { table });
  const prefs = built.ops.filter((o) => o.type === "preference.set" && o.title === "Pasta");
  assert.equal(prefs.length, 1);
  assert.equal(prefs[0].product_id, "ah-product-62025", "Farfalle (2 receipts), not Goodpasta (4)");
  const onlyCups = buildOps([receipt("r1", "2026-01-01", [good()]), receipt("r2", "2026-02-01", [good()])], VOCAB, { table });
  assert.equal(onlyCups.ops.filter((o) => o.type === "preference.set" && o.title === "Pasta").length, 0, "no preference rather than a cup");
  // The products carry their kind and category to the site.
  const put = built.ops.find((o) => o.type === "product.put" && o.id === "ah-product-62025");
  assert.equal(put.product.kind, "ingredient");
  assert.ok(built.ops.filter((o) => o.type === "product.put").every(importerMayApply), "the importer may send them");
  assert.equal(importItemKinds([{ item: "Pasta", kind: "ready_meal", receipts: new Set([1, 2, 3]) }]).get("pasta"), "ingredient", "the name says ingredient");
});

// ------------------------------------------------------------ the op engine

const ctx = { memberId: "member-thomas-01", isAdmin: true, now: "2026-10-28T10:00:00.000Z" };

test("product.put: category and kind, the kind derived when not given, a bad kind refused", () => {
  const s = emptyState();
  applyOp(s, { type: "product.put", id: "product-farf-01", product: { name: "AH Farfalle", brand: "AH", category: "Pasta, rijst, wereldkeuken > Farfalle" } }, ctx);
  assert.deepEqual([s.products["product-farf-01"].category, s.products["product-farf-01"].kind], ["Pasta, rijst, wereldkeuken > Farfalle", "ingredient"]);
  applyOp(s, { type: "product.put", id: "product-good-01", product: { name: "Goodpasta", brand: "Knorr" } }, ctx);
  assert.equal(s.products["product-good-01"].kind, "ready_meal", "from the name rules");
  applyOp(s, { type: "product.put", id: "product-odd-001", product: { name: "Raar ding" } }, ctx);
  assert.equal(s.products["product-odd-001"].kind, null, "unknown stays null: Claude is asked after the batch");
  applyOp(s, { type: "product.put", id: "product-odd-001", product: { kind: "snack" } }, ctx);
  assert.equal(s.products["product-odd-001"].kind, "snack");
  applyOp(s, { type: "product.put", id: "product-odd-001", product: { last_price_cents: 99 } }, ctx);
  assert.equal(s.products["product-odd-001"].kind, "snack", "a patch without kind keeps it");
  assert.throws(() => applyOp(s, { type: "product.put", id: "product-odd-001", product: { kind: "food" } }, ctx), OpError);
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
async function site(extra = {}) {
  const env = { ...(await makeEnv()), ...extra };
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  return { env, thomas: tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456" } })) };
}
let counter = 0;
const op = (o) => ({ op_id: `op-kinds-${String(++counter).padStart(6, "0")}`, ...o });
async function send(env, cookie, ops) {
  const waits = [];
  const res = await call(env, "POST", "/api/ops", { cookie, body: { ops }, waits });
  const out = (await res.json()).results;
  await Promise.all(waits);
  return out;
}
const pull = async (env, cookie, since) => (await call(env, "GET", `/api/sync?since=${since}`, { cookie })).json();

/** Claude: the kind requests answer from `table` (label -> kind); shelf requests get 3 days. */
function mockClaude(table) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const kindCall = body.output_config.format.schema.required[0] === "products";
    calls.push({ kind: kindCall, body });
    const lines = body.messages[0].content[0].text.split("\n").map((l) => l.match(/^(\d+)\. ([^(]+?)(?: \(|$)/)).filter(Boolean);
    const answer = kindCall
      ? { products: lines.map(([, n, label]) => ({ n: Number(n), kind: table[label] ?? "other" })) }
      : { items: lines.map(([, n]) => ({ n: Number(n), shelf_days: 3, opened_days: 0, kind: "t" })) };
    return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(answer) }] }), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = original; }, kindCalls: () => calls.filter((c) => c.kind) };
}

test("Haiku: a product no rule knows is asked once, after the answer; a known one never; the column syncs", async () => {
  const { env, thomas } = await site({ ANTHROPIC_API_KEY: "test-key-not-real" });
  const head = await pull(env, thomas, 0);
  const claude = mockClaude({ "Zwq Krokantje": "snack" });
  try {
    const r = await send(env, thomas, [
      op({ type: "receipt.save", id: "receipt-kind-01", store: "Dirk", bought_on: "2026-10-28", total_cents: 0, lines: [] }),
      op({ type: "purchase.add", id: "purchase-kind-1", source: "receipt", receipt_id: "receipt-kind-01", title: "Krokantje", item_id: "item-krokant-01",
        bought_on: "2026-10-28", qty: 1, product: { id: "product-krok-1", name: "Krokantje", brand: "Zwq" } }),
      op({ type: "purchase.add", id: "purchase-kind-2", source: "receipt", receipt_id: "receipt-kind-01", title: "Pasta", item_id: "item-pasta-0001",
        bought_on: "2026-10-28", qty: 1, product: { id: "product-farf-1", name: "Farfalle", brand: "AH" } }),
    ]);
    assert.ok(r.every((x) => x.ok), JSON.stringify(r));
    const asked = claude.kindCalls();
    assert.equal(asked.length, 1, "one request for the unknown product");
    assert.equal(asked[0].body.model, CHEAP_MODEL);
    assert.match(asked[0].body.messages[0].content[0].text, /1\. Zwq Krokantje$/, "only the unknown one goes");
    const delta = await pull(env, thomas, head.rev);
    assert.equal(delta.products.find((p) => p.id === "product-krok-1").kind, "snack", "Claude's answer arrives in the delta");
    assert.equal(delta.products.find((p) => p.id === "product-farf-1").kind, "ingredient", "the rules knew this one");
    await send(env, thomas, [op({ type: "purchase.add", id: "purchase-kind-3", source: "receipt", receipt_id: "receipt-kind-01", title: "Krokantje",
      item_id: "item-krokant-01", bought_on: "2026-10-28", qty: 1, product: { id: "product-krok-1", name: "Krokantje", brand: "Zwq" } })]);
    assert.equal(claude.kindCalls().length, 1, "known now: no second paid call");
    assert.ok(KIND_DAILY_LIMIT > 0);
  } finally {
    claude.restore();
  }
});

test("Haiku: excluded never goes, a wrong answer is left out", () => {
  const products = [{ id: "a", label: "Zwq Krokantje" }, { id: "b", label: "Raar" }];
  const got = kindAnswers(products, { products: [{ n: 1, kind: "snack" }, { n: 2, kind: "food" }, { n: 9, kind: "snack" }] });
  assert.deepEqual([...got], [["a", "snack"]]);
  assert.match(kindPrompt(products), /1\. Zwq Krokantje\n2\. Raar$/);
});

// ------------------------------------------------------------ the audit

test("audit: Goodpasta under Pasta is found with its import preference, and --push moves it without deleting a row", async () => {
  const { env, thomas } = await site();
  const recipe = { id: "recipe-pasta-01", title: "Pasta pesto", servings: 2, ingredients: [{ name: "pasta", qty: 500, unit: "g" }], steps: [] };
  const buy = (n, productId, name, brand, day) => op({ type: "purchase.add", id: `purchase-audit-${n}`, source: "receipt", receipt_id: `receipt-audit-${n}`,
    title: "Pasta", item_id: "item-pasta-0001", bought_on: day, store: "Albert Heijn", qty: 1, price_cents: 209, product: { id: productId, name, brand } });
  const ops = [op({ type: "recipe.put", id: recipe.id, recipe })];
  for (let n = 1; n <= 4; n++) ops.push(op({ type: "receipt.save", id: `receipt-audit-${n}`, store: "Albert Heijn", bought_on: `2026-0${n}-01`, total_cents: 0, lines: [] }));
  ops.push(buy(1, "ah-product-200183", "Goodpasta", "Knorr", "2026-01-01"), buy(2, "ah-product-200183", "Goodpasta", "Knorr", "2026-02-01"),
    buy(3, "ah-product-62025", "AH Farfalle", "AH", "2026-03-01"), buy(4, "ah-product-62025", "AH Farfalle", "AH", "2026-04-01"));
  ops.push(op({ type: "preference.set", id: importPreferenceId("Pasta"), item_id: "item-pasta-0001", product_id: "ah-product-200183", store: "Albert Heijn", only_if_unset: true }));
  const r = await send(env, thomas, ops);
  assert.ok(r.every((x) => x.ok), JSON.stringify(r.filter((x) => !x.ok)));

  const read = async () => {
    const all = await pull(env, thomas, 0);
    const byId = (rows) => Object.fromEntries(rows.map((x) => [x.id, x]));
    return { items: byId(all.items), recipes: byId(all.recipes), products: byId(all.products), purchases: byId(all.purchases), preferences: byId(all.preferences) };
  };
  const data = withKinds(await read(), { 62025: { main: "Pasta, rijst, wereldkeuken", sub: "Farfalle" } });
  const audit = auditItems(data);
  assert.equal(audit.mismatches.length, 1);
  const [m] = audit.mismatches;
  assert.equal(m.item.name, "Pasta");
  assert.deepEqual([m.itemKind, m.why], ["ingredient", "recipe"]);
  assert.deepEqual(m.products.map((p) => [p.product.id, p.kind, p.purchases, p.preference]), [["ah-product-200183", "ready_meal", 2, "import"]]);
  assert.equal(m.products[0].target, "Pasta beker");
  assert.match(reportText(audit), /Pasta\s+<- Knorr Goodpasta\s+\(ready_meal, 2x, PREFERENCE import\)\s+-> Pasta beker/);

  const fix = fixOps(data, audit);
  assert.ok(!fix.some((o) => /delete/.test(o.type) && o.type !== "purchase.delete"), "no hard delete of anything");
  const sent = await send(env, thomas, fix);
  assert.ok(sent.every((x) => x.ok), JSON.stringify(sent.filter((x) => !x.ok)));
  const after = await read();
  const live = Object.values(after.purchases);
  const beker = Object.values(after.items).find((i) => i.name === "Pasta beker");
  assert.ok(beker, "the cup's own item");
  assert.equal(live.filter((x) => x.product_id === "ah-product-200183" && x.item_id === "item-pasta-0001").length, 0);
  assert.equal(live.filter((x) => x.product_id === "ah-product-200183" && x.item_id === beker.id).length, 2);
  const tombs = await pull(env, thomas, 1);
  assert.equal(tombs.purchases.filter((x) => x.deleted_at).length, 2, "the old purchases are tombstones, every phone hears it");
  const pref = Object.values(after.preferences).find((p) => p.item_id === "item-pasta-0001" && p.store === "Albert Heijn" && !p.recipe_id);
  assert.equal(pref.product_id, "ah-product-62025", "the AH preference is Farfalle now");
  assert.equal(auditItems(withKinds(after, {})).mismatches.length, 0, "nothing left");
  // Twice is once.
  const again = await send(env, thomas, fix);
  assert.ok(again.every((x) => x.ok));
  assert.equal(Object.values((await read()).purchases).length, live.length);
});

test("audit: a person's preference and the reviewed table are reported, never changed", () => {
  const h = household();
  h.item("item-noodles", "Noodles");
  h.product("ah-product-111", "Nissin cup noodles", "Nissin", { category: "Soepen, sauzen, kruiden, olie > Noedelsoep kip" });
  h.product("ah-product-222", "AH Mie", "AH", { category: "Pasta, rijst, wereldkeuken > Noedels" });
  h.buy("item-noodles", "ah-product-111", 2);
  h.buy("item-noodles", "ah-product-222", 1);
  const recipes = { r: { id: "r", title: "Bami", deleted_at: null, ingredients: [{ name: "noodles" }] } };
  const preferences = { "pref-person": { id: "pref-person", item_id: "item-noodles", product_id: "ah-product-111", store: "Albert Heijn", recipe_id: "", deleted_at: null } };
  const data = withKinds({ ...h, recipes, preferences });
  const audit = auditItems(data);
  assert.equal(audit.mismatches[0].products[0].preference, "person");
  assert.equal(fixOps(data, audit).filter((o) => o.type.startsWith("preference")).length, 0, "a person's choice stays");
  assert.ok(audit.merged.some((m) => m.item.id === "item-noodles") || audit.mismatches.length === 1);
  assert.equal(targetItem(data.products["ah-product-111"], data.items["item-noodles"], new Map(), () => null), "Noodles beker");
});
