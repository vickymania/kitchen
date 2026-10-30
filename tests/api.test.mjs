// The worker end to end: real handlers, real migration, real op engine, on
// the D1 stand-in from tests/d1-shim.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { hashDevice } from "../worker/auth.js";

const HOST = "recipes.localhost:8787";
const ORIGIN = `http://${HOST}`;

function call(env, method, path, { body, cookie, bearer, origin = ORIGIN, host = HOST, type, raw } = {}) {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined || raw !== undefined) headers["Content-Type"] = type ?? "application/json";
  return worker.fetch(new Request(`http://${host}${path}`, {
    method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  }), env);
}

async function json(res) {
  return { status: res.status, body: await res.json() };
}

const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);

async function household() {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const res = await call(env, "POST", "/api/pair", { body: { code: "123456", label: "test phone" } });
  assert.equal(res.status, 200);
  return { env, thomas: tokenOf(res) };
}

let opCounter = 0;
const op = (o) => ({ op_id: `op-test-${String(++opCounter).padStart(6, "0")}`, ...o });

test("pairing with the first code makes an admin; the code works once", async () => {
  const { env, thomas } = await household();
  const me = await json(await call(env, "GET", "/api/me", { cookie: thomas }));
  assert.equal(me.body.member.name, "Thomas");
  assert.equal(me.body.member.is_admin, true);
  assert.equal(me.body.other_app, "http://groceries.localhost:8787");
  const again = await call(env, "POST", "/api/pair", { body: { code: "123456" } });
  assert.equal(again.status, 400);
});

test("no device, no data; a cookie from another site changes nothing", async () => {
  const { env, thomas } = await household();
  assert.equal((await call(env, "GET", "/api/sync")).status, 401);
  assert.equal((await call(env, "GET", "/api/sync", { cookie: "x".repeat(43) })).status, 401);
  const cross = await call(env, "POST", "/api/ops", { cookie: thomas, origin: "https://evil.example", body: { ops: [] } });
  assert.equal(cross.status, 403);
  const noOrigin = await call(env, "POST", "/api/ops", { cookie: thomas, origin: null, body: { ops: [] } });
  assert.equal(noOrigin.status, 403);
  const form = await call(env, "POST", "/api/ops", { cookie: thomas, raw: "ops=[]", type: "application/x-www-form-urlencoded" });
  assert.equal(form.status, 415);
});

test("ops apply, merge on the list, and replay without doubling", async () => {
  const { env, thomas } = await household();
  const add1 = op({ type: "entry.add", id: "entry-api-0001", item_id: "item-api-0001", title: "Gehakt", amounts: [{ qty: 400, unit: "g" }], source: { recipe_id: "recipe-api-chili", title: "Chili" } });
  const add2 = op({ type: "entry.add", id: "entry-api-0002", item_id: "item-api-0002", title: "gehakt", amounts: [{ qty: 300, unit: "g" }] });
  const recipe = op({ type: "recipe.put", id: "recipe-api-chili", recipe: { title: "Chili", servings: 4, ingredients: [{ qty: 400, unit: "g", name: "gehakt" }], steps: ["Bak het gehakt."] } });
  const r1 = await json(await call(env, "POST", "/api/ops", { cookie: thomas, body: { ops: [recipe, add1, add2] } }));
  assert.deepEqual(r1.body.results.map((r) => r.ok), [true, true, true]);
  assert.equal(r1.body.results[2].result.merged_into, "entry-api-0001");

  const replay = await json(await call(env, "POST", "/api/ops", { cookie: thomas, body: { ops: [add2] } }));
  assert.equal(replay.body.results[0].result.merged_into, "entry-api-0001");

  const full = await json(await call(env, "GET", "/api/sync?since=0", { cookie: thomas }));
  assert.equal(full.body.recipes.length, 1);
  assert.deepEqual(full.body.recipes[0].ingredients[0].name, "gehakt");
  assert.equal(full.body.entries.length, 1);
  assert.deepEqual(full.body.entries[0].amounts, [{ qty: 700, unit: "g" }]);
  assert.equal(full.body.members.length, 1);

  const bad = await json(await call(env, "POST", "/api/ops", { cookie: thomas, body: { ops: [op({ type: "recipe.put", id: "recipe-api-0002", recipe: {} })] } }));
  assert.deepEqual(bad.body.results[0], { op_id: bad.body.results[0].op_id, ok: false, error: "title_required" });
});

