// Shelf prices of other stores from Checkjebon (public/shared/store-prices.js,
// the op prices.sync, fetcher/prices.mjs) and the live offers on list lines
// (public/shared/deals.js liveLineOffers; no offer text in notes any more).
// tests/fixtures/checkjebon.json holds real rows of the file of 29-10-2026.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { importerMayApply, guestMayApply } from "../worker/auth.js";
import { GUEST_SYNCED } from "../worker/ops-store.js";
import { brandedName } from "../public/shared/offers.js";
import { applyOp, emptyState, OpError } from "../public/shared/ops.js";
import {
  parseCheckjebon, matchStorePrices, pricesOf, oldPricesDay, packSize, samePack, isDealNote, storePriceId, PRICE_STORES,
  MIN_STORE_ROWS, MAX_PRICE_WRITES,
} from "../public/shared/store-prices.js";
import { liveLineOffers, dealNote, dealsFor } from "../public/shared/deals.js";
import { currentOffers } from "../public/shared/offers.js";
import { priceOps, runPrices, commitDay, runStamp } from "../fetcher/prices.mjs";
import { stripOps } from "../tools/strip_offer_notes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/checkjebon.json"), "utf8"));
const DAY = "2026-10-29";
const TODAY = "2026-10-30";

// His products as the AH import writes them (the name with its brand in front).
const ITEMS = {
  "item-chips-000001": { id: "item-chips-000001", name: "Chips" },
  "item-pizza-000001": { id: "item-pizza-000001", name: "Pizza" },
  "item-kaas-0000001": { id: "item-kaas-0000001", name: "Kaas" },
  "item-melk-0000001": { id: "item-melk-0000001", name: "Melk" },
  "item-sprt-0000001": { id: "item-sprt-0000001", name: "Spruitjes" },
};
const product = (id, brand, name, size, item, extra = {}) => ({ id, brand, name, size, item_id: item, store: "Albert Heijn", ...extra });
const HAMKAS = product("ah-product-506602", "Crispy's", "Crispy's Hamka's original", "125 g", "item-chips-000001");
const PIZZA = product("ah-product-62760", "Dr. Oetker", "Dr. Oetker Big Americans pizza Hawaii", "460 g", "item-pizza-000001");
const GOUDSE = product("ah-product-2600", "AH", "AH Goudse belegen plakken", "190 g", "item-kaas-0000001");
const MELK = product("ah-product-450535", "AH", "AH Houdbare volle melk", "1 l", "item-melk-0000001");
const PRODUCTS = [HAMKAS, PIZZA, GOUDSE, MELK];
const ROWS = parseCheckjebon(FIXTURE);
const match = (slug, products = PRODUCTS) => matchStorePrices(products, ITEMS, ROWS[slug], PRICE_STORES[slug]);

// ------------------------------------------------------------- parsing

test("parsing: only the stores near home, prices in cents, AH's own number, never an excluded thing", () => {
  assert.deepEqual(Object.keys(ROWS).sort(), ["ah", "aldi", "dirk", "hoogvliet", "jumbo", "plus", "spar"], "no Lidl (a third party), no DekaMarkt or Poiesz");
  assert.deepEqual(ROWS.aldi, [], "ALDI's list was empty: no rows, nothing made up");
  assert.ok(ROWS.ah.some(([n, s, c, ref]) => n === "Crispy's Hamka's original" && s === "125 g" && c === 209 && ref === "506602"));
  assert.ok(!ROWS.ah.some(([n]) => /spruitjes extra fijn/i.test(n)), "the excluded row is dropped");
  assert.ok(!ROWS.dirk.some(([n]) => /groenhof/i.test(n)), "the excluded brand is dropped, also its light version");
  assert.ok(ROWS.dirk.every(([, , , ref]) => ref === ""), "only AH has a product number");
  assert.deepEqual(parseCheckjebon(null), {});
  assert.deepEqual(parseCheckjebon([{ n: "ah", d: [{ n: "X", p: "2,19" }, { n: "", p: 1 }, { n: "Y", p: 0 }] }]), { ah: [] }, "unusable rows are left out");
});

