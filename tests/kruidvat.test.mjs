// Kruidvat store purchases: made-up orders in the shape of the OCC
// users/current/orders/offline answer (no real order), the multibuy price
// rule, durable goods and other sections kept off the pantry, excluded out,
// the server run through the real worker, the session client (bearer +
// cookies, refresh with the site's client, Akamai named, a lost session),
// the login's session shape, and run.sh. No network, no personal data.
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
  buildKruidvatOps, initState, kruidvatDay, kruidvatKind, linePrices, normaliseKruidvatOrder, runReceipts, splitKruidvatName, TITLES_FILE,
} from "../fetcher/kruidvat_import.mjs";
import { KruidvatAuthError, KruidvatBlockedError, PURCHASES_URL, checkKruidvatSession, createKruidvatClient, orderFields } from "../fetcher/kruidvat_client.mjs";
import { isKruidvatLogin, kruidvatSession, tokenFrom } from "../fetcher/kruidvat-login.mjs";
import { describeSession } from "../fetcher/browser_login.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "http://groceries.localhost:8787";
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `kitchen-test-${name}-`));
const Cap = (s) => s[0].toUpperCase() + s.slice(1);

// ------------------------------------------------------------- made-up orders

const entry = (n, code, name, brand, url, quantity, base) => ({
  entryNumber: n, quantity, basePriceWithDiscount: { value: base, formattedValue: "x" },
  product: { code, name, masterBrand: { name: brand }, priceAtPurchase: String(base), price: { value: base }, productCategory: { name: "c", url }, images: [{ url: "/medias/x.jpg" }], ageRestricted: false },
});
/** A made-up order in the offline-orders shape, with fields the client must drop. */
function order(code, placed, town, entries, total) {
  return {
    code, placed, total: { value: total, currencyIso: "EUR" }, amountToPay: { value: total, currencyIso: "EUR" },
    totalUnitCount: entries.reduce((s, e) => s + e.quantity, 0), loyaltyPointsEarned: 12,
    formattedStoreAddress: `Teststraat 1 1234AB, ${town}`,
    deliveryAddress: { firstName: "DROGISTERIJ KRUIDVAT 0000", line1: "Teststraat 1", postalCode: "1234AB", town },
    entries,
  };
}
// Two multibuy lines (quantity 2, base = the line total), a trimmer, a photo print, an excluded line.
const K1 = order("100000000000000000000000000001", "2026-10-31T10:15:00+0100", "Utrecht", [
  entry(1, "2000001", "Andrelon Shampoo Classic 300ml", "Andrelon", "/verzorging/haarverzorging/shampoo", 2, 5.0),
  entry(2, "2000002", "Kruidvat Wc-blokjes Lavendel", "Kruidvat", "/huishouden/toilet/wc-blokjes", 1, 1.99),
  entry(3, "2000003", "Philips Neustrimmer NT1650", "Philips", "/verzorging/scheren-en-ontharen/trimmers/neustrimmer", 1, 14.99),
  entry(4, "2000004", "Fotoafdruk 10x15", "Kruidvat", "/foto/afdrukken", 1, 0.29),
  entry(5, "2000005", "Groenhof Spruitenchips", "Groenhof", "/eten-en-drinken/chips", 1, 1.49),
  entry(6, "2000006", "Haribo Goudberen 200g", "Haribo", "/eten-en-drinken/snoep/winegums", 2, 3.0),
], 26.76);
const K2 = order("100000000000000000000000000002", "2026-11-02T18:00:00+0100", "Utrecht", [
  entry(1, "2000001", "Andrelon Shampoo Classic 300ml", "Andrelon", "/verzorging/haarverzorging/shampoo", 1, 3.49),
], 3.49);
const K3 = order("100000000000000000000000000003", "2026-11-01T09:00:00+0100", Cap(OTHER_PEOPLE_CITIES[0]), [
  entry(1, "2000099", "Dove Deodorant Spray", "Dove", "/verzorging/deodorant", 1, 2.99),
], 2.99);
const ACCOUNT = [K1, K2, K3];

test("prices: multibuy bases are line totals when they add up to the total; base x quantity when that does; else said", () => {
  assert.deepEqual(linePrices(orderFields(K1)), { cents: [500, 199, 1499, 29, 149, 300], how: "line" });
  const unit = order("u", "2026-11-01T09:00:00+0100", "Utrecht", [entry(1, "1", "A", "", "/verzorging/x", 2, 1.5), entry(2, "2", "B", "", "/verzorging/x", 1, 2)], 5);
  assert.deepEqual(linePrices(orderFields(unit)), { cents: [300, 200], how: "unit" });
  const odd = order("o", "2026-11-01T09:00:00+0100", "Utrecht", [entry(1, "1", "A", "", "/verzorging/x", 1, 1)], 9);
  assert.equal(linePrices(orderFields(odd)).mismatch, -800);
  assert.match(normaliseKruidvatOrder(orderFields(odd)).note, /taken as line totals/);
});

