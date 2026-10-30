// The kitchen MCP server as Claude runs it: a separate process speaking
// JSON-RPC over stdio, talking HTTP to the real worker (on the D1 stand-in).
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mcp", "server.mjs");
// The server gets the tests' made-up never-suggest list too (tests/never-suggest.mjs).
const NEVER_SUGGEST = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "never-suggest.mjs")).href;

async function liveWorker() {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "654321" }));
  const httpServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = `http://recipes.localhost${req.url}`;
    const response = await worker.fetch(new Request(url, {
      method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
    }), env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${httpServer.address().port}`;
  const paired = await fetch(`${origin}/api/pair`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "http://recipes.localhost" },
    body: JSON.stringify({ code: "654321", label: "test" }),
  });
  const token = paired.headers.getSetCookie()[0].match(/^kd=([^;]+)/)[1];
  return { env, origin, token, close: () => httpServer.close() };
}

function mcp(origin, token) {
  const child = spawn(process.execPath, ["--import", NEVER_SUGGEST, SERVER], { env: { ...process.env, KITCHEN_ORIGIN: origin, KITCHEN_TOKEN: token } });
  let buffer = "";
  const waiting = new Map();
  child.stdout.on("data", (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  let n = 0;
  const call = (method, params) => new Promise((resolve) => {
    const id = ++n;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const tool = async (name, args) => {
    const msg = await call("tools/call", { name, arguments: args });
    return { text: msg.result.content[0].text, error: Boolean(msg.result.isError) };
  };
  return { call, tool, close: () => child.kill() };
}

test("the kitchen MCP server: recipes in, ingredients onto the list, merged", async () => {
  const live = await liveWorker();
  const client = mcp(live.origin, live.token);
  try {
    const init = await client.call("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(init.result.serverInfo.name, "kitchen");
    const list = await client.call("tools/list", {});
    assert.ok(list.result.tools.some((t) => t.name === "kitchen_recipe_to_list"));

    const saved = await client.tool("kitchen_recipe_save", {
      title: "Kip kerrie", servings: 4,
      ingredients: ["300 gr rijst", "400 gr kip", "2 ui", "optioneel: maïzena", "200 ml water"],
      steps: ["Kook de rijst.", "Bak de kip 10 minuten."],
    });
    assert.match(saved.text, /Created: Kip kerrie, 5 ingredients, 2 steps/);
    const id = saved.text.match(/\[id: ([\w-]+)\]/)[1];

    await client.tool("kitchen_list_add", { items: [{ title: "Ui", amount: "1" }, { title: "Waspods" }] });
    const added = await client.tool("kitchen_recipe_to_list", { id, servings: 2, skip: ["rijst", "water"] });
    assert.match(added.text, /2 ingredients of Kip kerrie put on the list \(for 2 people\)/);

    const got = await client.tool("kitchen_list_get", {});
    assert.match(got.text, /To get \(3\)/);
    assert.match(got.text, /- [Uu]i — 2 — for Kip kerrie/);
    assert.match(got.text, /kip — 200 gr — for Kip kerrie/);
    assert.doesNotMatch(got.text, /maïzena|rijst/);

    const found = await client.tool("kitchen_recipes_search", { query: "kip" });
    assert.match(found.text, /1 recipe:/);
    const bad = await client.tool("kitchen_recipe_save", { servings: 2 });
    assert.equal(bad.error, true);
  } finally {
    client.close();
    live.close();
  }
});

test("the kitchen MCP server: a recipe's lines land on the household's own items (ingredient-match.js)", async () => {
  const live = await liveWorker();
  const client = mcp(live.origin, live.token);
  try {
    await client.tool("kitchen_list_add", { items: [{ title: "Bloem" }, { title: "Eieren" }, { title: "Zout" }, { title: "Peper" }] });
    const saved = await client.tool("kitchen_recipe_save", {
      title: "Broodjes van Noor", servings: 4,
      ingredients: ["500 g wit patentbloem", "1 ei", "1 ei, losgeklopt", "zout en peper"],
    });
    const id = saved.text.match(/\[id: ([\w-]+)\]/)[1];
    await client.tool("kitchen_recipe_to_list", { id });
    const got = await client.tool("kitchen_list_get", {});
    assert.match(got.text, /- Bloem — 500 g(r)? — for Broodjes van Noor/);
    assert.match(got.text, /- Eieren — 2 — for Broodjes van Noor/);
    assert.match(got.text, /- Zout — for Broodjes van Noor/);
    assert.match(got.text, /- Peper — for Broodjes van Noor/);
    assert.doesNotMatch(got.text, /patentbloem|losgeklopt|zout en peper/);
  } finally {
    client.close();
    live.close();
  }
});

test("the kitchen MCP server: preferred products per store and recipe, offers on them, never an excluded thing", async () => {
  const live = await liveWorker();
  const today = new Date().toLocaleDateString("sv-SE");
  const later = new Date(Date.now() + 4 * 86_400_000).toLocaleDateString("sv-SE");
  const ops = [
    { type: "recipe.put", id: "recipe-nachos-01", recipe: { title: "Mexicaanse nachos lasagne" } },
    { type: "entry.add", id: "entry-chips-0001", item_id: "item-chips-0001", title: "Tortilla chips", source: { recipe_id: "recipe-nachos-01", title: "Mexicaanse nachos lasagne" } },
    { type: "product.put", id: "product-doritos", product: { name: "Nacho Cheese", brand: "Doritos", size: "185 g", item_id: "item-chips-0001" } },
    { type: "product.put", id: "product-dirk-ch", product: { name: "Tortilla chips naturel", brand: "Dirk", size: "200 g", store: "Dirk", item_id: "item-chips-0001" } },
    { type: "preference.set", id: "pref-mcp-00001", item_id: "item-chips-0001", product_id: "product-doritos" },
    { type: "preference.set", id: "pref-mcp-00002", item_id: "item-chips-0001", store: "Dirk", recipe_id: "recipe-nachos-01", product_id: "product-dirk-ch" },
  ].map((o, i) => ({ op_id: `op-mcp-pref-${i}000`, ...o }));
  const res = await fetch(`${live.origin}/api/ops`, {
    method: "POST", headers: { Authorization: `Bearer ${live.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ops }),
  });
  assert.ok((await res.json()).results.every((r) => r.ok));
  // Offers as the fetcher stores them, plus one excluded row that slipped in.
  const { id: hh, rev } = await live.env.DB.prepare("SELECT id, rev FROM households").first();
  const offer = (id, store, name, brand) => `('${id}', '${hh}', '${store}', '${name}', ${brand ? `'${brand}'` : "NULL"}, NULL, '1+1 gratis', 199, '${today}', '${later}', NULL, '${today}', '${today}', NULL, ${rev})`;
  await live.env.DB.exec(`INSERT INTO offers (id, household_id, store, name, brand, size, deal, price_cents, valid_from, valid_until, category, created_at, updated_at, deleted_at, rev) VALUES
    ${offer("of-mcp-0001", "Albert Heijn", "Doritos Nacho Cheese", "Doritos")},
    ${offer("of-mcp-0002", "Dirk", "Tortilla chips naturel", null)},
    ${offer("of-mcp-0003", "Lidl", "Tortilla chips paprika", null)},
    ${offer("of-mcp-0004", "Dirk", "Groene Ster spruitjes", null)};`);
  const client = mcp(live.origin, live.token);
  try {
    const list = await client.tool("kitchen_list_get", {});
    assert.match(list.text, /preferred: Dirk Tortilla chips naturel, 200 g \(Dirk, for Mexicaanse nachos lasagne\); Doritos Nacho Cheese, 185 g \(any store\)/);
    assert.match(list.text, /their product on offer: Albert Heijn · Doritos Nacho Cheese · 1\+1 gratis · €1,99/);

    const atDirk = await client.tool("kitchen_list_get", { store: "dirk" });
    assert.match(atDirk.text, /To get \(1\) at Dirk:/);
    assert.match(atDirk.text, /buy at Dirk: Dirk Tortilla chips naturel, 200 g \(for Mexicaanse nachos lasagne\)/);
    assert.match(atDirk.text, /their product on offer: Dirk · Tortilla chips naturel/);
    assert.doesNotMatch(atDirk.text, /Albert Heijn|Lidl/, "only that store's folder");

    const query = await client.tool("kitchen_offers", { query: "tortilla chips" });
    const lines = query.text.split("\n");
    assert.match(lines[0], /^- Dirk · Tortilla chips naturel .*\[their product: Dirk Tortilla chips naturel, 200 g for Tortilla chips\]$/, "theirs first");
    assert.match(query.text, /- Lidl · Tortilla chips paprika/);
    const forList = await client.tool("kitchen_offers", { store: "AH" });
    assert.match(forList.text, /^Tortilla chips:\n- Albert Heijn · Doritos Nacho Cheese .*\[their product: Doritos Nacho Cheese, 185 g for Tortilla chips\]/);

    for (const q of ["spruiten", "groene ster", "spruitjes"]) {
      const sprouts = await client.tool("kitchen_offers", { query: q });
      assert.match(sprouts.text, /^No current offers/, `never an excluded thing (${q})`);
    }
    const ratings = await client.tool("kitchen_product_ratings", { query: "chips" });
    assert.match(ratings.text, /item: Tortilla chips \(preferred: Dirk for Mexicaanse nachos lasagne\)/);

    // "Alleen bij deze winkel": the Dirk chips are sold at Dirk only, so at AH
    // the line says "haal bij Dirk", and with no store too.
    const only = await fetch(`${live.origin}/api/ops`, {
      method: "POST", headers: { Authorization: `Bearer ${live.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ops: [{ op_id: "op-mcp-store-only", type: "product.put", id: "product-dirk-ch", product: { store_only: true } }] }),
    });
    assert.ok((await only.json()).results[0].ok);
    const atAh = await client.tool("kitchen_list_get", { store: "AH" });
    assert.match(atAh.text, /haal bij Dirk: Dirk Tortilla chips naturel, 200 g \(only sold at Dirk\) \(for Mexicaanse nachos lasagne\)/);
    assert.doesNotMatch(atAh.text, /buy at Albert Heijn/);
    assert.match((await client.tool("kitchen_product_ratings", { query: "chips" })).text, /only sold at Dirk/);
  } finally {
    client.close();
    live.close();
  }
});

test("the kitchen MCP server: due items from the history, ratings read and written", async () => {
  const live = await liveWorker();
  // Local dates, like the server's "today": a UTC date is a day off between 00:00 and 01:00.
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toLocaleDateString("sv-SE");
  // Melk every 10 days, last 10 days ago: due. Kaas every 30, last 10 ago: later.
  const ops = [[30, 70], [20, 40], [10, 10]].flatMap(([melk, kaas], i) => [
    { op_id: `op-mcp-hist-melk-${i}`, type: "purchase.add", id: `purchase-mcp-melk-${i}`, source: "history", title: "Melk", item_id: "item-mcp-melk-0", bought_on: daysAgo(melk) },
    { op_id: `op-mcp-hist-kaas-${i}`, type: "purchase.add", id: `purchase-mcp-kaas-${i}`, source: "history", title: "Kaas", item_id: "item-mcp-kaas-0", bought_on: daysAgo(kaas) },
  ]);
  ops.push({ op_id: "op-mcp-product-01", type: "product.put", id: "product-mcp-001", product: { name: "Halfvolle melk", brand: "AH", size: "1 l", item_id: "item-mcp-melk-0" } });
  const res = await fetch(`${live.origin}/api/ops`, {
    method: "POST", headers: { Authorization: `Bearer ${live.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ops }),
  });
  assert.ok((await res.json()).results.every((r) => r.ok));
  const client = mcp(live.origin, live.token);
  try {
    const due = await client.tool("kitchen_due_items", {});
    assert.match(due.text, /- Melk: last 10 days ago, usually every ~10 days \(due\)/);
    assert.doesNotMatch(due.text, /Kaas/);
    const later = await client.tool("kitchen_due_items", { include_later: true });
    assert.match(later.text, /- Kaas: last 10 days ago, usually every ~30 days$/);

    const rated = await client.tool("kitchen_product_rate", { product_id: "product-mcp-001", stars: 4, note: "goed" });
    assert.equal(rated.text, "Rated 4/10.");
    const read = await client.tool("kitchen_product_ratings", { query: "melk" });
    assert.match(read.text, /- AH Halfvolle melk, 1 l \[id: product-mcp-001\] item: Melk; ratings: Thomas 4\/10 "goed"/);
    const wrong = await client.tool("kitchen_product_rate", { product_id: "product-mcp-404", stars: 4 });
    assert.equal(wrong.error, true);
  } finally {
    client.close();
    live.close();
  }
});