test("a delta pull has only what changed, deletions included", async () => {
  const { env, thomas } = await household();
  await call(env, "POST", "/api/ops", { cookie: thomas, body: { ops: [
    op({ type: "entry.add", id: "entry-delta-01", item_id: "item-delta-01", title: "Melk" }),
    op({ type: "entry.add", id: "entry-delta-02", item_id: "item-delta-02", title: "Kaas" }),
  ] } });
  const first = await json(await call(env, "GET", "/api/sync?since=0", { cookie: thomas }));
  await call(env, "POST", "/api/ops", { cookie: thomas, body: { ops: [op({ type: "entry.delete", id: "entry-delta-01" })] } });
  const delta = await json(await call(env, "GET", `/api/sync?since=${first.body.rev}`, { cookie: thomas }));
  assert.equal(delta.body.full, false);
  assert.deepEqual(delta.body.entries.map((e) => [e.id, Boolean(e.deleted_at)]), [["entry-delta-01", true]]);
  assert.equal(delta.body.recipes.length, 0);
  const fresh = await json(await call(env, "GET", "/api/sync?since=0", { cookie: thomas }));
  assert.deepEqual(fresh.body.entries.map((e) => e.title), ["Kaas"]);
});

test("usage: a change writes only what changed, an idle poll reads only the counter", async () => {
  const { env, thomas } = await household();
  const adds = Array.from({ length: 30 }, (_, i) => op({ type: "entry.add", id: `entry-use-${String(i).padStart(4, "0")}`, item_id: `item-use-${String(i).padStart(5, "0")}`, title: `Ding ${i}` }));
  await call(env, "POST", "/api/ops", { cookie: thomas, body: { ops: adds } });

  const batches = [];
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = (stmts) => {
    batches.push(stmts.map((s) => s.sql));
    return batch(stmts);
  };
  await call(env, "POST", "/api/ops", { cookie: thomas, body: { ops: [op({ type: "entry.check", id: "entry-use-0007", checked: true })] } });
  const writes = batches.find((b) => b.some((sql) => sql.startsWith("INSERT INTO list_entries")));
  // Phase 4: a tick also puts the line in the pantry (28-10-2026): one more row, no more.
  assert.equal(writes.length, 4, "rev bump + the line + its pantry row + applied_ops");
  assert.equal(writes.filter((sql) => sql.startsWith("INSERT INTO list_entries")).length, 1);
  assert.equal(writes.filter((sql) => sql.startsWith("INSERT INTO pantry ")).length, 1);

  const { body: head } = await json(await call(env, "GET", "/api/sync?since=0", { cookie: thomas }));
  const queries = [];
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    queries.push(sql);
    return prepare(sql);
  };
  const idle = await json(await call(env, "GET", `/api/sync?since=${head.rev}`, { cookie: thomas }));
  assert.deepEqual([idle.body.entries.length, idle.body.recipes.length], [0, 0]);
  assert.equal(queries.filter((sql) => /FROM (recipes|items|list_entries|pantry|pantry_events)\b|FROM members WHERE/.test(sql)).length, 0);
});