test("sizes: Checkjebon's ways of writing a pack are one size", () => {
  for (const s of ["125 g", "125 gram", "125 Gram", "Per 125 g", "125 GRM"]) assert.ok(samePack(packSize(s), packSize("125 g")), s);
  assert.ok(samePack(packSize("1 liter"), packSize("1 l")) && samePack(packSize("Per 1000 ml"), packSize("1 l")));
  assert.ok(samePack(packSize("500 Milliliter"), packSize("0,5 l")));
  assert.ok(samePack(packSize("Per stuk"), packSize("1 stuk")));
  assert.ok(samePack(packSize("", "Dr. Oetker Big Americans Pizza Hawaii 460 g"), packSize("460 g")), "Jumbo's size in the name");
  assert.ok(!samePack(packSize("185 Gram"), packSize("125 g")));
  assert.ok(!samePack(packSize("6 x 200 ml"), packSize("1200 ml")), "a multipack is not one pack");
  assert.ok(!samePack(null, packSize("125 g")) && !samePack(packSize("Per pak"), packSize("Per pak")), "unknown is never the same");
});

// ------------------------------------------------------------- matching

test("matching: his very product, same brand and pack, in every store's wording", () => {
  const cents = (slug, p) => match(slug).get(p.id)?.cents ?? null;
  assert.equal(cents("ah", HAMKAS), 209, "AH by its own number");
  assert.equal(cents("dirk", HAMKAS), 149, "\"Crispy's Hamka's\": 'original' is the default kind");
  assert.equal(cents("jumbo", HAMKAS), 199, "\"Crispy's Hamka's Chips 125 gr\": 'chips' is the item's word");
  assert.equal(cents("plus", HAMKAS), 179, "\"Crispys Crispy's Hamka's 125gr\": Crispy's and Crispys are one brand");
  assert.equal(cents("hoogvliet", HAMKAS), 179, "the 125 g bag, not the 170 g partypack");
  assert.equal(cents("spar", HAMKAS), null, "SPAR only has the 185 g bag");
  assert.equal(cents("hoogvliet", PIZZA), 499, "'pizza' is the item's word, so Hoogvliet may leave it out");
  assert.equal(cents("jumbo", PIZZA), 499, "the size from the name when the size field is empty");
});

test("matching negatives: another pack, a store brand elsewhere, no brand, an extra kind, a tie, excluded", () => {
  // The 185 g bag at Jumbo is not his 125 g bag.
  assert.equal(match("jumbo").get(HAMKAS.id)?.name, "Crispy's Hamka's Chips 125 gr");
  // AH's own cheese never matches PLUS's own cheese of the same name and size.
  assert.equal(match("plus").has(GOUDSE.id), false);
  assert.equal(match("ah").get(GOUDSE.id)?.cents, 295);
  // AH's milk is not Jumbo's milk; a product without a brand never gets a price elsewhere.
  assert.equal(match("jumbo").has(MELK.id), false);
  const plain = product("lidl-product-1", "", "Crispy's Hamka's", "125 g", "item-chips-000001");
  assert.equal(match("dirk", [plain]).size, 0);
  // Without a size there is no price.
  assert.equal(match("dirk", [{ ...HAMKAS, id: "photo-product-1", size: "" }]).size, 0);
  // A product AH sells is found at AH by number only, never by a similar name.
  assert.equal(match("ah", [{ ...HAMKAS, id: "ah-product-999999" }]).size, 0);
  // An extra word of the store's own is another kind: Dirk's "Kruidenthee ... bio" is not his tea.
  const tea = product("ah-product-495595", "Clipper", "Clipper Chamomile peach organic infusion", "30 g", "item-chips-000001");
  assert.equal(match("dirk", [{ ...tea, id: "tea-product-0001" }]).size, 0);
  // A number in his name is a kind: his senior "Whiskas 7+" is not SPAR's plain one (real SPAR row, 29-10-2026).
  const whiskas = product("ah-product-549385", "Whiskas", "Whiskas 7+ Vis selectie in gelei", "1,02 kg", "item-chips-000001");
  assert.equal(matchStorePrices([whiskas], ITEMS, [["Whiskas vis selectie en gelei", "1.02 Kilogram", 719, ""]], "SPAR").size, 0);
  assert.equal(matchStorePrices([whiskas], ITEMS, [["Whiskas 7+ vis selectie in gelei", "1.02 Kilogram", 719, ""]], "SPAR").size, 1);
  // Two rows that fit equally with different prices: unsure, so nothing.
  const tie = [["Crispy's Hamka's", "125 g", 149, ""], ["Crispy's Hamka's", "125 g", 179, ""]];
  assert.equal(matchStorePrices([HAMKAS], ITEMS, tie, "Dirk").size, 0);
  // A store_only product only in its own store.
  const only = { ...HAMKAS, id: "only-product-001", store: "Dirk", store_only: 1 };
  assert.equal(matchStorePrices([only], ITEMS, ROWS.jumbo, "Jumbo").size, 0);
  assert.equal(matchStorePrices([only], ITEMS, ROWS.dirk, "Dirk").size, 1);
  // Excluded: his sprouts never gets a price, whatever a row says.
  const sprouts = product("sprt-product-001", "Groenhof", "Groenhof Spruitjes", "6 x 250 ml", "item-sprt-0000001");
  assert.equal(matchStorePrices([sprouts], ITEMS, [["Groenhof Spruitjes", "6 x 250 ml", 629, ""]], "Dirk").size, 0);
});

