// Cooking before the receipt is in, and "… gekookt?" (28-10-2026: he
// shops, cooks the same evening, the receipt arrives the next morning; the
// receipt is leading, not his ticks). Pending takes: cookPending, pantry.pend,
// paid by a receipt purchase within PENDING_DAYS, undone with the cook. The
// prompt: cookPrompts (pure), the rows the engine writes on a tick or a
// receipt, and "nog niet" synced through recipe.cook_prompt.
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { applyOp, emptyState, OpError, cookPromptId } from "../public/shared/ops.js";
import { cookPending, cookTakes, pendingFits, PENDING_DAYS } from "../public/shared/pantry.js";
import { cookPrompts, PROMPT_DAYS } from "../public/shared/cook-prompts.js";
import { importerMayApply } from "../worker/auth.js";

const RECIPE = {
  id: "recipe-pasta-001", title: "Pastapotje HenkTorino", servings: 2,
  ingredients: [
    { name: "spaghetti", qty: 500, unit: "g" },
    { name: "ui", qty: 2, unit: null },
    { name: "zout", qty: null, unit: null },
    { name: "water", qty: 1, unit: "l" },
    { name: "snufje peper", qty: 1, unit: "pinch" },
  ],
};

// ------------------------------------------------------------ pure

test("cookPending: what the pantry lacks, in the ingredient's terms; the part a row covered is not pending", () => {
  const data = { pantry: {}, items: {}, pantry_events: {}, pending_takes: {} };
  const none = cookPending({ recipe: RECIPE, data, today: "2026-10-28" });
  assert.deepEqual(none.map((p) => [p.name, p.qty, p.unit]), [["spaghetti", 500, "g"], ["ui", 2, null]],
    "salt, tap water and a pinch never wait for a receipt");
  // Half a pack of 500 g in the house: 250 g taken, 250 g pending.
  data.pantry["pantry-spag-001"] = { id: "pantry-spag-001", item_id: "item-spag-0001", title: "Spaghetti", amount: 0.5, taken: 0.5,
    pack_size: "500 g", added_on: "2026-10-20", use_by: null, deleted_at: null };
  data.items["item-spag-0001"] = { id: "item-spag-0001", name: "Spaghetti", name_key: "spaghetti" };
  const half = cookPending({ recipe: RECIPE, data, today: "2026-10-28" });
  assert.deepEqual(half.find((p) => p.name === "spaghetti"), {
    name: "spaghetti", name_key: "spaghetti", item_id: "item-spag-0001", qty: 250, unit: "g", default_portion: false,
  });
  assert.deepEqual(cookTakes({ recipe: RECIPE, data, today: "2026-10-28" }).map((t) => [t.pantry_id, t.amount]), [["pantry-spag-001", 0.5]]);
  // Scaled to the servings cooked.
  const four = cookPending({ recipe: RECIPE, data: { pantry: {}, items: {} }, today: "2026-10-28", scale: (i) => ({ ...i, qty: i.qty * 2 }) });
  assert.deepEqual(four.map((p) => p.qty), [1000, 4]);
  // Already taken off or left pending today: one meal, nothing more.
  data.pending_takes["pending-x-00001"] = { id: "pending-x-00001", recipe_id: RECIPE.id, cooked_on: "2026-10-28", status: "pending" };
  assert.deepEqual(cookPending({ recipe: RECIPE, data, today: "2026-10-28" }), []);
  assert.equal(cookPending({ recipe: RECIPE, data, today: "2026-10-29" }).length, 2, "another day is another meal");
});

test("pendingFits: open, the same thing, bought from MATCH_DAYS before to PENDING_DAYS after the cook", () => {
  const p = { status: "pending", name_key: "spaghetti", item_id: null, cooked_on: "2026-10-28" };
  const row = (added_on, title = "Spaghetti") => ({ item_id: "item-x", title, added_on });
  assert.equal(PENDING_DAYS, 3);
  assert.equal(pendingFits(p, row("2026-10-29")), true, "the next morning");
  assert.equal(pendingFits(p, row("2026-10-31")), true, "three days later");
  assert.equal(pendingFits(p, row("2026-11-01")), false, "four days later: not this cook");
  assert.equal(pendingFits(p, row("2026-10-26")), true, "bought two days before, receipt late");
  assert.equal(pendingFits(p, row("2026-10-25")), false);
  assert.equal(pendingFits(p, row("2026-10-29", "Rijst")), false, "another thing");
  assert.equal(pendingFits({ ...p, status: "done" }, row("2026-10-29")), false);
  assert.equal(pendingFits({ ...p, item_id: "item-x", name_key: "iets anders" }, row("2026-10-29")), true, "the same item");
});

