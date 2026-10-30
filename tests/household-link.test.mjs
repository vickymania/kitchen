// A household link (30-10-2026): "Link delen" next to the code in Settings.
// A new full member, or another device of the asker, pairs by a one-time link
// on either host; a recipes-only link keeps its restriction. Fictional people.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";

const RECIPES = "recipes.localhost:8787";
const GROCERIES = "groceries.localhost:8787";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

function call(env, method, path, { body, cookie, host = RECIPES, ua } = {}) {
  const headers = { Origin: `http://${host}` };
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (ua) headers["User-Agent"] = ua;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`http://${host}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
const json = async (res) => ({ status: res.status, body: await res.json() });
const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
const tokenIn = (url) => url.match(/#\/join\/([\w-]+)$/)[1];

async function household() {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const thomas = tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456", label: "test phone" } }));
  return { env, thomas };
}

const link = async (env, cookie, body, host = RECIPES) => {
  const out = await json(await call(env, "POST", "/api/invites", { cookie, host, body }));
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body;
};

const join = async (env, made, host = RECIPES, extra = {}) =>
  tokenOf(await call(env, "POST", "/api/pair", { host, body: { invite: tokenIn(made.url), ...extra } }));

test("member link: pairs a new full member on groceries with full access, once", async () => {
  const { env, thomas } = await household();
  const made = await link(env, thomas, { kind: "member", name: "Sam" }, GROCERIES);
  assert.match(made.url, /^http:\/\/groceries\.localhost:8787\/#\/join\/[A-Za-z0-9_-]{40,}$/);
  const days = (Date.parse(made.expires_at) - Date.now()) / 86400_000;
  assert.ok(days > 6.9 && days <= 7);
  const row = await env.DB.prepare("SELECT * FROM pairing_codes WHERE kind = 'invite'").first();
  assert.ok(!JSON.stringify(row).includes(tokenIn(made.url)), "only the hash is stored");
  assert.equal(row.recipes_only, 0);

  const sam = tokenOf(await call(env, "POST", "/api/pair", { host: GROCERIES, body: { invite: tokenIn(made.url), device: "iPhone" }, ua: IPHONE }));
  assert.ok(sam);
  const me = await json(await call(env, "GET", "/api/me", { cookie: sam, host: GROCERIES }));
  assert.equal(me.body.member.name, "Sam");
  assert.equal(me.body.member.recipes_only, false);
  assert.equal(me.body.member.is_admin, false);
  const ops = await json(await call(env, "POST", "/api/ops", { cookie: sam, host: GROCERIES, body: { ops: [
    { op_id: "op-link-000001", type: "entry.add", id: "entry-link-0001", item_id: "item-link-0001", title: "Melk" }] } }));
  assert.equal(ops.status, 200);
  assert.ok(ops.body.results[0].ok);
  const sync = await json(await call(env, "GET", "/api/sync?since=0", { cookie: sam, host: GROCERIES }));
  assert.ok(sync.body.entries.length >= 1);
  const devices = await json(await call(env, "GET", "/api/devices", { cookie: thomas }));
  assert.ok(devices.body.devices.some((d) => d.label === "Sam - iPhone" && d.member_name === "Sam"));
  // One use only, on either host; a used link counts as a wrong code.
  assert.equal((await call(env, "POST", "/api/pair", { host: RECIPES, body: { invite: tokenIn(made.url) } })).status, 400);
  const fails = await env.DB.prepare("SELECT SUM(count) AS n FROM pairing_failures WHERE bucket LIKE 'ip:%'").first();
  assert.equal(fails.n, 1);
});

test("member link: on recipes too, with the way to groceries open", async () => {
  const { env, thomas } = await household();
  const sam = await join(env, await link(env, thomas, { kind: "member", name: "Sam" }));
  const me = await json(await call(env, "GET", "/api/me", { cookie: sam }));
  assert.equal(me.body.member.recipes_only, false);
  assert.ok(me.body.other_app, "the way to the other app is there");
  assert.equal((await call(env, "POST", "/api/handoff", { cookie: sam, body: {} })).status, 200);
  assert.equal((await call(env, "GET", "/api/widget", { cookie: sam })).status, 200);
});

test("member link: admins only, a name is needed, the admin flag is passed on", async () => {
  const { env, thomas } = await household();
  assert.equal((await call(env, "POST", "/api/invites", { cookie: thomas, body: { kind: "member", name: " " } })).status, 400);
  const sam = await join(env, await link(env, thomas, { kind: "member", name: "Sam" }));
  assert.equal((await call(env, "POST", "/api/invites", { cookie: sam, body: { kind: "member", name: "Eva" } })).status, 403);
  assert.equal((await call(env, "POST", "/api/invites", { cookie: sam, body: { name: "Eva" } })).status, 403, "no guest link either");
  const eva = await join(env, await link(env, thomas, { kind: "member", name: "Eva", admin: true }));
  assert.equal((await json(await call(env, "GET", "/api/me", { cookie: eva }))).body.member.is_admin, true);
  assert.equal((await call(env, "POST", "/api/invites", { cookie: thomas, body: { kind: "other" } })).status, 403);
});

test("device link: attaches to the same member on both hosts, labelled '<name> - <device>'", async () => {
  const { env, thomas } = await household();
  for (const host of [RECIPES, GROCERIES]) {
    const made = await link(env, thomas, { kind: "device" }, host);
    const device = await join(env, made, host, { device: "iPad" });
    const a = await json(await call(env, "GET", "/api/me", { cookie: thomas, host }));
    const b = await json(await call(env, "GET", "/api/me", { cookie: device, host }));
    assert.equal(b.body.member.id, a.body.member.id, `the same member on ${host}`);
    assert.equal(b.body.member.is_admin, true, "his rights come with him");
  }
  const devices = await json(await call(env, "GET", "/api/devices", { cookie: thomas }));
  assert.equal(devices.body.devices.filter((d) => d.label === "Thomas - iPad").length, 2);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM members").first()).n, 1, "no second person");
});

test("device link: a non-admin links his own device; a recipes-only person and a role device make none", async () => {
  const { env, thomas } = await household();
  const sam = await join(env, await link(env, thomas, { kind: "member", name: "Sam" }));
  const second = await join(env, await link(env, sam, { kind: "device" }), RECIPES, { device: "Android" });
  assert.equal((await json(await call(env, "GET", "/api/me", { cookie: second }))).body.member.name, "Sam");
  const henk = await join(env, await link(env, thomas, { name: "Henk" }));
  assert.equal((await call(env, "POST", "/api/invites", { cookie: henk, body: { kind: "device" } })).status, 403);
  assert.equal((await call(env, "GET", "/api/invites", { cookie: henk })).status, 403);
  const code = await json(await call(env, "POST", "/api/codes", { cookie: thomas, body: { for: "reviewer" } }));
  const reviewer = tokenOf(await call(env, "POST", "/api/pair", { body: { code: code.body.code } }));
  assert.equal((await call(env, "POST", "/api/invites", { cookie: reviewer, body: { kind: "device" } })).status, 403);
});

test("expiry: an expired household link pairs nothing and is no open link", async () => {
  const { env, thomas } = await household();
  const made = await link(env, thomas, { kind: "member", name: "Sam" });
  await env.DB.prepare("UPDATE pairing_codes SET expires_at = ? WHERE kind = 'invite'").bind(new Date(Date.now() - 1000).toISOString()).run();
  assert.equal((await call(env, "POST", "/api/pair", { host: GROCERIES, body: { invite: tokenIn(made.url) } })).status, 400);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM members").first()).n, 1);
  assert.equal((await json(await call(env, "GET", "/api/invites", { cookie: thomas }))).body.invites.length, 0);
});

test("limits: wrong links are stopped like wrong codes, on groceries too", async () => {
  const { env } = await household();
  let last;
  for (let i = 0; i < 11; i++) last = await call(env, "POST", "/api/pair", { host: GROCERIES, body: { invite: `${"a".repeat(39)}${i}` } });
  assert.equal(last.status, 429);
});

test("open links: an admin sees all, a member only the links for his own devices", async () => {
  const { env, thomas } = await household();
  const sam = await join(env, await link(env, thomas, { kind: "member", name: "Sam" }));
  await link(env, thomas, { kind: "member", name: "Eva" });
  await link(env, thomas, { kind: "device" });
  await link(env, thomas, { name: "Henk" });
  await link(env, sam, { kind: "device" });
  const all = (await json(await call(env, "GET", "/api/invites", { cookie: thomas }))).body.invites;
  assert.deepEqual(all.map((i) => [i.kind, i.name]).sort(), [["device", "Sam"], ["device", "Thomas"], ["guest", "Henk"], ["member", "Eva"]]);
  assert.ok(all.every((i) => /^[0-9a-f]{16}$/.test(i.id) && i.expires_at));
  const mine = (await json(await call(env, "GET", "/api/invites", { cookie: sam }))).body.invites;
  assert.deepEqual(mine.map((i) => [i.kind, i.name]), [["device", "Sam"]]);
});

test("revoke: an unused link is withdrawn and pairs nothing; a used or foreign one cannot be", async () => {
  const { env, thomas } = await household();
  const made = await link(env, thomas, { kind: "member", name: "Sam" });
  const guest = await link(env, thomas, { name: "Henk" });
  const list = (await json(await call(env, "GET", "/api/invites", { cookie: thomas }))).body.invites;
  const id = list.find((i) => i.kind === "member").id;
  assert.equal((await call(env, "POST", "/api/invites/revoke", { cookie: thomas, body: { id } })).status, 200);
  assert.equal((await call(env, "POST", "/api/pair", { host: GROCERIES, body: { invite: tokenIn(made.url) } })).status, 400);
  assert.equal((await call(env, "POST", "/api/invites/revoke", { cookie: thomas, body: { id } })).status, 404, "twice");
  const gid = (await json(await call(env, "GET", "/api/invites", { cookie: thomas }))).body.invites.find((i) => i.kind === "guest").id;
  assert.equal((await call(env, "POST", "/api/invites/revoke", { cookie: thomas, body: { id: gid } })).status, 200);
  assert.equal((await call(env, "POST", "/api/pair", { body: { invite: tokenIn(guest.url) } })).status, 400);
  assert.equal((await json(await call(env, "GET", "/api/invites", { cookie: thomas }))).body.invites.length, 0);
  // A used link is no open link; a member cannot withdraw someone else's.
  const sam = await join(env, await link(env, thomas, { kind: "member", name: "Sam" }));
  await link(env, thomas, { kind: "device" });
  const open = (await json(await call(env, "GET", "/api/invites", { cookie: thomas }))).body.invites;
  assert.equal(open.length, 1);
  assert.equal((await call(env, "POST", "/api/invites/revoke", { cookie: sam, body: { id: open[0].id } })).status, 404);
  assert.equal((await call(env, "POST", "/api/invites/revoke", { cookie: thomas, body: { id: "../" } })).status, 404);
  assert.equal((await json(await call(env, "GET", "/api/invites", { cookie: thomas }))).body.invites.length, 1, "still open");
});

test("guest links stay recipes-only: not on groceries, the flag stays on the member", async () => {
  const { env, thomas } = await household();
  const henk = await link(env, thomas, { name: "Henk" });
  assert.equal((await call(env, "POST", "/api/invites", { cookie: thomas, host: GROCERIES, body: { name: "Henk" } })).status, 403);
  const there = await json(await call(env, "POST", "/api/pair", { host: GROCERIES, body: { invite: tokenIn(henk.url) } }));
  assert.equal(there.status, 403);
  assert.equal(there.body.error, "recipes_only");
  const token = tokenOf(await call(env, "POST", "/api/pair", { body: { invite: tokenIn(henk.url) }, ua: IPHONE }));
  const me = await json(await call(env, "GET", "/api/me", { cookie: token }));
  assert.equal(me.body.member.recipes_only, true);
  assert.equal(me.body.other_app, null);
  assert.equal((await call(env, "GET", "/api/me", { cookie: token, host: GROCERIES })).status, 403);
  const second = await join(env, await link(env, thomas, { kind: "device" }));
  assert.equal((await json(await call(env, "GET", "/api/me", { cookie: second }))).body.member.recipes_only, false);
});
