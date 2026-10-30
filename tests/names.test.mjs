// Names that link to the right item (30-10-2026: "Als ik iets op mijn
// lijstje zet moet hij het echt aan het juiste product koppelen, anders heeft
// die hele database geen zin"). Other names per item (item.alias), the
// space- and case-free lookup findItem does on the phone and the server, the
// add box's suggestions (public/shared/suggest.js), the relink of a line, and
// the widget's names list. Typos only ever suggest; they never link.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv, applyMigration } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { applyOp, emptyState, findItem, OpError } from "../public/shared/ops.js";
import { nameKey } from "../public/shared/ingredients.js";
import { suggest, exactItem, didYouMean, editDistance, SUGGEST_MAX } from "../public/shared/suggest.js";
import { NAMES_MAX } from "../worker/widget.js";
import { importerMayApply } from "../worker/auth.js";

const DAY = "2026-10-30";
const ctx = { memberId: "member-thomas-01", isAdmin: true, now: `${DAY}T10:00:00.000Z` };
const apply = (s, op) => applyOp(s, op, ctx);
const key = (name) => nameKey(name);
const refused = (fn, code) => assert.throws(fn, (e) => e instanceof OpError && e.code === code);

const BROKKEN = "item-names-brokken";
const BROOD = "item-names-tbrood";

/** Minoes brokken (bought often, with "Pluizenbolbrokkenman"), Minoes brood, Uien, Ui, Jus d'orange, Groenhof. */
function house() {
  const s = emptyState();
  const add = (id, title) => apply(s, { type: "entry.add", id: `entry-${id}`, item_id: id, title });
  add(BROKKEN, "Minoes brokken");
  add(BROOD, "Minoes brood");
  add("item-names-uien01", "Uien");
  add("item-names-ui0001", "Ui");
  add("item-names-jus001", "Jus d'orange");
  add("item-names-hein01", "Groenhof");
  for (const [i, d] of ["2026-10-20", "2026-10-06", "2026-09-22"].entries()) {
    apply(s, { type: "purchase.add", id: `purchase-names-${i}0`, item_id: BROKKEN, title: "Minoes brokken", bought_on: d, source: "history" });
  }
  apply(s, { type: "purchase.add", id: "purchase-names-b0", item_id: BROOD, title: "Minoes brood", bought_on: "2025-01-01", source: "history" });
  apply(s, { type: "item.alias", id: "alias-names-pluiz", item_id: BROKKEN, name: "Pluizenbolbrokkenman" });
  return s;
}

// ------------------------------------------------------------ findItem

test("findItem: case, spaces and hyphens do not count; an alias and a merged name land on the item; a typo never", () => {
  const s = house();
  for (const typed of ["minoesbrokken", "Minoesbrokken", "MINOES BROKKEN", "minoes-brokken", "Pluizenbolbrokkenman", "pluizenbol brokkenman"]) {
    assert.equal(findItem(s, key(typed))?.id, BROKKEN, typed);
  }
  for (const typed of ["mines brokkken", "minor brokken", "brokkn", "Pluiz", "Mino"]) assert.equal(findItem(s, key(typed)), null, typed);
  assert.equal(findItem(s, key("Minoes brood"))?.id, BROOD);
  assert.equal(findItem(s, key("ui"))?.id, "item-names-ui0001", "the exact item, never Uien");
});

test("findItem: two items that differ only in spaces are ambiguous, never a guess", () => {
  // Two such items from before (the To Do history): a new one cannot be made,
  // "Kipfilet" typed now lands on "Kip filet".
  const s = emptyState();
  for (const [id, name] of [["item-amb-00001", "Kip filet"], ["item-amb-00002", "Kipfilet"]]) {
    s.items[id] = { id, name, name_key: key(name), created_at: ctx.now, deleted_at: null };
  }
  assert.equal(findItem(s, key("kip filet"))?.id, "item-amb-00001", "the exact one still wins");
  assert.equal(findItem(s, key("ki pfilet")), null, "a third spelling: both fit, so neither");
  const shown = suggest(s, "kipfi", { today: DAY }).map((r) => r.item.name).sort();
  assert.deepEqual(shown, ["Kip filet", "Kipfilet"], "both are suggested");
});

// ------------------------------------------------------------ the list