test("lines: care and household are products; the trimmer and the photo print stay on the receipt; excluded out; the day from placed", () => {
  const r = normaliseKruidvatOrder(orderFields(K1));
  assert.equal(r.day, "2026-10-31");
  assert.equal(r.city, "Utrecht");
  assert.equal(r.total_cents, 2676);
  assert.deepEqual(r.lines.filter((l) => l.kind === "product").map((l) => [l.code, l.productKind, l.qty, l.price_cents]), [
    ["2000001", "personal_care", 2, 500], ["2000002", "household", 1, 199], ["2000006", "snack", 2, 300],
  ]);
  assert.deepEqual(r.lines.filter((l) => l.kind === "other").map((l) => l.receiptName), ["Philips Neustrimmer NT1650", "Fotoafdruk 10x15"]);
  assert.equal(r.dropped.excluded, 1);
  assert.ok(!JSON.stringify(r).toLowerCase().includes("groenhof"));
  assert.equal(kruidvatDay("2026-11-03T23:30:00+0100"), "2026-11-03");
  assert.equal(kruidvatDay("2026-11-03T23:30:00+0000"), "2026-11-04", "past midnight in Amsterdam");
  assert.deepEqual(splitKruidvatName("King C. Gillette Baardolie 30ml", "King C"), { brand: "King C", bare: "Gillette Baardolie", size: "30 ml" });
  assert.equal(kruidvatKind({ name: "Remington Haardroger", categoryUrl: "/verzorging/haar/haardrogers" }), null);
  assert.equal(kruidvatKind({ name: "Opzetborstels 4 stuks", categoryUrl: "/verzorging/mondverzorging/opzetborstels" }), "personal_care");
  assert.equal(kruidvatKind({ name: "Knuffelbeer", categoryUrl: "/speelgoed/knuffels" }), null);
});

test("client keeps only what the import reads: no points, images, the shop's name or street", () => {
  const kept = JSON.stringify(orderFields(K1));
  for (const s of ["loyalty", "medias", "DROGISTERIJ", "Teststraat", "1234AB", "ageRestricted"]) assert.ok(!kept.includes(s), s);
});