// ------------------------------------------------------------- showing

const priceRow = (store, p, cents, on = DAY) => ({ id: storePriceId(store, p.id), product_id: p.id, store, name: p.name, size: p.size, price_cents: cents, price_on: on });

test("showing: cheapest marked, only the chosen store with \"Ik ben bij\", old prices say their day, never an excluded thing", () => {
  const rows = Object.fromEntries([priceRow("Albert Heijn", HAMKAS, 209), priceRow("Dirk", HAMKAS, 149), priceRow("Jumbo", HAMKAS, 199)].map((r) => [r.id, r]));
  const all = pricesOf(rows, HAMKAS, TODAY);
  assert.deepEqual(all.map((x) => [x.store, x.cents, x.cheapest]), [["Dirk", 149, true], ["Jumbo", 199, false], ["Albert Heijn", 209, false]]);
  assert.equal(oldPricesDay(all, TODAY), null, "a day old: no date");
  const same = Object.fromEntries([priceRow("Jumbo", PIZZA, 499), priceRow("PLUS", PIZZA, 499)].map((r) => [r.id, r]));
  assert.deepEqual(pricesOf(same, PIZZA, TODAY).map((x) => x.cheapest), [false, false], "the same everywhere: none is the cheapest");
  assert.deepEqual(pricesOf(rows, HAMKAS, TODAY, { store: "AH" }).map((x) => [x.store, x.cents, x.cheapest]), [["Albert Heijn", 209, false]], "Ik ben bij AH: only AH");
  assert.deepEqual(pricesOf(rows, HAMKAS, TODAY, { store: "Lidl" }), []);
  const old = { a: priceRow("Dirk", HAMKAS, 149, "2026-10-26") };
  assert.equal(oldPricesDay(pricesOf(old, HAMKAS, TODAY), TODAY), "2026-10-26");
  assert.deepEqual(pricesOf({ a: priceRow("Dirk", HAMKAS, 149, "2026-10-10") }, HAMKAS, TODAY), [], "older than two weeks: not shown");
  assert.deepEqual(pricesOf({ a: { ...priceRow("Dirk", HAMKAS, 149), deleted_at: "x" } }, HAMKAS, TODAY), []);
  const sprouts = product("sprt-product-001", "Groenhof", "Groenhof Spruitjes", "6 x 250 ml", "item-sprt-0000001");
  assert.deepEqual(pricesOf({ a: priceRow("Dirk", sprouts, 629) }, sprouts, TODAY), [], "excluded never, even from a stored row");
});

// ------------------------------------------------------------- the op

function priceState() {
  const s = emptyState();
  for (const p of PRODUCTS) s.products[p.id] = { ...p };
  Object.assign(s.items, ITEMS);
  return s;
}
const ctx = { memberId: "m1", isAdmin: true, now: "2026-10-30T05:20:00.000Z" };