test("entry.add: 'minoesbrokken' links to Minoes brokken and keeps what was typed; a typo makes a new item marked new", () => {
  const s = house();
  apply(s, { type: "entry.delete", id: `entry-${BROKKEN}` });
  const linked = apply(s, { type: "entry.add", id: "entry-names-typed1", item_id: "item-names-new001", title: "minoesbrokken" }).result;
  assert.deepEqual(linked, { item_id: BROKKEN, new_item: false });
  const e = s.entries["entry-names-typed1"];
  assert.deepEqual([e.item_id, e.title, e.typed, e.new_item], [BROKKEN, "Minoes brokken", "minoesbrokken", 0]);
  apply(s, { type: "entry.delete", id: "entry-names-typed1" });
  const typo = apply(s, { type: "entry.add", id: "entry-names-typo01", item_id: "item-names-typo01", title: "mines brokkken" }).result;
  assert.deepEqual(typo, { item_id: "item-names-typo01", new_item: true });
  assert.equal(s.entries["entry-names-typo01"].new_item, 1);
  assert.equal(s.entries["entry-names-typo01"].typed, null, "its own name");
  assert.equal(didYouMean(s, "mines brokkken", "item-names-typo01", { today: DAY })?.item.id, BROKKEN, "Bedoel je Minoes brokken?");
});

test("entry.add with a known item's id (a tapped suggestion) links to it whatever the title", () => {
  const s = house();
  apply(s, { type: "entry.delete", id: `entry-${BROKKEN}` });
  const r = apply(s, { type: "entry.add", id: "entry-names-tap001", item_id: BROKKEN, title: "Mino" }).result;
  assert.deepEqual(r, { item_id: BROKKEN, new_item: false });
  assert.equal(Object.values(s.items).filter((i) => i.name_key === "mino").length, 0, "no item 'Mino'");
});

test("entry.update relink: a new item's line goes to the known item, keeps the typed text, and the unused new item is dropped", () => {
  const s = house();
  apply(s, { type: "entry.delete", id: `entry-${BROKKEN}` });
  apply(s, { type: "entry.add", id: "entry-names-typo02", item_id: "item-names-typo02", title: "mines brokkken" });
  const { changed } = apply(s, { type: "entry.update", id: "entry-names-typo02", title: "Minoes brokken", item_id: BROKKEN });
  const e = s.entries["entry-names-typo02"];
  assert.deepEqual([e.item_id, e.title, e.typed, e.new_item], [BROKKEN, "Minoes brokken", "mines brokkken", 0]);
  assert.ok(s.items["item-names-typo02"].deleted_at, "the stray item is gone (a tombstone)");
  assert.ok(changed.some(([k, id]) => k === "items" && id === "item-names-typo02"));
  // Typed again later: the tombstone of that name comes back, no second row.
  apply(s, { type: "entry.delete", id: "entry-names-typo02" });
  apply(s, { type: "entry.add", id: "entry-names-typo03", item_id: "item-names-typo03", title: "mines brokkken" });
  assert.equal(s.entries["entry-names-typo03"].item_id, "item-names-typo02");
  assert.equal(s.items["item-names-typo02"].deleted_at, null);
});

test("entry.update relink: an item that has other rows is never dropped; a line that did not make its item drops nothing", () => {
  const s = house();
  apply(s, { type: "entry.add", id: "entry-names-new03", item_id: "item-names-new003", title: "Brokjes" });
  apply(s, { type: "purchase.add", id: "purchase-names-k0", item_id: "item-names-new003", title: "Brokjes", bought_on: DAY, source: "history" });
  apply(s, { type: "entry.update", id: "entry-names-new03", title: "Minoes brood", item_id: BROOD });
  assert.equal(s.items["item-names-new003"].deleted_at, null, "a purchase keeps it");
  apply(s, { type: "entry.delete", id: "entry-item-names-uien01" });
  apply(s, { type: "entry.add", id: "entry-names-uien2", item_id: "item-names-uien02", title: "uien" });
  assert.equal(s.entries["entry-names-uien2"].new_item, 0, "Uien was known");
  apply(s, { type: "entry.update", id: "entry-names-uien2", title: "Minoes brokken", item_id: BROKKEN });
  assert.equal(s.items["item-names-uien01"].deleted_at, null, "Uien was not this line's own new item");
});

// ------------------------------------------------------------ item.alias