test("quick-add: one typed line from the widget, parsed like the add box, never doubled", async () => {
  const { env, thomas } = await household();
  const add = (body, opts = {}) => call(env, "POST", "/api/quick-add", { bearer: thomas, origin: null, body, ...opts });

  const first = await json(await add({ text: "500 gr gehakt", op_id: "quick-test-0001" }));
  assert.equal(first.status, 200);
  assert.equal(first.body.title, "gehakt");
  // The same op_id again (the phone never heard the answer): no second line.
  const retry = await json(await add({ text: "500 gr gehakt", op_id: "quick-test-0001" }));
  assert.equal(retry.status, 200);
  // Another add of the same item merges like the add box does.
  const more = await json(await add({ text: "300 gr Gehakt", op_id: "quick-test-0002" }));
  assert.equal(more.body.result.merged_into, "quick-test-0001");
  await add({ text: "2 ui", op_id: "quick-test-0003" });

  const list = await json(await call(env, "GET", "/api/sync?since=0", { cookie: thomas }));
  const lines = Object.fromEntries(list.body.entries.map((e) => [e.title, e.amounts]));
  assert.deepEqual(lines, { gehakt: [{ qty: 800, unit: "g" }], ui: [{ qty: 2, unit: null }] });
  assert.equal(more.body.rev < list.body.rev, true, "rev in the answer is the household head after the add");

  assert.equal((await add({ text: "   ", op_id: "quick-test-0004" })).status, 400);
  assert.equal((await add({ text: "melk", op_id: "x" })).status, 400);
  assert.equal((await add({ text: "melk", op_id: "quick-test-0005" }, { bearer: null })).status, 401);
  const cross = await call(env, "POST", "/api/quick-add", { cookie: thomas, origin: "https://evil.example", body: { text: "melk", op_id: "quick-test-0006" } });
  assert.equal(cross.status, 403);
});

test("a second person: shared data, fewer rights", async () => {
  const { env, thomas } = await household();
  const code = await json(await call(env, "POST", "/api/codes", { cookie: thomas, body: { for: "new_member", name: "Sam" } }));
  assert.match(code.body.code, /^\d{6}$/);
  const paired = await call(env, "POST", "/api/pair", { body: { code: code.body.code, label: "Sam phone" } });
  const sam = tokenOf(paired);
  assert.ok(sam);

  await call(env, "POST", "/api/ops", { cookie: thomas, body: { ops: [op({ type: "entry.add", id: "entry-sam-0001", item_id: "item-sam-0001", title: "Brood" })] } });
  const seen = await json(await call(env, "GET", "/api/sync?since=0", { cookie: sam }));
  assert.deepEqual(seen.body.entries.map((e) => e.title), ["Brood"]);
  assert.equal(seen.body.members.length, 2);

  assert.equal((await call(env, "POST", "/api/codes", { cookie: sam, body: { for: "new_member", name: "X" } })).status, 403);
  const own = await json(await call(env, "POST", "/api/codes", { cookie: sam, body: {} }));
  assert.equal(own.status, 200);

  const thomasId = seen.body.members.find((m) => m.name === "Thomas").id;
  const rename = await json(await call(env, "POST", "/api/ops", { cookie: sam, body: { ops: [op({ type: "member.update", id: thomasId, name: "Vic" })] } }));
  assert.equal(rename.body.results[0].error, "forbidden");

  const samDevices = await json(await call(env, "GET", "/api/devices", { cookie: sam }));
  assert.equal(samDevices.body.devices.length, 1);
  const allDevices = await json(await call(env, "GET", "/api/devices", { cookie: thomas }));
  assert.equal(allDevices.body.devices.length, 2);

  const samId = seen.body.members.find((m) => m.name === "Sam").id;
  assert.equal((await call(env, "POST", "/api/members/remove", { cookie: thomas, body: { id: samId } })).status, 200);
  assert.equal((await call(env, "GET", "/api/me", { cookie: sam })).status, 401);
});