test("pantry.pend validates; pantry.unpend is the undo", () => {
  const s = emptyState();
  const ctx = { memberId: "member-thomas-01", isAdmin: true, now: "2026-10-28T19:00:00.000Z" };
  const pend = (pending) => applyOp(s, { type: "pantry.pend", recipe_id: RECIPE.id, on: "2026-10-28", pending }, ctx);
  assert.throws(() => pend([]), OpError);
  assert.throws(() => pend([{ id: "pending-a-00001", name: "ui", qty: 0 }]), OpError);
  assert.throws(() => pend([{ id: "pending-a-00001", name: "ui", qty: 1, unit: "bucket" }]), OpError);
  assert.throws(() => pend([{ id: "bad", name: "ui", qty: 1 }]), OpError);
  const out = pend([{ id: "pending-a-00001", name: "ui", qty: 2, unit: null }]);
  assert.deepEqual(out.result, { pending: ["pending-a-00001"] });
  assert.deepEqual(pend([{ id: "pending-a-00001", name: "ui", qty: 2 }]).changed, [], "a replay writes nothing");
  const p = s.pending_takes["pending-a-00001"];
  assert.deepEqual([p.status, p.cooked_on, p.name_key, p.recipe_id], ["pending", "2026-10-28", "ui", RECIPE.id]);
  applyOp(s, { type: "pantry.unpend", ids: ["pending-a-00001"] }, ctx);
  assert.ok(p.deleted_at);
  assert.equal(importerMayApply({ type: "pantry.pend" }), false);
});

test("cookPrompts: from the day after shopping, at most PROMPT_DAYS days, not when cooked, snoozed today or dismissed", () => {
  const view = {
    recipes: { [RECIPE.id]: RECIPE },
    cooks: {},
    cook_prompts: { a: { id: "a", recipe_id: RECIPE.id, listed_on: "2026-10-26", shopped_on: "2026-10-27", entry_ids: ["e"], snoozed_on: null, dismissed_at: null, deleted_at: null } },
  };
  const ask = (today) => cookPrompts(view, today).map((x) => `${x.title}|${x.shopped_on}`);
  assert.equal(PROMPT_DAYS, 3);
  assert.deepEqual(ask("2026-10-27"), [], "never on the day of the shopping");
  assert.deepEqual(ask("2026-10-28"), ["Pastapotje HenkTorino|2026-10-27"]);
  assert.deepEqual(ask("2026-10-30"), ["Pastapotje HenkTorino|2026-10-27"], "the third day");
  assert.deepEqual(ask("2026-10-31"), [], "then never");
  view.cook_prompts.a.snoozed_on = "2026-10-28";
  assert.deepEqual(ask("2026-10-28"), [], "\"nog niet\": not again today");
  assert.equal(ask("2026-10-29").length, 1, "asked again the next day");
  view.cooks.c = { id: "c", recipe_id: RECIPE.id, cooked_on: "2026-10-20", deleted_at: null };
  assert.equal(ask("2026-10-29").length, 1, "a cook before it was put on the list is another meal");
  view.cooks.c.cooked_on = "2026-10-27";
  assert.deepEqual(ask("2026-10-29"), [], "cook mode or \"Gegeten\" already said so (even on the shopping day)");
  view.cooks.c.deleted_at = "x";
  view.cook_prompts.a.dismissed_at = "x";
  assert.deepEqual(ask("2026-10-29"), []);
  view.cook_prompts.a.dismissed_at = null;
  view.recipes[RECIPE.id] = { ...RECIPE, deleted_at: "x" };
  assert.deepEqual(ask("2026-10-29"), [], "a deleted recipe");
});

