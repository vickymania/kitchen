// Action receipts: made-up receipts in the shape of the site's ReceiptList and
// ReceiptDetails answers (no real receipt), the line rules (two lines of one
// product, a non-grocery line kept off the pantry, excluded out), the server
// run through the real worker, the cookie-session client (headers, rotation,
// refresh, a lost session, PersistedQueryNotFound, paging, an empty history),
// the login's file handling, and run.sh. No network, no personal data.
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
import { readSent, vocabulary, OTHER_PEOPLE_CITIES } from "../tools/import_ah.mjs";
import {
  actionKind, actionDay, buildActionOps, initState, normaliseActionReceipt, runReceipts, splitActionName, TITLES_FILE,
} from "../fetcher/action_import.mjs";
import { ActionAuthError, ActionQueryError, QUERIES, createActionClient, receiptFields } from "../fetcher/action_client.mjs";
import { actionSession, checkActionSession, isActionLogin } from "../fetcher/action-login.mjs";
import { applySetCookies, cookieHeader, parseSetCookie } from "../fetcher/cookie_session.mjs";
import { describeSession, finishSessionLogin } from "../fetcher/browser_login.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "groceries.localhost:8787";
const ORIGIN = `http://${HOST}`;
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `kitchen-test-${name}-`));
const Cap = (s) => s[0].toUpperCase() + s.slice(1);

// ------------------------------------------------------------ made-up receipts

const line = (code, description, price, quantity = 1) => ({
  code, description, quantity, totalPriceFormat: `€ ${price.toFixed(2).replace(".", ",")}`,
  price: { adjustedSalesPrice: price / quantity, regularSalesPrice: price / quantity },
});
/** A made-up receipt in the ReceiptDetails shape, with the fields the client must drop. */
function receipt(id, dateTime, town, products, total) {
  return {
    id, receiptNumber: "0000", dateTime, dateTimeFormat: "x",
    store: { id: "9999", name: town, address: `Teststraat 1,1234 AB  ${town.toUpperCase()},NEDERLAND` },
    price: { total, subTotal: total, employeeDiscount: 0, otherDiscounts: 0, currency: "EUR" },
    totalQuantity: products.length, products,
    barcode: "BARCODE-MADE-UP", qrCode: "QR-MADE-UP", barcodeBase64Svg: "PHN2Zz4=", paymentMethods: [{ type: "card" }], membershipId: "****0000", warrantyYears: 2,
  };
}
const A1 = receipt("100_20261030120000_1_9999", "2026-10-30T12:00:00", "Utrecht", [
  line("1000001", "toblerone 100g melkchocolade", 1.99),
  line("1000001", "toblerone 100g melkchocolade", 1.99),
  line("1000002", "axe douchegel 250ml fresh", 2.49),
  line("1000003", "slimme stekker wifi 2-pack", 12.99),
  line("1000004", "led lamp e27 9w warm wit", 1.79),
  line("1000005", "glazen snijplank 30x20cm", 3.49),
  line("1000006", "groenhof spruiten 500g", 0.99),
  line("1000007", "allesreiniger citroen 1l", 0.89),
], 26.62);
const A2 = receipt("100_20261102180000_1_9999", "2026-11-02T18:00:00", "Utrecht", [line("1000001", "toblerone 100g melkchocolade", 1.99)], 1.99);
const A3 = receipt("100_20261101100000_1_8888", "2026-11-01T10:00:00", Cap(OTHER_PEOPLE_CITIES[0]), [line("1000099", "haribo goudberen 200g", 1.09)], 1.09);
const ACCOUNT = [A1, A2, A3];

test("lines: two lines of one product stay two; a smart plug, a lamp and a cutting board stay on the receipt only; excluded out", () => {
  const r = normaliseActionReceipt(receiptFields(A1));
  assert.equal(r.day, "2026-10-30");
  assert.equal(r.city, "Utrecht");
  assert.equal(r.total_cents, 2662);
  const products = r.lines.filter((l) => l.kind === "product");
  assert.deepEqual(products.map((l) => [l.code, l.productKind, l.price_cents]), [
    ["1000001", "snack", 199], ["1000001", "snack", 199], ["1000002", "personal_care", 249], ["1000007", "household", 89],
  ]);
  assert.deepEqual(r.lines.filter((l) => l.kind === "other").map((l) => l.receiptName), ["slimme stekker wifi 2-pack", "led lamp e27 9w warm wit", "glazen snijplank 30x20cm"]);
  assert.equal(r.dropped.excluded, 1);
  assert.ok(!JSON.stringify(r).toLowerCase().includes("groenhof"), "an excluded line is not even on the receipt");
});

