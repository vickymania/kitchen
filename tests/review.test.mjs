// The nightly Claude check on the home server: the reviewer device's rights
// (only item.alias, product.move by id and review.save; never an excluded thing), the
// review.save op and its sync, the prompt builder (log tail, new purchases,
// once a day, the MCP config), the report from claude's JSON output and its
// failure paths (lost login, timeout...), the MCP tools kitchen_product_move
// and kitchen_recent_purchases with the reviewer's own token file, and
// review.sh's locked-down call.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { OP_TYPES, applyOp, emptyState, REVIEW_MAX_LINES } from "../public/shared/ops.js";
import { reviewerMayApply, importerMayApply } from "../worker/auth.js";
import { GUEST_SYNCED } from "../worker/ops-store.js";
import { localToday } from "../public/shared/intervals.js";
import { newPurchasesText, NEW_PURCHASES_FILE } from "../tools/import_ah.mjs";
import {
  prepare, save, readReport, logTail, lastRunLog, amsterdamDay, logErrors, buildPrompt, mcpConfig, reportText, reviewOp, failureLines, LOG_LINES,
} from "../fetcher/review.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "groceries.localhost:8787";
const ORIGIN = `http://${HOST}`;
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `kitchen-review-${name}-`));

function call(env, method, p, { body, cookie, bearer } = {}) {
  const headers = { Origin: ORIGIN };
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`${ORIGIN}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);

let n = 0;
const opId = () => `op-review-${String(++n).padStart(6, "0")}`;

/** A household, Thomas's phone, and the home server paired with a reviewer code. */
async function setup() {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const thomas = tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456", label: "phone" } }));
  const code = await (await call(env, "POST", "/api/codes", { cookie: thomas, body: { for: "reviewer" } })).json();
  const reviewer = tokenOf(await call(env, "POST", "/api/pair", { body: { code: code.code, label: "Thuisserver controle" } }));
  assert.ok(reviewer);
  return { env, thomas, reviewer };
}

const purchase = (id, title, product) => ({
  op_id: opId(), type: "purchase.add", id, item_id: `item-${id}`, title, bought_on: localToday(), store: "Albert Heijn",
  qty: 1, price_cents: 129, source: "receipt", product,
});

/**
 * An excluded product as an old row: the op engine refuses excluded things in
 * purchase.add and product.put, so only data from before that rule holds one.
 */
async function excludedRow(env) {
  await env.DB.exec(`INSERT INTO products (id, household_id, name, brand, size, store, product_key, created_at, updated_at, rev)
    SELECT 'ah-product-groene-ster', id, 'Groene Ster spruitjes', 'Groene Ster', '6 x 30 cl', 'Albert Heijn', 'groene ster spruitjes|groene ster|6 x 30 cl', 'x', 'x', 1 FROM households;`);
}

/** Tuna in water bought as "Tonijn", the cat's item "Minoestuna", and an excluded product. */
async function seed(env, thomas) {
  const res = await call(env, "POST", "/api/ops", { cookie: thomas, body: { ops: [
    purchase("pur-review-tonijn1", "Tonijn", { id: "ah-product-tonijn-water", name: "AH Tonijn in water", brand: "AH", size: "3 x 56 g" }),
    purchase("pur-review-minoes1", "Minoestuna", { id: "ah-product-minoes-pouch", name: "Felix tonijn pouch", brand: "Felix", size: "85 g" }),
  ] } });
  await excludedRow(env);
  const body = await res.json();
  assert.equal(res.status, 200);
  const all = await (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();
  const item = (name) => all.items.find((i) => i.name === name);
  return { body, all, tonijn: item("Tonijn"), minoes: item("Minoestuna") };
}

// ------------------------------------------------------------------ rights

test("reviewer: reads /api/sync and sends an alias, a product move by id and its report", async () => {
  const { env, thomas, reviewer } = await setup();
  const { tonijn, minoes } = await seed(env, thomas);
  assert.ok(tonijn && minoes);
  assert.equal((await call(env, "GET", "/api/sync?since=0", { bearer: reviewer })).status, 200);
  const ops = [
    { op_id: opId(), type: "item.alias", id: "alias-review-0001", item_id: minoes.id, name: "Kattentonijn" },
    { op_id: opId(), type: "product.move", product_id: "ah-product-tonijn-water", item_id: minoes.id, on: localToday() },
    { op_id: opId(), type: "review.save", day: localToday(), run_ok: true, fixed: [{ text: "Tonijn in water staat nu bij Minoestuna.", undo: "Terug: Tonijn." }], decide: [] },
  ];
  const res = await call(env, "POST", "/api/ops", { bearer: reviewer, body: { ops } });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).results.every((r) => r.ok));
  const all = await (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();
  assert.equal(all.purchases.find((p) => p.id === "pur-review-tonijn1").item_id, minoes.id, "the purchase moved with its product");
  assert.ok(all.aliases.some((a) => a.name === "Kattentonijn" && a.item_id === minoes.id));
  assert.equal(all.reviews.length, 1);
});

test("reviewer: every other op, a removed name, a move by title, a merge of two things and an excluded thing are refused whole", async () => {
  const { env, thomas, reviewer } = await setup();
  const { tonijn, minoes } = await seed(env, thomas);
  const wasmiddel = "item-review-wasmiddel";
  assert.equal((await call(env, "POST", "/api/ops", { cookie: thomas, body: { ops: [{ op_id: opId(), type: "entry.add", id: "entry-review-wasm1", item_id: wasmiddel, title: "Wasmiddel" }] } })).status, 200);
  for (const type of OP_TYPES.filter((t) => !["item.alias", "product.move", "review.save"].includes(t))) {
    const res = await call(env, "POST", "/api/ops", { bearer: reviewer, body: { ops: [{ op_id: opId(), type, id: "x-review-000001" }] } });
    assert.equal(res.status, 403, `the reviewer may not send ${type}`);
  }
  const refused = [
    [{ type: "item.alias", item_id: minoes.id, name: "Tonijn", remove: true }, "remove a name"],
    [{ type: "product.move", product_id: "ah-product-tonijn-water", title: "Kattenvoer nieuw", on: localToday() }, "make an item by moving to a title"],
    [{ type: "item.merge", from_item_id: tonijn.id, into_title: "Minoestuna", into_item_id: minoes.id, on: localToday() }, "merge into a title"],
    [{ type: "item.rename", item_id: tonijn.id, name: "Tonijn?" }, "rename to a question mark"],
    // Not Tonijn into the cat's tuna: the household's SAME names may make that one product (public/shared/item-names.js).
    [{ type: "item.merge", from_item_id: tonijn.id, into_item_id: wasmiddel, on: localToday() }, "merge items that are not one thing", true],
  ];
  for (const [op, why, shapeOk = false] of refused) {
    assert.equal(reviewerMayApply(op), shapeOk, why);
    const res = await call(env, "POST", "/api/ops", { bearer: reviewer, body: { ops: [{ ...op, op_id: opId() }] } });
    assert.equal(res.status, 403, `the reviewer may not ${why}`);
  }
  // An excluded thing: never moved, never named.
  const sprouts = await call(env, "POST", "/api/ops", { bearer: reviewer, body: { ops: [
    { op_id: opId(), type: "product.move", product_id: "ah-product-groene-ster", item_id: minoes.id, on: localToday() }] } });
  assert.equal(sprouts.status, 403, "an excluded product is never moved");
  const named = await call(env, "POST", "/api/ops", { bearer: reviewer, body: { ops: [
    { op_id: opId(), type: "item.alias", id: "alias-review-sprt1", item_id: minoes.id, name: "Groenhof spruitjes" }] } });
  assert.equal(named.status, 403, "an excluded name is never an alias");
  // One bad op refuses the batch before anything is applied.
  const mixed = [
    { op_id: opId(), type: "item.alias", id: "alias-review-0002", item_id: minoes.id, name: "Poezentonijn" },
    { op_id: opId(), type: "item.merge", from_item_id: tonijn.id, into_item_id: wasmiddel, on: localToday() },
  ];
  assert.equal((await call(env, "POST", "/api/ops", { bearer: reviewer, body: { ops: mixed } })).status, 403);
  const all = await (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();
  assert.ok(!all.aliases.some((a) => a.name === "Poezentonijn"), "nothing of the refused batch");
  assert.ok(all.items.some((i) => i.id === tonijn.id), "Tonijn was not merged");
});

test("reviewer: no route but /api/sync and /api/ops; review.save is the reviewer's alone; a reviewer code is an admin's", async () => {
  const { env, thomas, reviewer } = await setup();
  const api = fs.readFileSync(path.join(ROOT, "worker/api.js"), "utf8");
  const routes = [...api.matchAll(/\["(GET|POST)", "(\/api\/[^"]+)", \w+(?:, (\{[^}]*\}))?\]/g)].map((m) => [m[1], m[2], m[3] ?? ""]);
  assert.ok(routes.length >= 15, "the route table was read");
  for (const [method, route, opts] of routes) {
    if (["/api/ops", "/api/sync"].includes(route) || opts.includes("open: true")) continue;
    const res = await call(env, method, method === "GET" ? `${route}?since=0` : route, { bearer: reviewer, body: method === "POST" ? {} : undefined });
    assert.equal(res.status, 403, `the reviewer may not ${method} ${route}`);
  }
  const report = { type: "review.save", day: localToday(), decide: ["Saus? samenvoegen?"] };
  assert.equal((await call(env, "POST", "/api/ops", { cookie: thomas, body: { ops: [{ ...report, op_id: opId() }] } })).status, 403, "not from a person");
  assert.equal(importerMayApply(report), false, "not from the importer");
  const sam = await (await call(env, "POST", "/api/codes", { cookie: thomas, body: { for: "new_member", name: "Sam" } })).json();
  const samToken = tokenOf(await call(env, "POST", "/api/pair", { body: { code: sam.code } }));
  assert.equal((await call(env, "POST", "/api/codes", { cookie: samToken, body: { for: "reviewer" } })).status, 403);
  const devices = await (await call(env, "GET", "/api/devices", { cookie: thomas })).json();
  assert.ok(devices.devices.some((d) => d.label === "Thuisserver controle"), "it shows (and can be revoked) like any device");
});

// -------------------------------------------------------------- review.save

test("review.save: one row per day, replaced by a second run, synced as reviews, checked", () => {
  const state = emptyState();
  const ctx = { memberId: "m1", isAdmin: true, now: "2026-10-30T06:30:00.000Z" };
  applyOp(state, { type: "review.save", day: "2026-10-30", run_ok: false, errors: ["Lidl: inloggen is verlopen."], fixed: [{ text: "A", undo: "B" }], decide: ["C?"], turns: 7, cost_cents: 12.4 }, ctx);
  const row = state.reviews["review-2026-10-30"];
  assert.deepEqual([row.run_ok, row.errors, row.fixed, row.decide, row.turns, row.cost_cents], [0, ["Lidl: inloggen is verlopen."], [{ text: "A", undo: "B" }], ["C?"], 7, 12]);
  applyOp(state, { type: "review.save", day: "2026-10-30", decide: [] }, { ...ctx, now: "2026-10-30T07:00:00.000Z" });
  assert.equal(Object.keys(state.reviews).length, 1, "the same day replaces");
  assert.deepEqual([state.reviews["review-2026-10-30"].run_ok, state.reviews["review-2026-10-30"].decide], [1, []]);
  assert.throws(() => applyOp(state, { type: "review.save", day: "gisteren" }, ctx), /bad_field/);
  assert.throws(() => applyOp(state, { type: "review.save", day: "2026-10-30", decide: Array(REVIEW_MAX_LINES + 1).fill("x") }, ctx), /bad_field/);
  assert.throws(() => applyOp(state, { type: "review.save", day: "2026-10-30", fixed: ["los"] }, ctx), /bad_field/);
  assert.ok(!GUEST_SYNCED.includes("reviews"), "a recipes-only person never gets the report");
});

// ------------------------------------------------------------ the prompt

test("prepare: the log tail and today's new purchases go into the prompt, once a day; the MCP config holds no token", () => {
  const home = tmp("home");
  fs.mkdirSync(path.join(home, "fetcher"));
  fs.copyFileSync(path.join(ROOT, "fetcher/review-prompt.md"), path.join(home, "fetcher/review-prompt.md"));
  const lines = ["2026-10-29T05:15:00Z lidl FAILED yesterday's error", "2026-10-30T05:15:00Z run start"];
  lines.push(...Array.from({ length: LOG_LINES + 30 }, (_, i) => `2026-10-30T05:17:${String(i % 60).padStart(2, "0")}Z line ${i}`));
  lines.push("2026-10-30T05:20:00Z lidl FAILED Lidl refresh refused", "2026-10-30T07:20:01+01:00 lidl exit 1");
  fs.writeFileSync(path.join(home, "fetcher.log"), lines.join("\n"));
  fs.mkdirSync(path.join(home, "ah-state"));
  fs.mkdirSync(path.join(home, "lidl-state"));
  const built = { products: [{ id: "ah-product-1", how: "guess" }], ops: [
    { type: "receipt.save" },
    { type: "purchase.add", bought_on: "2026-10-29", store: "Albert Heijn", title: "Tonijn", product: { id: "ah-product-1", brand: "AH", name: "AH Tonijn in water", size: "3 x 56 g" } },
  ] };
  fs.writeFileSync(path.join(home, "ah-state", NEW_PURCHASES_FILE), newPurchasesText(built, "AH"));
  const old = path.join(home, "lidl-state", NEW_PURCHASES_FILE);
  fs.writeFileSync(old, "Lidl: 1 new purchase\nYESTERDAY'S LINE");
  const now = Date.now();
  fs.utimesSync(old, new Date(now - 30 * 3600_000), new Date(now - 30 * 3600_000));
  const stateDir = path.join(home, "review-state");
  const household = path.join(home, "fetcher", "review-household.md");
  fs.writeFileSync(household, "- The cat is Minoes: tuna in water is Minoestuna.\n");

  assert.equal(prepare({ home, stateDir, today: "2026-10-30", now }), true);
  const prompt = fs.readFileSync(path.join(stateDir, "prompt.txt"), "utf8");
  assert.match(prompt, /Today is 2026-10-30\./);
  assert.match(prompt, /2026-10-29 Albert Heijn: AH AH Tonijn in water \(3 x 56 g\) \[ah-product-1\] -> Tonijn \(guess\)/);
  assert.match(prompt, /lidl FAILED Lidl refresh refused/);
  assert.ok(!prompt.includes(`line ${LOG_LINES + 28}\n`) || prompt.includes(`line ${LOG_LINES + 29}`), "the last lines are kept");
  assert.ok(!prompt.includes("line 0\n"), "older lines are cut");
  assert.ok(!prompt.includes("YESTERDAY'S LINE"), "yesterday's file is not today's run");
  assert.match(prompt, /lidl-state: not run today/);
  assert.ok(!/\{\{\w+\}\}/.test(prompt), "every placeholder is filled");
  assert.match(prompt, /Never touch anything on the household.s never-suggest list/);
  assert.match(prompt, /## The household's own rules\n\n- The cat is Minoes: tuna in water is Minoestuna\./, "the private rules go in");
  fs.rmSync(household);

  const mcp = JSON.parse(fs.readFileSync(path.join(stateDir, "mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(mcp.mcpServers), ["kitchen"]);
  assert.equal(mcp.mcpServers.kitchen.env.KITCHEN_TOKEN_FILE, path.join(home, "reviewer-token"));
  assert.ok(!("KITCHEN_TOKEN" in mcp.mcpServers.kitchen.env), "the token itself is never in the config");
  assert.ok(mcp.mcpServers.kitchen.args[0].endsWith(path.join("mcp", "server.mjs")));

  assert.equal(prepare({ home, stateDir, today: "2026-10-30", now }), false, "once a day");
  assert.equal(prepare({ home, stateDir, today: "2026-10-30", now, force: true }), true);
  assert.equal(prepare({ home, stateDir, today: "2026-10-31", now }), true);
  assert.match(fs.readFileSync(path.join(stateDir, "prompt.txt"), "utf8"), /## The household's own rules\n\n\(none\)/, "without them, the general rules only");
  assert.deepEqual(logErrors(logTail(lines.join("\n"))), ["lidl FAILED Lidl refresh refused", "lidl exit 1"]);
  assert.match(buildPrompt({ template: "{{LOG}}|{{PURCHASES}}", today: "x", log: "", purchases: "" }), /\(empty\)[\s\S]*\(none\)/);
  assert.equal(mcpConfig("/h", "https://x").mcpServers.kitchen.env.KITCHEN_ORIGIN, "https://x");
});

// ------------------------------------------------------------ the report

const result = (obj) => JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 9, total_cost_usd: 0.183, result: `Klaar.\n${JSON.stringify(obj)}` });

test("readReport: claude's answer becomes the report; every failure says why, a lost login how to log in again", () => {
  const good = readReport(result({ run_ok: true, errors: [], fixed: [{ text: "Tonijn in water staat nu bij Minoestuna.", undo: "Terug: Tonijn." }], decide: ["Saus? samenvoegen met Calvé saus?"] }));
  assert.equal(good.ok, true);
  assert.deepEqual(good.meta, { turns: 9, cost_usd: 0.183, subtype: "success" });
  assert.deepEqual(good.report.decide, ["Saus? samenvoegen met Calvé saus?"]);
  assert.match(reportText("2026-10-30", good.report), /Opgelost:\n- Tonijn in water staat nu bij Minoestuna\. \(Terug: Tonijn\.\)\nBeslissen:/);
  const op = reviewOp("2026-10-30", good.report, good.meta);
  assert.deepEqual([op.type, op.day, op.turns, op.cost_cents], ["review.save", "2026-10-30", 9, 18]);
  assert.equal(readReport(result({ run_ok: true, errors: ["AH: 2 bonnen geweigerd."] })).report.run_ok, false, "an error is never a good run");

  const login = ["Claude op je server moet opnieuw inloggen.", "ssh user@home-server.local", "cd ~/kitchen-fetcher && ~/.local/bin/claude, dan /login"];
  const expired = readReport(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login" }), { exitCode: 1, ssh: "user@home-server.local" });
  assert.deepEqual([expired.ok, expired.failure, expired.report.decide], [false, "auth", login]);
  const fromStderr = readReport("", { exitCode: 1, stderr: "OAuth token has expired. Please obtain a new token or refresh your existing token.", ssh: "user@home-server.local" });
  assert.deepEqual([fromStderr.failure, fromStderr.report.decide], ["auth", login]);
  assert.deepEqual(failureLines("auth", { ssh: "me@host" })[1], "ssh me@host");

  const cases = [
    [readReport("", { exitCode: 124 }), "timeout", "Nachtcontrole is niet gelukt: het duurde te lang."],
    [readReport(JSON.stringify({ subtype: "error_max_turns", is_error: true, num_turns: 26 }), { exitCode: 1 }), "turns", "Nachtcontrole is niet gelukt: er waren te veel stappen nodig."],
    [readReport("", { exitCode: 127 }), "missing", "Nachtcontrole is niet gelukt: Claude staat niet op de server."],
    [readReport(JSON.stringify({ subtype: "success", is_error: false, result: "Ik weet het niet." })), "unreadable", "Nachtcontrole is niet gelukt: het rapport was niet leesbaar."],
    [readReport("Segmentation fault", { exitCode: 139 }), "crash", "Nachtcontrole is niet gelukt: Claude stopte met een fout (code 139)."],
  ];
  for (const [r, failure, line] of cases) assert.deepEqual([r.ok, r.failure, r.report.decide], [false, failure, [line]], failure);
  const withRunError = readReport("", { exitCode: 124, tail: "2026-10-30T07:20:01+01:00 lidl exit 1" });
  assert.deepEqual([withRunError.report.run_ok, withRunError.report.errors], [false, ["lidl exit 1"]], "the run's own errors still show");
});

test("save: a report, a lost login and a timeout all reach the app through the reviewer token, and stay on the server", async () => {
  const { env, thomas, reviewer } = await setup();
  const post = (url, init) => worker.fetch(new Request(url.replace(/^https?:\/\/[^/]+/, ORIGIN), init), env);
  const home = tmp("save");
  const stateDir = path.join(home, "review-state");
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(home, "fetcher.log"), "2026-10-30T07:17:00+01:00 exit 0\n");
  const say = () => {};
  const run = async (day, raw, exitCode, stderr = "") => {
    fs.writeFileSync(path.join(stateDir, "claude.json"), raw);
    fs.writeFileSync(path.join(stateDir, "claude.err"), stderr);
    return save({ exitCode, home, stateDir, today: day, origin: ORIGIN, post, token: reviewer, say });
  };

  const ok = await run("2026-10-28", result({ run_ok: true, fixed: [], decide: ["Saus? samenvoegen met Calvé saus?"] }), 0);
  assert.equal(ok.ok, true);
  const expired = await run("2026-10-29", JSON.stringify({ is_error: true, result: "Not logged in · Please run /login" }), 1);
  assert.equal(expired.failure, "auth");
  const slow = await run("2026-10-30", "", 124);
  assert.equal(slow.failure, "timeout");

  const all = await (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();
  const byDay = Object.fromEntries(all.reviews.map((r) => [r.day, r]));
  assert.deepEqual(byDay["2026-10-28"].decide, ["Saus? samenvoegen met Calvé saus?"]);
  assert.equal(byDay["2026-10-29"].decide[0], "Claude op je server moet opnieuw inloggen.");
  assert.equal(byDay["2026-10-30"].decide[0], "Nachtcontrole is niet gelukt: het duurde te lang.");
  assert.match(fs.readFileSync(path.join(stateDir, "last.txt"), "utf8"), /^Nachtcontrole 2026-10-30\nRun: goed\nBeslissen:\n- Nachtcontrole is niet gelukt/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, "last.json"), "utf8")).failure, "timeout");
  // A refused report fails the step (the log says so), never silently.
  await assert.rejects(save({ exitCode: 0, home, stateDir, today: "2026-10-31", origin: ORIGIN, post, token: thomas, say }), /review\.save refused: 403/);
});

test("newPurchasesText: one line per new purchase with how it was mapped", () => {
  const text = newPurchasesText({ products: [{ id: "p1", how: "rule", table: true }], ops: [
    { type: "purchase.add", bought_on: "2026-10-30", store: "Lidl", title: "Melk", product: { id: "p1", name: "Milbona melk", size: "1 l" } },
  ] }, "Lidl");
  assert.equal(text, "Lidl: 1 new purchase\n2026-10-30 Lidl: Milbona melk (1 l) [p1] -> Melk (table)");
  assert.equal(newPurchasesText({ ops: [] }, "AH"), "AH: 0 new purchases");
});

// --------------------------------------------------------- the MCP tools

const SERVER = path.join(ROOT, "mcp", "server.mjs");
// The server gets the tests' made-up never-suggest list too (tests/never-suggest.mjs).
const NEVER_SUGGEST = pathToFileURL(path.join(ROOT, "tests", "never-suggest.mjs")).href;

async function liveWorker() {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "654321" }));
  const httpServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const response = await worker.fetch(new Request(`http://groceries.localhost${req.url}`, {
      method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
    }), env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${httpServer.address().port}`;
  const pair = async (code, label) => (await fetch(`${origin}/api/pair`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "http://groceries.localhost" }, body: JSON.stringify({ code, label }),
  })).headers.getSetCookie()[0].match(/^kd=([^;]+)/)[1];
  const thomas = await pair("654321", "phone");
  const code = await (await fetch(`${origin}/api/codes`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${thomas}` }, body: JSON.stringify({ for: "reviewer" }),
  })).json();
  const reviewer = await pair(code.code, "Thuisserver controle");
  return { env, origin, thomas, reviewer, close: () => httpServer.close() };
}