test("op prices.sync: keeps only his products, writes only what changed, tombstones what is gone, ignores older data", () => {
  const s = priceState();
  const op = (day, rows) => ({ type: "prices.sync", store: "dirk", day, rows });
  const first = applyOp(s, op(DAY, ROWS.dirk), ctx);
  assert.deepEqual(first.result, { matched: 1, comparable: 0, written: 1, left: 0 });
  const id = storePriceId("Dirk", HAMKAS.id);
  assert.equal(Object.keys(s.store_prices).length, 1, "one row, not the store's whole list");
  assert.deepEqual([s.store_prices[id].store, s.store_prices[id].price_cents, s.store_prices[id].price_on], ["Dirk", 149, DAY]);
  assert.equal(applyOp(s, op(DAY, ROWS.dirk), ctx).changed.length, 0, "the same day again writes nothing");
  assert.equal(applyOp(s, op("2026-10-30", ROWS.dirk), ctx).changed.length, 1, "a new day refreshes the day");
  assert.deepEqual(applyOp(s, op(DAY, ROWS.dirk), ctx).result, { stale: true }, "older data changes nothing");
  const cheaper = ROWS.dirk.map((r) => (r[0] === "Crispy's Hamka's" ? [r[0], r[1], 129, r[3]] : r));
  applyOp(s, op("2026-10-31", cheaper), ctx);
  assert.equal(s.store_prices[id].price_cents, 129);
  const gone = applyOp(s, op("2026-11-01", ROWS.dirk.filter((r) => r[0] !== "Crispy's Hamka's")), ctx);
  assert.ok(s.store_prices[id].deleted_at, "no match any more: a tombstone");
  assert.equal(gone.result.matched, 0);
  for (const bad of [{ store: "Lidl" }, { store: "Vomar" }, { day: "gisteren" }, { rows: [["x", "", -1, ""]] }, { rows: "nope" }]) {
    assert.throws(() => applyOp(priceState(), { ...op(DAY, ROWS.dirk), ...bad }, ctx), OpError, JSON.stringify(bad));
  }
});

test("op prices.sync: at most MAX_PRICE_WRITES rows, new prices before refreshed days", () => {
  const s = emptyState();
  const n = MAX_PRICE_WRITES + 5;
  const rows = [];
  // A word of letters only per product, three letters of i in base 26 and then "ding".
  const word = (i) => `${[...i.toString(26).padStart(3, "0")].map((c) => String.fromCharCode(97 + parseInt(c, 26))).join("")}ding`;
  for (let i = 0; i < n; i++) {
    s.products[`p-${i}`] = { id: `p-${i}`, brand: "Merk", name: `Merk ${word(i)}`, size: "100 g", store: "Dirk" };
    rows.push([`Merk ${word(i)}`, "100 g", 100 + i, ""]);
  }
  const first = applyOp(s, { type: "prices.sync", store: "Dirk", day: DAY, rows }, ctx);
  assert.deepEqual(first.result, { matched: n, comparable: 0, written: MAX_PRICE_WRITES, left: 5 });
  const next = applyOp(s, { type: "prices.sync", store: "Dirk", day: "2026-10-30", rows }, ctx);
  assert.equal(next.result.written, MAX_PRICE_WRITES);
  const newOnes = Array.from({ length: n }, (_, i) => s.store_prices[storePriceId("Dirk", `p-${i}`)]).filter(Boolean);
  assert.equal(newOnes.length, n, "the five left over came first the next day");
});

// ------------------------------------------------------------- the route

