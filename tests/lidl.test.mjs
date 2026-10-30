// Lidl Plus: the receipt parser on a made-up Dutch receipt (the HTML shape of
// the tickets API v3, as in iLidl's GB fixture), the mapping (the Kania
// macaroni mix, the snack guard), excluded, Noor's towns, the server run
// through the real worker (dry run, push once, the importer's rights), the
// coupons as offers of their own source (never wiping the folder offers),
// the client's token handling, the login's file handling, and run.sh.
// No network, no personal data.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { importerMayApply } from "../worker/auth.js";
import { amsterdamDay } from "../worker/offers.js";
import { readSent, vocabulary, OTHER_PEOPLE_CITIES, OWNERS } from "../tools/import_ah.mjs";
// Noor's towns and the owners.json names are household data (tools/ah_items.mjs).
const [TOWN_A, TOWN_B] = OTHER_PEOPLE_CITIES;
const Cap = (s) => s[0].toUpperCase() + s.slice(1);
import {
  parseReceiptHtml, parseItemsLine, normaliseReceipt, splitName, isOwn, buildLidlOps, toCents, mapLine,
} from "../tools/import_lidl.mjs";
import { KANIA_MACARONI } from "../tools/lidl_items.mjs";
import { runReceipts, runCoupons, couponOffers, initState, TITLES_FILE } from "../fetcher/lidl_import.mjs";
import { createLidlClient } from "../fetcher/lidl_client.mjs";
import { authUrl, extractCode, finishLogin, pkce } from "../fetcher/lidl-login.mjs";
import { currentOffers, lineOffers, isCoupon } from "../public/shared/offers.js";
import { dealNote } from "../public/shared/deals.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "groceries.localhost:8787";
const ORIGIN = `http://${HOST}`;
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `kitchen-test-${name}-`));
const day = (offset) => amsterdamDay(new Date(Date.now() + offset * 86400_000));
const TODAY = day(0);