function mcp(env) {
  const child = spawn(process.execPath, ["--import", NEVER_SUGGEST, SERVER], { env: { ...process.env, ...env } });
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
  let k = 0;
  const tool = (name, args) => new Promise((resolve) => {
    const id = ++k;
    waiting.set(id, (msg) => resolve({ text: msg.result.content[0].text, error: Boolean(msg.result.isError) }));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
  });
  return { tool, close: () => child.kill() };
}

test("MCP with the reviewer's token file: recent purchases, a product moved (never an excluded thing), no merge", async () => {
  const live = await liveWorker();
  const dir = tmp("mcp");
  const tokenFile = path.join(dir, "reviewer-token");
  fs.writeFileSync(tokenFile, `${live.reviewer}\n`);
  // Thomas's own token as KITCHEN_TOKEN: the token file wins, so the server acts as the reviewer.
  const client = mcp({ KITCHEN_ORIGIN: live.origin, KITCHEN_TOKEN_FILE: tokenFile, KITCHEN_TOKEN: live.thomas });
  try {
    const seeded = await fetch(`${live.origin}/api/ops`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${live.thomas}` },
      body: JSON.stringify({ ops: [
        purchase("pur-review-mcp-tonijn", "Tonijn", { id: "ah-product-tonijn-water", name: "AH Tonijn in water", brand: "AH", size: "3 x 56 g" }),
        purchase("pur-review-mcp-minoes", "Minoestuna", { id: "ah-product-minoes-pouch", name: "Felix tonijn pouch", brand: "Felix", size: "85 g" }),
      ] }),
    });
    assert.equal(seeded.status, 200);
    await excludedRow(live.env);

    const recent = await client.tool("kitchen_recent_purchases", { days: 2 });
    assert.equal(recent.error, false, recent.text);
    assert.match(recent.text, /AH Tonijn in water, 3 x 56 g \[product: ah-product-tonijn-water\] → item Tonijn/);
    assert.match(recent.text, /candidate items: .*Minoestuna \[item: /, "the cat's tuna is offered as a candidate for the tuna in water");
    assert.ok(!/All items/.test(recent.text), "no list of every item any more");
    assert.ok(!/Groene Ster|Spruitjes/i.test(recent.text), "an excluded thing is never listed");

    const dry = await client.tool("kitchen_product_move", { product_id: "ah-product-tonijn-water", item: "minoestuna", dry_run: true });
    assert.match(dry.text, /Would move AH Tonijn in water, 3 x 56 g from Tonijn to Minoestuna, with 1 purchase\./);
    const moved = await client.tool("kitchen_product_move", { product_id: "ah-product-tonijn-water", item: "Minoestuna" });
    assert.equal(moved.error, false, moved.text);
    assert.match(moved.text, /Moved .* from Tonijn to Minoestuna \(1 purchases.*Undo: move it back to Tonijn\./);
    const sync = await (await fetch(`${live.origin}/api/sync?since=0`, { headers: { Authorization: `Bearer ${live.thomas}` } })).json();
    const minoes = sync.items.find((i) => i.name === "Minoestuna");
    assert.equal(sync.purchases.find((p) => p.id === "pur-review-mcp-tonijn").item_id, minoes.id);

    assert.match((await client.tool("kitchen_product_move", { product_id: "ah-product-groene-ster", item: "Minoestuna" })).text, /never-suggest list, never touched/);
    assert.match((await client.tool("kitchen_product_move", { product_id: "ah-product-tonijn-water", item: "Kattenvoer" })).text, /No item "Kattenvoer"/);
    await fetch(`${live.origin}/api/ops`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${live.thomas}` },
      body: JSON.stringify({ ops: [{ op_id: "op-review-mcp-wasm", type: "entry.add", id: "entry-review-mcp-wasm", item_id: "item-review-mcp-wasm", title: "Wasmiddel" }] }) });
    const merge = await client.tool("kitchen_item_merge", { from: "Tonijn", into: "Wasmiddel" });
    assert.deepEqual([merge.error, /403/.test(merge.text)], [true, true], "the server refuses a merge from the reviewer");
    const alias = await client.tool("kitchen_item_alias", { item: "Minoestuna", name: "Kattentonijn" });
    assert.match(alias.text, /"Kattentonijn" now means Minoestuna/);
  } finally {
    client.close();
    live.close();
  }
});