test("names and kinds: brand first and size out of the till line; tools and electronics are no consumable", () => {
  assert.deepEqual(splitActionName("toblerone 340g melkchocolade"), { brand: "Toblerone", bare: "Melkchocolade", size: "340 g" });
  assert.deepEqual(splitActionName("axe douchegel 400ml excite"), { brand: "Axe", bare: "Douchegel excite", size: "400 ml" });
  assert.deepEqual(splitActionName("theelichtjes 4x50 st").bare.length > 0, true);
  for (const n of ["led strip 5m rgb", "koekenpan 28cm", "smart plug", "led kaars 3-pack", "usb kabel 1m"]) assert.equal(actionKind(n), null, n);
  for (const [n, k] of [["haribo goudberen 200g", "snack"], ["dove douchegel 250ml", "personal_care"], ["wc blokjes lavendel", "household"], ["kattenvoer zalm 12x85g", "pet"]]) assert.equal(actionKind(n), k, n);
  assert.equal(actionKind("vaas glas 20cm"), null, "decor");
  assert.equal(actionDay("2026-11-03T23:30:00"), "2026-11-03", "a local time without a zone keeps its own day");
});

test("client keeps only what the import reads: no barcode, QR code, payment or membership", () => {
  const kept = JSON.stringify(receiptFields(A1));
  for (const s of ["BARCODE", "QR-MADE-UP", "PHN2Zz4", "card", "****", "warranty"]) assert.ok(!kept.includes(s), s);
});

test("ops: store Action, never a product, purchase or pantry row for a non-grocery line, all within the importer's rights", () => {
  const vocab = vocabulary(["Chocolade", "Douchegel", "Allesreiniger"]);
  const r1 = normaliseActionReceipt(receiptFields(A1));
  const r2 = normaliseActionReceipt(receiptFields(A2));
  const { ops } = buildActionOps([r1, r2], vocab, { pantrySince: "2026-10-25" });
  assert.ok(ops.every(importerMayApply));
  assert.ok(ops.filter((o) => o.store).every((o) => o.store === "Action"));
  const purchases = ops.filter((o) => o.type === "purchase.add");
  assert.equal(purchases.length, 5, "2 + 1 Toblerone, the shower gel, the cleaner");
  assert.equal(new Set(purchases.map((p) => p.id)).size, 5, "two lines of one product are two purchases");
  assert.ok(!JSON.stringify(ops.filter((o) => o.type !== "receipt.save")).match(/stekker|led lamp|snijplank/), "no product, purchase or pantry for them");
  const saved = ops.find((o) => o.type === "receipt.save" && o.id.startsWith("action-100_20261030"));
  assert.deepEqual(saved.lines.filter((l) => l.kind === "other").length, 3, "they stay on the receipt");
  assert.equal(saved.lines.reduce((s, l) => s + (l.price_cents ?? 0), 0), 2662 - 99, "the receipt's lines add up (less the excluded one)");
  assert.deepEqual(ops.filter((o) => o.type === "product.put").map((o) => o.product.kind).sort(), ["household", "personal_care", "snack"]);
  assert.ok(ops.filter((o) => o.type === "product.put").every((o) => o.id.startsWith("action-product-")));
  assert.deepEqual(ops.filter((o) => o.type === "preference.set").map((o) => o.product_id), ["action-product-1000001"], "only the chocolate is on 2 receipts");
});

// ---------------------------------------------------------- the server run

