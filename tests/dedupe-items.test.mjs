// tools/dedupe_items.mjs: duplicate items of the old To Do import, grouped
// from their names (30-10-2026). Fictional names; the merge itself
// is the engine's item.merge (tests/item-merge.test.mjs).
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyState } from "../public/shared/ops.js";
import { nameKey } from "../public/shared/ingredients.js";
import { cleanName, planGroups, planOps, simulate, groupsText, familyMembers, typoDistance, HEAVY, DOUBT_SYNONYMS } from "../tools/dedupe_items.mjs";

const DAY = "2026-10-30";

function house(spec) {
  const s = emptyState();
  let n = 0;
  for (const [name, bought = 0, extra = {}] of spec) {
    const id = `item-dd-${String(++n).padStart(3, "0")}`;
    s.items[id] = { id, name, name_key: nameKey(name), deleted_at: null, use_per_day: null, rate_source: null, ...extra.item };
    for (let i = 0; i < bought; i++) {
      const pid = `purchase-dd-${n}-${i}`;
      s.purchases[pid] = { id: pid, item_id: id, title: name, bought_on: "2026-10-01", source: "history", deleted_at: null };
    }
    if (extra.stock) s.pantry[`pantry-dd-${n}`] = { id: `pantry-dd-${n}`, item_id: id, title: name, amount: extra.stock, taken: 0, pack_size: "", added_on: DAY, use_by: null, deleted_at: null };
    if (extra.rule) s.deal_rules[`rule-dd-${n}`] = { id: `rule-dd-${n}`, item_id: id, product_id: null, offer_only: 1, deleted_at: null };
  }
  return s;
}
const nameOf = (g, id) => g.facts[id].item.name;
const clearOf = (g) => Object.fromEntries(g.clear.map((x) => [nameOf(g, x.target), x.members.map((m) => nameOf(g, m.id)).sort()]));
const doubtOf = (g, target) => g.doubt.find((f) => nameOf(g, f.target) === target);

test("dedupe: the noise of the old lists is no part of the name", () => {
  const key = (n) => cleanName(n).compact;
  for (const n of ["Pastinaak", "x pastinaak", "- Pastinaak, voor op de burger", "• pastinaak", "Pastinaak 2", "Pastinaak 500g",
    "Pastinaak 400 g", "pastinaak verpakking 8st formaat klein", "Maybe pastinaak", "pastinaak hebben we nog denk",
    "Pastinaak?", "Grote pastinaak", "pastinaak blik", "pastinaak voor het serveren", "alles voor pastinaak", "pastinaak, fijngesneden"]) {
    assert.equal(key(n), "pastinaak", n);
  }
  assert.equal(key("Mango's"), "mango");
  assert.equal(key("Mango’s"), "mango", "curly apostrophe");
  assert.equal(key("Gerookte paprika"), "gerooktepaprika", "spaces in compounds go");
  assert.equal(key("Griekse kwark 10%"), "grieksekwark10pct", "a percentage is the product");
  assert.equal(key("Afvalzakken 30L"), "afvalzakken30l", "litres are the product");
  assert.deepEqual(cleanName("gemalen nootmuskaat").doubt, ['"gemalen"'], "a word that may change the product is a doubt");
  assert.deepEqual(cleanName("Taart? Slagroom?").several, ["Taart", "Slagroom"]);
  assert.deepEqual(cleanName("pastinaak of knolselderij").several, ["pastinaak", "knolselderij"]);
  assert.equal(typoDistance("pastinaak", "pastinaka"), 1, "a swap is one");
});