// ------------------------------------------------------------ the scripts

test("review.sh: off by default, last in run.sh, Claude locked to the kitchen tools; the files are deployed", () => {
  const run = fs.readFileSync(path.join(ROOT, "fetcher/run.sh"), "utf8");
  assert.ok(run.lastIndexOf("fetcher/review.sh") > run.indexOf("fetcher/prices.mjs"), "after the last run");
  const sh = fs.readFileSync(path.join(ROOT, "fetcher/review.sh"), "utf8");
  assert.match(sh, /\[ "\$\(setting REVIEW_MODE\)" = "on" \] \|\| exit 0/);
  assert.match(fs.readFileSync(path.join(ROOT, "fetcher/config.example.env"), "utf8"), /^REVIEW_MODE=off$/m);
  for (const flag of ['--tools ""', "--strict-mcp-config", "--permission-mode dontAsk", '--max-turns "$TURNS"', "--output-format json", '--max-budget-usd "$BUDGET"', "--disable-slash-commands", "--setting-sources project", '--system-prompt "$SYSTEM"']) {
    assert.ok(sh.includes(flag), `review.sh passes ${flag}`);
  }
  assert.match(sh, /timeout "\$SECONDS_MAX" "\$CLAUDE" -p/);
  assert.match(sh, /TURNS=25/);
  const tools = sh.match(/^TOOLS="([^"]+)"/m)[1].split(" ");
  assert.deepEqual(tools.sort(), ["kitchen_item_alias", "kitchen_pantry_get", "kitchen_prices", "kitchen_product_move", "kitchen_product_ratings", "kitchen_recent_purchases"].map((t) => `mcp__kitchen__${t}`));
  assert.ok(!/Bash|Edit|Write|merge|rate_set/.test(tools.join(" ")), "no shell, no files, no merge, no rates");
  // The report is saved whatever claude did.
  assert.match(sh, /CODE=\$\?\n(?:.*\n)*?.*review\.mjs" save "\$CODE"/);
  const deploy = fs.readFileSync(path.join(ROOT, "fetcher/deploy.mjs"), "utf8");
  for (const f of ["fetcher/review.mjs", "fetcher/review.sh", "fetcher/review-prompt.md", "mcp/server.mjs"]) assert.ok(deploy.includes(`["${f}", "${f}"]`), `${f} is deployed`);
  assert.ok(deploy.includes('"reviewer-token"'), "its token file is kept at mode 600");
});

