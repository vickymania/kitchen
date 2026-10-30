// The daily AH receipt import on the home server: the importer device's
// rights, the ported AH client's token handling, the server run on a made-up
// fixture (no network, no personal data), the second login's file handling,
// the state seed and run.sh.
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
import { OP_TYPES } from "../public/shared/ops.js";
import { importerMayApply } from "../worker/auth.js";
import { createAhClient } from "../fetcher/ah_client.mjs";
import { runImport, TITLES_FILE } from "../fetcher/ah_import.mjs";
import { secondLogin } from "../fetcher/ah-login.mjs";
import { stageSeed, SEED_FILES } from "../fetcher/ah-seed.mjs";
import { readSent, OTHER_PEOPLE_CITIES } from "../tools/import_ah.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `kitchen-test-${name}-`));

/** A household, Thomas's phone, and the home server paired with an importer code. */
async function setup() {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const thomas = tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456", label: "phone" } }));
  const code = await (await call(env, "POST", "/api/codes", { cookie: thomas, body: { for: "importer" } })).json();
  const importer = tokenOf(await call(env, "POST", "/api/pair", { body: { code: code.code, label: "Thuisserver AH" } }));
  assert.ok(importer);
  return { env, thomas, importer };
}

let n = 0;
const opId = () => `op-ahdaily-${String(++n).padStart(6, "0")}`;
const RECEIPT = { type: "receipt.save", id: "ah-test-1", store: "Albert Heijn", bought_on: "2026-10-20", total_cents: 165, lines: [] };
const PURCHASE = {
  type: "purchase.add", id: "purchase-ahdaily-1", item_id: "item-ahdaily-ham", title: "Ham", bought_on: "2026-10-20",
  store: "Albert Heijn", qty: 1, price_cents: 165, source: "receipt", receipt_id: "ah-test-1",
  product: { id: "ah-product-1", name: "AH Beenham", brand: "AH", size: "150 g" },
};

// ------------------------------------------------------------------ rights