test("item.alias: never a live item's name or another's without spaces; its own name is already; remove and add again revives", () => {
  const s = house();
  refused(() => apply(s, { type: "item.alias", id: "alias-names-x0001", item_id: BROKKEN, name: "Minoes brood" }), "name_taken");
  refused(() => apply(s, { type: "item.alias", id: "alias-names-x0002", item_id: BROKKEN, name: "minoesbrood" }), "name_taken");
  refused(() => apply(s, { type: "item.alias", id: "alias-names-x0003", item_id: BROOD, name: "Pluizenbol brokkenman" }), "name_taken");
  assert.deepEqual(apply(s, { type: "item.alias", id: "alias-names-x0004", item_id: BROKKEN, name: "MINOES BROKKEN" }).result, { already: true });
  assert.deepEqual(apply(s, { type: "item.alias", id: "alias-names-x0005", item_id: BROKKEN, name: "pluizenbolbrokkenman" }).result, { already: true });
  apply(s, { type: "item.alias", item_id: BROKKEN, name: "Pluizenbolbrokkenman", remove: true });
  assert.equal(findItem(s, key("Pluizenbolbrokkenman")), null);
  const again = apply(s, { type: "item.alias", id: "alias-names-x0006", item_id: BROKKEN, name: "Pluizenbolbrokkenman" }).result;
  assert.equal(again.alias_id, "alias-names-pluiz", "one row per name ever: revived");
  assert.equal(Object.keys(s.aliases).length, 1);
  assert.equal(findItem(s, key("pluizenbolbrokkenman"))?.id, BROKKEN);
});

test("item.alias: 'Cola' merged into Frisdrank becomes Sodastream cola's name, on the phone (alias row) and the server (tombstone)", () => {
  const s = emptyState();
  apply(s, { type: "entry.add", id: "entry-cola-0001", item_id: "item-cola-frisdr", title: "Frisdrank" });
  apply(s, { type: "entry.add", id: "entry-cola-0002", item_id: "item-cola-cola01", title: "Cola" });
  apply(s, { type: "entry.add", id: "entry-cola-0003", item_id: "item-cola-sodast", title: "Sodastream cola" });
  apply(s, { type: "item.merge", from_item_id: "item-cola-cola01", into_item_id: "item-cola-frisdr", on: DAY });
  assert.equal(findItem(s, key("cola"))?.id, "item-cola-frisdr", "the merge made Cola an alias of Frisdrank");
  assert.equal(s.aliases["ma-item-cola-cola01"]?.item_id, "item-cola-frisdr", "as an alias row the phones see");
  const r = apply(s, { type: "item.alias", id: "alias-cola-00001", item_id: "item-cola-sodast", name: "Cola" }).result;
  assert.deepEqual(r, { alias_id: "ma-item-cola-cola01", taken_from: "item-cola-frisdr" });
  assert.equal(s.items["item-cola-cola01"].merged_into, "item-cola-sodast", "the tombstone follows (the server reads it)");
  assert.equal(findItem(s, key("cola"))?.id, "item-cola-sodast");
  // The phone keeps no tombstones: the alias row alone answers the same.
  const phone = { items: Object.fromEntries(Object.entries(s.items).filter(([, i]) => !i.deleted_at)), aliases: s.aliases, purchases: {} };
  assert.equal(findItem(phone, key("Cola"))?.id, "item-cola-sodast");
  assert.equal(suggest(phone, "cola", { today: DAY })[0].item.id, "item-cola-sodast");
  assert.equal(exactItem(phone, "COLA")?.id, "item-cola-sodast");
});

test("item.merge: the from-item's aliases go along and its own name becomes an alias row; never for the importer", () => {
  const s = house();
  apply(s, { type: "entry.add", id: "entry-names-kibb1", item_id: "item-names-kibble", title: "Kattenbrokken" });
  apply(s, { type: "item.alias", id: "alias-names-kib01", item_id: "item-names-kibble", name: "Brokjes kat" });
  apply(s, { type: "item.merge", from_item_id: "item-names-kibble", into_item_id: BROKKEN, on: DAY });
  assert.equal(s.aliases["alias-names-kib01"].item_id, BROKKEN);
  assert.equal(s.aliases["ma-item-names-kibble"].name, "Kattenbrokken");
  for (const typed of ["Brokjes kat", "kattenbrokken"]) assert.equal(findItem(s, key(typed))?.id, BROKKEN, typed);
  assert.equal(importerMayApply({ type: "item.alias", item_id: BROKKEN, name: "x" }), false);
});