test("lastRunLog: only the lines of the latest run; an older run or no marker says so instead of passing old errors", () => {
  const old = ["2026-10-29T06:17:00+01:00 run start", "2026-10-29T06:18:00+01:00 lidl FAILED token", "2026-10-29T06:18:01+01:00 lidl exit 1"];
  const mine = ["2026-10-30T06:17:00+01:00 run start", "2026-10-30T06:18:01+01:00 lidl exit 0"];
  const both = lastRunLog([...old, ...mine].join("\n"), "2026-10-30");
  assert.equal(both, mine.join("\n"), "the earlier run is gone");
  assert.ok(!both.includes("FAILED"));
  // A manual check before today's run: the tail is yesterday's run.
  const stale = lastRunLog(old.join("\n"), "2026-10-30");
  assert.match(stale, /no run today yet/);
  assert.ok(!stale.includes("FAILED") && !stale.includes("exit 1"), "old errors are not passed on");
  assert.match(lastRunLog("lidl FAILED token\nlidl exit 1", "2026-10-30"), /no run today yet/);
  assert.match(lastRunLog("", "2026-10-30"), /no run today yet/);
  // The household's day is Amsterdam's: 23:30 UTC on the 29th is already the 30th there.
  assert.equal(amsterdamDay("2026-10-29T23:30:00Z"), "2026-10-30");
  assert.match(lastRunLog("2026-10-29T23:30:00Z run start\n2026-10-29T23:31:00Z ah exit 0", "2026-10-30"), /ah exit 0/);
  // run.sh writes the marker the check looks for.
  const sh = fs.readFileSync(path.join(ROOT, "fetcher", "run.sh"), "utf8");
  assert.match(sh, /echo "\$\(date -Is\) run start" >> "\$LOG"/);
  assert.ok(sh.indexOf("run start") < sh.indexOf("fetch.mjs"), "the marker comes first");
  // The prompt is told what to do with it.
  assert.match(buildPrompt({ template: "{{LOG}}", today: "x", log: stale, purchases: "" }), /no run today yet/);
});