const HOST = "groceries.localhost:8787";
const ORIGIN = `http://${HOST}`;
function call(env, method, p, { body, cookie, bearer } = {}) {
  const headers = { Origin: ORIGIN };
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`${ORIGIN}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
let n = 0;
const opId = () => `op-prices-${String(++n).padStart(6, "0")}`;

test("route: only the importer sends prices.sync; the rows reach the phones; nothing else of the importer changes", async () => {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const thomas = tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456", label: "phone" } }));
  const code = await (await call(env, "POST", "/api/codes", { cookie: thomas, body: { for: "importer" } })).json();
  const importer = tokenOf(await call(env, "POST", "/api/pair", { body: { code: code.code, label: "Thuisserver AH" } }));
  const put = (p) => ({ op_id: opId(), type: "product.put", id: p.id, product: { name: p.name, brand: p.brand, size: p.size, store: "Albert Heijn" } });
  assert.equal((await call(env, "POST", "/api/ops", { cookie: thomas, body: { ops: [put(HAMKAS), put(PIZZA)] } })).status, 200);

  assert.equal(importerMayApply({ type: "prices.sync" }), true);
  const sync = (slug) => ({ op_id: `prices-${slug}-${DAY}`, type: "prices.sync", store: PRICE_STORES[slug], day: DAY, rows: ROWS[slug] });
  // A person's phone never writes prices, not even an admin's.
  assert.equal((await call(env, "POST", "/api/ops", { cookie: thomas, body: { ops: [sync("dirk")] } })).status, 403);
  // The importer still may not send anything else with it.
  assert.equal((await call(env, "POST", "/api/ops", { bearer: importer, body: { ops: [sync("dirk"), { op_id: opId(), type: "entry.add", id: "entry-prices-1", item_id: "item-prices-1", title: "Melk" }] } })).status, 403);
  for (const slug of ["dirk", "jumbo", "hoogvliet"]) {
    const res = await call(env, "POST", "/api/ops", { bearer: importer, body: { ops: [sync(slug)] } });
    assert.equal(res.status, 200);
    const { results } = await res.json();
    assert.ok(results[0].ok, JSON.stringify(results[0]));
  }
  const all = await (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();
  const got = all.store_prices.map((r) => [r.store, r.product_id, r.price_cents]).sort();
  // Without an item, "chips" and "pizza" are no item words: Jumbo's "... Chips 125 gr" and
  // Hoogvliet's pizza without "pizza" are then not sure enough.
  assert.deepEqual(got, [["Dirk", HAMKAS.id, 149], ["Hoogvliet", HAMKAS.id, 179], ["Jumbo", PIZZA.id, 499]]);
  // A replay of one day is the first result; nothing is written twice.
  const before = (await (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json()).rev;
  await call(env, "POST", "/api/ops", { bearer: importer, body: { ops: [sync("dirk")] } });
  assert.equal((await (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json()).rev, before);
});

// ------------------------------------------------------------- the fetcher

test("fetcher: one op per store with enough rows; small or empty stores keep their old prices", () => {
  const big = { dirk: Array.from({ length: MIN_STORE_ROWS }, (_, i) => [`x${i}`, "", 100, ""]), aldi: [], jumbo: [["a", "", 1, ""]] };
  const { ops, skipped } = priceOps(big, DAY);
  assert.deepEqual(ops.map((o) => [o.op_id, o.type, o.store, o.day]), [[`prices-dirk-${DAY}`, "prices.sync", "Dirk", DAY]]);
  assert.equal(skipped.aldi, 0);
  assert.equal(skipped.jumbo, 1);
  assert.equal(commitDay([{ commit: { committer: { date: "2026-10-29T06:06:06Z" } } }]), "2026-10-29");
  assert.equal(commitDay({ message: "rate limited" }), null);
});

test("fetcher: unreachable leaves everything; an unchanged day fetches nothing; a new day sends each store once", async () => {
  const said = [];
  const say = (...a) => said.push(a.join(" "));
  const rows = (slug) => Array.from({ length: MIN_STORE_ROWS }, (_, i) => ({ n: `${slug} ding ${i}`, l: "x", p: 1.5, s: "100 g" }));
  const file = [{ n: "dirk", d: rows("dirk") }, { n: "jumbo", d: rows("jumbo") }, { n: "aldi", d: [] }];
  const commits = [{ commit: { committer: { date: "2026-10-29T06:06:06Z" } } }];
  const posted = [];
  const post = async (url, init) => {
    posted.push(JSON.parse(init.body).ops[0]);
    return new Response(JSON.stringify({ results: [{ ok: true, result: { matched: 0 } }] }), { status: 200 });
  };
  let saved = null;
  let cached = null;
  const base = { post, token: "t".repeat(30), say, saveState: (s) => { saved = s; }, cache: null, saveCache: (c) => { cached = c; } };

  const down = await runPrices("push", { ...base, state: {}, get: async () => { throw new Error("checkjebon: HTTP 503"); } });
  assert.equal(down.unreachable, true);
  assert.equal(posted.length, 0);
  assert.equal(saved, null, "nothing remembered, so the next run tries again");

  let fetchedFile = 0;
  const get = async (url) => (url.includes("api.github.com") ? commits : (fetchedFile++, file));
  await runPrices("push", { ...base, state: { day: "2026-10-29" }, get, cache: { day: "2026-10-29", perStore: parseCheckjebon(file) } });
  assert.equal(fetchedFile, 0, "the day was sent: the 10 MB file is not fetched again");

  posted.length = 0;
  const sent = await runPrices("push", { ...base, state: { day: "2026-10-27" }, get });
  assert.deepEqual(posted.map((o) => o.store), ["Dirk", "Jumbo"]);
  assert.equal(sent.skipped.aldi, 0);
  assert.deepEqual(saved, { day: "2026-10-29" });
  assert.equal(cached.day, "2026-10-29", "the filtered rows are kept for the re-checks");
  assert.deepEqual(posted.map((o) => o.op_id), [`prices-dirk-2026-10-29`, `prices-jumbo-2026-10-29`], "new data keeps the plain op id");
  assert.ok(said.includes("new data"));

  posted.length = 0;
  await runPrices("dry-run", { ...base, state: {}, get });
  assert.equal(posted.length, 0, "a dry run sends nothing");
});

test("fetcher: a day already sent is re-checked from the cache under a fresh op id, same day", async () => {
  const said = [];
  const say = (...a) => said.push(a.join(" "));
  const rows = (slug) => Array.from({ length: MIN_STORE_ROWS }, (_, i) => [`${slug} ding ${i}`, "100 g", 150, ""]);
  const cache = { day: "2026-10-29", perStore: { dirk: rows("dirk"), jumbo: rows("jumbo"), aldi: [] } };
  const commits = [{ commit: { committer: { date: "2026-10-29T06:06:06Z" } } }];
  const posted = [];
  const post = async (url, init) => {
    posted.push(JSON.parse(init.body).ops[0]);
    return new Response(JSON.stringify({ results: [{ ok: true, result: { matched: 0 } }] }), { status: 200 });
  };
  let saved = null;
  let cacheWrites = 0;
  let fileFetches = 0;
  const get = async (url) => (url.includes("api.github.com") ? commits : (fileFetches++, [{ n: "dirk", d: [{ n: "x", p: 1, s: "1 g" }] }]));
  const base = { post, token: "t".repeat(30), say, state: { day: "2026-10-29" }, saveState: (s) => { saved = s; }, saveCache: () => { cacheWrites++; }, get };

  const r1 = await runPrices("push", { ...base, cache, now: new Date("2026-10-30T10:17:00Z") });
  const r2 = await runPrices("push", { ...base, cache, now: new Date("2026-10-30T15:42:00Z") });
  assert.equal(fileFetches, 0, "no 10 MB download for a re-check");
  assert.equal(cacheWrites, 0);
  assert.equal(saved, null, "the remembered day does not move");
  assert.deepEqual([r1.recheck, r1.day, r1.sent], [true, "2026-10-29", 2]);
  assert.ok(r2.recheck);
  assert.ok(posted.every((o) => o.day === "2026-10-29" && o.type === "prices.sync"), "the same day, so the worker keeps price_on");
  const ids = posted.map((o) => o.op_id);
  assert.equal(new Set(ids).size, ids.length, "a later run has new op ids, so it is no replay");
  assert.ok(ids.every((id) => /^[A-Za-z0-9_-]{8,64}$/.test(id) && id !== `prices-dirk-2026-10-29`));
  assert.equal(runStamp(new Date("2026-10-30T10:17:00Z")), "202610301117");
  assert.ok(said.includes("re-check from cache: day 2026-10-29 sent again"));
  assert.ok(!said.includes("new data"));

  // A re-check changes only what the worker finds new: the same rows again are no writes
  // and the day never goes back (older data is stale, equal data only adds new matches).
  const s = priceState();
  const op = (day) => ({ type: "prices.sync", store: "dirk", day, rows: ROWS.dirk });
  applyOp(s, op(DAY), ctx);
  assert.equal(applyOp(s, op(DAY), ctx).changed.length, 0);
  assert.deepEqual(applyOp(s, op("2026-10-01"), ctx).result, { stale: true });
});

test("fetcher: no cache yet fetches and caches the file; no cache and unreachable sends nothing; a dry run keeps no cache", async () => {
  const said = [];
  const say = (...a) => said.push(a.join(" "));
  const file = [{ n: "dirk", d: Array.from({ length: MIN_STORE_ROWS }, (_, i) => ({ n: `dirk ding ${i}`, l: "x", p: 1.5, s: "100 g" })) }];
  const commits = [{ commit: { committer: { date: "2026-10-29T06:06:06Z" } } }];
  const posted = [];
  const post = async (url, init) => {
    posted.push(JSON.parse(init.body).ops[0]);
    return new Response(JSON.stringify({ results: [{ ok: true, result: {} }] }), { status: 200 });
  };
  let cached = null;
  let saved = null;
  const base = { post, token: "t".repeat(30), say, state: { day: "2026-10-29" }, cache: null, saveCache: (c) => { cached = c; }, saveState: (s) => { saved = s; }, now: new Date("2026-10-30T10:17:00Z") };

  const down = await runPrices("push", { ...base, get: async () => { throw new Error("HTTP 503"); } });
  assert.equal(down.unreachable, true);
  assert.deepEqual([posted.length, cached, saved], [0, null, null], "no cache and no source: nothing sent, nothing kept");

  const get = async (url) => (url.includes("api.github.com") ? commits : file);
  const rebuilt = await runPrices("push", { ...base, get });
  assert.equal(rebuilt.recheck, true);
  assert.equal(cached.day, "2026-10-29");
  assert.equal(cached.perStore.dirk.length, MIN_STORE_ROWS);
  assert.match(posted[0].op_id, /^prices-dirk-2026-10-29-r\d{12}$/, "the day was sent before: a re-check id");
  assert.equal(saved, null);

  cached = null;
  await runPrices("dry-run", { ...base, get });
  assert.equal(cached, null, "a dry run keeps nothing");
});

test("run.sh and deploy: the prices run last, default dry-run, and its files go to the server", () => {
  const run = fs.readFileSync(path.join(ROOT, "fetcher/run.sh"), "utf8");
  assert.match(run, /case "\$PRICES_MODE" in push\|dry-run\) ;; \*\) PRICES_MODE=dry-run ;; esac/);
  assert.ok(run.indexOf("fetcher/prices.mjs") > run.indexOf("fetcher/lidl_import.mjs"));
  const deploy = fs.readFileSync(path.join(ROOT, "fetcher/deploy.mjs"), "utf8");
  for (const f of ["fetcher/prices.mjs", "public/shared/store-prices.js", "public/shared/deal-math.js"]) assert.ok(deploy.includes(`["${f}", "${f}"]`), f);
});

// ------------------------------------------------------- live offers on lines

const offer = (o) => ({ id: `of-${o.store}-${o.name}`, brand: null, size: null, deal: "-30%", price_cents: 199, valid_from: "2026-10-27", category: null, source: null, ...o });

test("live offers: an ended offer is gone, a new one appears, \"Ik ben bij\" shows only that store's", () => {
  const entry = { id: "e1", item_id: "item-chips-000001", title: "Chips" };
  const ended = offer({ store: "Dirk", name: "Crispy's Hamka's", valid_until: "2026-10-29" });
  const now = offer({ store: "Albert Heijn", name: "Crispy's Hamka's original", valid_until: "2026-11-02" });
  const offers = { a: ended, b: now };
  let current = currentOffers(offers, TODAY);
  let { mine, named } = liveLineOffers(entry, HAMKAS, current, [], null);
  assert.deepEqual(mine.map((o) => o.store), ["Albert Heijn"], "the Dirk offer ended yesterday: gone");
  assert.deepEqual(named, []);
  // A new folder offer shows by itself, without anyone editing the line.
  offers.c = offer({ store: "Jumbo", name: "Crispy's Hamka's Chips", valid_until: "2026-11-05" });
  current = currentOffers(offers, TODAY);
  ({ mine, named } = liveLineOffers(entry, HAMKAS, current, [], null));
  assert.deepEqual([...mine, ...named].map((o) => o.store).sort(), ["Albert Heijn", "Jumbo"]);
  // At Jumbo only Jumbo's.
  ({ mine, named } = liveLineOffers(entry, HAMKAS, current, [], "Jumbo"));
  assert.deepEqual([...mine, ...named].map((o) => o.store), ["Jumbo"]);
  // What the Deals tab found for the item (a rule's match words) shows too, also only at the chosen store.
  const felix = offer({ store: "Dirk", name: "Felix pouches", valid_until: "2026-11-02" });
  const hit = { item: { id: "item-minoes-00001", name: "Minoes eten" }, offer: felix, product: null, check: null };
  const cat = { id: "e2", item_id: "item-minoes-00001", title: "Minoes eten" };
  assert.deepEqual(liveLineOffers(cat, null, [felix], [hit], null).named, [felix]);
  assert.deepEqual(liveLineOffers(cat, null, [felix], [hit], "Albert Heijn").named, []);
  assert.deepEqual(liveLineOffers({ ...cat, item_id: "other-item-0001", title: "Melk" }, null, [felix], [hit], null).named, [], "another item's hit stays there");
});

test("live offers: the Deals tab's \"op de lijst\" writes no offer into the note; old Deals notes are recognised, a person's own never", () => {
  const src = fs.readFileSync(path.join(ROOT, "public/app/deals.js"), "utf8");
  const add = src.match(/type: "entry\.add"[^}]*}/g) ?? [];
  assert.ok(add.length >= 1);
  assert.ok(add.every((s) => !/note/.test(s)), add.join("\n"));
  assert.ok(!/dealNote/.test(src), "the Deals tab no longer builds a note");
  // What dealNote wrote, and what a person writes.
  for (const o of [{ store: "Dirk", deal: "-37%", valid_until: "2026-11-03" }, { store: "Poiesz", deal: null, valid_until: "2026-10-31" },
    { store: "Lidl", deal: "20% korting", valid_until: "2026-11-05", source: "lidl_plus" }, { store: "Albert Heijn", deal: "1+1 gratis", valid_until: "2026-10-04" }]) {
    assert.equal(isDealNote(dealNote(o)), true, dealNote(o));
  }
  for (const note of ["", "de grote zak", "Dirk is goedkoper", "voor Henk t/m 3 nov", "AH Halfvolle melk", null]) assert.equal(isDealNote(note), false, String(note));
  const entries = [
    { id: "e1", title: "Sojasaus", note: "Dirk · -37% t/m 3 nov" },
    { id: "e2", title: "Kaas", note: "de oude" },
    { id: "e3", title: "Chips", note: "Albert Heijn · 1+1 gratis t/m 4 okt", deleted_at: "x" },
  ];
  const ops = stripOps(entries);
  assert.deepEqual(ops.map((o) => [o.type, o.id, o.note]), [["entry.update", "e1", ""]]);
  assert.equal(stripOps(entries)[0].op_id, ops[0].op_id, "stable: a second --write is a replay");
});

test("excluded: no Deals hit or price for sprouts reaches a line", () => {
  const view = { ...emptyState(), offers: { a: offer({ store: "Albert Heijn", name: "Groenhof Spruitjes", valid_until: "2026-11-02" }) } };
  assert.deepEqual(currentOffers(view.offers, TODAY), []);
  assert.deepEqual(dealsFor(view, TODAY), []);
});

test("guests and labels: a recipes-only person never gets or sends prices; a product's brand is shown once", () => {
  assert.equal(GUEST_SYNCED.includes("store_prices"), false);
  assert.equal(guestMayApply({ type: "prices.sync" }), false);
  assert.equal(brandedName(HAMKAS), "Crispy's Hamka's original");
  assert.equal(brandedName({ brand: "AH", name: "Halfvolle melk" }), "AH Halfvolle melk");
  assert.equal(brandedName({ brand: "", name: "Fanta lemon zero" }), "Fanta lemon zero");
  assert.equal(brandedName({ brand: "Crispy's", name: "Crispy's" }), "Crispy's");
});