test("importer: may send the import's ops to /api/ops", async () => {
  const { env, importer, thomas } = await setup();
  const ops = [
    { ...RECEIPT, op_id: opId() },
    { ...PURCHASE, op_id: opId(), pantry: true },
    { op_id: opId(), type: "product.put", id: "ah-product-1", product: { name: "AH Beenham", brand: "AH", size: "150 g", store: "Albert Heijn" } },
    { op_id: opId(), type: "preference.set", id: "pref-ahdaily-1", item_id: "item-ahdaily-ham", title: "Ham", product_id: "ah-product-1", store: "Albert Heijn", only_if_unset: true },
  ];
  const res = await call(env, "POST", "/api/ops", { bearer: importer, body: { ops } });
  assert.equal(res.status, 200);
  const { results } = await res.json();
  assert.deepEqual(results.filter((r) => !r.ok), []);
  const all = await (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();
  assert.equal(all.purchases.length, 1);
  assert.equal(all.pantry.length, 1, "the pantry row comes with purchase.add");
  const members = all.members.map((m) => m.id);
  assert.ok(members.includes(all.purchases[0].created_by), "on behalf of the admin who made the code");
});

test("importer: every other op type, and import ops that touch a person's choices, are refused whole", async () => {
  const { env, importer, thomas } = await setup();
  // prices.sync: the Checkjebon shelf prices (tests/store-prices.test.mjs).
  const allowed = ["receipt.save", "purchase.add", "product.put", "preference.set", "prices.sync"];
  for (const type of OP_TYPES.filter((t) => !allowed.includes(t))) {
    const res = await call(env, "POST", "/api/ops", { bearer: importer, body: { ops: [{ op_id: opId(), type, id: "x-ahdaily-000001" }] } });
    assert.equal(res.status, 403, `the importer may not send ${type}`);
  }
  for (const [why, op] of [
    ["tick a list line", { ...PURCHASE, entry_id: "entry-1" }],
    ["prefer from a purchase", { ...PURCHASE, prefer: true }],
    ["prefer for a recipe", { ...PURCHASE, prefer_recipe_id: "recipe-1" }],
    ["a history purchase", { ...PURCHASE, source: "history" }],
    ["replace a preference", { type: "preference.set", id: "pref-x", item_id: "item-ahdaily-ham", title: "Ham", product_id: "ah-product-1", store: "Albert Heijn" }],
    ["no type", {}],
  ]) {
    assert.equal(importerMayApply(op), false, why);
    const res = await call(env, "POST", "/api/ops", { bearer: importer, body: { ops: [{ ...op, op_id: opId() }] } });
    assert.equal(res.status, 403, `the importer may not ${why}`);
  }
  // One bad op refuses the batch before anything is applied.
  const mixed = [{ ...RECEIPT, op_id: opId() }, { op_id: opId(), type: "entry.add", id: "entry-ahdaily-1", item_id: "item-ahdaily-1", title: "Melk" }];
  assert.equal((await call(env, "POST", "/api/ops", { bearer: importer, body: { ops: mixed } })).status, 403);
  const all = await (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();
  assert.deepEqual([all.receipts.length, all.entries.length], [0, 0], "nothing of the refused batch");
});

test("importer: every route but /api/ops is refused, and a normal device is unaffected", async () => {
  const { env, importer, thomas } = await setup();
  const api = fs.readFileSync(path.join(ROOT, "worker/api.js"), "utf8");
  const routes = [...api.matchAll(/\["(GET|POST)", "(\/api\/[^"]+)", \w+(?:, (\{[^}]*\}))?\]/g)].map((m) => [m[1], m[2], m[3] ?? ""]);
  assert.ok(routes.length >= 15, "the route table was read");
  for (const [method, route, opts] of routes) {
    // /api/prices/inputs: the importer's own read for the shelf prices (tests/store-prices.test.mjs).
    if (route === "/api/ops" || route === "/api/prices/inputs" || opts.includes("open: true")) continue;
    const res = await call(env, method, method === "GET" ? `${route}?since=0` : route, { bearer: importer, body: method === "POST" ? {} : undefined });
    assert.equal(res.status, 403, `the importer may not ${method} ${route}`);
  }
  assert.equal((await call(env, "GET", "/api/prices/inputs", { bearer: importer })).status, 200);
  assert.equal((await call(env, "GET", "/api/prices/inputs", { cookie: thomas })).status, 403, "a person's phone never");
  // A person's device: everything it could do before.
  const add = await call(env, "POST", "/api/ops", { cookie: thomas, body: { ops: [{ op_id: opId(), type: "entry.add", id: "entry-ahdaily-2", item_id: "item-ahdaily-2", title: "Melk" }] } });
  assert.equal(add.status, 200);
  assert.ok((await add.json()).results[0].ok);
  assert.equal((await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).status, 200);
  assert.equal((await call(env, "POST", "/api/offers/sync", { cookie: thomas, body: { offers: [] } })).status, 403, "deals stay the fetcher's");

  // An importer code is an admin's to make; the fetcher still may not send ops.
  const sam = await (await call(env, "POST", "/api/codes", { cookie: thomas, body: { for: "new_member", name: "Sam" } })).json();
  const samToken = tokenOf(await call(env, "POST", "/api/pair", { body: { code: sam.code } }));
  assert.equal((await call(env, "POST", "/api/codes", { cookie: samToken, body: { for: "importer" } })).status, 403);
  const f = await (await call(env, "POST", "/api/codes", { cookie: thomas, body: { for: "fetcher" } })).json();
  const fetcher = tokenOf(await call(env, "POST", "/api/pair", { body: { code: f.code, label: "Thuisserver" } }));
  assert.equal((await call(env, "POST", "/api/ops", { bearer: fetcher, body: { ops: [{ ...RECEIPT, op_id: opId() }] } })).status, 403);
  const devices = await (await call(env, "GET", "/api/devices", { cookie: thomas })).json();
  assert.ok(devices.devices.some((d) => d.label === "Thuisserver AH"), "it shows (and can be revoked) like any device");
});

// ------------------------------------------------------------ the AH client

/** A fake api.ah.nl: counts calls, rotates the refresh token on every refresh. */
function fakeAh({ expireFirst = false } = {}) {
  const seen = { refresh: 0, bearer: [], refreshTokens: [] };
  let gen = 0;
  let valid = expireFirst ? "none" : "access-0";
  const fetch = async (url, init) => {
    if (url.endsWith("/mobile-auth/v1/auth/token/refresh")) {
      seen.refresh++;
      seen.refreshTokens.push(JSON.parse(init.body).refreshToken);
      gen++;
      valid = `123_access-${gen}`;
      return Response.json({ access_token: valid, refresh_token: `refresh-${gen}`, expires_in: 3600 });
    }
    const bearer = init.headers.Authorization.slice(7);
    seen.bearer.push(bearer);
    if (bearer !== valid) return new Response("{}", { status: 401 });
    return Response.json({ data: { posReceiptsPage: { posReceipts: [{ id: "AH0000000000000000000000000001", dateTime: "2026-10-20T10:00:00Z", totalAmount: { amount: 1 } }] } } });
  };
  return { fetch, seen };
}

test("AH client: refreshes before expiry, writes the rotated tokens back (mode 600), retries a 401 once", async () => {
  const dir = tmp("ahclient");
  const file = path.join(dir, "ah-tokens.json");
  try {
    // Expired: refreshed first, and the new pair is on disk.
    fs.writeFileSync(file, JSON.stringify({ accessToken: "old", refreshToken: "refresh-0", expiresAt: Date.now() - 1000 }));
    const a = fakeAh();
    const client = createAhClient({ tokenFile: file, fetch: a.fetch });
    assert.equal((await client.listReceipts(0, 100)).length, 1);
    assert.deepEqual(a.seen.refreshTokens, ["refresh-0"]);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual([saved.accessToken, saved.refreshToken, saved.memberId], ["123_access-1", "refresh-1", "123"]);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ["ah-tokens.json"], "no temporary file left");

    // Valid by the clock but revoked by AH: one forced refresh with the rotated token, then success.
    fs.writeFileSync(file, JSON.stringify({ ...saved, expiresAt: Date.now() + 3600_000 }));
    const b = fakeAh({ expireFirst: true });
    await createAhClient({ tokenFile: file, fetch: b.fetch }).listReceipts(0, 100);
    assert.deepEqual(b.seen.refreshTokens, ["refresh-1"]);
    assert.equal(b.seen.bearer.length, 2);

    // A refused refresh: the error names no token.
    const c = createAhClient({ tokenFile: file, fetch: async () => new Response(JSON.stringify({ secret: "refresh-xyz" }), { status: 400 }) });
    fs.writeFileSync(file, JSON.stringify({ accessToken: "a", refreshToken: "refresh-xyz", expiresAt: 0 }));
    await assert.rejects(c.listReceipts(0, 100), (e) => !e.message.includes("refresh-xyz") && /HTTP 400/.test(e.message));
    // No session at all: says how to make one.
    fs.rmSync(file);
    await assert.rejects(c.listReceipts(0, 100), /ah-login/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------- the server run

const amount = (a) => ({ amount: a });
const line = (id, name, a, quantity = 1) => ({ id, quantity, name, price: null, amount: amount(a) });
const ACCOUNT = [
  // Imported before: in the seed and in sent.json.
  { id: "AH0000000000000000000000000001", dateTime: "2026-10-01T10:00:00.000Z", city: "Groningen", products: [line(101, "AH BEENHAM", 1.65), line(102, "AH HV MELK", 1.09)] },
  // New since: Thomas's, and one of Noor's.
  { id: "AH0000000000000000000000000002", dateTime: "2026-10-26T10:00:00.000Z", city: "ZEIST UTR", products: [line(101, "AH BEENHAM", 1.65), line(103, "GROENHOF", 9.49), line(0, "STATIEGELD", 0.15)] },
  { id: "AH0000000000000000000000000003", dateTime: "2026-10-27T10:00:00.000Z", city: OTHER_PEOPLE_CITIES[0].toUpperCase(), products: [line(104, "AH TOFU", 2.49)] },
];
const POS = { 101: 543345, 102: 9007, 103: 9001, 104: 9009 };
const CARDS = {
  543345: { webshopId: 543345, title: "AH Beenham", brand: "AH", salesUnitSize: "150 g" },
  9007: { webshopId: 9007, title: "AH Halfvolle melk", brand: "AH", salesUnitSize: "1 l" },
  9001: { webshopId: 9001, title: "Groenhof Spruitjes", brand: "Groenhof", salesUnitSize: "6 x 330 ml" },
  9009: { webshopId: 9009, title: "AH Tofu naturel", brand: "AH", salesUnitSize: "375 g" },
};

/** The api tools/ah_pull.mjs takes, on the fixture, counting calls. */
function fakeApi() {
  const calls = { details: [], cities: [] };
  const summary = (r) => ({ id: r.id, dateTime: r.dateTime, totalAmount: amount(1) });
  return {
    calls,
    async listReceipts(offset) { return offset ? [] : [...ACCOUNT].reverse().map(summary); },
    async getReceipt(id) {
      calls.details.push(id);
      const r = ACCOUNT.find((x) => x.id === id);
      return { id, products: r.products, discounts: [], total: amount(1) };
    },
    async convertPosIds(ids) { return new Map(ids.filter((i) => POS[i]).map((i) => [i, POS[i]])); },
    async getProductsByIds(ids) { return new Map(ids.map((i) => [i, CARDS[i]])); },
    async ahGraphQL(_q, { id }) {
      calls.cities.push(id);
      return { posReceiptDetails: { address: { city: ACCOUNT.find((x) => x.id === id).city } } };
    },
  };
}

/** The state a seed leaves: R1 cached and sent, Thomas's item names. */
function seededState() {
  const dir = tmp("ahstate");
  const r1 = ACCOUNT[0];
  fs.mkdirSync(path.join(dir, "receipts"));
  fs.writeFileSync(path.join(dir, "receipts.json"), JSON.stringify([{ id: "AH0000000000000000000000000001", dateTime: r1.dateTime, total: 1 }]));
  fs.writeFileSync(path.join(dir, "receipts", "AH0000000000000000000000000001.json"), JSON.stringify({ id: "AH0000000000000000000000000001", products: r1.products, discounts: [], total: amount(1) }));
  fs.writeFileSync(path.join(dir, "pos-to-webshop.json"), JSON.stringify({ 101: 543345, 102: 9007 }));
  fs.writeFileSync(path.join(dir, "products.json"), JSON.stringify({ 543345: { title: "AH Beenham", brand: "AH", size: "150 g", price: 1.65 }, 9007: { title: "AH Halfvolle melk", brand: "AH", size: "1 l", price: 1.09 } }));
  fs.writeFileSync(path.join(dir, "cities.json"), JSON.stringify({ AH0000000000000000000000000001: "Groningen" }));
  fs.writeFileSync(path.join(dir, "sent.json"), JSON.stringify({ [ORIGIN]: ["AH0000000000000000000000000001"] }));
  fs.writeFileSync(path.join(dir, TITLES_FILE), JSON.stringify(["Ham", "Melk"]));
  return dir;
}

test("server run: dry-run pulls and sends nothing; push sends only Thomas's new receipts, once", async () => {
  const { env, importer, thomas } = await setup();
  const dir = seededState();
  const post = (url, init) => worker.fetch(new Request(url, init), env);
  const lines = [];
  const opts = { stateDir: dir, origin: ORIGIN, post, token: importer, today: "2026-10-28", log: (...a) => lines.push(a.join(" ")) };
  try {
    const api = fakeApi();
    const dry = await runImport("dry-run", { ...opts, api });
    assert.deepEqual(dry, { sent: 0, newReceipts: 1 });
    assert.deepEqual(api.calls.details.sort(), ["AH0000000000000000000000000002", "AH0000000000000000000000000003"], "cached receipts are never fetched again");
    assert.ok(lines.some((l) => /3 on the account, 2 own, 1 someone else's.*new: 1/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /nothing sent/.test(l)));
    assert.deepEqual([...readSent(dir, ORIGIN)], ["AH0000000000000000000000000001"], "a dry run writes no sent.json");
    let all = await (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();
    assert.equal(all.receipts.length, 0);

    const pushed = await runImport("push", { ...opts, api: fakeApi() });
    assert.equal(pushed.newReceipts, 1);
    assert.deepEqual([...readSent(dir, ORIGIN)].sort(), ["AH0000000000000000000000000001", "AH0000000000000000000000000002"], "Noor's receipt is never marked, never sent");
    all = await (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();
    assert.deepEqual(all.receipts.map((r) => r.id), ["ah-AH0000000000000000000000000002"]);
    assert.deepEqual(all.purchases.map((p) => p.title), ["Ham"], "sprouts and deposit left out; R1 not again");
    assert.equal(all.pantry.length, 1, "a receipt of two days ago fills the pantry");
    assert.ok(!JSON.stringify(all).includes("Tofu"), "nothing of Noor's receipt");
    // The preference counts R1 too (two receipts with beenham).
    assert.equal(all.preferences.find((p) => p.store === "Albert Heijn")?.product_id, "ah-product-543345");

    const again = await runImport("push", { ...opts, api: fakeApi() });
    assert.deepEqual(again, { sent: 0, newReceipts: 0 });
    assert.ok(lines.at(-1).includes("no new receipts"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("server run: refuses without a seeded state, so two years are never sent again", async () => {
  const dir = tmp("ahempty");
  try {
    await assert.rejects(runImport("push", { stateDir: dir, origin: ORIGIN, api: fakeApi(), log: () => {} }), /seed the state first/);
    fs.writeFileSync(path.join(dir, "sent.json"), JSON.stringify({ "https://elsewhere.example": ["AH0000000000000000000000000001"] }));
    await assert.rejects(runImport("push", { stateDir: dir, origin: ORIGIN, api: fakeApi(), log: () => {} }), /another origin/);
    fs.writeFileSync(path.join(dir, "sent.json"), JSON.stringify({ [ORIGIN]: ["AH0000000000000000000000000001"] }));
    await assert.rejects(runImport("push", { stateDir: dir, origin: ORIGIN, api: fakeApi(), log: () => {} }), /history-titles/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------- the second login

test("second login: tokens go to a temporary folder, then to the upload; the PC's file is never touched", () => {
  const home = tmp("pcah");
  const pcFile = path.join(home, "tokens.json");
  fs.writeFileSync(pcFile, '{"accessToken":"pc","refreshToken":"pc"}');
  const before = fs.statSync(pcFile).mtimeMs;
  let dataDir = null;
  let uploaded = null;
  try {
    const out = secondLogin({
      pcTokenFile: pcFile,
      runLogin: (env) => {
        dataDir = env.AH_DATA_DIR;
        // What the MCP's login does: tokens.json in AH_DATA_DIR.
        fs.writeFileSync(path.join(dataDir, "tokens.json"), '{"accessToken":"server","refreshToken":"server-r"}');
        return 0;
      },
      upload: (file) => { uploaded = JSON.parse(fs.readFileSync(file, "utf8")); return "saved"; },
      warn: () => assert.fail("no warning expected"),
    });
    assert.equal(out, "saved");
    assert.notEqual(path.resolve(dataDir), path.resolve(home));
    assert.equal(uploaded.refreshToken, "server-r");
    assert.equal(fs.existsSync(dataDir), false, "the temporary folder is gone");
    assert.equal(fs.readFileSync(pcFile, "utf8"), '{"accessToken":"pc","refreshToken":"pc"}');
    assert.equal(fs.statSync(pcFile).mtimeMs, before);

    // A login that fails or writes nothing uploads nothing, and still cleans up.
    for (const runLogin of [() => 1, () => 0]) {
      let dir = null;
      assert.throws(() => secondLogin({
        pcTokenFile: pcFile, runLogin: (env) => { dir = env.AH_DATA_DIR; return runLogin(); }, upload: () => assert.fail("no upload"),
      }), /nothing was copied/);
      assert.equal(fs.existsSync(dir), false);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- seed, deploy, run.sh

test("seed: the cache, sent.json and the titles, never preview.txt", () => {
  const from = seededState();
  const stage = tmp("ahstage");
  try {
    fs.writeFileSync(path.join(from, "preview.txt"), "personal");
    const counts = stageSeed(from, stage, ["Ham"]);
    assert.deepEqual(counts, { sent: 0, receipts: 1, titles: 1 }, "the PC's sent.json is keyed by the live origin");
    assert.deepEqual(fs.readdirSync(stage).sort(), [...SEED_FILES.filter((f) => fs.existsSync(path.join(from, f))), "history-titles.json", "receipts"].sort());
    assert.throws(() => stageSeed(from, tmp("ahstage2"), []), /history titles/);
  } finally {
    fs.rmSync(from, { recursive: true, force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

test("run.sh: the receipts run after the deals, AH_MODE defaults to dry-run, both scripts are deployed", () => {
  const sh = fs.readFileSync(path.join(ROOT, "fetcher/run.sh"), "utf8");
  const deals = sh.indexOf("fetcher/fetch.mjs");
  const receipts = sh.indexOf("fetcher/ah_import.mjs");
  assert.ok(deals > 0 && receipts > deals);
  assert.match(sh, /case "\$AH_MODE" in push\|dry-run\) ;; \*\) AH_MODE=dry-run ;; esac/);
  assert.match(fs.readFileSync(path.join(ROOT, "fetcher/config.example.env"), "utf8"), /^AH_MODE=dry-run$/m);
  const deploy = fs.readFileSync(path.join(ROOT, "fetcher/deploy.mjs"), "utf8");
  for (const f of ["fetcher/fetch.mjs", "fetcher/ah_import.mjs"]) assert.ok(deploy.includes(`["${f}", "${f}"]`), `${f} is deployed`);
  // The PC-side tools stay on the PC.
  for (const f of ["fetcher/ah-login.mjs", "fetcher/ah-seed.mjs"]) assert.ok(!deploy.includes(`["${f}"`), `${f} is not deployed`);
});