test("kitchen_recent_purchases: 1500 items stay under the cap, still with the right candidate; no all_items", async () => {
  const live = await liveWorker();
  const dir = tmp("big");
  const tokenFile = path.join(dir, "reviewer-token");
  fs.writeFileSync(tokenFile, `${live.reviewer}
`);
  const client = mcp({ KITCHEN_ORIGIN: live.origin, KITCHEN_TOKEN_FILE: tokenFile });
  try {
    const send = async (ops) => assert.equal((await fetch(`${live.origin}/api/ops`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${live.thomas}` }, body: JSON.stringify({ ops }),
    })).status, 200);
    await send([
      purchase("pur-big-tonijn", "Tonijn", { id: "ah-product-tonijn-water", name: "AH Tonijn in water", brand: "AH", size: "3 x 56 g" }),
      purchase("pur-big-minoes", "Minoestuna", { id: "ah-product-minoes-pouch", name: "Felix tonijn pouch", brand: "Felix", size: "85 g" }),
    ]);
    // 1500 more items, each with a purchase from today: far more than one answer may hold.
    for (let start = 0; start < 1500; start += 100) {
      await send(Array.from({ length: 100 }, (_, k) => {
        const i = start + k;
        return purchase(`pur-big-${i}`, `Zzitem ${i} tonijnsalade ${"x".repeat(60)}`, { id: `ah-product-big-${i}`, name: `Zzproduct ${i} ${"y".repeat(40)}`, brand: "AH", size: "1 kg" });
      }));
    }
    const recent = await client.tool("kitchen_recent_purchases", { days: 2 });
    assert.equal(recent.error, false, recent.text);
    assert.ok(recent.text.length <= 14_300, `capped, got ${recent.text.length}`);
    assert.match(recent.text, /\(cut off: \d+ more purchases not shown/);
    assert.match(recent.text, /AH Tonijn in water, 3 x 56 g \[product: ah-product-tonijn-water\] → item Tonijn/);
    assert.match(recent.text, /candidate items: .*Minoestuna \[item: /);
    const tonijnBlock = recent.text.split("\n- ").find((b) => b.includes("ah-product-tonijn-water"));
    assert.ok((tonijnBlock.split("candidate items: ")[1] ?? "").split(" | ").length <= 15, "at most 15 candidates per purchase");
    assert.ok(!/All items/.test(recent.text));
  } finally {
    client.close();
    live.close();
  }
});