test("engine: a tick of a line for a recipe writes its prompt row once; an untick of the last line removes it; snooze and dismiss", () => {
  const s = emptyState();
  const ctx = { memberId: "member-thomas-01", isAdmin: true, now: "2026-10-27T17:00:00.000Z" };
  s.recipes[RECIPE.id] = { ...RECIPE, deleted_at: null };
  const src = { recipe_id: RECIPE.id, title: RECIPE.title };
  applyOp(s, { type: "entry.add", id: "entry-spag-0001", item_id: "item-spag-0001", title: "Spaghetti", source: src }, ctx);
  applyOp(s, { type: "entry.add", id: "entry-ui-000001", item_id: "item-ui-000001", title: "Ui", source: src }, ctx);
  applyOp(s, { type: "entry.add", id: "entry-melk-0001", item_id: "item-melk-00001", title: "Melk" }, ctx);
  assert.deepEqual(applyOp(s, { type: "entry.check", id: "entry-melk-0001", checked: true, on: "2026-10-27" }, ctx).changed.map(([k]) => k).sort(), ["entries", "pantry"],
    "a line without a recipe writes nothing more");
  applyOp(s, { type: "entry.check", id: "entry-spag-0001", checked: true, on: "2026-10-27" }, ctx);
  const t2 = applyOp(s, { type: "entry.check", id: "entry-ui-000001", checked: true, on: "2026-10-27" }, ctx);
  const pid = cookPromptId(RECIPE.id, "2026-10-27");
  assert.deepEqual(s.cook_prompts[pid].entry_ids, ["entry-spag-0001", "entry-ui-000001"]);
  assert.ok(t2.changed.some(([k]) => k === "cook_prompts"));
  assert.deepEqual([s.cook_prompts[pid].listed_on, s.cook_prompts[pid].shopped_on], ["2026-10-27", "2026-10-27"]);

  applyOp(s, { type: "entry.check", id: "entry-ui-000001", checked: false }, ctx);
  assert.equal(s.cook_prompts[pid].deleted_at, null, "one line left");
  applyOp(s, { type: "entry.check", id: "entry-spag-0001", checked: false }, ctx);
  assert.ok(s.cook_prompts[pid].deleted_at, "a mistap taken back: no question tomorrow");
  applyOp(s, { type: "entry.check", id: "entry-spag-0001", checked: true, on: "2026-10-27" }, ctx);
  assert.equal(s.cook_prompts[pid].deleted_at, null, "ticked again: back");

  const prompt = (o) => applyOp(s, { type: "recipe.cook_prompt", recipe_id: RECIPE.id, shopped_on: "2026-10-27", ...o }, ctx);
  assert.throws(() => prompt({ action: "later" }), OpError);
  assert.throws(() => prompt({ action: "snooze", shopped_on: "2026-10-01" }), (e) => e.code === "not_found");
  prompt({ action: "snooze", on: "2026-10-28" });
  assert.equal(s.cook_prompts[pid].snoozed_on, "2026-10-28");
  assert.deepEqual(prompt({ action: "snooze", on: "2026-10-28" }).changed, [], "the same again: nothing");
  prompt({ action: "dismiss" });
  assert.ok(s.cook_prompts[pid].dismissed_at);
});

// ------------------------------------------------------------ on the worker