test("ops: store Kruidvat, never a product, purchase or pantry row for the trimmer, all within the importer's rights", () => {
  const vocab = vocabulary(["Shampoo", "Wc blokjes"]);
  const { ops } = buildKruidvatOps([normaliseKruidvatOrder(orderFields(K1)), normaliseKruidvatOrder(orderFields(K2))], vocab, { pantrySince: "2026-10-25" });
  assert.ok(ops.every(importerMayApply));
  assert.ok(ops.filter((o) => o.store).every((o) => o.store === "Kruidvat"));
  assert.ok(!JSON.stringify(ops.filter((o) => o.type !== "receipt.save")).match(/trimmer|fotoafdruk/i));
  assert.ok(ops.filter((o) => o.type === "product.put").every((o) => o.id.startsWith("kruidvat-product-")));
  assert.deepEqual(ops.filter((o) => o.type === "preference.set").map((o) => o.product_id), ["kruidvat-product-2000001"], "the shampoo is on 2 receipts");
  const saved = ops.find((o) => o.type === "receipt.save" && o.id === "kruidvat-100000000000000000000000000001");
  assert.equal(saved.lines.reduce((s, l) => s + (l.price_cents ?? 0), 0), 2676 - 149, "the lines add up (less the excluded one)");
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
  return { env, thomas, importer: tokenOf(await call(env, "POST", "/api/pair", { body: { code: code.code, label: "Thuisserver AH" } })) };
}
const sync = async (env, thomas) => (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();
const fakeKruidvat = (account = ACCOUNT) => ({ async listPurchases() { return account.map(orderFields); } });
function state() {
  const dir = tmp("kvstate");
  const ah = tmp("ahstate");
  fs.writeFileSync(path.join(ah, TITLES_FILE), JSON.stringify(["Shampoo"]));
  initState({ stateDir: dir, origin: ORIGIN, titlesFrom: path.join(ah, TITLES_FILE) });
  fs.rmSync(ah, { recursive: true, force: true });
  return dir;
}

test("server run: dry-run sends nothing; push sends Thomas's purchases once, Noor's never; an empty window is fine", async () => {
  const { env, thomas, importer } = await setup();
  const dir = state();
  const post = (url, init) => worker.fetch(new Request(url, init), env);
  const lines = [];
  const opts = { stateDir: dir, origin: ORIGIN, post, token: importer, today: "2026-11-03", log: (...a) => lines.push(a.join(" ")) };
  try {
    assert.deepEqual(await runReceipts("dry-run", { ...opts, api: fakeKruidvat() }), { sent: 0, newReceipts: 2 });
    assert.match(fs.readFileSync(path.join(dir, "preview.txt"), "utf8"), /Neustrimmer/);
    assert.ok(lines.some((l) => /3 on the account, 2 own, 1 someone else's/.test(l)), lines.join("\n"));
    assert.equal((await sync(env, thomas)).receipts.length, 0);

    assert.equal((await runReceipts("push", { ...opts, api: fakeKruidvat() })).newReceipts, 2);
    assert.equal(readSent(dir, ORIGIN).size, 2);
    const all = await sync(env, thomas);
    assert.deepEqual(all.receipts.map((r) => r.store), ["Kruidvat", "Kruidvat"]);
    assert.ok(!JSON.stringify(all).includes("Deodorant"), "nothing of Noor's purchase");
    assert.ok(!JSON.stringify(all.products).match(/trimmer|fotoafdruk/i));
    assert.ok(!JSON.stringify(all.pantry).match(/trimmer|fotoafdruk/i));
    assert.ok(all.pantry.length >= 1);

    // Out of Kruidvat's 90 days: the cache keeps them, nothing is sent twice.
    const n = (await sync(env, thomas)).purchases.length;
    assert.deepEqual(await runReceipts("push", { ...opts, api: fakeKruidvat([]) }), { sent: 0, newReceipts: 0 });
    assert.equal((await sync(env, thomas)).purchases.length, n);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- the client

const SESSION = {
  cookies: [{ name: "JSESSIONID", value: "c-0", domain: ".kruidvat.nl", path: "/", expires: -1, secure: true, httpOnly: true }],
  token: { accessToken: "a-0", refreshToken: "r-0", expiresAt: null, tokenType: "bearer" },
  oauth: { clientId: "client-x", clientSecret: "", tokenUrl: null },
  userAgent: "TestBrowser/1.0",
};

test("client: bearer and cookies on the purchases call; a 401 refreshes with the site's client and the new token is saved (600)", async () => {
  const dir = tmp("kvclient");
  const file = path.join(dir, "kruidvat-session.json");
  fs.writeFileSync(file, JSON.stringify(SESSION));
  const seen = [];
  let valid = "a-1";
  const fetch = async (url, init) => {
    seen.push({ url, init });
    if (url.includes("/oauth/token")) {
      const b = new URLSearchParams(init.body);
      assert.deepEqual([b.get("grant_type"), b.get("refresh_token"), b.get("client_id")], ["refresh_token", "r-0", "client-x"]);
      return Response.json({ access_token: "a-1", refresh_token: "r-1", expires_in: 3600 }, { headers: [["set-cookie", "JSESSIONID=c-1; Domain=kruidvat.nl; Path=/; Secure"]] });
    }
    assert.equal(url, PURCHASES_URL);
    assert.match(init.headers.Cookie, /JSESSIONID=c-/);
    assert.equal(init.headers["User-Agent"], "TestBrowser/1.0");
    if (init.headers.Authorization !== `Bearer ${valid}`) return new Response("{}", { status: 401 });
    return Response.json({ orders: [K2] });
  };
  try {
    const list = await createKruidvatClient({ sessionFile: file, fetch }).listPurchases();
    assert.deepEqual(list.map((o) => o.code), [K2.code]);
    assert.equal(seen.filter((s) => s.url.includes("/oauth/token")).length, 1);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual([saved.token.accessToken, saved.token.refreshToken, saved.cookies[0].value], ["a-1", "r-1", "c-1"]);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ["kruidvat-session.json"]);
    assert.equal(await checkKruidvatSession(file, { fetch }), "the session works: 1 store purchase in the last 90 days");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("client: Akamai's 403 is named and stops; a lost session says to log in again; another answer shape throws", async () => {
  const dir = tmp("kvclient2");
  const file = path.join(dir, "kruidvat-session.json");
  fs.writeFileSync(file, JSON.stringify(SESSION));
  try {
    let n = 0;
    const akamai = createKruidvatClient({ sessionFile: file, fetch: async () => { n++; return new Response("<H1>Access Denied</H1> Reference #18.x", { status: 403, headers: { server: "AkamaiGHost" } }); } });
    await assert.rejects(akamai.listPurchases(), (e) => e instanceof KruidvatBlockedError && /Akamai/.test(e.message));
    assert.equal(n, 1, "never worked around");
    const gone = createKruidvatClient({ sessionFile: file, fetch: async (url) => new Response(JSON.stringify({ secret: "a-0" }), { status: url.includes("/oauth/token") ? 400 : 401 }) });
    await assert.rejects(gone.listPurchases(), (e) => e instanceof KruidvatAuthError && /kruidvat-login\.mjs/.test(e.message) && !e.message.includes("a-0"));
    fs.writeFileSync(file, JSON.stringify({ ...SESSION, oauth: null }));
    const noClient = createKruidvatClient({ sessionFile: file, fetch: async () => new Response("{}", { status: 401 }) });
    await assert.rejects(noClient.listPurchases(), /no way to refresh it/);
    const odd = createKruidvatClient({ sessionFile: file, fetch: async () => Response.json({ results: [] }) });
    await assert.rejects(odd.listPurchases(), /no orders/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------- the login

test("login: Spartacus' stored token read into the session; names only in --dry; only kruidvat.nl cookies", () => {
  const raw = JSON.stringify({ token: { access_token: "a", refresh_token: "r", expires_in: 3600, access_token_stored_at: 1000, token_type: "bearer" }, userId: "current" });
  assert.deepEqual(tokenFrom(raw), { accessToken: "a", refreshToken: "r", expiresAt: 1000 + 3600_000, tokenType: "bearer" });
  assert.equal(tokenFrom("not json"), null);
  assert.equal(tokenFrom(JSON.stringify({ token: {} })), null);
  const s = kruidvatSession({ cookies: [{ name: "JSESSIONID", value: "v", domain: ".kruidvat.nl" }, { name: "t", value: "v", domain: ".tracker.example" }], authRaw: raw, oauth: { clientId: "c" }, userAgent: "UA", tokenUrl: "https://api.kruidvat.nl/authorizationserver/oauth/token" });
  assert.deepEqual(s.cookies.map((c) => c.name), ["JSESSIONID"]);
  assert.equal(s.oauth.tokenUrl, "https://api.kruidvat.nl/authorizationserver/oauth/token");
  const named = describeSession(s);
  assert.match(named, /token fields: accessToken, expiresAt, refreshToken, tokenType/);
  assert.match(named, /OAuth client for refresh: found/);
  assert.ok(!/\bv\b|"a"|"r"/.test(named), "never a value");
  assert.ok(isKruidvatLogin({ url: "https://api.kruidvat.nl/authorizationserver/oauth/token", status: 200 }));
  assert.ok(!isKruidvatLogin({ url: "https://evil.example/authorizationserver/oauth/token", status: 200 }));
});

// ---------------------------------------------------------- run.sh, deploy

test("run.sh: Kruidvat runs after Action, KRUIDVAT_MODE defaults to dry-run, the server files are deployed, the login is not", () => {
  const sh = fs.readFileSync(path.join(ROOT, "fetcher/run.sh"), "utf8");
  assert.ok(sh.indexOf("fetcher/kruidvat_import.mjs") > sh.indexOf("fetcher/action_import.mjs"));
  assert.match(sh, /case "\$KRUIDVAT_MODE" in push\|dry-run\) ;; \*\) KRUIDVAT_MODE=dry-run ;; esac/);
  assert.match(sh, /kruidvat exit \$\?/);
  assert.match(fs.readFileSync(path.join(ROOT, "fetcher/config.example.env"), "utf8"), /^KRUIDVAT_MODE=dry-run$/m);
  const deploy = fs.readFileSync(path.join(ROOT, "fetcher/deploy.mjs"), "utf8");
  for (const f of ["fetcher/kruidvat_import.mjs", "fetcher/kruidvat_client.mjs", "fetcher/receipt_run.mjs", "fetcher/cookie_session.mjs"]) assert.ok(deploy.includes(`["${f}", "${f}"]`), `${f} is deployed`);
  assert.ok(!deploy.includes('["fetcher/kruidvat-login.mjs"'), "the login stays on the PC");
  assert.ok(deploy.includes('"kruidvat-session.json"'));
  assert.match(fs.readFileSync(path.join(ROOT, "fetcher/review.mjs"), "utf8"), /"kruidvat-state"/);
});
