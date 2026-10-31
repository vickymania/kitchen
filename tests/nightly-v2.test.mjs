// Nightly check v2 (30-10-2026, after the first real night): a real
// "Terugdraaien" on every changelog line (change.undo; a merge is a true
// unmerge from the rows item.merge recorded), "Samenvoegen" / "Apart houden"
// on every question (item.apart, never asked again), purchases the capped
// output left out carried to the next night, junk names removed
// (item.remove) or merged into what they clearly mean, never renamed, and
// the resolver gaps of that night. Fictional names.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { applyOp, emptyState, OpError, decisionId, apartPair, keepFixed } from "../public/shared/ops.js";
import { nameKey, splitPrep } from "../public/shared/ingredients.js";
import { resolveIngredient, numberForms } from "../public/shared/ingredient-match.js";
import { reviewerMayApply } from "../worker/auth.js";
import * as dedupe from "../public/shared/dedupe.js";
import { linkRecipe, linksStale, LINK_HOWS } from "../public/shared/recipe-links.js";
import { nightlyFixes, recipeLinkOps, readReport, decideLine, markShownChecked, mcpConfig, CHECKED_FILE, SHOWN_FILE, save } from "../fetcher/review.mjs";
import { junkPlan, junkOps, planText, removeOpId } from "../tools/remove_junk_items.mjs";
import { simulate } from "../tools/dedupe_items.mjs";

const DAY = "2026-10-31";
const HOST = "groceries.localhost:8787";
const ORIGIN = `http://${HOST}`;
const NOW = "2026-10-31T05:30:00.000Z";
const ctx = (extra = {}) => ({ memberId: "member-v2-0001", isAdmin: true, now: NOW, ...extra });

// ------------------------------------------------------------- the engine

