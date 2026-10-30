// Phase 3, deals: the fetcher's normalisation, the sync route's diff and
// rights, the offers in the wizard and on the list, and what it costs.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { amsterdamDay, SYNC_DAILY_LIMIT } from "../worker/offers.js";
import { fromAhBonus, fromFolder, prepare, dutchDay, sizeFrom, countByStore } from "../fetcher/normalise.mjs";
import { parseAhSection } from "../fetcher/sources.mjs";
import {
  cleanOffer, currentOffers, offersFor, offerMatches, relevanceTest, wizardBonus, isCurrent,
} from "../public/shared/offers.js";
import { propose } from "../public/shared/wizard.js";
import { nameKey } from "../public/shared/ingredients.js";

const HOST = "groceries.localhost:8787";
const ORIGIN = `http://${HOST}`;

function call(env, method, path, { body, cookie, bearer, origin = ORIGIN } = {}) {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`http://${HOST}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
}

const json = async (res) => ({ status: res.status, body: await res.json() });
const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);

const day = (offset) => amsterdamDay(new Date(Date.now() + offset * 86400_000));
const TODAY = day(0);

let opCounter = 0;
const op = (o) => ({ op_id: `op-offer-${String(++opCounter).padStart(6, "0")}`, ...o });

/** A household with a few items on the list, and the home server paired with a fetcher code. */
async function setup() {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const thomas = tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456", label: "phone" } }));
  const ops = ["Kipfilet", "Uien", "Melk", "Geitenkaas"].map((title, i) =>
    op({ type: "entry.add", id: `entry-offer-${i}000`, item_id: `item-offer-${i}000`, title }));
  await call(env, "POST", "/api/ops", { cookie: thomas, body: { ops } });
  const code = await json(await call(env, "POST", "/api/codes", { cookie: thomas, body: { for: "fetcher" } }));
  assert.equal(code.status, 200);
  const server = tokenOf(await call(env, "POST", "/api/pair", { body: { code: code.body.code, label: "Thuisserver" } }));
  assert.ok(server);
  return { env, thomas, server };
}

const offer = (o) => ({
  store: "Dirk", brand: null, size: null, deal: "-25%", price_cents: 199, valid_from: TODAY, valid_until: day(5), category: null, ...o,
});

const SET = [
  offer({ name: "Kipfilet naturel", size: "500 gram" }),
  offer({ store: "Albert Heijn", name: "AH Rode uien", deal: "2e halve prijs", category: "Groente, aardappelen" }),
  offer({ store: "Lidl", name: "Halfvolle melk", price_cents: 99 }),
  offer({ store: "Lidl", name: "Dames broek", price_cents: 899 }),
];

/** Records the SQL of every batch and every prepared statement from here on. */
function spy(env) {
  const seen = { batches: [], queries: [] };
  const batch = env.DB.batch.bind(env.DB);
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.batch = (stmts) => {
    seen.batches.push(stmts.map((s) => s.sql));
    return batch(stmts);
  };
  env.DB.prepare = (sql) => {
    seen.queries.push(sql);
    return prepare(sql);
  };
  return seen;
}

const offerWrites = (seen) => seen.batches.flat().filter((sql) => /^\s*(INSERT INTO offers|UPDATE offers)/.test(sql));

// ---------------------------------------------------------- normalisation

test("normalise: AH bonus items and folder offers become one shape", () => {
  const [product, group] = parseAhSection({
    bonusGroupOrProducts: [
      { product: { title: "AH Kipfilet", bonusMechanism: "25% KORTING", currentPrice: 4.99, salesUnitSize: "300 g", bonusStartDate: "2026-10-26", bonusEndDate: "2026-11-01" } },
      { bonusGroup: { segmentDescription: "Alle Hak groenten", discountLabels: [{ defaultDescription: "2 voor 3.00" }] } },
    ],
  }, "Vlees, kip, vis");
  const period = { bonusStartDate: "2026-10-26", bonusEndDate: "2026-11-01" };
  assert.deepEqual(fromAhBonus(product, period), {
    store: "Albert Heijn", name: "AH Kipfilet", brand: null, size: "300 g", deal: "25% korting", price_cents: 499,
    valid_from: "2026-10-26", valid_until: "2026-11-01", category: "Vlees, kip, vis",
  });
  const g = fromAhBonus(group, period);
  assert.equal(g.deal, "2 voor 3.00");
  assert.equal(g.valid_until, "2026-11-01");
  assert.equal(g.price_cents, null);

  const f = fromFolder({
    name: "Fresh & Minty Tandpasta 75 ml", description: "Alle soorten. 1+1 gratis", brandName: "Etos",
    priceAfterDiscount: 7.17, discountPercent: null, activeFrom: "2026-10-25T23:00:00Z", expireAfter: "2026-11-01T22:59:00Z",
    shop: { slug: "etos", name: "Etos" },
  });
  // 23:00 UTC on the 25th is the 26th in the Netherlands; 22:59 UTC on the 1st is still the 1st.
  assert.deepEqual(f, {
    store: "Etos", name: "Fresh & Minty Tandpasta 75 ml", brand: "Etos", size: "75 ml", deal: null, price_cents: 717,
    valid_from: "2026-10-26", valid_until: "2026-11-01", category: null,
  });
  assert.equal(fromFolder({ name: "Kaas", description: "2e halve prijs op alles", shop: { name: "Dirk" }, expireAfter: "2026-11-01T22:59:00Z" }).deal, "2e halve prijs op alles");
  assert.equal(fromFolder({ name: "Kaas", discountPercent: 33.4, shop: { name: "Dirk" }, expireAfter: "2026-11-01T22:59:00Z" }).deal, "-33%");
  assert.equal(dutchDay("2026-03-29T22:30:00Z"), "2026-03-30", "summer time");
  assert.equal(sizeFrom("Pak van 6 x 33 cl"), "6 x 33 cl");
  assert.equal(sizeFrom("geen maat"), null);
});

test("normalise: excluded, broken, expired and doubled offers are dropped", () => {
  const raw = [
    offer({ name: "Groenhof spruitjes zak" }),
    offer({ name: "Groene Ster chips", store: "Albert Heijn" }),
    offer({ name: "Mini kooltjes", brand: "Faustino", category: "Groente, spruitjes" }),
    offer({ name: "Diepvriesspruitjes" }),
    offer({ name: "Spruitensoep" }),
    offer({ name: "Gingerale" }),
    offer({ name: "Kipfilet" }),
    offer({ name: "kipfilet" }),
    offer({ name: "Oude brie", valid_from: day(-7), valid_until: day(-1) }),
    offer({ name: "", valid_until: day(3) }),
    offer({ name: "Zonder einde", valid_until: null }),
  ];
  const { offers, dropped } = prepare(raw, TODAY);
  assert.deepEqual(offers.map((o) => o.name), ["Spruitensoep", "Gingerale", "Kipfilet"]);
  assert.deepEqual(dropped, { excluded: 4, invalid: 2, expired: 1, duplicate: 1 });
  assert.deepEqual(countByStore(offers), { Dirk: 3 });
  assert.equal(cleanOffer(offer({ name: "Spruiten" })), null, "the worker's clean-up refuses excluded too");
  assert.equal(cleanOffer(offer({ name: "Kaas", price_cents: 1.5 })).price_cents, null);
  assert.equal(cleanOffer(offer({ name: "Kaas", valid_from: day(3), valid_until: day(1) })), null);
});

// ----------------------------------------------------------- sync route

test("offers sync: the first set adds the relevant ones, the same set again writes nothing", async () => {
  const { env, server, thomas } = await setup();
  const first = await json(await call(env, "POST", "/api/offers/sync", { bearer: server, body: { offers: SET } }));
  assert.equal(first.status, 200);
  assert.deepEqual(
    { added: first.body.added, irrelevant: first.body.irrelevant, removed: first.body.removed },
    { added: 3, irrelevant: 1, removed: 0 },
    "kipfilet, uien and melk are bought here; a pair of trousers is not");

  const full = await json(await call(env, "GET", "/api/sync?since=0", { cookie: thomas }));
  assert.deepEqual(full.body.offers.map((o) => o.name).sort(), ["AH Rode uien", "Halfvolle melk", "Kipfilet naturel"]);

  const seen = spy(env);
  const again = await json(await call(env, "POST", "/api/offers/sync", { bearer: server, body: { offers: SET } }));
  assert.deepEqual([again.body.added, again.body.changed, again.body.removed, again.body.kept], [0, 0, 0, 3]);
  assert.equal(offerWrites(seen).length, 0, "an unchanged set writes no offer row");
  assert.equal(seen.batches.filter((b) => b.some((sql) => sql.startsWith("UPDATE households"))).length, 0, "and no rev bump");
  assert.equal(again.body.rev, full.body.rev, "so no phone pulls anything");
});

test("offers sync: one changed offer is one row; a gone or expired one is a tombstone", async () => {
  const { env, server, thomas } = await setup();
  await call(env, "POST", "/api/offers/sync", { bearer: server, body: { offers: SET } });
  const { body: head } = await json(await call(env, "GET", "/api/sync?since=0", { cookie: thomas }));

  const changed = SET.map((o) => (o.name === "Halfvolle melk" ? { ...o, price_cents: 89 } : o));
  const seen = spy(env);
  const res = await json(await call(env, "POST", "/api/offers/sync", { bearer: server, body: { offers: changed } }));
  assert.deepEqual([res.body.added, res.body.changed, res.body.removed], [0, 1, 0]);
  assert.equal(offerWrites(seen).length, 1, "one row");
  const delta = await json(await call(env, "GET", `/api/sync?since=${head.rev}`, { cookie: thomas }));
  assert.deepEqual(delta.body.offers.map((o) => [o.name, o.price_cents]), [["Halfvolle melk", 89]]);
  assert.equal(delta.body.entries.length, 0);

  const gone = changed.filter((o) => o.name !== "Kipfilet naturel")
    .map((o) => (o.name === "AH Rode uien" ? { ...o, valid_until: day(-1) } : o));
  const out = await json(await call(env, "POST", "/api/offers/sync", { bearer: server, body: { offers: gone } }));
  assert.deepEqual([out.body.added, out.body.changed, out.body.removed, out.body.kept], [0, 0, 2, 1]);
  const after = await json(await call(env, "GET", `/api/sync?since=${delta.body.rev}`, { cookie: thomas }));
  assert.deepEqual(after.body.offers.map((o) => [o.name, Boolean(o.deleted_at)]).sort(), [["AH Rode uien", true], ["Kipfilet naturel", true]]);

  // Back in next week's folder: the tombstone comes back to life, same row.
  const back = await json(await call(env, "POST", "/api/offers/sync", { bearer: server, body: { offers: SET } }));
  assert.deepEqual([back.body.added, back.body.changed, back.body.removed], [2, 1, 0]);
  const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM offers").all();
  assert.equal(results[0].n, 3);
});

test("offers sync: many changes land in chunks, each with its own rev, and every one arrives", async () => {
  const { env, server, thomas } = await setup();
  const { body: head } = await json(await call(env, "GET", "/api/sync?since=0", { cookie: thomas }));
  const many = Array.from({ length: 120 }, (_, i) => offer({ name: `Kipfilet ${i}` }));
  const res = await json(await call(env, "POST", "/api/offers/sync", { bearer: server, body: { offers: many } }));
  assert.equal(res.body.added, 120);
  assert.equal(res.body.rev, head.rev + 3, "three chunks of at most 50");
  const delta = await json(await call(env, "GET", `/api/sync?since=${head.rev}`, { cookie: thomas }));
  assert.equal(delta.body.offers.length, 120);
});

// ---------------------------------------------------------------- rights

test("offers sync: only the fetcher device, and the fetcher device only there", async () => {
  const { env, server, thomas } = await setup();
  assert.equal((await call(env, "POST", "/api/offers/sync", { cookie: thomas, body: { offers: SET } })).status, 403, "a phone");
  const { body: tool } = await json(await call(env, "POST", "/api/codes", { cookie: thomas, body: {} }));
  const laptop = tokenOf(await call(env, "POST", "/api/pair", { body: { code: tool.code, label: "Claude (tools)" } }));
  assert.equal((await call(env, "POST", "/api/offers/sync", { bearer: laptop, body: { offers: SET } })).status, 403, "a tool with a Bearer token");
  assert.equal((await call(env, "POST", "/api/offers/sync", { body: { offers: SET } })).status, 401, "nobody");

  for (const [method, path, body] of [["GET", "/api/sync?since=0"], ["GET", "/api/me"], ["POST", "/api/ops", { ops: [] }],
    ["POST", "/api/codes", {}], ["POST", "/api/handoff", {}], ["GET", "/api/devices"], ["POST", "/api/logout", {}]]) {
    const res = await call(env, method, path, { bearer: server, body });
    assert.equal(res.status, 403, `the fetcher may not ${method} ${path}`);
  }

  // A fetcher code is an admin's to make.
  const { body: sam } = await json(await call(env, "POST", "/api/codes", { cookie: thomas, body: { for: "new_member", name: "Sam" } }));
  const samToken = tokenOf(await call(env, "POST", "/api/pair", { body: { code: sam.code } }));
  assert.equal((await call(env, "POST", "/api/codes", { cookie: samToken, body: { for: "fetcher" } })).status, 403);

  const devices = await json(await call(env, "GET", "/api/devices", { cookie: thomas }));
  assert.ok(devices.body.devices.some((d) => d.label === "Thuisserver"), "it shows (and can be revoked) like any device");
});

test("offers sync: rate-limited per household per day, and refuses a malformed body", async () => {
  const { env, server } = await setup();
  assert.equal((await call(env, "POST", "/api/offers/sync", { bearer: server, body: { offers: "x" } })).status, 400);
  for (let i = 0; i < SYNC_DAILY_LIMIT; i++) {
    assert.equal((await call(env, "POST", "/api/offers/sync", { bearer: server, body: { offers: [] } })).status, 200);
  }
  const over = await json(await call(env, "POST", "/api/offers/sync", { bearer: server, body: { offers: [] } }));
  assert.deepEqual([over.status, over.body.error], [429, "too_many_syncs"]);
});

// ----------------------------------------------------------- usage

test("usage: with offers stored, an idle poll still reads only the counter", async () => {
  const { env, server, thomas } = await setup();
  await call(env, "POST", "/api/offers/sync", { bearer: server, body: { offers: SET } });
  const { body: head } = await json(await call(env, "GET", "/api/sync?since=0", { cookie: thomas }));
  const seen = spy(env);
  const idle = await json(await call(env, "GET", `/api/sync?since=${head.rev}`, { cookie: thomas }));
  assert.equal(idle.body.offers.length, 0);
  const data = seen.queries.filter((sql) => !/FROM devices d JOIN members/.test(sql));
  assert.deepEqual(data, ["SELECT rev FROM households WHERE id = ?"], "one row: the household counter");
  assert.equal(seen.batches.length, 0);
});

// ------------------------------------------------- the wizard and the list

const synced = (list) => Object.fromEntries(list.map((o, i) => [`of-${i}`, { id: `of-${i}`, ...o }]));

test("wizard: the synced offers give the bonus weight; expired and excluded do not", () => {
  const recipe = (id, main) => ({
    id, title: id, labels_by: "claude", ingredients: [{ qty: 400, unit: "g", name: main }], steps: ["Bak."],
  });
  const data = { recipes: { a: recipe("a", "kipfilet"), b: recipe("b", "zalm") }, cooks: {}, purchases: {}, entries: {}, items: {} };
  const offers = synced([
    offer({ store: "Albert Heijn", name: "AH Kipfilet", valid_until: day(2) }),
    offer({ name: "Zalmfilet", valid_until: day(-1) }),
    offer({ name: "Zalm in spruiten", valid_until: day(2) }),
  ]);
  const bonus = wizardBonus(offers, TODAY);
  assert.deepEqual(bonus.map((b) => b.name), ["AH Kipfilet"]);
  const [top] = propose({ data, bonus, today: TODAY, random: () => 0, count: 2 });
  assert.equal(top.recipe.id, "a");
  assert.deepEqual(top.reasons.map((r) => r.key), ["bonus"]);
  const none = propose({ data, bonus: [], today: TODAY, random: () => 0, count: 2 });
  assert.ok(none.every((p) => p.reasons.every((r) => r.key !== "bonus")));
});

test("list: an open line finds its offers by name; outside their days they are not shown", () => {
  const offers = synced([
    offer({ store: "Albert Heijn", name: "AH Rode uien", valid_until: day(1) }),
    offer({ store: "Dirk", name: "Uien", valid_until: day(4) }),
    offer({ store: "Lidl", name: "Kipfilet naturel" }),
    offer({ store: "Dirk", name: "Franse geitenkaas" }),
    offer({ store: "Jumbo", name: "Volle melk", valid_from: day(1) }),
    offer({ store: "Plus", name: "Halfvolle melk", valid_until: day(-1) }),
    offer({ store: "Spar", name: "Scharreleieren" }),
  ]);
  const current = currentOffers(offers, TODAY);
  assert.deepEqual(current.map((o) => o.name).sort(), ["AH Rode uien", "Franse geitenkaas", "Kipfilet naturel", "Scharreleieren", "Uien"]);
  assert.ok(!isCurrent(offers["of-4"], TODAY) && isCurrent(offers["of-4"], day(1)), "next week's folder counts from its first day");

  const names = (title) => offersFor(title, current).map((o) => o.name);
  assert.deepEqual(names("Uien"), ["Uien", "AH Rode uien"], "the exact name first");
  assert.deepEqual(names("ui"), ["Uien", "AH Rode uien"], "through the canonical name");
  assert.deepEqual(names("kip"), ["Kipfilet naturel"], "the start of a word");
  assert.deepEqual(names("Geitenkaas"), ["Franse geitenkaas"]);
  assert.deepEqual(names("Geitenkaas blokjes"), [], "every word of the line must be there");
  assert.deepEqual(names("kaas"), ["Franse geitenkaas"], "the end of a word");
  assert.deepEqual(names("eieren"), ["Scharreleieren"]);
  assert.deepEqual(names("Melk"), [], "not before or after its days");
  assert.deepEqual(names("fruit"), [], "a generic line is no product");
  assert.deepEqual(names("ei"), ["Scharreleieren"], "ei is eieren");
});

test("relevance: the worker's fast test agrees with the list's matching", () => {
  const lines = ["Kipfilet", "ui", "kaas", "Halfvolle melk", "rijst", "Minoes brokken", "fruit", "ei"];
  const names = ["AH Kipfilet", "Kip drumsticks", "Rode uien", "Geitenkaas", "Kaasschaaf", "Halfvolle melk 1L", "Volle melk",
    "Zilvervliesrijst", "Rijstwafels", "Dames broek", "Fruitmand", "Scharreleieren", "Kattenbrokken"];
  const test = relevanceTest(lines);
  for (const name of names) {
    const o = { name, brand: null };
    const slow = lines.some((l) => offersFor(l, [{ ...o, valid_until: TODAY, store: "x" }]).length > 0);
    assert.equal(test(o), slow, name);
  }
  assert.equal(test({ name: "Dames broek" }), false);
  assert.equal(offerMatches(nameKey("kip"), { name: "Kipfilet" }), true);
});
