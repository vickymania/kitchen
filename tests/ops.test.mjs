import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOp, emptyState, OpError } from "../public/shared/ops.js";

const ctx = (memberId = "member-thomas", now = "2026-10-27T12:00:00.000Z", isAdmin = true) => ({ memberId, now, isAdmin });
const run = (state, op, c = ctx()) => applyOp(state, op, c);

test("adding the same item twice gives one line with the amounts added up", () => {
  const s = emptyState();
  run(s, { type: "entry.add", id: "entry-aaaa1", item_id: "item-aaaa1", title: "Gehakt", amounts: [{ qty: 400, unit: "g" }], source: { recipe_id: "recipe-chili", title: "Chili" } });
  const { result } = run(s, { type: "entry.add", id: "entry-aaaa2", item_id: "item-aaaa2", title: "gehakt ", amounts: [{ qty: 300, unit: "g" }], source: { recipe_id: "recipe-lasagne", title: "Lasagne" } });
  assert.equal(result.merged_into, "entry-aaaa1");
  assert.equal(Object.keys(s.entries).length, 1);
  assert.equal(Object.keys(s.items).length, 1);
  const e = s.entries["entry-aaaa1"];
  assert.deepEqual(e.amounts, [{ qty: 700, unit: "g" }]);
  assert.deepEqual(e.sources.map((x) => x.title), ["Chili", "Lasagne"]);
});

test("an item already in the cart gets a new line", () => {
  const s = emptyState();
  run(s, { type: "entry.add", id: "entry-bbbb1", item_id: "item-bbbb1", title: "Melk" });
  run(s, { type: "entry.check", id: "entry-bbbb1", checked: true });
  const { result } = run(s, { type: "entry.add", id: "entry-bbbb2", item_id: "item-bbbb2", title: "melk" });
  assert.equal(result.merged_into, undefined);
  assert.equal(s.entries["entry-bbbb2"].item_id, s.entries["entry-bbbb1"].item_id);
});

test("unchecking while the item is on the list again merges the two", () => {
  const s = emptyState();
  run(s, { type: "entry.add", id: "entry-cccc1", item_id: "item-cccc1", title: "Ui", amounts: [{ qty: 1, unit: null }] });
  run(s, { type: "entry.check", id: "entry-cccc1", checked: true });
  run(s, { type: "entry.add", id: "entry-cccc2", item_id: "item-cccc2", title: "Ui", amounts: [{ qty: 2, unit: null }] });
  const { result } = run(s, { type: "entry.check", id: "entry-cccc1", checked: false });
  assert.equal(result.merged_into, "entry-cccc2");
  assert.deepEqual(s.entries["entry-cccc2"].amounts, [{ qty: 3, unit: null }]);
  assert.ok(s.entries["entry-cccc1"].deleted_at);
});

test("clearing the cart clears only the lines that were seen", () => {
  const s = emptyState();
  for (const n of [1, 2, 3]) {
    run(s, { type: "entry.add", id: `entry-dddd${n}`, item_id: `item-dddd${n}`, title: `Ding ${n}` });
    run(s, { type: "entry.check", id: `entry-dddd${n}`, checked: true });
  }
  const { result } = run(s, { type: "entry.clear_checked", ids: ["entry-dddd1", "entry-dddd2"] });
  assert.equal(result.cleared, 2);
  assert.equal(s.entries["entry-dddd3"].deleted_at, null);
});

test("a replayed add changes nothing", () => {
  const s = emptyState();
  const op = { type: "entry.add", id: "entry-eeee1", item_id: "item-eeee1", title: "Kaas", amounts: [{ qty: 1, unit: null }] };
  run(s, op);
  const { changed } = run(s, op);
  assert.deepEqual(changed, []);
  assert.deepEqual(s.entries["entry-eeee1"].amounts, [{ qty: 1, unit: null }]);
});