/** Two items of one thing with every kind of row item.merge moves, buries or revives. */
function mergeHouse() {
  const s = emptyState();
  const item = (id, name, extra = {}) => { s.items[id] = { id, name, name_key: nameKey(name), deleted_at: null, use_per_day: null, rate_source: null, again: null, low_at: null, low_off: null, not_yet_until: null, shelf_source: null, ...extra }; };
  item("item-v2-from", "x pastinaak", { again: "hide", low_at: 2 });
  item("item-v2-into", "Pastinaak");
  const row = (kind, id, extra) => { s[kind][id] = { id, deleted_at: null, created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z", ...extra }; };
  row("purchases", "pur-v2-0001", { item_id: "item-v2-from", title: "x pastinaak", bought_on: "2026-10-01" });
  row("purchases", "pur-v2-0002", { item_id: "item-v2-from", title: "x pastinaak", bought_on: "2026-10-02" });
  row("purchases", "pur-v2-0003", { item_id: "item-v2-into", title: "Pastinaak", bought_on: "2026-10-03" });
  row("products", "prod-v2-0001", { item_id: "item-v2-from", name: "Pastinaak los" });
  row("pantry", "pan-v2-00001", { item_id: "item-v2-from", title: "x pastinaak", amount: 1, added_on: "2026-10-01" });
  row("pantry_events", "pev-v2-00001", { item_id: "item-v2-from", pantry_id: "pan-v2-00001", reason: "used", amount: 0.5, happened_on: "2026-10-02" });
  row("entries", "ent-v2-open-f", { item_id: "item-v2-from", title: "x pastinaak", amounts: [{ qty: 2, unit: null }], sources: [], note: "voor soep", checked_at: null });
  row("entries", "ent-v2-open-i", { item_id: "item-v2-into", title: "Pastinaak", amounts: [{ qty: 1, unit: null }], sources: [], note: "", checked_at: null });
  row("entries", "ent-v2-done-f", { item_id: "item-v2-from", title: "x pastinaak", amounts: [], sources: [], note: "", checked_at: "2026-10-02T10:00:00.000Z" });
  row("preferences", "pref-v2-ah-f", { item_id: "item-v2-from", store: "AH", recipe_id: "", product_id: "prod-v2-0001" });
  row("preferences", "pref-v2-any-f", { item_id: "item-v2-from", store: "", recipe_id: "", product_id: "prod-v2-0001" });
  row("preferences", "pref-v2-any-i", { item_id: "item-v2-into", store: "", recipe_id: "", product_id: "prod-v2-other" });
  row("preferences", "pref-v2-lidl-f", { item_id: "item-v2-from", store: "Lidl", recipe_id: "", product_id: "prod-v2-0001" });
  row("preferences", "pref-v2-lidl-i", { item_id: "item-v2-into", store: "Lidl", recipe_id: "", product_id: "prod-v2-old", deleted_at: "2026-10-05T00:00:00.000Z" });
  row("deal_rules", "rule-v2-0001", { item_id: "item-v2-from", product_id: null, max_price_cents: 99 });
  row("aliases", "alias-v2-0001", { item_id: "item-v2-from", name: "pastinaakje", name_key: "pastinaakje" });
  return s;
}

const pick = (s) => ({
  items: Object.fromEntries(Object.values(s.items).map((i) => [i.id, [i.deleted_at, i.merged_into ?? null, i.again, i.low_at]])),
  rows: Object.fromEntries(["purchases", "products", "pantry", "pantry_events", "entries", "preferences", "deal_rules"].flatMap((k) =>
    Object.values(s[k]).map((r) => [r.id, [r.item_id, r.deleted_at ?? null, r.product_id ?? null, JSON.stringify(r.amounts ?? null), r.note ?? null]]))),
  aliases: Object.values(s.aliases).filter((a) => !a.deleted_at).map((a) => [a.name, a.item_id]).sort(),
});

test("unmerge: every row item.merge moved, folded, buried or revived goes back; into's taken settings too; the names stay apart", () => {
  const s = mergeHouse();
  const before = pick(s);
  const merged = applyOp(s, { type: "item.merge", from_item_id: "item-v2-from", into_item_id: "item-v2-into", on: DAY }, ctx()).result;
  assert.equal(merged.moved.entries_merged, 1);
  assert.equal(s.items["item-v2-into"].again, "hide", "into took the setting it lacked");
  const rec = s.items["item-v2-from"].undo_rows;
  assert.deepEqual(rec.rows.purchases.sort(), ["pur-v2-0001", "pur-v2-0002"], "exactly what moved is recorded");
  assert.deepEqual(rec.scoped.map((x) => [x.id, x.how]).sort(), [["pref-v2-ah-f", "moved"], ["pref-v2-any-f", "buried"], ["pref-v2-lidl-f", "revived"], ["rule-v2-0001", "moved"]]);
  // Something new on into after the merge stays there.
  s.purchases["pur-v2-later"] = { id: "pur-v2-later", item_id: "item-v2-into", title: "Pastinaak", bought_on: DAY, deleted_at: null };
  const undone = applyOp(s, { type: "item.unmerge", item_id: "item-v2-from", on: DAY }, ctx({ now: "2026-10-31T06:00:00.000Z" })).result;
  assert.equal(undone.into_id, "item-v2-into");
  delete s.purchases["pur-v2-later"];
  assert.deepEqual(pick(s).rows, before.rows, "every row back as it was");
  assert.deepEqual(pick(s).aliases, before.aliases, "the merged name is no alias of into any more; its own alias is back");
  assert.deepEqual(pick(s).items, before.items, "both items as before, the settings into took over given back");
  assert.equal(s.items["item-v2-from"].undo_rows, null);
  const [a, b] = apartPair("x pastinaak", "Pastinaak");
  assert.ok(s.decisions[decisionId("apart", a, b)], "kept apart from now on");
  // Again: nothing to do.
  assert.equal(applyOp(s, { type: "item.unmerge", item_id: "item-v2-from", on: DAY }, ctx()).result.already, true);
});

test("unmerge on a phone (no tombstones): pending, the changelog line marked; a merge without a record brings back the name only", () => {
  const s = emptyState();
  s.items["item-v2-into"] = { id: "item-v2-into", name: "Pastinaak", name_key: "pastinaak", deleted_at: null };
  s.auto_changes["ac-op-v2-merge"] = { id: "ac-op-v2-merge", day: DAY, what: "merge", name: "x pastinaak", target: "Pastinaak", item_id: "item-v2-into", undo: { from_item_id: "item-v2-gone" }, deleted_at: null };
  const r = applyOp(s, { type: "change.undo", change_id: "ac-op-v2-merge", on: DAY }, ctx({ partial: true })).result;
  assert.equal(r.pending, true);
  assert.ok(s.auto_changes["ac-op-v2-merge"].undone_at, "Teruggedraaid shows at once");
  assert.throws(() => applyOp(emptyState(), { type: "item.unmerge", item_id: "item-v2-gone", on: DAY }, ctx()), (e) => e instanceof OpError && e.code === "not_found");
  // A merge from before the record (30-10-2026): the name is its own item again, the rows stay.
  const old = emptyState();
  old.items["item-v2-into"] = { id: "item-v2-into", name: "Pastinaak", name_key: "pastinaak", deleted_at: null };
  old.items["item-v2-old"] = { id: "item-v2-old", name: "x pastinaak", name_key: "x pastinaak", deleted_at: "2026-10-30T05:00:00.000Z", merged_into: "item-v2-into" };
  old.aliases["ma-item-v2-old"] = { id: "ma-item-v2-old", item_id: "item-v2-into", name: "x pastinaak", name_key: "x pastinaak", deleted_at: null };
  old.auto_changes["ac-old-merge-1"] = { id: "ac-old-merge-1", day: "2026-10-30", what: "merge", name: "x pastinaak", target: "Pastinaak", item_id: "item-v2-into", deleted_at: null };
  const legacy = applyOp(old, { type: "change.undo", change_id: "ac-old-merge-1", on: DAY }, ctx()).result;
  assert.equal(legacy.rows_unknown, true);
  assert.equal(old.items["item-v2-old"].deleted_at, null);
  assert.ok(old.aliases["ma-item-v2-old"].deleted_at, "the name no longer lands on Pastinaak");
});

test("item.remove: the item and its lines, names, pantry rows and purchases become tombstones; unremove brings exactly those back; a product refuses", () => {
  const s = emptyState();
  s.items["item-v2-lunch"] = { id: "item-v2-lunch", name: "Lunch", name_key: "lunch", deleted_at: null };
  s.items["item-v2-real"] = { id: "item-v2-real", name: "Prei", name_key: "prei", deleted_at: null };
  s.entries["ent-v2-lunch"] = { id: "ent-v2-lunch", item_id: "item-v2-lunch", title: "Lunch", checked_at: null, deleted_at: null };
  s.purchases["pur-v2-lunch1"] = { id: "pur-v2-lunch1", item_id: "item-v2-lunch", title: "Lunch", bought_on: "2021-03-01", deleted_at: null };
  s.purchases["pur-v2-lunch0"] = { id: "pur-v2-lunch0", item_id: "item-v2-lunch", title: "Lunch", bought_on: "2020-03-01", deleted_at: "2020-04-01T00:00:00.000Z" };
  s.aliases["alias-v2-lunch"] = { id: "alias-v2-lunch", item_id: "item-v2-lunch", name: "lunchje", name_key: "lunchje", deleted_at: null };
  s.products["prod-v2-prei"] = { id: "prod-v2-prei", item_id: "item-v2-real", name: "Prei", deleted_at: null };
  const r = applyOp(s, { type: "item.remove", item_id: "item-v2-lunch", on: DAY }, ctx()).result;
  assert.deepEqual(r.removed, { entries: 1, aliases: 1, purchases: 1 });
  assert.ok(s.items["item-v2-lunch"].deleted_at && s.entries["ent-v2-lunch"].deleted_at && s.purchases["pur-v2-lunch1"].deleted_at);
  assert.throws(() => applyOp(s, { type: "item.remove", item_id: "item-v2-real", on: DAY }, ctx()), (e) => e.code === "has_products");
  applyOp(s, { type: "item.unremove", item_id: "item-v2-lunch" }, ctx({ now: "2026-10-31T07:00:00.000Z" }));
  assert.equal(s.items["item-v2-lunch"].deleted_at, null);
  assert.equal(s.entries["ent-v2-lunch"].deleted_at, null);
  assert.equal(s.purchases["pur-v2-lunch1"].deleted_at, null);
  assert.ok(s.purchases["pur-v2-lunch0"].deleted_at, "a row that was gone before stays gone");
  assert.ok(s.decisions[decisionId("keep", "item-v2-lunch", "")], "no junk from now on");
});

test("recipe.link_fix: the line links to the item picked, and the nightly links keep it", () => {
  const s = emptyState();
  s.items["item-v2-ui"] = { id: "item-v2-ui", name: "Uien", name_key: "uien", deleted_at: null };
  s.items["item-v2-rui"] = { id: "item-v2-rui", name: "Sjalot", name_key: "sjalot", deleted_at: null };
  s.recipes["rec-v2-soep1"] = { id: "rec-v2-soep1", title: "Soep", updated_at: "2026-10-01T00:00:00.000Z", deleted_at: null, ingredients: [{ name: "uien" }, { name: "zout" }] };
  const lines = linkRecipe(s.recipes["rec-v2-soep1"], s);
  applyOp(s, { type: "recipe.links", recipe_id: "rec-v2-soep1", at: "2026-10-01T00:00:00.000Z", lines }, ctx());
  applyOp(s, { type: "recipe.link_fix", recipe_id: "rec-v2-soep1", name: "uien", item_id: "item-v2-rui" }, ctx());
  assert.deepEqual(s.recipes["rec-v2-soep1"].ingredient_links.lines[0], { name: "uien", item_id: "item-v2-rui", item: "Sjalot", how: "person" });
  // The next night: its answer for the line is Uien, but the household's pick stays and nothing is sent.
  assert.deepEqual(recipeLinkOps(s).ops, [], "not stale: the fix is applied before comparing");
  applyOp(s, { type: "recipe.links", recipe_id: "rec-v2-soep1", at: "2026-10-01T00:00:00.000Z", lines }, ctx());
  assert.equal(s.recipes["rec-v2-soep1"].ingredient_links.lines[0].item, "Sjalot", "recipe.links never overrides it");
  assert.ok(LINK_HOWS.includes("person") && LINK_HOWS.includes("english"));
  assert.deepEqual(keepFixed([{ name: "zout", item_id: null, reason: "never" }], null), [{ name: "zout", item_id: null, reason: "never" }]);
});

// --------------------------------------------------------- the rules

function house(spec) {
  const s = emptyState();
  let n = 0;
  for (const [name, bought = 0, extra = {}] of spec) {
    const id = `item-v2-${String(++n).padStart(3, "0")}`;
    s.items[id] = { id, name, name_key: nameKey(name), deleted_at: null, use_per_day: null, rate_source: null, ...extra.item };
    for (let i = 0; i < bought; i++) s.purchases[`pur-v2-${n}-${i}`] = { id: `pur-v2-${n}-${i}`, item_id: id, title: name, bought_on: "2021-01-01", deleted_at: null };
    if (extra.product) s.products[`prod-v2-${n}`] = { id: `prod-v2-${n}`, item_id: id, name, deleted_at: null };
  }
  return s;
}
const byName = (s, name) => Object.values(s.items).find((i) => i.name === name)?.id;

test("junk: vague, shouted and several-things names never bought as a product; one that clearly means an item merges, a maybe is asked, the rest goes; never renamed", () => {
  for (const n of ["Lunch", "Meer tapas", "Iets op stokbroodje", "Electronica bak", "Ander fizzy", "Drankje", "Eten minoes!!!!!!!!"]) assert.ok(dedupe.junkReason(n), n);
  for (const n of ["Knoflookpoeder?", "Minoes eten", "Kattenbakvulling", "Tapas", "Stokbrood"]) assert.equal(dedupe.junkReason(n), null, n);
  const s = house([["Lunch", 4], ["Meer tapas", 1], ["Eten minoes!!!!!!!!", 2], ["Minoes eten", 3, { product: true }], ["Kattenbak!!!", 1],
    ["Kattenbakvulling", 5, { product: true }], ["Knoflookpoeder?", 2], ["Drankje", 1, { product: true }], ["Iets lekkers", 1, { item: { use_per_day: 0.1, rate_source: "person" } }]]);
  const plan = dedupe.nightlyPlan(dedupe.planGroups(s));
  const name = (id) => s.items[id].name;
  assert.deepEqual(plan.merges.map((m) => [name(m.from), name(m.into), m.how]), [["Eten minoes!!!!!!!!", "Minoes eten", "junk"]]);
  assert.deepEqual(plan.removes.map((r) => [name(r.id), r.reason]), [["Lunch", "vaag"], ["Meer tapas", "vaag"]]);
  assert.deepEqual(plan.junkAsks.map((j) => [name(j.from), name(j.into)]), [["Kattenbak!!!", "Kattenbakvulling"]]);
  assert.deepEqual(plan.renames.map((r) => r.was), ["Knoflookpoeder?"], "a thing with a bad spelling is tidied; junk never");
  assert.equal(dedupe.mergeProblem(dedupe.itemFacts(s)[byName(s, "Eten minoes!!!!!!!!")], dedupe.itemFacts(s)[byName(s, "Minoes eten")]), null, "the worker lets the junk merge through");
  const kept = dedupe.nightlyPlan(dedupe.planGroups(s), { decisions: dedupe.decisionSets([{ kind: "keep", a: byName(s, "Lunch"), b: "" }]) });
  assert.ok(!kept.removes.some((r) => r.id === byName(s, "Lunch")), "an undone removal is never done again");
  assert.equal(dedupe.nightlyPlan(dedupe.planGroups(s), { maxRemoves: 1 }).removes.length, 1, "capped; the rest the next night");
});

test("junk: a name of only vague words goes, even when a longer name starts with it; never asked (31-10-2026)", () => {
  for (const n of ["Eten voor Vic", "drankjesz", "Ontbijt"]) assert.equal(dedupe.junkReason(n), "vaag", n);
  for (const n of ["Ontbijtgranen", "Minoes eten", "Snoepjes"]) assert.equal(dedupe.junkReason(n), null, n);
  const s = house([["Drankje", 1], ["drankjesz", 1], ["Eten", 2], ["Eten voor Vic", 1], ["Ontbijt", 3], ["Ontbijtgranen", 6, { product: true }]]);
  const plan = dedupe.nightlyPlan(dedupe.planGroups(s));
  const name = (id) => s.items[id].name;
  assert.deepEqual(plan.junkAsks, []);
  assert.deepEqual(plan.removes.map((r) => name(r.id)).sort(), ["Drankje", "Eten", "Eten voor Vic", "Ontbijt", "drankjesz"]);
});

test("apart: two names kept apart are never grouped, merged or asked again; an undone rename is never redone", () => {
  const s = house([["Nootmuskaat", 3], ["Gemalen nootmuskaat", 1], ["Pastinaak", 2], ["x pastinaak", 1], ["Kerrie?", 1]]);
  const sync = (st) => Object.fromEntries(Object.entries(st).map(([k, rows]) => [k, Object.values(rows)]));
  const first = nightlyFixes(sync(s), { today: DAY, seen: [] });
  const q = first.decide.find((d) => d.text.startsWith("Nootmuskaat"));
  assert.deepEqual(q, { text: "Nootmuskaat en Gemalen nootmuskaat samenvoegen?", ids: [byName(s, "Nootmuskaat"), byName(s, "Gemalen nootmuskaat")], into: byName(s, "Nootmuskaat") });
  assert.ok(first.ops.some((o) => o.type === "item.merge"));
  for (const [x, y] of [["Nootmuskaat", "Gemalen nootmuskaat"], ["Pastinaak", "x pastinaak"]]) {
    applyOp(s, { type: "item.apart", names: [x, y] }, ctx());
  }
  s.decisions[decisionId("no_rename", byName(s, "Kerrie?"), "")] = { id: "x", kind: "no_rename", a: byName(s, "Kerrie?"), b: "", deleted_at: null };
  const after = nightlyFixes(sync(s), { today: DAY, seen: [] });
  assert.deepEqual(after.decide, [], "kept apart: never asked again, even with an empty seen list");
  assert.deepEqual(after.ops, [], "no merge of an apart pair, no rename the household undid");
  const g = dedupe.planGroups(s, { apart: dedupe.decisionSets(s.decisions).apart });
  assert.deepEqual([g.clear.length, g.doubt.length], [0, 0]);
  assert.throws(() => applyOp(s, { type: "item.apart", names: ["Nootmuskaat"] }, ctx()), (e) => e.code === "bad_field");
});

test("report: a question with ids or names survives review.save and readReport; plain lines stay lines", () => {
  const s = emptyState();
  applyOp(s, { type: "review.save", day: DAY, decide: ["Een vraag?", { text: "A en B samenvoegen?", ids: ["item-v2-aaaa", "item-v2-bbbb"], into: "item-v2-aaaa" }, { text: "Saus samenvoegen met Tomatensaus?", names: ["Saus", "Tomatensaus"] }] }, ctx());
  assert.deepEqual(s.reviews[`review-${DAY}`].decide, ["Een vraag?", { text: "A en B samenvoegen?", ids: ["item-v2-aaaa", "item-v2-bbbb"], into: "item-v2-aaaa" }, { text: "Saus samenvoegen met Tomatensaus?", names: ["Saus", "Tomatensaus"] }]);
  assert.throws(() => applyOp(s, { type: "review.save", day: DAY, decide: [{ text: "x", ids: ["bad id!"] }] }, ctx()), (e) => e.code === "bad_id");
  const raw = JSON.stringify({ result: JSON.stringify({ run_ok: true, errors: [], fixed: [], decide: [{ text: "Saus samenvoegen met Tomatensaus?", names: ["Saus", "Tomatensaus"] }, "Klopt de prijs?"] }), num_turns: 3, total_cost_usd: 0.1 });
  assert.deepEqual(readReport(raw).report.decide, [{ text: "Saus samenvoegen met Tomatensaus?", names: ["Saus", "Tomatensaus"] }, "Klopt de prijs?"]);
  assert.equal(decideLine({ text: "x", names: ["Een"] }), "x", "one name is no merge question");
});

// --------------------------------------------------------- the server

function call(env, method, p, { body, cookie, bearer } = {}) {
  const headers = { Origin: ORIGIN };
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`${ORIGIN}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
let n = 0;
const opId = () => `op-v2-${String(++n).padStart(6, "0")}`;

async function setup(items = []) {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const thomas = tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456", label: "phone" } }));
  const code = await (await call(env, "POST", "/api/codes", { cookie: thomas, body: { for: "reviewer" } })).json();
  const reviewer = tokenOf(await call(env, "POST", "/api/pair", { body: { code: code.code, label: "Thuisserver controle" } }));
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
  for (const [id, title, bought = 0] of items) {
    await env.DB.exec(`INSERT INTO items (id, household_id, name, name_key, created_at, rev) SELECT ${q(id)}, id, ${q(title)}, ${q(nameKey(title))}, 'x', 1 FROM households;`);
    for (let i = 0; i < bought; i++) {
      await env.DB.exec(`INSERT INTO purchases (id, household_id, item_id, title, bought_on, store, qty, source, created_at, rev)
        SELECT ${q(`pur-${id}-${i}`)}, id, ${q(id)}, ${q(title)}, '2021-10-01', 'AH', 1, 'history', 'x', 1 FROM households;`);
    }
  }
  return { env, thomas: { cookie: thomas }, reviewer: { bearer: reviewer } };
}
const send = async (env, who, ops) => {
  const res = await call(env, "POST", "/api/ops", { ...who, body: { ops: ops.map((o) => ({ op_id: opId(), ...o })) } });
  return { status: res.status, body: await res.json() };
};
const syncOf = async (env, who) => (await call(env, "GET", "/api/sync?since=0", who)).json();

test("server: the night merges, Thomas taps Terugdraaien, the purchases are back on their own item, and the night never merges them again", async () => {
  const { env, thomas, reviewer } = await setup([["item-v2-pastinaak", "Pastinaak", 3], ["item-v2-pastx", "x pastinaak", 2]]);
  await send(env, thomas, [{ type: "entry.add", id: "ent-v2-pastx", item_id: "item-v2-pastx", title: "x pastinaak" }]);
  const merge = { type: "item.merge", from_item_id: "item-v2-pastx", into_item_id: "item-v2-pastinaak", on: DAY };
  assert.equal((await send(env, reviewer, [merge])).status, 200);
  let all = await syncOf(env, thomas);
  assert.ok(!all.items.some((i) => i.id === "item-v2-pastx"));
  assert.ok(!all.items.some((i) => "undo_rows" in i), "the record never goes to a phone");
  const line = all.auto_changes.find((c) => c.what === "merge");
  assert.deepEqual(line.undo, { from_item_id: "item-v2-pastx" });
  const undo = await send(env, thomas, [{ type: "change.undo", change_id: line.id, on: DAY }]);
  assert.ok(undo.body.results[0].ok, JSON.stringify(undo.body));
  all = await syncOf(env, thomas);
  assert.equal(all.items.find((i) => i.id === "item-v2-pastx")?.name, "x pastinaak", "the item is back");
  assert.equal(all.purchases.filter((p) => p.item_id === "item-v2-pastx").length, 2, "its purchases are back");
  assert.equal(all.entries.find((e) => e.id === "ent-v2-pastx").item_id, "item-v2-pastx");
  assert.ok(all.auto_changes.find((c) => c.id === line.id).undone_at, "Teruggedraaid");
  assert.ok(!all.aliases.some((a) => a.name_key === "x pastinaak" && !a.deleted_at), "the old name lands on its own item again");
  assert.ok(all.decisions.some((d) => d.kind === "apart" && d.a_name && d.b_name), "kept apart, synced");
  // The night: the rules skip the pair, and the server refuses it anyway.
  assert.equal((await send(env, reviewer, [merge])).status, 403);
  const plan = nightlyFixes(all, { today: DAY, seen: [] });
  assert.ok(!plan.ops.some((o) => o.type === "item.merge"));
  // A second tap: nothing more.
  assert.equal((await send(env, thomas, [{ type: "change.undo", change_id: line.id, on: DAY }])).body.results[0].result.already, true);
});

test("server: an alias, a product move and a rename undone in one tap each, and the night is refused when it tries again", async () => {
  const { env, thomas, reviewer } = await setup([["item-v2-tonijn", "Tonijn", 1], ["item-v2-kat", "Kattentonijn", 1], ["item-v2-kerrie", "Kerrie?", 1]]);
  await send(env, thomas, [{ type: "purchase.add", id: "pur-v2-receipt1", item_id: "item-v2-new1", title: "Tonijn", bought_on: DAY, store: "Albert Heijn", qty: 1, price_cents: 129, source: "receipt",
    product: { id: "prod-v2-tonijnw", name: "Tonijn in water", brand: "AH", size: "3 x 56 g" } }]);
  const night = [
    { type: "item.alias", id: "alias-v2-katje", item_id: "item-v2-kat", name: "kattenvis", reason: "ander woord" },
    { type: "product.move", product_id: "prod-v2-tonijnw", item_id: "item-v2-kat", on: DAY },
    { type: "item.rename", item_id: "item-v2-kerrie", name: "Kerrie" },
  ];
  for (const op of night) assert.equal((await send(env, reviewer, [op])).status, 200, op.type);
  let all = await syncOf(env, thomas);
  const lines = Object.fromEntries(all.auto_changes.map((c) => [c.what, c]));
  assert.deepEqual(lines.move.undo, { from_item_id: "item-v2-tonijn" });
  for (const what of ["alias", "move", "rename"]) {
    const r = await send(env, thomas, [{ type: "change.undo", change_id: lines[what].id, on: DAY }]);
    assert.ok(r.body.results[0].ok, `${what}: ${JSON.stringify(r.body)}`);
  }
  all = await syncOf(env, thomas);
  assert.ok(!all.aliases.some((a) => a.name === "kattenvis"), "the alias is gone");
  assert.equal(all.products.find((p) => p.id === "prod-v2-tonijnw").item_id, "item-v2-tonijn", "the product is back");
  assert.equal(all.purchases.find((p) => p.id === "pur-v2-receipt1").item_id, "item-v2-tonijn", "with what was bought of it");
  assert.equal(all.items.find((i) => i.id === "item-v2-kerrie").name, "Kerrie?", "the old spelling is back");
  assert.ok(all.auto_changes.every((c) => c.undone_at));
  for (const op of night) assert.equal((await send(env, reviewer, [op])).status, 403, `${op.type} is never done again`);
});

test("server: the night removes junk only (never a product's item, never one kept), logs it, and Terugdraaien brings it back", async () => {
  const { env, thomas, reviewer } = await setup([["item-v2-lunch", "Lunch", 3], ["item-v2-prei", "Prei", 1]]);
  await send(env, thomas, [{ type: "entry.add", id: "ent-v2-lunch", item_id: "item-v2-lunch", title: "Lunch" }]);
  assert.ok(reviewerMayApply({ type: "item.remove", item_id: "item-v2-lunch", on: DAY }));
  assert.equal((await send(env, reviewer, [{ type: "item.remove", item_id: "item-v2-prei", on: DAY }])).status, 403, "Prei is no junk");
  const r = await send(env, reviewer, [{ type: "item.remove", item_id: "item-v2-lunch", on: DAY, reason: "vaag" }]);
  assert.equal(r.status, 200);
  let all = await syncOf(env, thomas);
  assert.ok(!all.items.some((i) => i.id === "item-v2-lunch"));
  assert.ok(!all.entries.some((e) => e.id === "ent-v2-lunch"), "its list line went too");
  assert.ok(!all.purchases.some((p) => p.item_id === "item-v2-lunch"), "and the old notes");
  const line = all.auto_changes.find((c) => c.what === "remove");
  assert.deepEqual([line.name, line.reason], ["Lunch", "vaag"]);
  assert.ok((await send(env, thomas, [{ type: "change.undo", change_id: line.id, on: DAY }])).body.results[0].ok);
  all = await syncOf(env, thomas);
  assert.ok(all.items.some((i) => i.id === "item-v2-lunch"));
  assert.equal(all.purchases.filter((p) => p.item_id === "item-v2-lunch").length, 3);
  assert.ok(all.entries.some((e) => e.id === "ent-v2-lunch"));
  assert.equal((await send(env, reviewer, [{ type: "item.remove", item_id: "item-v2-lunch", on: DAY }])).status, 403, "kept: never removed again");
});

test("server: Samenvoegen and Apart houden from a phone; the report keeps its question objects", async () => {
  const { env, thomas, reviewer } = await setup([["item-v2-noot", "Nootmuskaat", 3], ["item-v2-gnoot", "Gemalen nootmuskaat", 1], ["item-v2-komijn", "Komijn", 1], ["item-v2-gkomijn", "Gemalen komijn", 1]]);
  const saved = await send(env, reviewer, [{ type: "review.save", day: DAY, decide: [{ text: "Nootmuskaat en Gemalen nootmuskaat samenvoegen?", ids: ["item-v2-noot", "item-v2-gnoot"], into: "item-v2-noot" }] }]);
  assert.equal(saved.status, 200);
  assert.ok((await send(env, thomas, [{ type: "item.merge", from_item_id: "item-v2-gnoot", into_item_id: "item-v2-noot", on: DAY }])).body.results[0].ok);
  assert.ok((await send(env, thomas, [{ type: "item.apart", names: ["Komijn", "Gemalen komijn"] }])).body.results[0].ok);
  const all = await syncOf(env, thomas);
  assert.equal(typeof all.reviews[0].decide[0], "object");
  assert.equal(all.auto_changes.length, 0, "a person's merge is no line of the night");
  const plan = nightlyFixes(all, { today: DAY, seen: [] });
  assert.deepEqual(plan.decide, [], "neither question comes back");
  // A person's merge is recorded too: it can be unmerged.
  assert.ok((await send(env, thomas, [{ type: "item.unmerge", item_id: "item-v2-gnoot", on: DAY }])).body.results[0].ok);
  assert.ok((await syncOf(env, thomas)).purchases.some((p) => p.item_id === "item-v2-gnoot"));
});

// ------------------------------------------------- carried-over purchases

test("carry-over: what the capped tool showed tonight is checked, the rest waits; a stale shown file is dropped", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-v2-carry-"));
  fs.writeFileSync(path.join(dir, SHOWN_FILE), JSON.stringify(["pur-a", "pur-b"]));
  assert.deepEqual(markShownChecked(dir), { checked: 2, added: 2 });
  fs.writeFileSync(path.join(dir, SHOWN_FILE), JSON.stringify(["pur-b", "pur-c"]));
  assert.deepEqual(markShownChecked(dir), { checked: 3, added: 1 });
  assert.ok(!fs.existsSync(path.join(dir, SHOWN_FILE)));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, CHECKED_FILE), "utf8")), ["pur-a", "pur-b", "pur-c"]);
  const env = mcpConfig("/srv/kitchen", "https://example.test", dir).mcpServers.kitchen.env;
  assert.deepEqual([env.KITCHEN_CHECKED_FILE, env.KITCHEN_SHOWN_FILE], [path.join(dir, CHECKED_FILE), path.join(dir, SHOWN_FILE)]);
  // save() checks tonight's shown purchases off and never puts a cap note in the report.
  fs.writeFileSync(path.join(dir, SHOWN_FILE), JSON.stringify(["pur-d"]));
  const posted = [];
  await save({ exitCode: 0, home: dir, stateDir: dir, today: DAY, token: "t".repeat(24), say: () => {},
    post: async (_url, init) => { posted.push(JSON.parse(init.body)); return new Response(JSON.stringify({ results: [{ ok: true }] }), { status: 200 }); } });
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, CHECKED_FILE), "utf8")).includes("pur-d"));
  assert.equal(posted.length, 1);
});

// --------------------------------------------------------- the resolver

test("resolver: rode uien, kokosmelk light, sesamzaad ter garnering", () => {
  const items = {};
  for (const name of ["Rode ui", "Uien", "Kokosmelk", "Sesamzaad"]) items[`item-${nameKey(name)}`] = { id: `item-${nameKey(name)}`, name, name_key: nameKey(name), deleted_at: null };
  const r = (n) => resolveIngredient(n, { items, aliases: {} })?.item.name ?? null;
  assert.equal(r("rode uien"), "Rode ui", "ui/uien with its colour word");
  assert.equal(r("uien"), "Uien");
  assert.equal(r("kokosmelk light"), "Kokosmelk");
  assert.equal(r("Sesamzaad ter garnering"), "Sesamzaad");
  assert.equal(r("sesamzaad, ter garnering"), "Sesamzaad");
  assert.deepEqual(splitPrep("koriander ter garnering"), { name: "koriander", note: "ter garnering" });
  assert.deepEqual(numberForms("uien"), ["ui"]);
  assert.ok(numberForms("ui").includes("uien"));
  assert.equal(r("rode peper"), null, "a colour is never dropped");
});

// --------------------------------------------------------- the junk tool

test("remove_junk_items: the dry run lists what goes and what goes along; --name takes an item along; a product never", () => {
  const s = house([["Lunch", 2], ["Eten minoes!!!", 1], ["Minoes eten", 3, { product: true }], ["Kattenbak!!!", 1], ["Kattenbakvulling", 2, { product: true }],
    ["Bami pakket", 1], ["Prei", 2, { product: true }]]);
  s.entries["ent-v2-lunch1"] = { id: "ent-v2-lunch1", item_id: byName(s, "Lunch"), title: "Lunch", checked_at: null, deleted_at: null };
  const plan = junkPlan(s, { names: ["Bami pakket", "Prei"] });
  const name = (id) => s.items[id].name;
  assert.deepEqual(plan.merges.map((m) => [name(m.from), name(m.into)]), [["Eten minoes!!!", "Minoes eten"]]);
  assert.deepEqual(plan.removes.map((r) => [name(r.id), r.reason]), [["Bami pakket", "genoemd"], ["Lunch", "vaag"]]);
  assert.deepEqual(plan.asks.map((a) => name(a.from)), ["Kattenbak!!!"]);
  assert.deepEqual(plan.skipped.map((x) => [name(x.id), x.why]), [["Prei", "heeft producten"]]);
  const ops = junkOps(plan, DAY);
  assert.equal(ops.find((o) => o.type === "item.remove" && o.item_id === byName(s, "Lunch")).op_id, removeOpId(byName(s, "Lunch")), "the nightly check's op id: a replay");
  const outcomes = simulate(s, ops, NOW);
  assert.ok(outcomes.every((o) => o.ok));
  const text = planText(s, plan, outcomes);
  assert.match(text, /Lunch \(vaag\): 1 lijstregels, 2 aankopen/);
  assert.match(text, /Kattenbak!!! samenvoegen met Kattenbakvulling\?/);
  assert.equal(junkPlan(s, { keepNames: ["Lunch"] }).removes.some((r) => name(r.id) === "Lunch"), false);
});

// ------------------------------------------------ with both languages (0029)

test("English names: a merge hands over the from-item's English name and unmerge gives it back; removal and unremoval keep it", () => {
  const s = mergeHouse();
  Object.assign(s.items["item-v2-from"], { name_en: "Parsnip", name_en_key: "parsnip", name_en_source: "person" });
  applyOp(s, { type: "item.merge", from_item_id: "item-v2-from", into_item_id: "item-v2-into", on: DAY }, ctx());
  assert.equal(s.items["item-v2-into"].name_en, "Parsnip", "into had none: it takes it over");
  applyOp(s, { type: "item.unmerge", item_id: "item-v2-from", on: DAY }, ctx({ now: "2026-10-31T06:00:00.000Z" }));
  assert.deepEqual([s.items["item-v2-into"].name_en, s.items["item-v2-into"].name_en_key], [null, null], "given back");
  assert.equal(s.items["item-v2-from"].name_en, "Parsnip");
  const r = emptyState();
  r.items["item-v2-lunch"] = { id: "item-v2-lunch", name: "Lunch", name_key: "lunch", name_en: "Lunch", name_en_key: "lunch", name_en_source: "claude", deleted_at: null };
  applyOp(r, { type: "item.remove", item_id: "item-v2-lunch", on: DAY }, ctx());
  applyOp(r, { type: "item.unremove", item_id: "item-v2-lunch" }, ctx({ now: "2026-10-31T07:00:00.000Z" }));
  assert.deepEqual([r.items["item-v2-lunch"].name_en, r.items["item-v2-lunch"].name_en_source], ["Lunch", "claude"]);
});

test("server: the night's English name undone in one tap and never sent again; never a private item's; decisions about a private item stay private", async () => {
  const { env, thomas, reviewer } = await setup([["item-v2-prei", "Prei", 1], ["item-v2-geheim", "Geheimpje", 0], ["item-v2-geheim2", "Geheimpje 2", 0]]);
  const tr = { type: "item.translate", item_id: "item-v2-prei", name_en: "Leak", source: "claude" };
  assert.equal((await send(env, reviewer, [tr])).status, 200);
  let all = await syncOf(env, thomas);
  const line = all.auto_changes.find((c) => c.what === "translate");
  assert.deepEqual(line.undo, { name_en: null, name_en_source: null });
  assert.ok((await send(env, thomas, [{ type: "change.undo", change_id: line.id, on: DAY }])).body.results[0].ok);
  all = await syncOf(env, thomas);
  assert.equal(all.items.find((i) => i.id === "item-v2-prei").name_en ?? null, null, "the English name before");
  assert.equal((await send(env, reviewer, [tr])).status, 403, "never the same again");
  assert.equal((await send(env, reviewer, [{ ...tr, name_en: "Leek" }])).status, 200, "a better one may come");
  // Private to Thomas (the reviewer's own member): the night never touches it.
  assert.ok((await send(env, thomas, [{ type: "item.private", item_id: "item-v2-geheim", private: true }, { type: "item.private", item_id: "item-v2-geheim2", private: true }])).body.results.every((x) => x.ok));
  assert.equal((await send(env, reviewer, [{ type: "item.translate", item_id: "item-v2-geheim", name_en: "Secret", source: "claude" }])).status, 403);
  assert.equal((await send(env, reviewer, [{ type: "item.remove", item_id: "item-v2-geheim", on: DAY }])).status, 403);
  // Thomas keeps two private names apart; another member never sees that decision.
  assert.ok((await send(env, thomas, [{ type: "item.apart", names: ["Geheimpje", "Geheimpje 2"] }])).body.results[0].ok);
  assert.equal((await syncOf(env, thomas)).decisions.filter((d) => d.kind === "apart").length, 1);
  const inv = await (await call(env, "POST", "/api/codes", { ...thomas, body: { for: "new_member", name: "Sam" } })).json();
  const sam = tokenOf(await call(env, "POST", "/api/pair", { body: { code: inv.code, label: "sam phone" } }));
  const theirs = await syncOf(env, { cookie: sam });
  assert.ok(theirs.items && !theirs.items.some((i) => i.id === "item-v2-geheim"), "Sam is a member who may not see it");
  assert.equal(theirs.decisions.filter((d) => d.kind === "apart").length, 0, "nor the decision about it");
});