test("dedupe: clear groups merge into the most bought, never across a word that changes the product", () => {
  const s = house([
    ["Pastinaak", 9, { stock: 1 }], ["Pastinaken", 1], ["x pastinaak", 1], ["Pastinaak 500g", 1], ["Maybe pastinaak", 1],
    ["Pastinaakchips", 2], ["Pastinaak wraps", 1], ["Pastinaakpuree", 3], ["Pastinaak puree", 1],
    ["Gerookte kwark", 2], ["gerooktekwark", 1], ["belegen gerookte kwark", 1], ["gerookte mozzarella", 1],
    ["Kikkererwt", 0, { stock: 2 }], ["Kikkererwten", 0],
  ]);
  const g = planGroups(s);
  const c = clearOf(g);
  assert.deepEqual(c["Pastinaak"], ["Maybe pastinaak", "Pastinaak 500g", "Pastinaken", "x pastinaak"]);
  assert.deepEqual(c["Pastinaakpuree"], ["Pastinaak puree"], "puree is its own product");
  assert.deepEqual(c["Gerookte kwark"], ["belegen gerookte kwark", "gerooktekwark"], "belegen is the same for this household");
  assert.equal(c["Kikkererwt"]?.length, 1, "no purchases: the stock decides");
  const all = g.clear.flatMap((x) => [x.target, ...x.members.map((m) => m.id)]).map((id) => nameOf(g, id));
  for (const n of ["Pastinaakchips", "Pastinaak wraps", "gerookte mozzarella"]) assert.ok(!all.includes(n), n);
  assert.deepEqual(g.doubt, [], "nothing doubtful here");
});

test("dedupe: two established items, a doubt word, a synonym, a typo or a line of several things is Thomas's call", () => {
  const [syn, other] = DOUBT_SYNONYMS[0];
  const cap = (x) => x[0].toUpperCase() + x.slice(1);
  const s = house([
    ["Pruim", HEAVY], ["Pruimen", HEAVY + 1], ["Pruim 2", 1],
    ["Nootmuskaat", 3], ["Gemalen nootmuskaat", 2],
    [`${cap(other)}s`, 8], [`${cap(syn)}s`, 1],
    ["Havervlokken", 4], ["Havervlokkne", 1],
    ["Taart? Pruimen?", 1],
    ["Kaneel", 2], ["Kaneel of nootmuskaat", 1],
  ]);
  const g = planGroups(s);
  assert.deepEqual(clearOf(g)["Pruim"], ["Pruim 2"], "the clear part still merges on its own");
  const plum = doubtOf(g, "Pruimen");
  assert.ok(plum, "Pruim and Pruimen both bought often: doubt");
  assert.deepEqual(familyMembers(plum).map((id) => nameOf(g, id)).sort(), ["Pruim", "Pruim 2", "Taart? Pruimen?"]);
  assert.ok(doubtOf(g, "Nootmuskaat"));
  assert.ok(doubtOf(g, `${cap(other)}s`), "a synonym");
  assert.ok(doubtOf(g, "Havervlokken"), "a typo");
  assert.ok(!g.doubt.some((f) => familyMembers(f).some((id) => nameOf(g, id) === "Kaneel of nootmuskaat")), "a line naming two known things joins neither");
  const text = groupsText(g);
  assert.match(text, /TWIJFEL: 4 groepen/);
  assert.match(text, /Pruimen \[6b\]\n {6}zeker al: Pruim \[5b\] <- Pruim 2 \[1b\]/);

  // Only the clear groups are written; --include adds a doubt family as one group.
  const plain = planOps(g, DAY);
  assert.deepEqual(plain.notes, ["Pruim 2 -> Pruim"]);
  const more = planOps(g, DAY, ["pruimen"]);
  assert.deepEqual(more.notes.sort(), ["Pruim -> Pruimen", "Pruim 2 -> Pruimen", "Taart? Pruimen? -> Pruimen"]);
  assert.throws(() => planOps(g, DAY, ["Appelmoes"]), /no DOUBT group with target "appelmoes"/);
});

