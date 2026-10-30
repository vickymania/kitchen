// A recipes-only person (30-10-2026: his father Henk gets the recipe
// book, never the groceries side). The invite link pairs his phone as
// "Henk - iPhone"; the server gives him only the recipe side and accepts only
// his stars; groceries.vexed.works refuses him. Every route is walked.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { deviceKind, guestMayApply } from "../worker/auth.js";
import { GUEST_SYNCED } from "../worker/ops-store.js";
import { OP_TYPES } from "../public/shared/ops.js";
import { GUEST_IMPORT_DAILY_LIMIT, IMPORT_DAILY_LIMIT } from "../worker/recipe-import.js";

const HOST = "recipes.localhost:8787";
const GROCERIES = "groceries.localhost:8787";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

function call(env, method, path, { body, cookie, bearer, host = HOST, origin = `http://${host}`, type, raw, ua } = {}) {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (ua) headers["User-Agent"] = ua;
  if (body !== undefined || raw !== undefined) headers["Content-Type"] = type ?? "application/json";
  return worker.fetch(new Request(`http://${host}${path}`, {
    method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  }), env);
}

const json = async (res) => ({ status: res.status, body: await res.json() });
const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);

let opCounter = 0;
const op = (o) => ({ op_id: `op-guest-${String(++opCounter).padStart(6, "0")}`, ...o });

async function household() {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const thomas = tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456", label: "test phone" } }));
  // The book, the list, the pantry, a purchase and a cook, as Thomas.
  const seed = await json(await call(env, "POST", "/api/ops", { cookie: thomas, body: { ops: [
    op({ type: "recipe.put", id: "recipe-guest-chili", recipe: { title: "Chili", servings: 4, ingredients: [{ qty: 400, unit: "g", name: "gehakt" }], steps: ["Bak het gehakt."] } }),
    op({ type: "entry.add", id: "entry-guest-0001", item_id: "item-guest-0001", title: "Melk" }),
    op({ type: "pantry.add", id: "pantry-guest-001", item_id: "item-guest-0003", title: "Gehakt", amount: 1 }),
    op({ type: "purchase.add", id: "purchase-guest-01", item_id: "item-guest-0004", source: "receipt", title: "Kaas", bought_on: "2026-10-29", store: "AH", price_cents: 399 }),
    op({ type: "recipe.cooked", id: "cook-guest-00001", recipe_id: "recipe-guest-chili", cooked_on: "2026-10-29" }),
  ] } }));
  assert.ok(seed.body.results.every((r) => r.ok), JSON.stringify(seed.body.results));
  return { env, thomas };
}

async function invite(env, thomas, name = "Henk") {
  const out = await json(await call(env, "POST", "/api/invites", { cookie: thomas, body: { name } }));
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body;
}