// ------------------------------------------------------------ suggestions

test("suggest: 'Mino' gives Minoes brokken (bought often and lately) before Minoes brood; 'Pluiz' gives Minoes brokken through its other name", () => {
  const s = house();
  assert.deepEqual(suggest(s, "Mino", { today: DAY }).map((r) => r.item.name), ["Minoes brokken", "Minoes brood"]);
  const [pluiz, ...rest] = suggest(s, "Pluiz", { today: DAY });
  assert.deepEqual([pluiz.item.id, pluiz.via, rest.length], [BROKKEN, "Pluizenbolbrokkenman", 0]);
  assert.equal(suggest(s, "brokk", { today: DAY })[0].item.id, BROKKEN, "any word start");
});

test("suggest: exact before without-spaces before word start before typo; typos still find it", () => {
  const s = house();
  const top = (text) => suggest(s, text, { today: DAY })[0];
  assert.deepEqual([top("MINOES BROKKEN").item.id, top("MINOES BROKKEN").tier], [BROKKEN, 0]);
  assert.deepEqual([top("minoesbrokken").item.id, top("minoesbrokken").tier], [BROKKEN, 1]);
  assert.deepEqual([top("Minoesbrokken").item.id, top("Minoesbrokken").tier], [BROKKEN, 1]);
  for (const typo of ["mines brokkken", "minor brokken", "brokkn"]) {
    assert.deepEqual([top(typo)?.item.id, top(typo)?.tier], [BROKKEN, 3], typo);
    assert.equal(exactItem(s, typo), null, `Enter never links "${typo}"`);
  }
  assert.equal(exactItem(s, "minoesbrokken")?.id, BROKKEN, "Enter links the same name without spaces");
});

test("suggest: no noise: 'Minoes brood' is only Minoes brood, 'ui' never finds 'jus', a short word gets no typos", () => {
  const s = house();
  assert.deepEqual(suggest(s, "Minoes brood", { today: DAY }).map((r) => r.item.name), ["Minoes brood"]);
  assert.equal(exactItem(s, "Minoes brood")?.id, BROOD);
  assert.deepEqual(suggest(s, "ui", { today: DAY }).map((r) => [r.item.name, r.tier]), [["Ui", 0], ["Uien", 2]], "Ui first; Uien only as a word start");
  assert.deepEqual(suggest(s, "jus", { today: DAY }).map((r) => r.item.name), ["Jus d'orange"]);
  assert.deepEqual(suggest(s, "uj", { today: DAY }), [], "two letters never match by typo");
  assert.equal(editDistance("ui", "jus", 2), 2);
});

test("suggest: excluded only when the text names it exactly; at most six rows", () => {
  const s = house();
  assert.deepEqual(suggest(s, "hein", { today: DAY }), [], "no Groenhof from a start");
  assert.deepEqual(suggest(s, "groenho", { today: DAY }), [], "nor from a typo");
  assert.equal(suggest(s, "Groenhof", { today: DAY })[0]?.item.name, "Groenhof", "typed in full: it is what he means");
  for (let i = 0; i < 9; i++) apply(s, { type: "entry.add", id: `entry-names-many${i}`, item_id: `item-names-many0${i}`, title: `Minoes snack ${i}` });
  assert.equal(suggest(s, "minoes", { today: DAY }).length, SUGGEST_MAX);
});

// ------------------------------------------------------------ D1

const HOST = "groceries.localhost:8787";
function call(env, method, path, { body, bearer } = {}) {
  const headers = {};
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`http://${HOST}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
let n = 0;
const op = (o) => ({ op_id: `op-names-${String(++n).padStart(6, "0")}`, ...o });

async function household(options) {
  const env = await makeEnv(options);
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const thomas = tokenOf(await worker.fetch(new Request(`http://${HOST}/api/pair`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: `http://${HOST}` }, body: JSON.stringify({ code: "123456", label: "test" }),
  }), env));
  const send = async (...ops) => (await (await call(env, "POST", "/api/ops", { bearer: thomas, body: { ops: ops.map(op) } })).json()).results;
  return { env, thomas, send };
}