function call(env, method, p, { body, cookie } = {}) {
  const headers = { Origin: ORIGIN };
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`${ORIGIN}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
async function setup() {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const thomas = tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456", label: "phone" } }));
  const code = await (await call(env, "POST", "/api/codes", { cookie: thomas, body: { for: "importer" } })).json();
  const importer = tokenOf(await call(env, "POST", "/api/pair", { body: { code: code.code, label: "Thuisserver AH" } }));
  return { env, thomas, importer };
}
const sync = async (env, thomas) => (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();

function fakeAction(account = ACCOUNT) {
  const calls = { list: 0, details: [] };
  return {
    calls,
    async listReceipts() { calls.list++; return account.map((r) => ({ id: r.id, dateTime: r.dateTime, total: r.price.total })).reverse(); },
    async getReceipt(id) { calls.details.push(id); return receiptFields(account.find((r) => r.id === id)); },
  };
}
function state() {
  const dir = tmp("actionstate");
  const ah = tmp("ahstate");
  fs.writeFileSync(path.join(ah, TITLES_FILE), JSON.stringify(["Chocolade", "Douchegel"]));
  initState({ stateDir: dir, origin: ORIGIN, titlesFrom: path.join(ah, TITLES_FILE) });
  fs.rmSync(ah, { recursive: true, force: true });
  return dir;
}

test("server run: dry-run sends nothing; push sends Thomas's receipts once, Noor's never; no pantry row for a lamp", async () => {
  const { env, thomas, importer } = await setup();
  const dir = state();
  const post = (url, init) => worker.fetch(new Request(url, init), env);
  const lines = [];
  const opts = { stateDir: dir, origin: ORIGIN, post, token: importer, today: "2026-11-03", log: (...a) => lines.push(a.join(" ")) };
  try {
    assert.deepEqual(await runReceipts("dry-run", { ...opts, api: fakeAction() }), { sent: 0, newReceipts: 2 });
    assert.match(fs.readFileSync(path.join(dir, "preview.txt"), "utf8"), /slimme stekker wifi/);
    assert.ok(lines.some((l) => /3 on the account, 2 own, 1 someone else's/.test(l)), lines.join("\n"));
    assert.equal((await sync(env, thomas)).receipts.length, 0);

    const again = fakeAction();
    assert.equal((await runReceipts("push", { ...opts, api: again })).newReceipts, 2);
    assert.deepEqual(again.calls.details, [], "a cached receipt is never fetched again");
    assert.equal(readSent(dir, ORIGIN).size, 2);
    const all = await sync(env, thomas);
    assert.equal(all.receipts.length, 2);
    assert.ok(all.receipts.every((r) => r.store === "Action" && r.id.startsWith("action-")));
    assert.ok(!JSON.stringify(all).toLowerCase().includes("goudberen"), "nothing of Noor's receipt");
    assert.ok(!JSON.stringify(all).toLowerCase().includes("groenhof"));
    assert.ok(!JSON.stringify(all.products).match(/stekker|lamp|snijplank/i), "no product for a non-grocery line");
    assert.ok(!JSON.stringify(all.pantry).match(/stekker|lamp|snijplank/i), "nor a pantry row");
    assert.ok(all.pantry.length >= 1, "the chocolate of a day ago is in the pantry");
    assert.ok(fs.readFileSync(path.join(dir, "new-purchases.txt"), "utf8").startsWith("Action: "));

    const n = (await sync(env, thomas)).purchases.length;
    assert.deepEqual(await runReceipts("push", { ...opts, api: fakeAction() }), { sent: 0, newReceipts: 0 });
    assert.equal((await sync(env, thomas)).purchases.length, n, "twice is once");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("server run: an empty history is fine; refuses without init", async () => {
  const dir = state();
  try {
    assert.deepEqual(await runReceipts("push", { stateDir: dir, origin: ORIGIN, api: fakeAction([]), token: "x".repeat(30), log: () => {} }), { sent: 0, newReceipts: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const empty = tmp("actionempty");
  try {
    await assert.rejects(runReceipts("push", { stateDir: empty, origin: ORIGIN, api: fakeAction(), log: () => {} }), /action_import.mjs init/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- the client

const SESSION = { cookies: [
  { name: "sess", value: "s-0", domain: "www.action.com", path: "/", expires: -1, secure: true, httpOnly: true },
  { name: "__cf_bm", value: "cf-0", domain: ".action.com", path: "/", expires: -1, secure: true, httpOnly: true },
  { name: "other", value: "o", domain: ".example.com", path: "/", expires: -1 },
], userAgent: "TestBrowser/1.0" };

test("cookies: header per host and path, Set-Cookie replaces, Max-Age 0 removes", () => {
  assert.equal(cookieHeader(SESSION.cookies, "https://www.action.com/api/graphql"), "sess=s-0; __cf_bm=cf-0");
  const c = parseSetCookie("sess=s-1; Path=/; Max-Age=3600; HttpOnly; Secure", "https://www.action.com/api/auth/refresh", 0);
  assert.deepEqual([c.name, c.value, c.expires, c.httpOnly], ["sess", "s-1", 3600, true]);
  const { cookies, changed } = applySetCookies(SESSION.cookies, ["sess=s-1; Path=/", "__cf_bm=x; Domain=action.com; Max-Age=0"], "https://www.action.com/x");
  assert.ok(changed);
  assert.equal(cookieHeader(cookies, "https://www.action.com/"), "sess=s-1");
  assert.equal(applySetCookies(cookies, ["sess=s-1; Path=/"], "https://www.action.com/x").changed, false);
});

const page = (receipts, hasNext, offset) => Response.json({ data: { receiptList: { receipts, hasNext, offset } } });
const summary = (r) => ({ id: r.id, dateTime: r.dateTime, price: { currency: "EUR", total: r.price.total } });

test("client: headers, cookies, paging by offset; a 401 refreshes once and rotated cookies go back to the file (600)", async () => {
  const dir = tmp("actionclient");
  const file = path.join(dir, "action-session.json");
  fs.writeFileSync(file, JSON.stringify(SESSION));
  const seen = [];
  let valid = "s-0";
  const fetch = async (url, init) => {
    const u = new URL(url);
    seen.push({ path: u.pathname, op: u.searchParams.get("operationName"), vars: u.searchParams.get("variables"), init });
    if (u.pathname === "/api/auth/refresh") {
      valid = "s-1";
      return new Response("{}", { status: 200, headers: [["set-cookie", "sess=s-1; Path=/; HttpOnly; Secure"]] });
    }
    assert.equal(init.headers["apollographql-client-name"], "web");
    assert.equal(init.headers["x-apollo-operation-name"], u.searchParams.get("operationName"));
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.equal(init.headers["User-Agent"], "TestBrowser/1.0");
    assert.equal(JSON.parse(u.searchParams.get("extensions")).persistedQuery.sha256Hash, QUERIES[u.searchParams.get("operationName")]);
    if (!init.headers.Cookie.includes(`sess=${valid}`) || valid === "s-0") return new Response("{}", { status: 401 });
    const vars = JSON.parse(u.searchParams.get("variables"));
    if (u.searchParams.get("operationName") === "ReceiptDetails") return Response.json({ data: { receipt: A1 } });
    return vars.offset === undefined ? page([summary(A2)], true, 14) : page([summary(A1)], false, null);
  };
  try {
    const client = createActionClient({ sessionFile: file, fetch, pause: 0 });
    assert.deepEqual((await client.listReceipts()).map((r) => r.id), [A2.id, A1.id]);
    assert.equal(seen.filter((s) => s.path === "/api/auth/refresh").length, 1, "one refresh");
    assert.deepEqual(seen.filter((s) => s.op === "ReceiptList").map((s) => JSON.parse(s.vars)), [{ limit: 14 }, { limit: 14 }, { limit: 14, offset: 14 }]);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(saved.cookies.find((c) => c.name === "sess").value, "s-1");
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ["action-session.json"], "no temporary file left");
    const one = await client.getReceipt(A1.id);
    assert.equal(one.barcode, undefined);
    // Stops at the first page it already knows.
    seen.length = 0;
    await client.listReceipts({ known: new Set([A2.id]) });
    assert.equal(seen.filter((s) => s.op === "ReceiptList").length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("client: a lost session says to log in again; PersistedQueryNotFound is never guessed around; Cloudflare is named; an empty list is fine", async () => {
  const dir = tmp("actionclient2");
  const file = path.join(dir, "action-session.json");
  fs.writeFileSync(file, JSON.stringify(SESSION));
  try {
    const gone = createActionClient({ sessionFile: file, pause: 0, fetch: async (url) => new Response(JSON.stringify({ secret: "s-0" }), { status: 401 }) });
    await assert.rejects(gone.listReceipts(), (e) => e instanceof ActionAuthError && /action-login\.mjs/.test(e.message) && !e.message.includes("s-0"));
    let n = 0;
    const changed = createActionClient({ sessionFile: file, pause: 0, fetch: async () => { n++; return Response.json({ errors: [{ message: "PersistedQueryNotFound", extensions: { code: "PERSISTED_QUERY_NOT_FOUND" } }] }); } });
    await assert.rejects(changed.listReceipts(), (e) => e instanceof ActionQueryError && /PersistedQueryNotFound/.test(e.message));
    assert.equal(n, 1, "no second try with a guessed query");
    const cf = createActionClient({ sessionFile: file, pause: 0, fetch: async () => new Response("<title>Just a moment...</title>", { status: 403, headers: { "cf-mitigated": "challenge" } }) });
    await assert.rejects(cf.listReceipts(), /Cloudflare/);
    const none = createActionClient({ sessionFile: file, pause: 0, fetch: async () => page([], false, null) });
    assert.deepEqual(await none.listReceipts(), []);
    fs.rmSync(file);
    await assert.rejects(none.listReceipts(), /no session in .*action-login\.mjs/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------- the login

test("login: the site's own login answer ends the wait; only action.com cookies go along, via a temporary file that is always deleted", async () => {
  assert.ok(isActionLogin({ url: "https://www.action.com/api/auth/login", status: 200 }));
  assert.ok(!isActionLogin({ url: "https://www.action.com/api/auth/login", status: 401 }));
  assert.ok(!isActionLogin({ url: "https://evil.example/api/auth/login", status: 200 }));
  const session = actionSession([...SESSION.cookies, { name: "x", value: "y", domain: "www.notaction.com" }], "UA");
  assert.deepEqual(session.cookies.map((c) => c.name), ["sess", "__cf_bm"]);
  const named = describeSession(session);
  assert.match(named, /cookies \(2\): __cf_bm, sess/);
  assert.ok(!named.includes("s-0") && !named.includes("cf-0"), "never a value");

  const root = tmp("actionlogin");
  try {
    let at = null;
    const out = await finishSessionLogin({
      session, tmpRoot: root, name: "action-session.json",
      check: (file) => checkActionSession(file, { fetch: async () => page([summary(A2)], false, null) }),
      upload: (file) => { at = file; if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600); return "saved"; },
    });
    assert.deepEqual(out, { checked: "the session works: 1 receipt on the first page", uploaded: "saved" });
    assert.equal(fs.existsSync(at), false);
    assert.deepEqual(fs.readdirSync(root), []);
    await assert.rejects(finishSessionLogin({ session: { cookies: [] }, tmpRoot: root, upload: () => assert.fail("no upload") }), /nothing was copied/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------- run.sh, deploy

test("run.sh: Action runs after Lidl, ACTION_MODE defaults to dry-run, the server files are deployed, the login is not", () => {
  const sh = fs.readFileSync(path.join(ROOT, "fetcher/run.sh"), "utf8");
  assert.ok(sh.indexOf("fetcher/action_import.mjs") > sh.indexOf("fetcher/lidl_import.mjs"));
  assert.match(sh, /case "\$ACTION_MODE" in push\|dry-run\) ;; \*\) ACTION_MODE=dry-run ;; esac/);
  assert.match(sh, /action exit \$\?/);
  assert.match(fs.readFileSync(path.join(ROOT, "fetcher/config.example.env"), "utf8"), /^ACTION_MODE=dry-run$/m);
  const deploy = fs.readFileSync(path.join(ROOT, "fetcher/deploy.mjs"), "utf8");
  for (const f of ["fetcher/action_import.mjs", "fetcher/action_client.mjs", "fetcher/cookie_session.mjs"]) assert.ok(deploy.includes(`["${f}", "${f}"]`), `${f} is deployed`);
  for (const f of ["fetcher/action-login.mjs", "fetcher/browser_login.mjs"]) assert.ok(!deploy.includes(`["${f}"`), `${f} stays on the PC`);
  assert.ok(deploy.includes('"action-session.json"'), "its mode is kept at 600");
  assert.match(fs.readFileSync(path.join(ROOT, "fetcher/review.mjs"), "utf8"), /"action-state"/, "the nightly check reads its new purchases");
});