const tokenIn = (url) => url.match(/#\/join\/([\w-]+)$/)[1];

async function henk() {
  const h = await household();
  const link = await invite(h.env, h.thomas);
  const res = await call(h.env, "POST", "/api/pair", { body: { invite: tokenIn(link.url) }, ua: IPHONE });
  assert.equal(res.status, 200);
  return { ...h, henk: tokenOf(res), link };
}

test("invite: an admin makes a one-time link on recipes, 7 days, only its hash stored", async () => {
  const { env, thomas } = await household();
  const link = await invite(env, thomas);
  assert.match(link.url, /^http:\/\/recipes\.localhost:8787\/#\/join\/[A-Za-z0-9_-]{40,}$/);
  const days = (Date.parse(link.expires_at) - Date.now()) / 86400_000;
  assert.ok(days > 6.9 && days <= 7, `expires in ${days} days`);
  const row = await env.DB.prepare("SELECT * FROM pairing_codes WHERE kind = 'invite'").first();
  assert.equal(row.recipes_only, 1);
  assert.equal(row.new_member_name, "Henk");
  assert.notEqual(row.code_hash, tokenIn(link.url));
  assert.ok(!JSON.stringify(row).includes(tokenIn(link.url)), "the token itself is never stored");
  // Not on groceries, not without a name, not by a person who is no admin.
  assert.equal((await call(env, "POST", "/api/invites", { cookie: thomas, host: GROCERIES, body: { name: "Henk" } })).status, 403, "only on recipes");
  assert.equal((await json(await call(env, "POST", "/api/invites", { cookie: thomas, body: { name: " " } }))).status, 400);
  const code = await json(await call(env, "POST", "/api/codes", { cookie: thomas, body: { for: "new_member", name: "Sam" } }));
  const sam = tokenOf(await call(env, "POST", "/api/pair", { body: { code: code.body.code } }));
  assert.equal((await call(env, "POST", "/api/invites", { cookie: sam, body: { name: "Henk" } })).status, 403);
});

test("invite: the link pairs a recipes-only person as '<name> - iPhone', once", async () => {
  const { env, thomas, henk: token, link } = await henk();
  const me = await json(await call(env, "GET", "/api/me", { cookie: token }));
  assert.equal(me.body.member.name, "Henk");
  assert.equal(me.body.member.recipes_only, true);
  assert.equal(me.body.member.is_admin, false);
  assert.equal(me.body.other_app, null, "no way to the groceries app");
  const devices = await json(await call(env, "GET", "/api/devices", { cookie: thomas }));
  assert.ok(devices.body.devices.some((d) => d.label === "Henk - iPhone" && d.member_name === "Henk"));
  // One use only, and a used link counts as a wrong code.
  const again = await call(env, "POST", "/api/pair", { body: { invite: tokenIn(link.url) }, ua: IPHONE });
  assert.equal(again.status, 400);
  const fails = await env.DB.prepare("SELECT SUM(count) AS n FROM pairing_failures WHERE bucket LIKE 'ip:%'").first();
  assert.equal(fails.n, 1);
  // Thomas still has the whole household.
  assert.equal((await json(await call(env, "GET", "/api/me", { cookie: thomas }))).body.member.recipes_only, false);
});

test("invite: the label names the device from the user agent, or the page's hint", async () => {
  assert.equal(deviceKind(IPHONE), "iPhone");
  assert.equal(deviceKind("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)"), "iPad");
  assert.equal(deviceKind("Mozilla/5.0 (Linux; Android 14; Pixel 8)"), "Android");
  assert.equal(deviceKind(MAC), "Mac");
  assert.equal(deviceKind(MAC, "iPad"), "iPad", "an iPad's Safari says Macintosh; the page knows better");
  assert.equal(deviceKind("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "Windows");
  assert.equal(deviceKind(""), "telefoon");
  assert.equal(deviceKind("curl/8", "<script>"), "telefoon", "a hint outside the list is ignored");
  const { env, thomas } = await household();
  const link = await invite(env, thomas, "Oma");
  await call(env, "POST", "/api/pair", { body: { invite: tokenIn(link.url), device: "iPad", label: "something else" }, ua: MAC });
  const devices = await json(await call(env, "GET", "/api/devices", { cookie: thomas }));
  assert.ok(devices.body.devices.some((d) => d.label === "Oma - iPad"), "the label is the server's, not typed");
});

test("invite: an expired link pairs nothing; a link never pairs on groceries", async () => {
  const { env, thomas } = await household();
  const old = await invite(env, thomas);
  await env.DB.prepare("UPDATE pairing_codes SET expires_at = ? WHERE kind = 'invite'").bind(new Date(Date.now() - 1000).toISOString()).run();
  assert.equal((await call(env, "POST", "/api/pair", { body: { invite: tokenIn(old.url) } })).status, 400);
  const link = await invite(env, thomas);
  const there = await json(await call(env, "POST", "/api/pair", { host: GROCERIES, body: { invite: tokenIn(link.url) } }));
  assert.equal(there.status, 403);
  assert.equal(there.body.error, "recipes_only");
  assert.equal((await call(env, "POST", "/api/pair", { body: { invite: tokenIn(link.url) } })).status, 200, "still good on recipes");
});

test("invite: a new phone for the same name is the same person, so his stars stay his", async () => {
  const { env, thomas, henk: first } = await henk();
  const second = tokenOf(await call(env, "POST", "/api/pair", { body: { invite: tokenIn((await invite(env, thomas, "henk")).url) }, ua: MAC }));
  const a = await json(await call(env, "GET", "/api/me", { cookie: first }));
  const b = await json(await call(env, "GET", "/api/me", { cookie: second }));
  assert.equal(a.body.member.id, b.body.member.id);
});

test("sync: a recipes-only person pulls the book, the stars and names, nothing else", async () => {
  const { env, henk: token } = await henk();
  const full = await json(await call(env, "GET", "/api/sync?since=0", { cookie: token }));
  assert.deepEqual(Object.keys(full.body).sort(), ["full", "rev", ...GUEST_SYNCED].sort());
  assert.deepEqual(GUEST_SYNCED, ["recipes", "members", "recipe_ratings"]);
  assert.equal(full.body.recipes.length, 1);
  for (const m of full.body.members) assert.deepEqual(Object.keys(m).sort(), ["id", "name", "removed_at"]);
  // A delta and an idle poll have the same shape.
  const idle = await json(await call(env, "GET", `/api/sync?since=${full.body.rev}`, { cookie: token }));
  assert.deepEqual(Object.keys(idle.body).sort(), ["full", "rev", ...GUEST_SYNCED].sort());
  const delta = await json(await call(env, "GET", "/api/sync?since=1", { cookie: token }));
  for (const kind of ["entries", "items", "pantry", "pantry_events", "purchases", "receipts", "offers", "preferences", "products",
    "ratings", "deal_rules", "cooks", "pending_takes", "cook_prompts"]) assert.equal(delta.body[kind], undefined, kind);
});

const GUEST_TYPES = ["recipe.put", "recipe.delete", "recipe.rate"];

test("ops: a recipes-only person may give stars, nothing of the groceries side, and a mixed batch applies nothing", async () => {
  const { env, thomas, henk: token } = await henk();
  assert.deepEqual(OP_TYPES.filter((type) => guestMayApply({ type })), GUEST_TYPES);
  const rate = await json(await call(env, "POST", "/api/ops", { cookie: token, body: { ops: [
    op({ type: "recipe.rate", id: "rrate-henk-00001", recipe_id: "recipe-guest-chili", stars: 5, on: "2026-10-30" }),
  ] } }));
  assert.equal(rate.status, 200);
  assert.ok(rate.body.results[0].ok);
  const me = await json(await call(env, "GET", "/api/me", { cookie: token }));
  const row = await env.DB.prepare("SELECT member_id, stars FROM recipe_ratings WHERE id = 'rrate-henk-00001'").first();
  assert.deepEqual({ ...row }, { member_id: me.body.member.id, stars: 5 }, "his own stars");

  const pantryBefore = await env.DB.prepare("SELECT amount, taken FROM pantry WHERE id = 'pantry-guest-001'").first();
  for (const type of OP_TYPES.filter((t) => !GUEST_TYPES.includes(t))) {
    const res = await json(await call(env, "POST", "/api/ops", { cookie: token, body: { ops: [op({ type, id: "x-guest-000001", recipe_id: "recipe-guest-chili" })] } }));
    assert.equal(res.status, 403, type);
    assert.equal(res.body.error, "recipes_only", type);
  }
  const mixed = await call(env, "POST", "/api/ops", { cookie: token, body: { ops: [
    op({ type: "recipe.rate", id: "rrate-henk-00002", recipe_id: "recipe-guest-chili", stars: 1 }),
    op({ type: "entry.add", id: "entry-henk-0001", item_id: "item-henk-0001", title: "Spruitjes" }),
  ] } });
  assert.equal(mixed.status, 403);
  assert.equal(await env.DB.prepare("SELECT 1 FROM recipe_ratings WHERE id = 'rrate-henk-00002'").first(), null);
  // Cooking from the book: no cook record, no pantry take, the recipe as it was.
  for (const o of [
    { type: "recipe.cooked", id: "cook-henk-000001", recipe_id: "recipe-guest-chili", cooked_on: "2026-10-30" },
    { type: "pantry.use", reason: "cooked", recipe_id: "recipe-guest-chili", takes: [{ event_id: "ev-henk-00000001", pantry_id: "pantry-guest-001", amount: 1 }] },
    { type: "recipe.put", id: "recipe-guest-chili", recipe: { title: "Henk's chili", servings: 2, ingredients: [], steps: [] } },
    { type: "recipe.delete", id: "recipe-guest-chili" },
  ]) assert.equal((await call(env, "POST", "/api/ops", { cookie: token, body: { ops: [op(o)] } })).status, 403, o.type);
  assert.deepEqual({ ...(await env.DB.prepare("SELECT amount, taken FROM pantry WHERE id = 'pantry-guest-001'").first()) }, { ...pantryBefore });
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM cooks").first()).n, 1, "only Thomas's cook");
  assert.equal((await env.DB.prepare("SELECT title FROM recipes WHERE id = 'recipe-guest-chili'").first()).title, "Chili");
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM pantry_events").first()).n, 0);
  // Thomas's own ops still go through.
  const own = await call(env, "POST", "/api/ops", { cookie: thomas, body: { ops: [op({ type: "entry.add", id: "entry-guest-0002", item_id: "item-guest-0002", title: "Brood" })] } });
  assert.equal(own.status, 200);
});

// Every route in worker/api.js ROUTES, as a recipes-only person on recipes.
const REFUSED = [
  ["POST", "/api/invites", { name: "Oma" }],
  ["POST", "/api/handoff", {}],
  ["POST", "/api/members/remove", { id: "x" }],
  ["POST", "/api/quick-add", { text: "melk", op_id: "quick-henk-0001" }],
  ["GET", "/api/widget"],
  ["POST", "/api/recipes/label", { id: "recipe-guest-chili" }],     // Thomas's recipe
  ["POST", "/api/items/shelf-fill", { dry_run: true }],
  ["POST", "/api/offers/sync", { offers: [] }],
];

test("routes: everything outside the recipe side is refused, also with a Bearer token (the MCP server's way)", async () => {
  const { env, henk: token } = await henk();
  for (const [method, path, body] of REFUSED) {
    for (const auth of [{ cookie: token }, { bearer: token, origin: null }]) {
      const res = await json(await call(env, method, path, { ...auth, body }));
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.ok(["recipes_only", "forbidden"].includes(res.body.error), `${path}: ${res.body.error}`);
    }
  }
  const receipt = await call(env, "POST", "/api/receipts/read", { cookie: token, raw: new Uint8Array([0xff, 0xd8, 0xff]), type: "image/jpeg" });
  assert.equal(receipt.status, 403);
  // A photo for a recipe of his own may go up.
  const photo = await call(env, "POST", "/api/photos", { cookie: token, raw: new Uint8Array([0xff, 0xd8, 0xff]), type: "image/jpeg" });
  assert.equal(photo.status, 200);
  // Codes: only for another device of his own, which is recipes-only too.
  assert.equal((await call(env, "POST", "/api/codes", { cookie: token, body: { for: "new_member", name: "Oma" } })).status, 403);
  assert.equal((await call(env, "POST", "/api/codes", { cookie: token, body: { for: "importer" } })).status, 403);
  const code = await json(await call(env, "POST", "/api/codes", { cookie: token, body: {} }));
  assert.equal(code.status, 200);
  const onGroceries = await json(await call(env, "POST", "/api/pair", { host: GROCERIES, body: { code: code.body.code } }));
  assert.equal(onGroceries.status, 403);
  const ipad = tokenOf(await call(env, "POST", "/api/pair", { body: { code: code.body.code, label: "iPad" } }));
  assert.equal((await json(await call(env, "GET", "/api/me", { cookie: ipad }))).body.member.recipes_only, true);
  assert.equal((await call(env, "GET", "/api/widget", { cookie: ipad })).status, 403);
  // What he may do: me, sync, his devices, revoke one, sign out.
  assert.equal((await call(env, "GET", "/api/me", { cookie: token })).status, 200);
  const mine = await json(await call(env, "GET", "/api/devices", { cookie: token }));
  assert.equal(mine.body.devices.length, 2, "only his own devices");
  const other = mine.body.devices.find((d) => !d.current);
  assert.equal((await call(env, "POST", "/api/devices/revoke", { cookie: token, body: { id: other.id } })).status, 200);
  assert.equal((await call(env, "POST", "/api/logout", { cookie: token, body: {} })).status, 200);
  assert.equal((await call(env, "GET", "/api/me", { cookie: token })).status, 401);
});

test("groceries host: refuses a recipes-only person on every route and page; photos too", async () => {
  const { env, thomas, henk: token } = await henk();
  for (const [method, path, body] of [["GET", "/api/me"], ["GET", "/api/sync?since=0"], ["GET", "/api/devices"], ["POST", "/api/ops", { ops: [] }], ["POST", "/api/codes", {}]]) {
    const res = await json(await call(env, method, path, { bearer: token, origin: null, host: GROCERIES, body }));
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(res.body.error, "recipes_only");
  }
  for (const path of ["/", "/index.html", "/groceries.html"]) {
    const page = await call(env, "GET", path, { cookie: token, host: GROCERIES });
    assert.equal(page.status, 403, path);
    const html = await page.text();
    assert.match(html, /Je hebt alleen toegang tot de recepten\./);
    assert.match(html, /href="http:\/\/recipes\.localhost:8787\/"/);
    assert.doesNotMatch(html, /<script/, "never the list's shell");
    assert.match(page.headers.get("Content-Security-Policy"), /script-src 'self'/);
  }
  assert.equal((await call(env, "GET", "/photos/p/abcdefgh12.jpg", { cookie: token, host: GROCERIES })).status, 403);
  // Thomas and a device that is not paired get the app as before.
  assert.match(await (await call(env, "GET", "/", { cookie: thomas, host: GROCERIES })).text(), /data-app="groceries"/);
  assert.match(await (await call(env, "GET", "/", { host: GROCERIES })).text(), /data-app="groceries"/);
});

test("revoke: an admin sees the guest's device and takes it away; removing the person does too", async () => {
  const { env, thomas, henk: token } = await henk();
  const list = await json(await call(env, "GET", "/api/devices", { cookie: thomas }));
  const phone = list.body.devices.find((d) => d.label === "Henk - iPhone");
  assert.equal((await call(env, "POST", "/api/devices/revoke", { cookie: thomas, body: { id: phone.id } })).status, 200);
  assert.equal((await call(env, "GET", "/api/sync?since=0", { cookie: token })).status, 401);
  // Thomas's members list says who is recipes-only.
  const sync = await json(await call(env, "GET", "/api/sync?since=0", { cookie: thomas }));
  assert.equal(sync.body.members.find((m) => m.name === "Henk").recipes_only, true);
  assert.equal(sync.body.members.find((m) => m.name === "Thomas").recipes_only, false);
});

test("own recipes: a recipes-only person adds, changes and deletes his own, never Thomas's; Thomas changes all", async () => {
  const { env, thomas, henk: token } = await henk();
  const me = (await json(await call(env, "GET", "/api/me", { cookie: token }))).body.member;
  const send = async (who, ...ops) => call(env, "POST", "/api/ops", { cookie: who, body: { ops: ops.map(op) } });
  const recipe = (title) => ({ title, servings: 2, ingredients: [{ qty: 1, name: "ui" }], steps: ["Snij de ui."] });

  assert.equal((await send(token, { type: "recipe.put", id: "recipe-henk-soep", recipe: recipe("Soep") })).status, 200);
  assert.equal((await env.DB.prepare("SELECT created_by FROM recipes WHERE id = 'recipe-henk-soep'").first()).created_by, me.id);
  assert.equal((await send(token, { type: "recipe.put", id: "recipe-henk-soep", recipe: recipe("Henk's soep") })).status, 200);
  assert.equal((await env.DB.prepare("SELECT title FROM recipes WHERE id = 'recipe-henk-soep'").first()).title, "Henk's soep");

  // Thomas's recipe: no change, no delete, also not hidden in a batch with his own.
  for (const o of [
    { type: "recipe.put", id: "recipe-guest-chili", recipe: recipe("Henk's chili") },
    { type: "recipe.delete", id: "recipe-guest-chili" },
  ]) assert.equal((await send(token, o)).status, 403, o.type);
  const mixed = await send(token,
    { type: "recipe.put", id: "recipe-henk-stamp", recipe: recipe("Stamppot") },
    { type: "recipe.delete", id: "recipe-guest-chili" });
  assert.equal(mixed.status, 403);
  assert.equal(await env.DB.prepare("SELECT 1 FROM recipes WHERE id = 'recipe-henk-stamp'").first(), null, "nothing of the batch applied");
  const chili = await env.DB.prepare("SELECT title, deleted_at FROM recipes WHERE id = 'recipe-guest-chili'").first();
  assert.deepEqual({ ...chili }, { title: "Chili", deleted_at: null });

  // A recipe Thomas deleted cannot come back as Henk's.
  assert.equal((await send(thomas, { type: "recipe.put", id: "recipe-thomas-old", recipe: recipe("Oud") })).status, 200);
  assert.equal((await send(thomas, { type: "recipe.delete", id: "recipe-thomas-old" })).status, 200);
  assert.equal((await send(token, { type: "recipe.put", id: "recipe-thomas-old", recipe: recipe("Nieuw") })).status, 403);

  // Thomas may still change everything, Henk's recipe too; Henk deletes his own.
  assert.equal((await send(thomas, { type: "recipe.put", id: "recipe-henk-soep", recipe: recipe("Soep van Henk") })).status, 200);
  assert.equal((await send(thomas, { type: "recipe.put", id: "recipe-guest-chili", recipe: recipe("Chili con carne") })).status, 200);
  assert.equal((await send(token, { type: "recipe.delete", id: "recipe-henk-soep" })).status, 200);
  assert.ok((await env.DB.prepare("SELECT deleted_at FROM recipes WHERE id = 'recipe-henk-soep'").first()).deleted_at);

  // Labels: only for a recipe he made (no key here: 503 means it got past the check).
  assert.equal((await call(env, "POST", "/api/recipes/label", { cookie: token, body: { id: "recipe-guest-chili" } })).status, 403);
  assert.equal((await send(token, { type: "recipe.put", id: "recipe-henk-pap", recipe: recipe("Pap") })).status, 200);
  assert.equal((await call(env, "POST", "/api/recipes/label", { cookie: token, body: { id: "recipe-henk-pap" } })).status, 503);
});

test("import: a recipes-only person reads recipes on his own daily count, never the household's", async () => {
  const { env, henk: token } = await henk();
  env.ANTHROPIC_API_KEY = "test-key-never-called";
  const me = (await json(await call(env, "GET", "/api/me", { cookie: token }))).body.member;
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare("INSERT INTO usage_limits (bucket, count) VALUES (?, ?)").bind(`recipe_import_guest:${me.id}:${day}`, GUEST_IMPORT_DAILY_LIMIT).run();
  const photos = await json(await call(env, "POST", "/api/recipes/import/photos", { cookie: token, body: { photos: [{ type: "image/jpeg", data: "/9j/4AAQ" }] } }));
  assert.equal(photos.status, 429);
  assert.equal(photos.body.error, "too_many_imports");
  const page = await json(await call(env, "POST", "/api/recipes/import/url", { cookie: token, body: { url: "https://example.com/recept" } }));
  assert.equal(page.status, 429);
  const household = await env.DB.prepare("SELECT count FROM usage_limits WHERE bucket LIKE 'recipe_import:%'").first();
  assert.equal(household, null, "the household's count is untouched");
  assert.ok(GUEST_IMPORT_DAILY_LIMIT < IMPORT_DAILY_LIMIT);
});