test("D1: the server links without spaces and by other names, refuses a taken name, relinks, and the Cola alias takes over", async () => {
  const { env, thomas, send } = await household();
  await send(
    { type: "entry.add", id: "entry-d1-brokken", item_id: BROKKEN, title: "Minoes brokken" },
    { type: "entry.add", id: "entry-d1-brood01", item_id: BROOD, title: "Minoes brood" },
    { type: "entry.check", id: "entry-d1-brokken", checked: true },
  );
  let [r] = await send({ type: "entry.add", id: "entry-d1-typed01", item_id: "item-d1-new00001", title: "minoesbrokken" });
  assert.deepEqual(r.result, { item_id: BROKKEN, new_item: false });
  [r] = await send({ type: "item.alias", id: "alias-d1-pluiz01", item_id: BROKKEN, name: "Pluizenbolbrokkenman" });
  assert.equal(r.ok, true);
  [r] = await send({ type: "item.alias", id: "alias-d1-taken01", item_id: BROOD, name: "Pluizenbol brokkenman" });
  assert.deepEqual([r.ok, r.error], [false, "name_taken"]);
  [r] = await send({ type: "item.alias", id: "alias-d1-taken02", item_id: BROOD, name: "MinoesBrokken" });
  assert.deepEqual([r.ok, r.error], [false, "name_taken"]);
  // A typo: a new item, then relinked; the stray item gets a tombstone on D1.
  await send({ type: "entry.delete", id: "entry-d1-typed01" });
  [r] = await send({ type: "entry.add", id: "entry-d1-typo001", item_id: "item-d1-typo0001", title: "mines brokkken" });
  assert.deepEqual(r.result, { item_id: "item-d1-typo0001", new_item: true });
  [r] = await send({ type: "entry.update", id: "entry-d1-typo001", title: "Minoes brokken", item_id: BROKKEN });
  assert.equal(r.ok, true);
  const row = await env.DB.prepare("SELECT item_id, typed, new_item FROM list_entries WHERE id = 'entry-d1-typo001'").first();
  assert.deepEqual({ ...row }, { item_id: BROKKEN, typed: "mines brokkken", new_item: 0 });
  assert.ok((await env.DB.prepare("SELECT deleted_at FROM items WHERE id = 'item-d1-typo0001'").first()).deleted_at);
  [r] = await send({ type: "entry.add", id: "entry-d1-pluiz01", item_id: "item-d1-new00002", title: "pluizenbolbrokkenman" });
  assert.equal(r.result.item_id, BROKKEN, "the other name, server side");
  // Cola: merged into Frisdrank, then Sodastream cola's name.
  await send(
    { type: "entry.add", id: "entry-d1-frisdr1", item_id: "item-d1-frisdrank", title: "Frisdrank" },
    { type: "entry.add", id: "entry-d1-cola001", item_id: "item-d1-cola00001", title: "Cola" },
    { type: "entry.add", id: "entry-d1-soda001", item_id: "item-d1-sodastrm1", title: "Sodastream cola" },
  );
  [r] = await send({ type: "item.merge", from_item_id: "item-d1-cola00001", into_item_id: "item-d1-frisdrank", on: DAY });
  assert.equal(r.ok, true);
  [r] = await send({ type: "item.alias", id: "alias-d1-cola001", item_id: "item-d1-sodastrm1", name: "Cola" });
  assert.deepEqual(r.result, { alias_id: "ma-item-d1-cola00001", taken_from: "item-d1-frisdrank" });
  await send({ type: "entry.check", id: "entry-d1-soda001", checked: true });
  [r] = await send({ type: "entry.add", id: "entry-d1-cola002", item_id: "item-d1-new00003", title: "cola" });
  assert.deepEqual(r.result, { item_id: "item-d1-sodastrm1", new_item: false });
  // The phones get the alias rows with the pull.
  const sync = await (await call(env, "GET", "/api/sync?since=0", { bearer: thomas })).json();
  assert.deepEqual(sync.aliases.map((a) => [a.name, a.item_id]).sort(), [["Cola", "item-d1-sodastrm1"], ["Pluizenbolbrokkenman", BROKKEN]]);
});