test("a handoff link signs the same person into the other app, once", async () => {
  const { env, thomas } = await household();
  const { body } = await json(await call(env, "POST", "/api/handoff", { cookie: thomas, body: {} }));
  assert.match(body.url, /^http:\/\/groceries\.localhost:8787\/#pair=[\w-]+$/);
  const token = body.url.split("#pair=")[1];
  const g = "groceries.localhost:8787";
  const paired = await call(env, "POST", "/api/pair", { host: g, origin: `http://${g}`, body: { handoff: token } });
  const other = tokenOf(paired);
  const me = await json(await call(env, "GET", "/api/me", { host: g, cookie: other }));
  assert.equal(me.body.member.name, "Thomas");
  assert.equal((await call(env, "POST", "/api/pair", { host: g, origin: `http://${g}`, body: { handoff: token } })).status, 400);
});

test("wrong codes are limited per address per day", async () => {
  const { env } = await household();
  for (let i = 0; i < 10; i++) assert.equal((await call(env, "POST", "/api/pair", { body: { code: "000000" } })).status, 400);
  assert.equal((await call(env, "POST", "/api/pair", { body: { code: "000000" } })).status, 429);
});

test("revoking a device and signing out end its access", async () => {
  const { env, thomas } = await household();
  const code = await json(await call(env, "POST", "/api/codes", { cookie: thomas, body: {} }));
  const second = tokenOf(await call(env, "POST", "/api/pair", { body: { code: code.body.code } }));
  const list = await json(await call(env, "GET", "/api/devices", { cookie: thomas }));
  const target = list.body.devices.find((d) => !d.current);
  assert.equal((await call(env, "POST", "/api/devices/revoke", { cookie: thomas, body: { id: target.id } })).status, 200);
  assert.equal((await call(env, "GET", "/api/me", { cookie: second })).status, 401);
  assert.equal((await call(env, "POST", "/api/logout", { cookie: thomas, body: {} })).status, 200);
  assert.equal((await call(env, "GET", "/api/me", { cookie: thomas })).status, 401);
});

test("another household sees nothing and overwrites nothing", async () => {
  const { env, thomas } = await household();
  await call(env, "POST", "/api/ops", { cookie: thomas, body: { ops: [op({ type: "recipe.put", id: "recipe-mine-001", recipe: { title: "Mijn recept" } })] } });
  const now = new Date().toISOString();
  await env.DB.exec(`INSERT INTO households (id, name, rev, created_at) VALUES ('hh-other-000', 'Buren', 0, '${now}');
    INSERT INTO members (id, household_id, name, is_admin, created_at, rev) VALUES ('member-other-1', 'hh-other-000', 'Buur', 1, '${now}', 0);
    INSERT INTO devices (id, member_id, token_hash, created_at) VALUES ('device-other-1', 'member-other-1', '${await hashDevice("t".repeat(43))}', '${now}');`);
  const stranger = "t".repeat(43);
  const theirs = await json(await call(env, "GET", "/api/sync?since=0", { cookie: stranger }));
  assert.equal(theirs.body.recipes.length, 0);
  await call(env, "POST", "/api/ops", { cookie: stranger, body: { ops: [op({ type: "recipe.put", id: "recipe-mine-001", recipe: { title: "Overgenomen" } })] } });
  const mine = await json(await call(env, "GET", "/api/sync?since=0", { cookie: thomas }));
  assert.equal(mine.body.recipes[0].title, "Mijn recept");
});

test("photos: upload with a token, view only from the household", async () => {
  const { env, thomas } = await household();
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const up = await json(await call(env, "POST", "/api/photos", { bearer: thomas, raw: jpeg, type: "image/jpeg", origin: null }));
  assert.match(up.body.key, /^p\/[\w-]+\.jpg$/);
  const seen = await call(env, "GET", `/photos/${up.body.key}`, { cookie: thomas });
  assert.equal(seen.status, 200);
  assert.equal(seen.headers.get("Content-Type"), "image/jpeg");
  assert.deepEqual(new Uint8Array(await seen.arrayBuffer()), jpeg);
  assert.equal((await call(env, "GET", `/photos/${up.body.key}`)).status, 401);
  assert.equal((await call(env, "GET", "/photos/p/../../secret.jpg", { cookie: thomas })).status, 404);
  const text = await call(env, "POST", "/api/photos", { bearer: thomas, raw: "hello", type: "text/plain", origin: null });
  assert.equal(text.status, 415);
});

test("the host name picks the app; the shell is served with its headers", async () => {
  const env = await makeEnv();
  const recipes = await call(env, "GET", "/");
  assert.match(await recipes.text(), /data-app="recipes"/);
  assert.match(recipes.headers.get("Content-Security-Policy"), /script-src 'self'/);
  const groceries = await call(env, "GET", "/", { host: "groceries.localhost:8787" });
  assert.match(await groceries.text(), /data-app="groceries"/);
  const manifest = await (await call(env, "GET", "/manifest.webmanifest", { host: "groceries.localhost:8787" })).json();
  assert.equal(manifest.short_name, "Groceries");
  const sw = await call(env, "GET", "/sw.js");
  assert.match(await sw.text(), /const VERSION = "test"/);
  assert.equal(sw.headers.get("Cache-Control"), "no-store");
  assert.equal((await call(env, "GET", "/api/nope")).status, 404);
});