function call(env, method, p, { body, cookie, bearer } = {}) {
  const headers = { Origin: ORIGIN };
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`${ORIGIN}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);

/** A household with a few lines and the Kania product, Thomas's phone, the importer and the fetcher. */
async function setup() {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const thomas = tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456", label: "phone" } }));
  const ops = [
    ...["Kipfilet", "Paprika", "Macaroni", "Halfvolle melk"].map((title, i) => ({ op_id: `op-lidlsetup-${i}000`, type: "entry.add", id: `entry-lidl-${i}000`, item_id: `item-lidl-${i}000`, title })),
    { op_id: "op-lidlsetup-kania", type: "product.put", id: KANIA_MACARONI.id, product: { name: KANIA_MACARONI.name, brand: "Kania", store: "Lidl", store_only: true } },
    { op_id: "op-lidlsetup-kitem", type: "entry.add", id: "entry-lidl-kania", item_id: "item-lidl-kania", title: "macaroni kruidenmix" },
  ];
  const res = await call(env, "POST", "/api/ops", { cookie: thomas, body: { ops } });
  assert.deepEqual((await res.json()).results.filter((r) => !r.ok), []);
  const pair = async (role, label) => {
    const code = await (await call(env, "POST", "/api/codes", { cookie: thomas, body: { for: role } })).json();
    return tokenOf(await call(env, "POST", "/api/pair", { body: { code: code.code, label } }));
  };
  return { env, thomas, importer: await pair("importer", "Thuisserver AH"), fetcher: await pair("fetcher", "Thuisserver") };
}
const sync = async (env, thomas) => (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();

// ------------------------------------------------------------- the receipt

const art = (id, desc, unit, text, qty) => `<span id="l" class="article" data-art-id="${id}"${qty ? ` data-art-quantity="${qty}"` : ""} data-unit-price="${unit}" data-tax-type="A" data-art-description="${desc}">${text}</span>\r\n`;
const bold = (label, amount) => `<span class="css_bold">${label}</span><span>   </span><span class="css_bold">${amount}</span>\r\n`;

/** A made-up Lidl NL receipt in the v3 shape: store with its town, the printed receipt as HTML. */
function receipt(id, date, locality, body) {
  return {
    id, date, totalAmount: "12,34", store: { id: "NL0001", name: "Lidl", address: "Straat 1", postalCode: "3000 AA", locality },
    htmlPrintedReceipt: `<html><body><pre><span class="purchase_list">${body}</span>${bold("Te betalen", "12,34")}</pre></body></html>`,
  };
}
const R1_BODY = [
  art("0100001", "Kipfilet", "4,99", "Kipfilet                4,99 A"),
  bold("Lidl Plus korting", "-1,00"),
  art("0100002", "Kania Macaroni Spaghetti", "0,79", "Kania Macaroni Spaghetti 0,79 A"),
  art("0100003", "Combino Macaroni 500g", "0,99", "Combino Macaroni 500g   0,99 A"),
  art("0100004", "Snack Day Paprika chips", "1,19", "Snack Day Paprika chips 1,19 A"),
  art("0100005", "Groenhof Spruiten 6x0,33", "4,49", "Groenhof Spruiten       4,49 A"),
  art("0100006", "Wortelen los", "1,49", "Wortelen los            0,52 A", "0,350"),
  art("0100006", "Wortelen los", "1,49", "  0,350 kg x 1,49 EUR/kg", "0,350"),
  art("0100007", "Milbona Halfvolle melk 1L", "1,09", "Milbona Halfvolle melk  2,18 A", "2"),
  art("0100007", "Milbona Halfvolle melk 1L", "1,09", "  2 x 1,09", "2"),
  art("0100008", "Statiegeld", "0,15", "Statiegeld              0,15 A"),
  art("0100001", "Kipfilet", "4,99", "Kipfilet                4,99 A"),
].join("");

test("receipt: articles, a weighed and a counted line, a discount on the line above, totals left alone", () => {
  const lines = parseReceiptHtml(receipt("x", "2026-10-26T18:00:00", "Groningen", R1_BODY).htmlPrintedReceipt);
  assert.deepEqual(lines.map((l) => l.name), ["Kipfilet", "Kania Macaroni Spaghetti", "Combino Macaroni 500g", "Snack Day Paprika chips",
    "Groenhof Spruiten 6x0,33", "Wortelen los", "Milbona Halfvolle melk 1L", "Statiegeld", "Kipfilet"], "the second line of a weighed or counted article is skipped; a second scan is a line");
  assert.equal(lines[0].discount_cents, -100);
  assert.equal(lines[8].discount_cents, 0, "the total's bold amount is no discount");
  assert.deepEqual([lines[5].qty, lines[5].weighed, lines[5].price_cents], [1, true, 52], "0,350 kg is one pack of 52 cents");
  assert.deepEqual([lines[6].qty, lines[6].price_cents], [2, 218]);
  assert.deepEqual([toCents("1.234,56"), toCents("-0,50"), toCents("3.39"), toCents("x")], [123456, -50, 339, null]);
  assert.deepEqual(splitName("Milbona Halfvolle melk 1L"), { brand: "Milbona", bare: "Halfvolle melk", size: "1 l" });
  // The older JSON answer reads the same.
  const old = parseItemsLine([{ name: "Kipfilet", quantity: "1", currentUnitPrice: "4,99", originalAmount: "4,99", isWeight: false, discounts: [{ description: "Korting", amount: "1,00" }], codeInput: "0100001" }]);
  assert.deepEqual([old[0].name, old[0].price_cents, old[0].discount_cents], ["Kipfilet", 499, -100]);
});

test("normalise: excluded out, deposit kept on the receipt only, the Kania mix pinned to his product, the town kept", () => {
  const r = normaliseReceipt(receipt("L1", "2026-10-26T18:00:00", "Groningen", R1_BODY));
  assert.equal(r.city, "Groningen");
  assert.equal(r.day, "2026-10-26");
  assert.equal(r.dropped.excluded, 1);
  assert.ok(!JSON.stringify(r).includes("Groenhof"), "the sprouts is gone entirely");
  assert.equal(r.lines.find((l) => l.name === "Statiegeld").kind, "deposit");
  const kania = r.lines.find((l) => /Kania/.test(l.receiptName));
  assert.equal(kania.pin.id, "product-kania-macaroni-lidl");
  assert.equal(r.lines.find((l) => /Combino/.test(l.receiptName)).pin, undefined, "the pasta itself is not the mix");
  assert.equal(r.lines[0].price_cents, 399, "the discount lowers its line");
});

test("mapping: the mix is 'macaroni kruidenmix', the pasta is Macaroni, chips never Paprika", () => {
  const vocab = vocabulary(["Kipfilet", "Paprika", "Macaroni", "macaroni kruidenmix", "Halfvolle melk", "Wortelen"]);
  const r = normaliseReceipt(receipt("L1", "2026-10-26T18:00:00", "Groningen", R1_BODY));
  const item = (re) => mapLine(r.lines.find((l) => re.test(l.receiptName)), vocab).item;
  assert.equal(item(/Kania/).toLowerCase(), "macaroni kruidenmix");
  assert.equal(item(/Combino/), "Macaroni");
  assert.notEqual(item(/chips/), "Paprika", "the snack guard: chips are no ingredient's product");
  assert.equal(item(/melk/), "Halfvolle melk");
});

test("whose receipt: the other towns are Noor's, owners.json overrides, no town is Thomas's", () => {
  assert.equal(isOwn({ id: "a", city: TOWN_A.toUpperCase() }), false);
  assert.equal(isOwn({ id: "a", city: Cap(TOWN_B) }), false);
  assert.equal(isOwn({ id: "a", city: "Groningen" }), true);
  assert.equal(isOwn({ id: "a", city: null }), true);
  assert.equal(isOwn({ id: "a", city: Cap(TOWN_A) }, { a: OWNERS.own }), true);
  assert.equal(isOwn({ id: "b", city: "Groningen" }, { b: "skip" }), false);
});

test("ops: store Lidl, preferences only on 2+ receipts and never a snack for an ingredient, the pinned product never renamed, all within the importer's rights", () => {
  const vocab = vocabulary(["Kipfilet", "Paprika", "Macaroni", "macaroni kruidenmix", "Halfvolle melk"]);
  const r1 = normaliseReceipt(receipt("L1", "2026-10-20T18:00:00", "Groningen", R1_BODY));
  const r2 = normaliseReceipt(receipt("L2", "2026-10-26T18:00:00", "Groningen", [art("0100001", "Kipfilet", "4,99", "Kipfilet 4,99"), art("0100004", "Snack Day Paprika chips", "1,19", "Snack Day Paprika chips 1,19"), art("0100002", "Kania Macaroni Spaghetti", "0,79", "Kania Macaroni Spaghetti 0,79")].join("")));
  const { ops } = buildLidlOps([r1, r2], vocab, { pantrySince: "2026-10-25" });
  assert.ok(ops.every(importerMayApply), "every op is one the importer device may send");
  assert.ok(ops.filter((o) => o.store).every((o) => o.store === "Lidl"));
  const prefs = ops.filter((o) => o.type === "preference.set");
  assert.deepEqual(prefs.map((p) => p.title.toLowerCase()).sort(), ["kipfilet", "macaroni kruidenmix", "paprika chips"], "on 2 receipts: Kipfilet, the mix, the chips under their own item; the melk on one; never chips for Paprika");
  assert.ok(prefs.every((p) => p.only_if_unset));
  assert.ok(!ops.some((o) => o.type === "product.put" && o.id === KANIA_MACARONI.id), "his own product is linked, never put again");
  const kania = ops.filter((o) => o.type === "purchase.add" && o.product.id === KANIA_MACARONI.id);
  assert.equal(kania.length, 2);
  assert.equal(kania[0].product.name, KANIA_MACARONI.name);
  assert.deepEqual(ops.filter((o) => o.pantry).map((o) => o.receipt_id).filter((v, i, a) => a.indexOf(v) === i), ["lidl-L2-"], "only the last days fill the pantry");
});

// ---------------------------------------------------------- the server run

const ACCOUNT = [
  receipt("L1", "2026-10-20T18:00:00", "Groningen", R1_BODY),
  receipt("L2", "2026-10-26T18:00:00", "Groningen", [art("0100001", "Kipfilet", "4,99", "Kipfilet 4,99"), art("0100002", "Kania Macaroni Spaghetti", "0,79", "Kania Macaroni Spaghetti 0,79")].join("")),
  receipt("L3", "2026-10-27T18:00:00", Cap(TOWN_A), art("0100099", "Tofu", "2,49", "Tofu 2,49")),
];
const COUPONS = {
  sections: [
    { name: "FavoriteStore", promotions: [
      { id: "c1", title: "Kipfilet", discount: { title: "20%", description: "korting" }, validity: { start: `${TODAY}T00:00:00`, end: `${day(6)}T23:59:59` }, isActivated: false },
      { id: "c2", title: "Groenhof Spruiten", discount: { title: "1+1", description: "gratis" }, validity: { start: `${TODAY}T00:00:00`, end: `${day(6)}T23:59:59` } },
    ] },
    { name: "AllStores", promotions: [
      { id: "c3", title: "Halfvolle melk", discount: { title: "€0,25", description: "korting" }, validity: { start: `${TODAY}T00:00:00`, end: `${day(3)}T23:59:59` } },
      { id: "c1", title: "Kipfilet", discount: { title: "20%", description: "korting" }, validity: { start: `${TODAY}T00:00:00`, end: `${day(6)}T23:59:59` } },
    ] },
  ],
};

function fakeLidl({ coupons = COUPONS } = {}) {
  const calls = { list: 0, details: [], coupons: 0 };
  return {
    calls,
    async listReceipts() { calls.list++; return ACCOUNT.map((r) => ({ id: r.id, date: r.date, total: 12.34 })).reverse(); },
    async getReceipt(id) { calls.details.push(id); return ACCOUNT.find((r) => r.id === id); },
    async listCoupons() { calls.coupons++; return coupons; },
  };
}

function state() {
  const dir = tmp("lidlstate");
  const ah = tmp("ahstate");
  fs.writeFileSync(path.join(ah, TITLES_FILE), JSON.stringify(["Kipfilet", "Macaroni", "macaroni kruidenmix", "Halfvolle melk"]));
  initState({ stateDir: dir, origin: ORIGIN, titlesFrom: path.join(ah, TITLES_FILE) });
  fs.rmSync(ah, { recursive: true, force: true });
  return dir;
}

test("server run: init once; dry-run pulls and sends nothing; push sends Thomas's receipts once; Noor's never", async () => {
  const { env, thomas, importer } = await setup();
  const dir = state();
  const post = (url, init) => worker.fetch(new Request(url, init), env);
  const lines = [];
  const opts = { stateDir: dir, origin: ORIGIN, post, token: importer, today: "2026-10-28", log: (...a) => lines.push(a.join(" ")) };
  try {
    assert.throws(() => initState({ stateDir: dir, origin: ORIGIN, titlesFrom: path.join(dir, TITLES_FILE) }), /exists already/, "init never replaces sent.json");
    const api = fakeLidl();
    assert.deepEqual(await runReceipts("dry-run", { ...opts, api }), { sent: 0, newReceipts: 2 });
    assert.ok(fs.existsSync(path.join(dir, "preview.txt")));
    assert.ok(lines.some((l) => /3 on the account, 2 own, 1 someone else's/.test(l)), lines.join("\n"));
    assert.equal((await sync(env, thomas)).receipts.length, 0, "a dry run sends nothing");
    assert.equal(readSent(dir, ORIGIN).size, 0);

    const again = fakeLidl();
    const pushed = await runReceipts("push", { ...opts, api: again });
    assert.equal(pushed.newReceipts, 2);
    assert.deepEqual(again.calls.details, [], "a cached receipt is never fetched again");
    assert.deepEqual([...readSent(dir, ORIGIN)].sort(), ["L1", "L2"]);
    const all = await sync(env, thomas);
    assert.deepEqual(all.receipts.map((r) => r.id).sort(), ["lidl-L1-", "lidl-L2-"]);
    assert.ok(!JSON.stringify(all).includes("Tofu"), "nothing of Noor's receipt");
    assert.ok(!JSON.stringify(all).toLowerCase().includes("groenhof"), "never an excluded thing");
    const kania = all.products.find((p) => p.id === KANIA_MACARONI.id);
    assert.equal(kania.store_only, 1, "his 'alleen bij Lidl' stays");
    assert.equal(all.products.filter((p) => p.name === KANIA_MACARONI.name || /macaroni kruidenmix|macaroni spaghetti/i.test(p.name)).length, 1, "no second Kania product");
    assert.equal(all.preferences.find((p) => p.store === "Lidl" && p.product_id === KANIA_MACARONI.id)?.store, "Lidl");
    assert.ok(all.pantry.length >= 1, "the receipt of two days ago fills the pantry");

    const before = JSON.stringify((await sync(env, thomas)).purchases.length);
    assert.deepEqual(await runReceipts("push", { ...opts, api: fakeLidl() }), { sent: 0, newReceipts: 0 });
    assert.equal(JSON.stringify((await sync(env, thomas)).purchases.length), before, "twice is once");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("server run: refuses without init or for another origin", async () => {
  const dir = tmp("lidlempty");
  try {
    await assert.rejects(runReceipts("push", { stateDir: dir, origin: ORIGIN, api: fakeLidl(), log: () => {} }), /lidl_import.mjs init/);
    fs.writeFileSync(path.join(dir, "sent.json"), JSON.stringify({ "https://elsewhere.example": [] }));
    await assert.rejects(runReceipts("push", { stateDir: dir, origin: ORIGIN, api: fakeLidl(), log: () => {} }), /another origin/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------- coupons

test("coupons: normalised as Lidl offers of source lidl_plus, doubles and excluded out", () => {
  const offers = couponOffers(COUPONS);
  assert.deepEqual(offers.map((o) => o.name), ["Kipfilet", "Halfvolle melk"]);
  assert.ok(offers.every((o) => o.store === "Lidl" && o.source === "lidl_plus" && isCoupon(o)));
  assert.equal(offers[0].deal, "20% korting");
  assert.equal(offers[0].valid_until, day(6));
  // The older answer shape reads too.
  const old = couponOffers({ sections: [{ coupons: [{ id: "o1", title: "Paprika", offerTitle: "-30%", offerDescriptionShort: "op paprika's", startValidityDate: `${TODAY}T00:00:00`, endValidityDate: `${day(2)}T23:59:59` }] }] });
  assert.deepEqual([old[0].name, old[0].deal], ["Paprika", "-30% op paprika's"]);
  assert.match(dealNote(offers[0]), /^Lidl · Lidl Plus-coupon \(activeer in de app\) · 20% korting t\/m/);
});

const folder = (name, store = "Dirk") => ({ store, name, brand: null, size: null, deal: "-25%", price_cents: 199, valid_from: TODAY, valid_until: day(5), category: null });

test("coupons: their sync replaces only coupons; the folder sync never removes a coupon", async () => {
  const { env, thomas, fetcher, importer } = await setup();
  const post = (url, init) => worker.fetch(new Request(url, init), env);
  const folders = [folder("Kipfilet naturel"), folder("Halfvolle melk", "Lidl"), folder("Paprika rood", "Albert Heijn")];
  assert.equal((await call(env, "POST", "/api/offers/sync", { bearer: fetcher, body: { offers: folders } })).status, 200);

  const first = await runCoupons("push", { origin: ORIGIN, api: fakeLidl(), post, token: fetcher, log: () => {} });
  assert.equal(first.result.added, 2);
  assert.equal(first.result.removed, 0, "the folder offers are not the coupon set's");
  let live = (await sync(env, thomas)).offers.filter((o) => !o.deleted_at);
  assert.equal(live.length, 5);
  assert.equal(live.filter((o) => o.source === "lidl_plus").length, 2);
  assert.equal(live.filter((o) => o.store === "Lidl").length, 2 + 1, "a coupon and a folder offer on melk are two rows");

  // The folder run again (one offer gone): the coupons stay.
  const again = await (await call(env, "POST", "/api/offers/sync", { bearer: fetcher, body: { offers: folders.slice(0, 2) } })).json();
  assert.equal(again.removed, 1);
  live = (await sync(env, thomas)).offers.filter((o) => !o.deleted_at);
  assert.equal(live.filter((o) => o.source === "lidl_plus").length, 2);

  // An empty coupon set removes the coupons only.
  const none = await runCoupons("push", { origin: ORIGIN, api: fakeLidl({ coupons: { sections: [] } }), post, token: fetcher, log: () => {} });
  assert.equal(none.result.removed, 2);
  live = (await sync(env, thomas)).offers.filter((o) => !o.deleted_at);
  assert.deepEqual(live.map((o) => o.name).sort(), ["Halfvolle melk", "Kipfilet naturel"]);

  // A broken answer is never sent as "no coupons"; a dry run sends nothing.
  await assert.rejects(runCoupons("push", { origin: ORIGIN, api: fakeLidl({ coupons: { promotions: "?" } }), post, token: fetcher, log: () => {} }), /unexpected coupon answer/);
  assert.equal((await runCoupons("dry-run", { origin: ORIGIN, api: fakeLidl(), post: () => assert.fail("no request"), log: () => {} })).synced, false);

  // An unknown source is refused; the importer may not sync offers; a person's phone neither.
  assert.equal((await call(env, "POST", "/api/offers/sync", { bearer: fetcher, body: { source: "other", offers: [] } })).status, 400);
  assert.equal((await call(env, "POST", "/api/offers/sync", { bearer: importer, body: { source: "lidl_plus", offers: [] } })).status, 403);
  assert.equal((await call(env, "POST", "/api/offers/sync", { cookie: thomas, body: { source: "lidl_plus", offers: [] } })).status, 403);
});

test("coupons: each source has its own daily limit", async () => {
  const { env, fetcher } = await setup();
  for (let i = 0; i < 4; i++) assert.equal((await call(env, "POST", "/api/offers/sync", { bearer: fetcher, body: { source: "lidl_plus", offers: [] } })).status, 200);
  assert.equal((await call(env, "POST", "/api/offers/sync", { bearer: fetcher, body: { source: "lidl_plus", offers: [] } })).status, 429);
  assert.equal((await call(env, "POST", "/api/offers/sync", { bearer: fetcher, body: { offers: [folder("Kipfilet")] } })).status, 200, "the folders still sync");
});

test("coupons: on the list line like a folder offer", () => {
  const offers = Object.fromEntries(couponOffers(COUPONS).map((o, i) => [`c${i}`, o]));
  const { named } = lineOffers("Kipfilet", null, currentOffers(offers, TODAY));
  assert.equal(named.length, 1);
  assert.ok(isCoupon(named[0]));
  const i18n = (lang) => JSON.parse(fs.readFileSync(path.join(ROOT, `public/i18n/${lang}.json`), "utf8")).list.coupon;
  assert.match(i18n("nl"), /^Lidl Plus-coupon/);
  assert.match(i18n("en"), /^Lidl Plus coupon/);
});

// ---------------------------------------------------------------- the client

test("client: refreshes with the rotated token (file mode 600), retries a 401 once, never names a token, reads coupons only", async () => {
  const dir = tmp("lidlclient");
  const file = path.join(dir, "lidl-tokens.json");
  const seen = { refresh: [], methods: [], urls: [] };
  let gen = 0;
  let valid = "none";
  const fetch = async (url, init) => {
    seen.methods.push(init.method);
    seen.urls.push(url);
    if (url.endsWith("/connect/token")) {
      const body = new URLSearchParams(init.body);
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.match(init.headers.Authorization, /^Basic /);
      seen.refresh.push(body.get("refresh_token"));
      gen++;
      valid = `access-${gen}`;
      return Response.json({ access_token: valid, refresh_token: `refresh-${gen}`, expires_in: 3600 });
    }
    assert.equal(init.headers["App-Version"].split(".").length, 3);
    if (init.headers.Authorization !== `Bearer ${valid}`) return new Response("{}", { status: 401 });
    if (url.includes("promotionsList")) {
      assert.equal(init.headers.Country, "NL");
      return Response.json(COUPONS);
    }
    return Response.json({ tickets: [{ id: "L2", date: "2026-10-26T18:00:00", totalAmount: 1 }], totalCount: 1, size: 25 });
  };
  try {
    fs.writeFileSync(file, JSON.stringify({ refreshToken: "refresh-0" }));
    const client = createLidlClient({ tokenFile: file, fetch, pause: 0 });
    assert.deepEqual((await client.listReceipts()).map((r) => r.id), ["L2"]);
    assert.deepEqual(seen.refresh, ["refresh-0"]);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual([saved.accessToken, saved.refreshToken], ["access-1", "refresh-1"]);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ["lidl-tokens.json"], "no temporary file left");

    // Valid by the clock, revoked by Lidl: one forced refresh with the rotated token.
    valid = "something-else";
    assert.equal(couponOffers(await client.listCoupons()).length, 2);
    assert.deepEqual(seen.refresh, ["refresh-0", "refresh-1"]);
    assert.ok(seen.methods.filter((m, i) => !seen.urls[i].endsWith("/connect/token")).every((m) => m === "GET"), "never activates a coupon");
    assert.ok(!Object.keys(client).some((k) => /activ/i.test(k)), "no activation call at all");

    const refused = createLidlClient({ tokenFile: file, fetch: async () => new Response(JSON.stringify({ secret: "refresh-1" }), { status: 400 }), pause: 0 });
    fs.writeFileSync(file, JSON.stringify({ refreshToken: "refresh-1", expiresAt: 0 }));
    await assert.rejects(refused.listReceipts(), (e) => !e.message.includes("refresh-1") && /HTTP 400/.test(e.message));
    fs.rmSync(file);
    await assert.rejects(refused.listReceipts(), /lidl-login/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------- the login

test("login: PKCE for the app's client in NL; the code from the callback; tokens via a temporary file that is always deleted", async () => {
  const { verifier, challenge } = pkce();
  assert.ok(verifier.length >= 43 && challenge.length === 43);
  const u = new URL(authUrl(challenge));
  assert.equal(u.origin, "https://accounts.lidl.com");
  assert.deepEqual([u.searchParams.get("client_id"), u.searchParams.get("redirect_uri"), u.searchParams.get("code_challenge_method"), u.searchParams.get("Country"), u.searchParams.get("language")],
    ["LidlPlusNativeClient", "com.lidlplus.app://callback", "S256", "NL", "nl-NL"]);
  assert.equal(extractCode('{"url":"com.lidlplus.app://callback?code=ABC123\\u0026scope=openid"}'), "ABC123");
  assert.equal(extractCode("com.lidlplus.app://callback?code=XYZ&state=1"), "XYZ");
  assert.equal(extractCode("https://example.com/?code=nope"), undefined);

  const root = tmp("lidllogin");
  try {
    let uploaded = null;
    let at = null;
    const out = await finishLogin({
      code: "ABC123", verifier, tmpRoot: root,
      exchange: async (code, v) => { assert.deepEqual([code, v], ["ABC123", verifier]); return { accessToken: "a", refreshToken: "r", expiresAt: 1 }; },
      upload: (file) => { at = file; uploaded = JSON.parse(fs.readFileSync(file, "utf8")); if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600); return "saved"; },
    });
    assert.equal(out, "saved");
    assert.equal(uploaded.refreshToken, "r");
    assert.equal(fs.existsSync(at), false);
    assert.deepEqual(fs.readdirSync(root), [], "the temporary folder is gone");
    await assert.rejects(finishLogin({ code: "x", verifier, tmpRoot: root, exchange: async () => { throw new Error("Lidl refused the code: HTTP 400"); }, upload: () => assert.fail("no upload") }), /refused/);
    await assert.rejects(finishLogin({ code: "x", verifier, tmpRoot: root, exchange: async () => ({ accessToken: "a" }), upload: () => assert.fail("no upload") }), /nothing was copied/);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------- run.sh, deploy

test("run.sh: Lidl runs after the AH receipts, LIDL_MODE defaults to dry-run, the server files are deployed, the login is not", () => {
  const sh = fs.readFileSync(path.join(ROOT, "fetcher/run.sh"), "utf8");
  assert.ok(sh.indexOf("fetcher/ah_import.mjs") > 0 && sh.indexOf("fetcher/lidl_import.mjs") > sh.indexOf("fetcher/ah_import.mjs"));
  assert.match(sh, /case "\$LIDL_MODE" in push\|dry-run\) ;; \*\) LIDL_MODE=dry-run ;; esac/);
  assert.match(sh, /lidl exit \$\?/, "its own exit line");
  assert.match(fs.readFileSync(path.join(ROOT, "fetcher/config.example.env"), "utf8"), /^LIDL_MODE=dry-run$/m);
  const deploy = fs.readFileSync(path.join(ROOT, "fetcher/deploy.mjs"), "utf8");
  for (const f of ["fetcher/lidl_import.mjs", "fetcher/lidl_client.mjs", "tools/import_lidl.mjs", "tools/lidl_items.mjs"]) assert.ok(deploy.includes(`["${f}", "${f}"]`), `${f} is deployed`);
  assert.ok(!deploy.includes('["fetcher/lidl-login.mjs"'), "the login stays on the PC");
  assert.ok(deploy.includes('"lidl-tokens.json"'), "its mode is kept at 600");
});