test("a recipe edit is a patch", () => {
  const s = emptyState();
  run(s, { type: "recipe.put", id: "recipe-ffff1", recipe: { title: "Kip kerrie", servings: 4, ingredients: [{ qty: 300, unit: "g", name: "rijst" }], steps: ["Kook de rijst."] } });
  run(s, { type: "recipe.put", id: "recipe-ffff1", recipe: { photo: "p/abcdefgh1234.jpg" } });
  const r = s.recipes["recipe-ffff1"];
  assert.equal(r.title, "Kip kerrie");
  assert.equal(r.photo, "p/abcdefgh1234.jpg");
  assert.equal(r.ingredients[0].name, "rijst");
});

test("bad input is refused with a code, not stored", () => {
  const s = emptyState();
  const code = (fn) => {
    try {
      fn();
    } catch (e) {
      assert.ok(e instanceof OpError);
      return e.code;
    }
    return "no error";
  };
  assert.equal(code(() => run(s, { type: "recipe.put", id: "recipe-gggg1", recipe: { servings: 4 } })), "title_required");
  assert.equal(code(() => run(s, { type: "recipe.put", id: "x", recipe: { title: "A" } })), "bad_id");
  assert.equal(code(() => run(s, { type: "recipe.put", id: "recipe-gggg1", recipe: { title: "A", photo: "../../etc/passwd" } })), "bad_field");
  assert.equal(code(() => run(s, { type: "recipe.put", id: "recipe-gggg1", recipe: { title: "A", ingredients: [{ name: "x", unit: "bucket" }] } })), "bad_field");
  assert.equal(code(() => run(s, { type: "entry.add", id: "entry-gggg1", item_id: "item-gggg1", title: "  " })), "title_required");
  assert.equal(code(() => run(s, { type: "drop.tables" })), "unknown_op");
  assert.deepEqual(s.recipes, {});
});

test("members change only their own name, unless admin", () => {
  const s = emptyState();
  s.members["member-sam00"] = { id: "member-sam00", name: "Sam", locale: "nl", removed_at: null };
  const code = (fn) => {
    try {
      fn();
      return "ok";
    } catch (e) {
      return e.code;
    }
  };
  assert.equal(code(() => run(s, { type: "member.update", id: "member-sam00", name: "X" }, ctx("member-other", undefined, false))), "forbidden");
  assert.equal(code(() => run(s, { type: "member.update", id: "member-sam00", locale: "en" }, ctx("member-sam00", undefined, false))), "ok");
  assert.equal(s.members["member-sam00"].locale, "en");
  assert.equal(code(() => run(s, { type: "member.update", id: "member-sam00", locale: "de" }, ctx("member-sam00"))), "bad_field");
});

test("credits: a link or just a name", () => {
  const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof OpError); return e.code; } return null; };
  const s = emptyState();
  run(s, { type: "recipe.put", id: "recipe-cred1", recipe: { title: "Pannenkoeken", source_url: "  Henk  " } });
  assert.equal(s.recipes["recipe-cred1"].source_url, "Henk");
  run(s, { type: "recipe.put", id: "recipe-cred1", recipe: { source_url: "https://example.com/pannenkoeken" } });
  assert.equal(s.recipes["recipe-cred1"].source_url, "https://example.com/pannenkoeken");
  assert.equal(code(() => run(s, { type: "recipe.put", id: "recipe-cred1", recipe: { source_url: "https://x" } })), "bad_field");
  assert.equal(code(() => run(s, { type: "recipe.put", id: "recipe-cred1", recipe: { source_url: "a".repeat(121) } })), "bad_field");
});

test("item.rename tidies the shown name only", () => {
  const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof OpError); return e.code; } return null; };
  const s = emptyState();
  run(s, { type: "entry.add", id: "entry-rn001", item_id: "item-rn001", title: "Kaneelpoeder?" });
  run(s, { type: "item.rename", item_id: "item-rn001", name: "Kaneelpoeder" });
  assert.equal(s.items["item-rn001"].name, "Kaneelpoeder");
  assert.equal(code(() => run(s, { type: "item.rename", item_id: "item-rn001", name: "Kaneel" })), "bad_field", "another word is a merge, not a rename");
});