test("dedupe: never-suggest items and generic lines are never touched; a member whose own rate or deal rule would lose waits", () => {
  const rate = (v) => ({ item: { use_per_day: v, rate_source: "person" } });
  const s = house([
    ["Spruitjes", 4], ["x spruitjes", 1],
    ["Fruit", 9], ["Fruit 2", 1],
    ["Zeeppompje", 6, { item: { use_per_day: 0.1, rate_source: "person" }, rule: true }], ["Zeeppompjes", 1, { ...rate(0.5), rule: true }],
    ["Tandpasta", 6, rate(0.1)], ["Tandpasta 2", 1, rate(0.1)],
  ]);
  const g = planGroups(s);
  const touched = [...g.clear.flatMap((x) => [x.target, ...x.members.map((m) => m.id)]), ...g.doubt.flatMap((f) => [f.target, ...familyMembers(f)])].map((id) => nameOf(g, id));
  for (const n of ["Spruitjes", "x spruitjes", "Fruit", "Fruit 2"]) assert.ok(!touched.includes(n), n);
  assert.deepEqual(clearOf(g)["Tandpasta"], ["Tandpasta 2"], "the same rate is no conflict");
  const soap = doubtOf(g, "Zeeppompje");
  assert.deepEqual(soap.extra.map((m) => [nameOf(g, m.id), m.reason]), [["Zeeppompjes", "eigen verbruik botst, deal-regel botst"]]);
});

test("dedupe: the ops are item.merge with stable ids, and the engine moves the purchases and stock", () => {
  const s = house([["Pastinaak", 3], ["Pastinaken", 1, { stock: 2 }], ["x pastinaak", 1]]);
  const g = planGroups(s);
  const plan = planOps(g, DAY);
  assert.ok(plan.ops.every((o) => o.type === "item.merge" && o.on === DAY && o.op_id.startsWith("op-")));
  assert.deepEqual(planOps(planGroups(s), DAY).ops.map((o) => o.op_id), plan.ops.map((o) => o.op_id), "a second --write is a replay");
  const out = simulate(s, plan.ops);
  assert.ok(out.every((o) => o.ok), JSON.stringify(out));
  const moved = out.reduce((n, o) => n + o.result.moved.purchases, 0);
  assert.equal(moved, 2);
  assert.equal(out.reduce((n, o) => n + o.result.moved.pantry, 0), 1);
});

test("dedupe: --target makes the household's name the target of its group (clear and included doubt); --exclude keeps an item out", () => {
  const s = house([
    ["Kattenvoer", 3, { rule: true }], ["Kattenvoer 2", 1],
    ["Pruim", HEAVY], ["Pruimen", HEAVY + 1],
    ["Most", 4], ["Mostje", 9], ["Mostjes", 1],
  ]);
  const plain = planGroups(s);
  assert.deepEqual(clearOf(plain)["Kattenvoer"], ["Kattenvoer 2"]);
  const g = planGroups(s, { targets: ["pruim"], excludes: ["Most"] });
  assert.equal(doubtOf(g, "Pruim")?.target && nameOf(g, doubtOf(g, "Pruim").target), "Pruim", "the named item wins over the most bought");
  const notes = planOps(g, DAY, ["Pruim"]).notes;
  assert.ok(notes.includes("Pruimen -> Pruim") && !notes.includes("Pruim -> Pruimen"), notes.join("; "));
  assert.deepEqual(clearOf(g)["Mostje"], ["Mostjes"]);
  const touched = g.clear.flatMap((x) => [x.target, ...x.members.map((m) => m.id)]).map((id) => nameOf(g, id));
  assert.ok(!touched.includes("Most"), "an excluded item is in no group");
  // A clear group: the named item is the target although it was bought less.
  const t = planGroups(house([["Kattenbrok", 2, { rule: true }], ["Kattenbrokken", 6], ["x kattenbrok", 1]]), { targets: ["Kattenbrok"] });
  assert.deepEqual(clearOf(t)["Kattenbrok"], ["Kattenbrokken", "x kattenbrok"]);
  assert.ok(planOps(t, DAY).notes.includes("Kattenbrokken -> Kattenbrok"));
});

test("dedupe: the household's defaults are optional; the tool runs without them", async () => {
  const { householdDefaults } = await import("../tools/dedupe_items.mjs");
  const d = await householdDefaults();
  assert.ok(Array.isArray(d.TARGETS) && Array.isArray(d.EXCLUDES));
});