test("the kitchen MCP server: the pantry, due first, never an excluded thing, and 'need it again' skips what is there", async () => {
  const live = await liveWorker();
  const day = (n) => new Date(Date.now() + n * 86_400_000).toLocaleDateString("sv-SE");
  const ops = [
    { type: "entry.add", id: "entry-mcp-kip-01", item_id: "item-mcp-kip-001", title: "Kipfilet" },
    { type: "entry.check", id: "entry-mcp-kip-01", checked: true, on: day(0) },
    { type: "pantry.add", id: "pantry-mcp-rijst", item_id: "item-mcp-rijst-1", title: "Rijst", amount: 2, on: day(0) },
    { type: "pantry.add", id: "pantry-mcp-kaas1", item_id: "item-mcp-kaas-01", title: "Kaas", amount: 0.5, pack_size: "400 g", use_by: day(20), on: day(0) },
    { type: "item.shelf", item_id: "item-mcp-kaas-01", shelf_days: 28, opened_days: 5, source: "person" },
    { type: "pantry.add", id: "pantry-mcp-sla01", item_id: "item-mcp-sla-001", title: "Sla", on: day(-1) },
    { type: "pantry.use", reason: "thrown", takes: [{ event_id: "event-mcp-sla-01", pantry_id: "pantry-mcp-sla01" }] },
    { type: "pantry.add", id: "pantry-mcp-sla02", item_id: "item-mcp-sla-002", title: "Sla", on: day(-1) },
    ...[30, 23, 16, 9].map((n, i) => ({ type: "purchase.add", id: `purchase-mcp-r${i}00`, source: "history", title: "Rijst", item_id: "item-mcp-rijst-1", bought_on: day(-n) })),
  ].map((o, i) => ({ op_id: `op-mcp-pantry-${String(i).padStart(3, "0")}`, ...o }));
  const res = await fetch(`${live.origin}/api/ops`, {
    method: "POST", headers: { Authorization: `Bearer ${live.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ops }),
  });
  const results = (await res.json()).results;
  assert.ok(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
  // A sprouts row that slipped in by hand is never named.
  const { id: hh, rev } = await live.env.DB.prepare("SELECT id, rev FROM households").first();
  await live.env.DB.exec(`INSERT INTO pantry (id, household_id, item_id, title, amount, added_on, use_by, created_at, updated_at, rev)
    VALUES ('pantry-mcp-sprt', '${hh}', 'item-mcp-kip-001', 'Groene Ster spruitjes', 6, '${day(0)}', '${day(0)}', '${day(0)}', '${day(0)}', ${rev});`);
  const client = mcp(live.origin, live.token);
  try {
    const got = await client.tool("kitchen_pantry_get", {});
    const [due, rest] = got.text.split("\n\n");
    assert.match(due, /^Use up soon:\n- Kipfilet: 1, use by \d{4}-\d{2}-\d{2} \(estimated\), in 2 days\n- Sla: 1, use by \d{4}-\d{2}-\d{2} \(estimated\), in 2 days, thrown away 1x before$/);
    assert.match(rest, /^In the house:\n- Kaas: 0.5 x 400 g, use by \d{4}-\d{2}-\d{2}, keeps ~28 days closed, ~5 days open\n- Rijst: 2, no date$/);
    assert.doesNotMatch(got.text, /spruit|Groene Ster/i);
    const dueItems = await client.tool("kitchen_due_items", { include_later: true });
    assert.match(dueItems.text, /- Rijst: last 9 days ago, usually every ~7 days \[still in the pantry\]/, "bought again on rhythm, but still there: not due");
  } finally {
    client.close();
    live.close();
  }
});

test("the kitchen MCP server: deal rules set and read back, hits with reasons, AH and Dirk only unless a detour, never an excluded thing", async () => {
  const live = await liveWorker();
  const day = (n) => new Date(Date.now() + n * 86_400_000).toLocaleDateString("sv-SE");
  const ops = [
    { type: "entry.add", id: "entry-mcp-wipe1", item_id: "item-mcp-wipes-1", title: "Vochtig toiletpapier" },
    { type: "entry.add", id: "entry-mcp-cat01", item_id: "item-mcp-cat-001", title: "Nat kattenvoer" },
    { type: "product.put", id: "product-mcp-edet", product: { item_id: "item-mcp-wipes-1", brand: "Edet", name: "Edet Amandelmelk vochtig toiletpapier", size: "42 stuks", store: "Albert Heijn", last_price_cents: 279 } },
    { type: "pantry.add", id: "pantry-mcp-cat01", item_id: "item-mcp-cat-001", title: "Nat kattenvoer", on: day(-5) },
    { type: "pantry.use", reason: "used", takes: [{ event_id: "event-mcp-cat-01", pantry_id: "pantry-mcp-cat01" }] },
    // Kwark bought on three days, no rule: an implicit "only on offer" rule.
    ...[10, 40, 70].map((n) => ({ type: "purchase.add", id: `purchase-mcp-kwark-${n}`, source: "receipt", title: "Kwark", item_id: "item-mcp-kwark-1", store: "Albert Heijn", bought_on: day(-n), price_cents: 289,
      product: { id: "product-mcp-melko", brand: "Melko", name: "Melko Romige kwark mango kiwi banaan", size: "450 g" } })),
  ].map((o, i) => ({ op_id: `op-mcp-deals-${String(i).padStart(3, "0")}`, ...o }));
  const res = await fetch(`${live.origin}/api/ops`, {
    method: "POST", headers: { Authorization: `Bearer ${live.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ops }),
  });
  assert.ok((await res.json()).results.every((r) => r.ok));
  const { id: hh } = await live.env.DB.prepare("SELECT id FROM households").first();
  const offer = (id, store, name, size, deal, price) => `('${id}', '${hh}', '${store}', '${name}', NULL, ${size ? `'${size}'` : "NULL"}, ${deal ? `'${deal}'` : "NULL"}, ${price ?? "NULL"}, '${day(-1)}', '${day(3)}', NULL, '${day(0)}', '${day(0)}', NULL, (SELECT rev FROM households))`;
  await live.env.DB.exec(`UPDATE households SET rev = rev + 1;
    INSERT INTO offers (id, household_id, store, name, brand, size, deal, price_cents, valid_from, valid_until, category, created_at, updated_at, deleted_at, rev) VALUES
    ${offer("of-mcp-edet-ah", "Albert Heijn", "Edet vochtig toiletpapier", null, "-55%", 119)},
    ${offer("of-mcp-edet-dk", "Dirk", "Edet vochtig toiletpapier maxi pack", null, null, 199)},
    ${offer("of-mcp-edet-hv", "Hoogvliet", "Edet vochtig toiletpapier", null, "-57%", 109)},
    ${offer("of-mcp-cat-lid", "Lidl", "Nat kattenvoer in saus", "12 x 85 g", "-20%", 520)},
    ${offer("of-mcp-sprx-ah", "Albert Heijn", "Nat kattenvoer verse spruitjes saus", null, "25% korting", 449)},
    ${offer("of-mcp-melko", "Albert Heijn", "Alle Alpro en Melko 400-500 gram", "500 gram", "2 voor 3.99", null)},
    ${offer("of-mcp-kwark-l", "Lidl", "Kwark", null, "-30%", 99)};`);
  const client = mcp(live.origin, live.token);
  try {
    const first = (await client.tool("kitchen_deals", {})).text;
    assert.match(first, /No deal rules yet/);
    assert.match(first, /^Deals now:\n- \[you buy it often\] \[check: they usually buy Melko Romige kwark mango kiwi banaan\] Kwark: Albert Heijn · Alle Alpro en Melko 400-500 gram · 500 gram · 2 voor 3\.99 · .*\n {2}no rule: bought on 3 days in the past year, only on offer$/m, "no note: the list line shows its offers live");
    assert.doesNotMatch(first, /Lidl/, "without a rule only AH and Dirk");
    const set = await client.tool("kitchen_deal_rule_set", { item: "Vochtig toiletpapier", product_id: "product-mcp-edet", max_price: 1.25 });
    assert.equal(set.error, false, set.text);
    assert.match(set.text, /Rule for Vochtig toiletpapier \(Edet .*Amandelmelk vochtig toiletpapier, 42 stuks\): at most €1,25 each/);
    const cat = await client.tool("kitchen_deal_rule_set", { item: "nat kattenvoer", detour: true });
    assert.match(cat.text, /worth a detour/);
    assert.equal((await client.tool("kitchen_deal_rule_set", { item: "Verse spruitjes", detour: true })).error, true, "excluded refused");

    const deals = (await client.tool("kitchen_deals", {})).text;
    assert.match(deals, /^Deals now:\n- \[recommended: nothing left in the pantry\] Nat kattenvoer: Lidl \(detour\) · Nat kattenvoer in saus · 12 x 85 g · -20% · €5,20 each, €5,10 per kg, €0,43 per piece, 20% off/);
    assert.match(deals, /- Vochtig toiletpapier: Albert Heijn · Edet vochtig toiletpapier · -55% · €1,19 each, 55% off · until \d{4}-\d{2}-\d{2}\n {2}rule: at most €1,25 each \(multi-buys per piece\); only at Albert Heijn and Dirk \(for Edet .*Amandelmelk vochtig toiletpapier, 42 stuks\)$/m);
    assert.doesNotMatch(deals, /Hoogvliet/, "not a regular store and no detour");
    assert.doesNotMatch(deals, /Dirk · Edet/, "€1,99 is over €1,25");
    assert.doesNotMatch(deals, /spruit/i);
    assert.match(deals, /Rules:\n- Vochtig toiletpapier \(for Edet/);

    // A patch: detour added, the price kept; then Hoogvliet counts.
    const patched = await client.tool("kitchen_deal_rule_set", { item: "Vochtig toiletpapier", product_id: "product-mcp-edet", detour: true });
    assert.match(patched.text, /at most €1,25 each \(multi-buys per piece\); worth a detour/);
    assert.match((await client.tool("kitchen_deals", {})).text, /Vochtig toiletpapier: Hoogvliet \(detour\) · Edet vochtig toiletpapier/);

    // Only the pink one: the folder names no kind, so both are check hits.
    const pink = await client.tool("kitchen_deal_rule_set", { item: "Vochtig toiletpapier", product_id: "product-mcp-edet", require_words: ["Amandelmelk"] });
    assert.match(pink.text, /only when the offer says amandelmelk \(no kind named: a check hit\)/);
    assert.match((await client.tool("kitchen_deals", {})).text, /- \[check: is it amandelmelk\?\] Vochtig toiletpapier: Albert Heijn · Edet/);
    // Cat food found by its words.
    const words = await client.tool("kitchen_deal_rule_set", { item: "nat kattenvoer", match_words: ["felix", "pouches"] });
    assert.match(words.text, /worth a detour \(any store\); also found by: felix, pouches/);

    const cleared = await client.tool("kitchen_deal_rule_set", { item: "Vochtig toiletpapier", product_id: "product-mcp-edet", clear: true });
    assert.match(cleared.text, /Rule removed/);
    assert.doesNotMatch((await client.tool("kitchen_deals", {})).text, /toiletpapier/i);
  } finally {
    client.close();
    live.close();
  }
});

test("the kitchen MCP server: running low, with why, never an excluded thing, never what is on the list", async () => {
  const live = await liveWorker();
  const day = (n) => new Date(Date.now() + n * 86_400_000).toLocaleDateString("sv-SE");
  const ops = [
    { type: "recipe.put", id: "recipe-mcp-nasi1", recipe: { title: "Nasi", servings: 2, ingredients: [{ name: "rijst", qty: 300, unit: "g" }] } },
    { type: "pantry.add", id: "pantry-mcp-low-r", item_id: "item-mcp-low-rijst", title: "Rijst", amount: 0.4, pack_size: "1 kg", on: day(-3) },
    { type: "pantry.use", reason: "cooked", recipe_id: "recipe-mcp-nasi1", on: day(-1), takes: [{ event_id: "event-mcp-low-r1", pantry_id: "pantry-mcp-low-r", amount: 0.3 }] },
    { type: "pantry.add", id: "pantry-mcp-low-m", item_id: "item-mcp-low-mosterd", title: "Mosterd", on: day(-3) },
    { type: "pantry.use", reason: "used", on: day(0), takes: [{ event_id: "event-mcp-low-m1", pantry_id: "pantry-mcp-low-m" }] },
    { type: "pantry.add", id: "pantry-mcp-low-k", item_id: "item-mcp-low-kaas", title: "Kaas", amount: 0.2, pack_size: "400 g", on: day(-3) },
    { type: "item.low", item_id: "item-mcp-low-kaas", low_at: "100 g" },
    { type: "pantry.add", id: "pantry-mcp-low-t", item_id: "item-mcp-low-thee", title: "Thee", amount: 0.1, on: day(-3) },
    { type: "entry.add", id: "entry-mcp-low-t1", item_id: "item-mcp-low-thee2", title: "Thee" },
  ].map((o, i) => ({ op_id: `op-mcp-low-${String(i).padStart(3, "0")}`, ...o }));
  const res = await fetch(`${live.origin}/api/ops`, {
    method: "POST", headers: { Authorization: `Bearer ${live.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ops }),
  });
  const results = (await res.json()).results;
  assert.ok(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
  const { id: hh, rev } = await live.env.DB.prepare("SELECT id, rev FROM households").first();
  await live.env.DB.exec(`INSERT INTO pantry (id, household_id, item_id, title, amount, added_on, created_at, updated_at, rev)
    VALUES ('pantry-mcp-low-b', '${hh}', 'item-mcp-low-kaas', 'Groene Ster spruitjes', 0.1, '${day(0)}', '${day(0)}', '${day(0)}', ${rev});`);
  const client = mcp(live.origin, live.token);
  try {
    const list = await client.call("tools/list", {});
    assert.ok(list.result.tools.some((t) => t.name === "kitchen_low_stock"));
    const got = await client.tool("kitchen_low_stock", {});
    assert.equal(got.text, [
      `- Mosterd: ran out on ${day(0)} (marked 'op')`,
      "- Rijst (pack 1 kg): 100 g left, not enough for Nasi",
      "- Kaas (pack 400 g): 80 g left, under 100 g",
    ].join("\n"), "Thee is on the list, the sprouts is never named");
  } finally {
    client.close();
    live.close();
  }
});

test("the kitchen MCP server: things used at a steady rate, counted down in the pantry and 'Bijna op', the rate set by name", async () => {
  const live = await liveWorker();
  const day = (n) => new Date(Date.now() + n * 86_400_000).toLocaleDateString("sv-SE");
  const ops = [
    { type: "pantry.add", id: "pantry-mcp-rate-c", item_id: "item-mcp-rate-cat1", title: "Minoes eten", amount: 33, on: day(-7) },
    { type: "item.rate", item_id: "item-mcp-rate-cat1", use_per_day: 6 / 7, source: "person", on: day(-7) },
    { type: "pantry.add", id: "pantry-mcp-rate-t", item_id: "item-mcp-rate-tuna", title: "Minoestuna", amount: 1, on: day(-2) },
    { type: "item.rate", item_id: "item-mcp-rate-tuna", use_per_day: 1 / 7, source: "person", on: day(-2) },
  ].map((o, i) => ({ op_id: `op-mcp-rate-${String(i).padStart(3, "0")}`, ...o }));
  const res = await fetch(`${live.origin}/api/ops`, {
    method: "POST", headers: { Authorization: `Bearer ${live.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ops }),
  });
  const results = (await res.json()).results;
  assert.ok(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
  const client = mcp(live.origin, live.token);
  try {
    const pantry = await client.tool("kitchen_pantry_get", {});
    assert.match(pantry.text, /- Minoes eten: 27, no date, used ~6 per week \(set by the household\), ~31 days left/);
    assert.match(pantry.text, /- Minoestuna: 0\.75, .*used ~1 per week \(set by the household\), ~5 days left/);
    const low = await client.tool("kitchen_low_stock", {});
    assert.equal(low.text, "- Minoestuna: 0.75 pack left, ~5 days left at 1 per week", "the cat food has a month left: not low");

    const set = await client.tool("kitchen_pantry_rate_set", { item: "Waterfilter kattenfontein", every_days: 30 });
    assert.equal(set.text, "Waterfilter kattenfontein: 1 per month (set by the household).");
    const guess = await client.tool("kitchen_pantry_rate_set", { item: "Waterfilter kattenfontein", every_days: 20, estimate: true });
    assert.match(guess.text, /Kept the household's own rate/);
    const tooth = await client.tool("kitchen_pantry_rate_set", { item: "Tandpasta", clear: true });
    assert.equal(tooth.text, "Tandpasta: 1 every 42 days (default estimate for household goods).");
    const sprouts = await client.tool("kitchen_pantry_rate_set", { item: "Groenhof", per_week: 6 });
    assert.equal(sprouts.error, true);
    const two = await client.tool("kitchen_pantry_rate_set", { item: "Minoestuna", per_week: 1, per_day: 1 });
    assert.equal(two.error, true, "exactly one of the rates");
  } finally {
    client.close();
    live.close();
  }
});

test("the kitchen MCP server: two items merged by name; the old name lands on the new item", async () => {
  const live = await liveWorker();
  const ops = [
    { type: "entry.add", id: "entry-mcp-merge-01", item_id: "item-mcp-merge-tonijn", title: "Tonijn" },
    { type: "item.rate", title: "Minoestuna", item_id: "item-mcp-merge-minoes", use_per_day: 1 / 7, source: "person", on: "2026-10-20" },
  ].map((o, i) => ({ op_id: `op-mcp-merge-${String(i).padStart(3, "0")}`, ...o }));
  const res = await fetch(`${live.origin}/api/ops`, {
    method: "POST", headers: { Authorization: `Bearer ${live.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ops }),
  });
  assert.ok((await res.json()).results.every((r) => r.ok));
  const client = mcp(live.origin, live.token);
  try {
    const list = await client.call("tools/list", {});
    assert.ok(list.result.tools.some((t) => t.name === "kitchen_item_merge"));
    const dry = await client.tool("kitchen_item_merge", { from: "Tonijn", into: "Minoestuna", dry_run: true });
    assert.equal(dry.text, 'Would merge Tonijn into Minoestuna: 1 list lines. After it, "Tonijn" means Minoestuna.');
    assert.equal((await client.tool("kitchen_item_merge", { from: "Tonijn", into: "Sardines" })).error, true, "both must exist");
    assert.equal((await client.tool("kitchen_item_merge", { from: "Tonijn", into: "tonijn" })).error, true, "the same item");
    const done = await client.tool("kitchen_item_merge", { from: "Tonijn", into: "Minoestuna" });
    assert.equal(done.text, 'Merged Tonijn into Minoestuna: 1 list lines. "Tonijn" now means Minoestuna.');
    await client.tool("kitchen_list_add", { items: [{ title: "Tonijn", amount: "2" }] });
    const got = await client.tool("kitchen_list_get", {});
    assert.match(got.text, /Minoestuna/);
    assert.doesNotMatch(got.text, /Tonijn/);
  } finally {
    client.close();
    live.close();
  }
});

test("the kitchen MCP server: kitchen_list_add says what each line linked to and whether it is new; kitchen_item_alias gives a name", async () => {
  const live = await liveWorker();
  const client = mcp(live.origin, live.token);
  try {
    await client.call("initialize", { protocolVersion: "2025-06-18" });
    await client.tool("kitchen_list_add", { items: [{ title: "Minoes brokken" }, { title: "Frisdrank" }, { title: "Sodastream cola" }] });
    await client.tool("kitchen_list_add", { items: [{ title: "Cola" }] });
    const merged = await client.tool("kitchen_item_merge", { from: "Cola", into: "Frisdrank" });
    assert.equal(merged.error, false, merged.text);
    const named = await client.tool("kitchen_item_alias", { item: "Minoes brokken", name: "Pluizenbolbrokkenman" });
    assert.match(named.text, /"Pluizenbolbrokkenman" now means Minoes brokken\./);
    const cola = await client.tool("kitchen_item_alias", { item: "Sodastream cola", name: "Cola" });
    assert.match(cola.text, /"Cola" now means Sodastream cola \(it meant Frisdrank before\)\./);
    const listed = await client.tool("kitchen_item_alias", { item: "minoesbrokken" });
    assert.match(listed.text, /Minoes brokken is also called: Pluizenbolbrokkenman\./);
    const taken = await client.tool("kitchen_item_alias", { item: "Frisdrank", name: "Minoes brokken" });
    assert.equal(taken.error, true, "a live item's name is never another's");

    const added = await client.tool("kitchen_list_add", { items: [{ title: "pluizenbolbrokkenman" }, { title: "minoesbrokken" }, { title: "cola" }, { title: "mines brokkken" }] });
    assert.match(added.text, /- "pluizenbolbrokkenman" → Minoes brokken \(linked by another name of "Minoes brokken", added to the line already open\)/);
    assert.match(added.text, /- "minoesbrokken" → Minoes brokken \(linked, added to the line already open\)/);
    assert.match(added.text, /- "cola" → Sodastream cola \(linked by another name of "Sodastream cola", added to the line already open\)/);
    assert.match(added.text, /- "mines brokkken" → mines brokkken \(NEW item\); did you mean "Minoes brokken"\?/);
  } finally {
    client.close();
    live.close();
  }
});

test("recipe stars: kitchen_recipes_search shows them and ranks low-rated last, kitchen_recipe_get shows the average", async () => {
  const live = await liveWorker();
  const client = mcp(live.origin, live.token);
  try {
    await client.call("initialize", { protocolVersion: "2025-06-18" });
    const ids = {};
    for (const title of ["Andijvie stamppot", "Bami", "Chili"]) {
      const saved = await client.tool("kitchen_recipe_save", { title, servings: 2, ingredients: ["1 ui"], steps: ["Kook."] });
      ids[title] = saved.text.match(/\[id: ([\w-]+)\]/)[1];
    }
    const rate = (recipe_id, stars, n) => fetch(`${live.origin}/api/ops`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${live.token}` },
      body: JSON.stringify({ ops: [{ op_id: `op-mcp-rstars-${n}0000`, type: "recipe.rate", id: `rrate-mcp-${n}00000`, recipe_id, stars }] }),
    });
    await rate(ids["Andijvie stamppot"], 2, 1);
    await rate(ids.Chili, 10, 2);
    const found = await client.tool("kitchen_recipes_search", {});
    const order = [...found.text.matchAll(/^- (.+?) \(/gm)].map((m) => m[1]);
    assert.deepEqual(order, ["Chili", "Bami", "Andijvie stamppot"], "ten stars first, unrated in between, two stars last");
    assert.match(found.text, /Chili \(2 p\) — 1 ingredients, 1 steps, stars 10\/10 from 1 \(Thomas 10\)/);
    const got = await client.tool("kitchen_recipe_get", { id: ids["Andijvie stamppot"] });
    assert.match(got.text, /Stars: 2\/10 from 1 \(Thomas 2\)/);
    assert.match((await client.tool("kitchen_recipe_get", { id: ids.Bami })).text, /Stars: none yet/);
  } finally {
    client.close();
    live.close();
  }
});

test("shelf prices: kitchen_prices shows his product's prices per store, the cheapest marked, only one store when asked", async () => {
  const live = await liveWorker();
  const client = mcp(live.origin, live.token);
  try {
    await client.call("initialize", { protocolVersion: "2025-06-18" });
    const post = (ops) => fetch(`${live.origin}/api/ops`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${live.token}` }, body: JSON.stringify({ ops }),
    });
    await post([{ op_id: "op-mcp-prices-0001", type: "product.put", id: "ah-product-506602", product: { name: "Crispy's Hamka's original", brand: "Crispy's", size: "125 g", store: "Albert Heijn" } }]);
    // The prices as the importer's prices.sync writes them (the op itself: tests/store-prices.test.mjs).
    const { id: hh } = await live.env.DB.prepare("SELECT id FROM households").first();
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" });
    await live.env.DB.exec(`UPDATE households SET rev = rev + 1;
      INSERT INTO store_prices (id, household_id, product_id, store, name, size, price_cents, price_on, created_at, updated_at, rev) VALUES
        ('sp-dirk-ah-product-506602', '${hh}', 'ah-product-506602', 'Dirk', 'Lay''s Hamka''s', '125 g', 149, '${today}', 'x', 'x', (SELECT rev FROM households)),
        ('sp-jumbo-ah-product-506602', '${hh}', 'ah-product-506602', 'Jumbo', 'Lay''s Hamka''s Chips 125 gr', '125 Gram', 199, '${today}', 'x', 'x', (SELECT rev FROM households));`);
    const list = await client.call("tools/list", {});
    assert.ok(list.result.tools.some((t) => t.name === "kitchen_prices"));
    const all = await client.tool("kitchen_prices", { query: "hamka" });
    assert.match(all.text, /Crispy's Hamka's original, 125 g \(\?\): Dirk €1,49 \(cheapest\) · Jumbo €1,99/);
    const one = await client.tool("kitchen_prices", { query: "hamka", store: "Jumbo" });
    assert.match(one.text, /: Jumbo €1,99$/);
    assert.match((await client.tool("kitchen_prices", { query: "spruitjes" })).text, /No shelf prices for "spruitjes"/);
    const counted = await client.tool("kitchen_prices", { count: true });
    assert.match(counted.text, /^1 of 1 products have a shelf price \(1 at a store other than Albert Heijn\)\.\nPer store: Dirk 1, Jumbo 1\.$/);
    assert.doesNotMatch(all.text, /Crispy's Crispy's/, "the brand once");
  } finally {
    client.close();
    live.close();
  }
});