test("D1 migration: every name merged before 0022 becomes an alias row at the live end, with a new rev", async () => {
  // The rows as 0020's merges left them: Wc blok -> Toiletblok -> Toiletblokken.
  const { env } = await household({ before: "0022" });
  await env.DB.exec(`INSERT INTO items (id, household_id, name, name_key, created_at, deleted_at, merged_into, rev)
    SELECT 'item-mig-wcblok01', id, 'Wc blok', 'wc blok', 'x', 'x', 'item-mig-toilet01', 1 FROM households;
    INSERT INTO items (id, household_id, name, name_key, created_at, deleted_at, merged_into, rev)
    SELECT 'item-mig-toilet01', id, 'Toiletblok', 'toiletblok', 'x', 'x', 'item-mig-toilet02', 1 FROM households;
    INSERT INTO items (id, household_id, name, name_key, created_at, deleted_at, merged_into, rev)
    SELECT 'item-mig-toilet02', id, 'Toiletblokken', 'toiletblokken', 'x', NULL, NULL, 1 FROM households;`);
  const before = (await env.DB.prepare("SELECT rev FROM households").first()).rev;
  applyMigration(env, "0022");
  const { results } = await env.DB.prepare("SELECT id, name, item_id, rev FROM item_aliases ORDER BY name").all();
  assert.deepEqual(results.map((a) => [a.id, a.name, a.item_id]), [
    ["ma-item-mig-toilet01", "Toiletblok", "item-mig-toilet02"],
    ["ma-item-mig-wcblok01", "Wc blok", "item-mig-toilet02"],
  ]);
  assert.ok(results.every((a) => a.rev > before), "the phones fetch them");
});

test("widget names: the most bought first, with other names and product, never an excluded thing, at most NAMES_MAX; a tap adds that item", async () => {
  const { env, thomas, send } = await household();
  const ops = [];
  for (let i = 0; i < NAMES_MAX + 40; i++) ops.push({ type: "entry.add", id: `entry-wn-${String(i).padStart(6, "0")}`, item_id: `item-wn-${String(i).padStart(6, "0")}`, title: `Ding ${i}` });
  ops.push({ type: "entry.add", id: "entry-wn-brokken", item_id: BROKKEN, title: "Minoes brokken" });
  ops.push({ type: "entry.add", id: "entry-wn-groenho", item_id: "item-wn-groenhof", title: "Groenhof" });
  for (let i = 0; i < ops.length; i += 100) await send(...ops.slice(i, i + 100));
  await send(
    { type: "purchase.add", id: "purchase-wn-00001", item_id: BROKKEN, title: "Minoes brokken", bought_on: DAY, source: "history" },
    { type: "purchase.add", id: "purchase-wn-00002", item_id: "item-wn-groenhof", title: "Groenhof", bought_on: DAY, source: "history" },
    { type: "item.alias", id: "alias-wn-pluiz01", item_id: BROKKEN, name: "Pluizenbolbrokkenman" },
    { type: "product.put", id: "product-wn-brokken", product: { name: "Minoes Brokken kip", brand: "AH", size: "2 kg", item_id: BROKKEN } },
    { type: "preference.set", id: "pref-wn-brokken01", item_id: BROKKEN, product_id: "product-wn-brokken" },
  );
  const res = await call(env, "GET", "/api/widget/names", { bearer: thomas });
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.names.length, NAMES_MAX);
  assert.ok(text.length < 40_000, `bounded: ${text.length} bytes`);
  assert.deepEqual(body.names[0], { i: BROKKEN, n: "Minoes brokken", s: 1, a: ["Pluizenbolbrokkenman"], p: "AH Minoes Brokken kip · 2 kg" });
  assert.ok(!body.names.some((x) => /groenhof/i.test(x.n)), "never an excluded thing, also when bought");
  // The widget's tap: quick-add with the item's id and name, the amount from the text.
  await send({ type: "entry.check", id: "entry-wn-brokken", checked: true });
  const add = await (await call(env, "POST", "/api/quick-add", { bearer: thomas, body: { text: "2 mino", op_id: "quickadd-wn-0001", item_id: BROKKEN, title: "Minoes brokken" } })).json();
  assert.deepEqual(add.result, { item_id: BROKKEN, new_item: false });
  const line = await env.DB.prepare("SELECT title, amounts, typed FROM list_entries WHERE id = 'quickadd-wn-0001'").first();
  assert.deepEqual({ ...line, amounts: JSON.parse(line.amounts) }, { title: "Minoes brokken", amounts: [{ qty: 2, unit: null }], typed: null });
});