const HOST = "groceries.localhost";
function call(env, method, p, { body, cookie } = {}) {
  const headers = { Origin: `http://${HOST}` };
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`http://${HOST}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
async function household() {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  return { env, thomas: tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456" } })) };
}
let counter = 0;
const op = (o) => ({ op_id: `op-cookfirst-${String(++counter).padStart(6, "0")}`, ...o });
async function send(env, cookie, ops) {
  const results = (await (await call(env, "POST", "/api/ops", { cookie, body: { ops } })).json()).results;
  results.forEach((r) => assert.equal(r.ok, true, JSON.stringify(r)));
  return results;
}
const view = async (env, cookie) => {
  const all = await (await call(env, "GET", "/api/sync?since=0", { cookie })).json();
  return Object.fromEntries(Object.entries(all).map(([k, v]) => [k, Array.isArray(v) ? Object.fromEntries(v.map((r) => [r.id, r])) : v]));
};

/** The cook as markCooked sends it: recipe.cooked, then the pending takes the pantry could not cover. */
async function cook(env, cookie, day, n) {
  await send(env, cookie, [op({ type: "recipe.cooked", id: `cook-${n}-0000001`, recipe_id: RECIPE.id, cooked_on: day })]);
  const pending = cookPending({ recipe: RECIPE, data: await view(env, cookie), today: day }).map((p, i) => ({ ...p, id: `pending-${n}-${i}-000` }));
  assert.ok(pending.length);
  await send(env, cookie, [op({ type: "pantry.pend", recipe_id: RECIPE.id, cook_id: `cook-${n}-0000001`, on: day, pending })]);
  return pending;
}
const receipt = (id, day, title, qty, product) => op({
  type: "purchase.add", id, source: "receipt", pantry: true, title, item_id: `item-${id}`.slice(0, 40), bought_on: day, qty, product,
});
const spaghetti = { id: "product-spag-001", name: "Spaghetti", brand: "AH", size: "500 g" };

test("D1: cooked with nothing in the house, the receipt the next morning leaves bought minus cooked", async () => {
  const { env, thomas } = await household();
  await send(env, thomas, [op({ type: "recipe.put", id: RECIPE.id, recipe: RECIPE })]);
  const pending = await cook(env, thomas, "2026-10-28", "a");
  assert.deepEqual(pending.map((p) => [p.name, p.qty]), [["spaghetti", 500], ["ui", 2]]);
  // The next morning: the AH receipt of yesterday's shopping.
  await send(env, thomas, [
    receipt("purchase-spag-01", "2026-10-28", "Spaghetti", 2, spaghetti),
    receipt("purchase-ui-0001", "2026-10-28", "Uien", 3, { id: "product-ui-0001", name: "Gele uien", brand: "AH", size: "" }),
  ]);
  const v = await view(env, thomas);
  const rows = Object.values(v.pantry).map((r) => [r.title, r.amount, r.taken]).sort();
  assert.deepEqual(rows, [["Spaghetti", 1, 1], ["Uien", 1, 2]], "two packs minus one, three onions minus two");
  assert.deepEqual(Object.values(v.pending_takes).map((p) => p.status), ["done", "done"]);
  const events = Object.values(v.pantry_events);
  assert.deepEqual(events.map((e) => [e.reason, e.recipe_id, e.happened_on]), [["cooked", RECIPE.id, "2026-10-28"], ["cooked", RECIPE.id, "2026-10-28"]],
    "each paid take is a cook event on the cook's day");
  // The next receipt of spaghetti does not take it again.
  await send(env, thomas, [receipt("purchase-spag-02", "2026-10-29", "Spaghetti", 1, spaghetti)]);
  assert.equal((await view(env, thomas)).pantry["pp-purchase-spag-02"].amount, 1);

  // Undo after the receipt paid it: the row gets back what the cook took.
  await send(env, thomas, [op({ type: "pantry.unpend", ids: pending.map((p) => p.id) })]);
  const after = await view(env, thomas);
  assert.deepEqual(Object.values(after.pantry).filter((r) => r.title !== "Spaghetti" || r.id === "pp-purchase-spag-01")
    .map((r) => [r.title, r.amount]).sort(), [["Spaghetti", 2], ["Uien", 3]]);
  assert.deepEqual(Object.keys(after.pending_takes), [], "the pending takes are gone");
});

test("D1: a receipt four days after the cook does not pay it; an undone cook leaves nothing to pay", async () => {
  const { env, thomas } = await household();
  await send(env, thomas, [op({ type: "recipe.put", id: RECIPE.id, recipe: RECIPE })]);
  await cook(env, thomas, "2026-10-20", "b");
  await send(env, thomas, [receipt("purchase-late-01", "2026-10-24", "Spaghetti", 2, spaghetti)]);
  let v = await view(env, thomas);
  assert.equal(v.pantry["pp-purchase-late-01"].amount, 2, "another shopping, not this cook's");
  assert.ok(Object.values(v.pending_takes).every((p) => p.status === "pending"));

  const pending = await cook(env, thomas, "2026-10-26", "c");
  await send(env, thomas, [op({ type: "pantry.unpend", ids: pending.map((p) => p.id) })]);
  await send(env, thomas, [receipt("purchase-undo-01", "2026-10-26", "Spaghetti", 2, { ...spaghetti, id: "product-spag-002" })]);
  v = await view(env, thomas);
  assert.equal(v.pantry["pp-purchase-undo-01"].amount, 2, "the undone cook takes nothing");
});

test("D1: a tick, a cook that took more than the tick said, then the receipt: one row, bought minus all that was cooked", async () => {
  const { env, thomas } = await household();
  await send(env, thomas, [
    op({ type: "recipe.put", id: RECIPE.id, recipe: { ...RECIPE, ingredients: [{ name: "spaghetti", qty: 1000, unit: "g" }] } }),
    op({ type: "entry.add", id: "entry-spag-0001", item_id: "item-spag-0001", title: "Spaghetti", amounts: [{ qty: 500, unit: "g" }] }),
    op({ type: "entry.check", id: "entry-spag-0001", checked: true, on: "2026-10-28" }),
  ]);
  const recipe = { ...RECIPE, ingredients: [{ name: "spaghetti", qty: 1000, unit: "g" }] };
  const data = await view(env, thomas);
  const takes = cookTakes({ recipe, data, today: "2026-10-28" });
  const pending = cookPending({ recipe, data, today: "2026-10-28" }).map((p, i) => ({ ...p, id: `pending-d-${i}-000` }));
  assert.deepEqual(takes.map((t) => t.amount), [1], "the tick said one pack of 500 g");
  assert.deepEqual(pending.map((p) => [p.qty, p.unit]), [[500, "g"]], "the other 500 g waits");
  await send(env, thomas, [
    op({ type: "pantry.use", reason: "cooked", recipe_id: RECIPE.id, on: "2026-10-28", takes: takes.map((t, i) => ({ event_id: `event-d-${i}-0000`, pantry_id: t.pantry_id, amount: t.amount })) }),
    op({ type: "pantry.pend", recipe_id: RECIPE.id, on: "2026-10-28", pending }),
  ]);
  // The receipt says three packs: the tick's estimate is replaced, both takes count.
  await send(env, thomas, [receipt("purchase-tick-01", "2026-10-28", "Spaghetti", 3, spaghetti)]);
  const v = await view(env, thomas);
  const rows = Object.values(v.pantry);
  assert.equal(rows.length, 1, "the receipt filled in the tick's row");
  assert.deepEqual([rows[0].amount, rows[0].taken, rows[0].source_purchase_id], [1, 2, "purchase-tick-01"]);
});

test("D1: \"… gekookt?\" survives clearing the cart, a receipt for an open line counts, \"nog niet\" reaches every phone", async () => {
  const { env, thomas } = await household();
  const src = { recipe_id: RECIPE.id, title: RECIPE.title };
  await send(env, thomas, [
    op({ type: "recipe.put", id: RECIPE.id, recipe: RECIPE }),
    op({ type: "entry.add", id: "entry-spag-0001", item_id: "item-spag-0001", title: "Spaghetti", source: src }),
    op({ type: "entry.check", id: "entry-spag-0001", checked: true, on: "2026-10-27" }),
    op({ type: "entry.clear_checked", ids: ["entry-spag-0001"] }),
  ]);
  let v = await view(env, thomas);
  assert.deepEqual(Object.keys(v.entries), [], "the cart was cleared");
  assert.deepEqual(cookPrompts(v, "2026-10-27"), [], "not on the shopping day");
  assert.deepEqual(cookPrompts(v, "2026-10-28").map((x) => x.title), [RECIPE.title], "the next day it asks");

  await send(env, thomas, [op({ type: "recipe.cook_prompt", recipe_id: RECIPE.id, shopped_on: "2026-10-27", action: "snooze", on: "2026-10-28" })]);
  v = await view(env, thomas);
  assert.deepEqual(cookPrompts(v, "2026-10-28"), [], "\"nog niet\" holds on every phone");
  assert.equal(cookPrompts(v, "2026-10-29").length, 1);
  await send(env, thomas, [op({ type: "recipe.cooked", id: "cook-yes-000001", recipe_id: RECIPE.id, cooked_on: "2026-10-28" })]);
  assert.deepEqual(cookPrompts(await view(env, thomas), "2026-10-29"), [], "\"Ja, gisteren\" answered it");

  // An AH receipt (no entry_id) for a line that is still open names the recipe
  // too. The line is made today (the worker's clock), so the shopping is today.
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  await send(env, thomas, [
    op({ type: "recipe.uncooked", id: "cook-yes-000001" }),
    op({ type: "entry.add", id: "entry-ui-000001", item_id: "item-ui-000001", title: "Ui", source: src }),
    receipt("purchase-ui-0002", today, "Ui", 1, { id: "product-ui-0002", name: "Uien", brand: "AH", size: "1 kg" }),
  ]);
  v = await view(env, thomas);
  assert.ok(v.cook_prompts[cookPromptId(RECIPE.id, today)], "bought on a receipt: shopped that day");
  assert.equal(cookPrompts(v, tomorrow).length, 1);
  assert.equal(importerMayApply({ type: "recipe.cook_prompt" }), false);
});
