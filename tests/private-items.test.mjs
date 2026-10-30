// Private items (30-10-2026): an item one member keeps to himself ("Alleen
// voor mij"). For every other member of the household it does not exist:
// not in /api/sync (full or delta, every kind), not in the widget, and any op
// of theirs that names it is refused as not_found. Imports of the owner's
// devices still land on it. Fictional household: Thomas (admin, the owner),
// Sam (a member), the home server's importer and reviewer (made by Thomas).
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { guestMayApply, importerMayApply, reviewerMayApply } from "../worker/auth.js";
import { applyOp, emptyState, OpError, OP_TYPES } from "../public/shared/ops.js";
import { mergeProblem, planGroups } from "../public/shared/dedupe.js";
import { hiddenOf, namesHidden, rowFor, rowHidden } from "../worker/privacy.js";

const ORIGIN = "http://groceries.localhost:8787";

function call(env, method, p, { body, cookie, bearer } = {}) {
  const headers = { Origin: ORIGIN };
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(new Request(`${ORIGIN}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
const json = async (res) => ({ status: res.status, body: await res.json() });
const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);

let n = 0;
const op = (o) => ({ op_id: `op-private-${String(++n).padStart(6, "0")}`, ...o });

const ITEM = "item-priv-zalf01";
const PRODUCT = "product-priv-zalf1";
const DAY = "2026-10-29";

async function send(env, who, ops) {
  const res = await json(await call(env, "POST", "/api/ops", { ...who, body: { ops } }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.results;
}
const allOk = (results) => assert.deepEqual(results.filter((r) => !r.ok), [], JSON.stringify(results));
const sync = async (env, who, since = 0) => (await json(await call(env, "GET", `/api/sync?since=${since}`, who))).body;

/** Thomas, Sam, the importer and the reviewer; Voetzalf with something of every kind. */
async function household() {
  const env = await makeEnv();
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const thomas = { cookie: tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456", label: "phone" } })) };
  const pairCode = async (body, label) => {
    const code = (await json(await call(env, "POST", "/api/codes", { ...thomas, body }))).body.code;
    return tokenOf(await call(env, "POST", "/api/pair", { body: { code, label } }));
  };
  const sam = { cookie: await pairCode({ for: "new_member", name: "Sam" }, "sam phone") };
  const importer = { bearer: await pairCode({ for: "importer" }, "Thuisserver AH") };
  const reviewer = { bearer: await pairCode({ for: "reviewer" }, "Thuisserver controle") };
  const me = async (who) => (await json(await call(env, "GET", "/api/me", who))).body.member.id;

  allOk(await send(env, thomas, [
    op({ type: "entry.add", id: "entry-priv-zalf1", item_id: ITEM, title: "Voetzalf" }),
    op({ type: "entry.add", id: "entry-priv-brood", item_id: "item-priv-brood1", title: "Brood" }),
    op({ type: "recipe.put", id: "recipe-priv-soep", recipe: { title: "Soep", servings: 2, ingredients: [{ qty: 1, unit: null, name: "brood" }, { qty: 1, unit: null, name: "zalf" }], steps: ["Kook."] } }),
  ]));
  // The home server's receipt: Voetzalf and bread, as AH sends them.
  allOk(await send(env, importer, [
    op({ type: "receipt.save", id: "ah-priv-receipt1", store: "Albert Heijn", bought_on: DAY, total_cents: 748, lines: [
      { name: "Kruidvat Voetzalf", brand: "Kruidvat", size: "75 ml", qty: 1, price_cents: 499 },
      { name: "AH Brood", brand: "AH", size: "800 g", qty: 1, price_cents: 249 },
    ] }),
    op({ type: "purchase.add", id: "purchase-priv-zalf1", item_id: ITEM, title: "Voetzalf", bought_on: DAY, store: "Albert Heijn", qty: 1, price_cents: 499,
      source: "receipt", receipt_id: "ah-priv-receipt1", pantry: true, product: { id: PRODUCT, name: "Kruidvat Voetzalf", brand: "Kruidvat", size: "75 ml" } }),
    op({ type: "purchase.add", id: "purchase-priv-brood", item_id: "item-priv-brood1", title: "Brood", bought_on: DAY, store: "Albert Heijn", qty: 1, price_cents: 249,
      source: "receipt", receipt_id: "ah-priv-receipt1", pantry: true, product: { id: "product-priv-brood", name: "AH Brood", brand: "AH", size: "800 g" } }),
    op({ type: "preference.set", id: "pref-priv-zalf01", item_id: ITEM, title: "Voetzalf", product_id: PRODUCT, store: "", only_if_unset: true }),
  ]));
  allOk(await send(env, thomas, [
    op({ type: "deal_rule.set", id: "rule-priv-zalf01", item_id: ITEM, product_id: PRODUCT, max_price_cents: 400 }),
    op({ type: "rating.set", id: "rating-priv-zalf1", product_id: PRODUCT, stars: 8 }),
    op({ type: "item.rate", item_id: ITEM, use_per_day: 0.05, source: "person" }),
  ]));
  // The nightly check (Thomas's reviewer): another name, a report, a recipe link.
  allOk(await send(env, reviewer, [
    op({ type: "item.alias", id: "alias-priv-zalf1", item_id: ITEM, name: "Zalf voor voeten", on: DAY }),
    op({ type: "review.save", day: DAY, run_ok: true, fixed: [{ text: "Zalf voor voeten is nu Voetzalf.", undo: "Haal de naam weg bij Voetzalf." }, { text: "Brood klopt.", undo: "-" }], decide: ["Voetzalf: welke maat?"], errors: [] }),
    op({ type: "recipe.links", recipe_id: "recipe-priv-soep", at: "x", lines: [
      { name: "brood", item_id: "item-priv-brood1", item: "Brood", how: "exact" },
      { name: "zalf", item_id: ITEM, item: "Voetzalf", how: "exact" },
    ] }),
  ]));
  // A shelf price and an offer (written by the home server's runs).
  const hh = (await env.DB.prepare("SELECT id FROM households").first()).id;
  await env.DB.exec(`INSERT INTO store_prices (id, household_id, product_id, store, name, size, price_cents, price_on, created_at, updated_at, rev)
      VALUES ('sp-priv-zalf1', '${hh}', '${PRODUCT}', 'Dirk', 'Voetzalf', '75 ml', 459, '${DAY}', 'x', 'x', (SELECT rev FROM households));
    INSERT INTO offers (id, household_id, store, name, brand, size, deal, price_cents, valid_from, valid_until, created_at, updated_at, rev)
      VALUES ('offer-priv-zalf1', '${hh}', 'Kruidvat', 'Voetzalf', 'Kruidvat', '75 ml', '1+1 gratis', 499, '2026-10-01', '2099-12-31', 'x', 'x', (SELECT rev FROM households)),
             ('offer-priv-brood', '${hh}', 'Albert Heijn', 'Brood', 'AH', '800 g', '2e halve prijs', 249, '2026-10-01', '2099-12-31', 'x', 'x', (SELECT rev FROM households));
    UPDATE households SET rev = rev + 1;`);
  return { env, thomas, sam, importer, reviewer, thomasId: await me(thomas), samId: await me(sam) };
}

const KINDS_ABOUT_IT = ["items", "entries", "products", "ratings", "purchases", "pantry", "preferences", "deal_rules", "aliases", "store_prices", "offers", "auto_changes"];
const mentions = (body) => /voetzalf|zalf voor voeten/i.test(JSON.stringify(body)) || JSON.stringify(body).includes(ITEM) || JSON.stringify(body).includes(PRODUCT);

test("before: nothing is private, everyone sees everything (existing data unchanged)", async () => {
  const { env, sam } = await household();
  const s = await sync(env, sam);
  assert.equal(s.items.find((i) => i.id === ITEM).private_to, null);
  for (const kind of KINDS_ABOUT_IT) assert.ok(mentions(s[kind]), `${kind} has the item before it is private`);
});

test("sync: another member's full load has nothing of it, in every kind; the owner has all of it", async () => {
  const { env, thomas, sam, thomasId } = await household();
  allOk(await send(env, thomas, [op({ type: "item.private", item_id: ITEM, private: true })]));
  const s = await sync(env, sam);
  for (const kind of KINDS_ABOUT_IT) assert.ok(!mentions(s[kind]), `${kind}: ${JSON.stringify(s[kind])}`);
  // Rows that stay, without what names it.
  assert.deepEqual(s.receipts[0].lines.map((l) => l.name), ["AH Brood"]);
  assert.deepEqual(s.reviews[0].fixed.map((f) => f.text), ["Brood klopt."]);
  assert.deepEqual(s.reviews[0].decide, []);
  assert.deepEqual(s.recipes[0].ingredient_links.lines.map((l) => l.name), ["brood"]);
  assert.ok(!mentions(s), "nothing anywhere in the answer: " + Object.entries(s).filter(([, v]) => mentions(v)).map(([k, v]) => k + "=" + JSON.stringify(v)).join(" ; "));
  assert.ok(s.items.some((i) => i.name === "Brood") && s.offers.some((o) => o.name === "Brood"), "the rest is there");

  const t = await sync(env, thomas);
  assert.equal(t.items.find((i) => i.id === ITEM).private_to, thomasId);
  for (const kind of KINDS_ABOUT_IT) assert.ok(mentions(t[kind]), `${kind} for the owner`);
  assert.equal(t.receipts[0].lines.length, 2);
  assert.equal(t.reviews[0].decide.length, 1);
});

test("sync: a delta after it went private takes it off the other phone as bare tombstones; back public brings it back", async () => {
  const { env, thomas, sam } = await household();
  const head = await sync(env, sam);
  allOk(await send(env, thomas, [op({ type: "item.private", item_id: ITEM, private: true })]));
  const d = await sync(env, sam, head.rev);
  assert.ok(!/voetzalf|zalf voor voeten/i.test(JSON.stringify(d)), "no name in the delta");
  for (const kind of ["items", "entries", "products", "ratings", "purchases", "pantry", "preferences", "deal_rules", "aliases", "auto_changes"]) {
    assert.ok(d[kind].length > 0, `${kind} is sent again`);
    for (const row of d[kind]) assert.deepEqual(Object.keys(row).sort(), ["deleted_at", "id", "rev"], `${kind} row is a bare tombstone`);
  }
  assert.deepEqual(d.receipts[0].lines.map((l) => l.name), ["AH Brood"], "the receipt comes again without the line");
  assert.deepEqual(d.reviews[0].decide, [], "the report comes again without the line");
  // Thomas ticks it: Sam's next delta says nothing but an id.
  const h2 = await sync(env, sam, d.rev);
  allOk(await send(env, thomas, [op({ type: "entry.check", id: "entry-priv-zalf1", checked: true })]));
  const d2 = await sync(env, sam, h2.rev);
  assert.ok(!/voetzalf/i.test(JSON.stringify(d2)));
  // Back to the household: the rows come back whole.
  allOk(await send(env, thomas, [op({ type: "item.private", item_id: ITEM, private: false })]));
  const d3 = await sync(env, sam, d2.rev);
  assert.equal(d3.items.find((i) => i.id === ITEM)?.name, "Voetzalf");
  assert.ok(d3.purchases.some((p) => p.item_id === ITEM && p.price_cents === 499));
  assert.equal(d3.receipts[0].lines.length, 2);
});

test("sync: an idle poll still reads only the counter", async () => {
  const { env, thomas, sam } = await household();
  allOk(await send(env, thomas, [op({ type: "item.private", item_id: ITEM, private: true })]));
  const head = await sync(env, sam);
  const queries = [];
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => { queries.push(sql); return prepare(sql); };
  await sync(env, sam, head.rev);
  assert.deepEqual(queries.filter((q) => /FROM (items|products|item_aliases)\b/.test(q)), []);
});

test("ops: the other member can never touch it, and is told only not_found", async () => {
  const { env, thomas, sam } = await household();
  allOk(await send(env, thomas, [op({ type: "item.private", item_id: ITEM, private: true })]));
  const tries = [
    { type: "entry.check", id: "entry-priv-zalf1", checked: true },
    { type: "entry.delete", id: "entry-priv-zalf1" },
    { type: "entry.update", id: "entry-priv-zalf1", note: "x" },
    { type: "entry.add", id: "entry-sam-zalf001", item_id: "item-sam-zalf0001", title: "Voetzalf" },
    { type: "entry.add", id: "entry-sam-zalf002", item_id: "item-sam-zalf0002", title: "voet zalf" },
    { type: "entry.add", id: "entry-sam-zalf003", item_id: "item-sam-zalf0003", title: "Zalf voor voeten" },
    { type: "entry.add", id: "entry-sam-zalf004", item_id: ITEM, title: "Iets anders" },
    { type: "item.rename", item_id: ITEM, name: "voetzalf" },
    { type: "item.low", item_id: ITEM, low_off: true },
    { type: "item.private", item_id: ITEM, private: false },
    { type: "item.private", item_id: ITEM, private: true },
    { type: "item.merge", from_item_id: ITEM, into_item_id: "item-priv-brood1", on: DAY },
    { type: "item.merge", from_item_id: "item-priv-brood1", into_item_id: ITEM, on: DAY },
    { type: "item.merge", from_item_id: "item-priv-brood1", into_title: "Voetzalf", into_item_id: "item-sam-new00001", on: DAY },
    { type: "item.alias", id: "alias-sam-zalf001", item_id: ITEM, name: "Zalfje" },
    { type: "item.alias", id: "alias-sam-zalf002", item_id: "item-priv-brood1", name: "Voetzalf" },
    { type: "product.move", product_id: PRODUCT, item_id: "item-priv-brood1", on: DAY },
    { type: "product.move", product_id: "product-priv-brood", item_id: ITEM, on: DAY },
    { type: "rating.set", id: "rating-sam-zalf01", product_id: PRODUCT, stars: 2 },
    { type: "deal_rule.set", id: "rule-sam-zalf001", title: "Voetzalf", max_price_cents: 100 },
    { type: "preference.set", id: "pref-sam-zalf001", item_id: ITEM, product_id: PRODUCT, store: "" },
    { type: "purchase.delete", id: "purchase-priv-zalf1" },
    { type: "pantry.add", id: "pantry-sam-zalf01", item_id: "item-sam-zalf0005", title: "Voetzalf", amount: 1 },
    { type: "item.rate", item_id: ITEM, use_per_day: 1, source: "person" },
  ];
  const before = JSON.stringify(await sync(env, thomas));
  for (const t of tries) {
    const [r] = await send(env, sam, [op(t)]);
    assert.deepEqual([t.type, r.ok, r.error], [t.type, false, "not_found"], JSON.stringify(t));
  }
  const after = await sync(env, thomas);
  assert.equal(JSON.stringify(after), before.replace(/"rev":\d+/, `"rev":${after.rev}`), "nothing of Thomas's changed");
  // His own things still work, and a receipt of his never clears Thomas's basket line.
  allOk(await send(env, thomas, [op({ type: "entry.check", id: "entry-priv-zalf1", checked: true })]));
  allOk(await send(env, sam, [
    op({ type: "entry.add", id: "entry-sam-kaas001", item_id: "item-sam-kaas0001", title: "Kaas" }),
    op({ type: "purchase.add", id: "purchase-sam-kaas1", item_id: "item-sam-kaas0001", title: "Kaas", bought_on: DAY, store: "Dirk", qty: 1, price_cents: 300, source: "receipt", pantry: true }),
  ]));
  const line = (await sync(env, thomas)).entries.find((e) => e.id === "entry-priv-zalf1");
  assert.ok(line && !line.deleted_at && line.checked_at, "Thomas's ticked line is untouched");
});

test("ops: only the owner sets and clears it; guests, the importer and the reviewer never", async () => {
  const { env, thomas, sam, importer, reviewer, samId } = await household();
  assert.equal(guestMayApply({ type: "item.private", item_id: ITEM, private: true }), false);
  assert.equal(importerMayApply({ type: "item.private", item_id: ITEM, private: true }), false);
  assert.equal(reviewerMayApply({ type: "item.private", item_id: ITEM, private: true }), false);
  for (const who of [importer, reviewer]) {
    assert.equal((await call(env, "POST", "/api/ops", { ...who, body: { ops: [op({ type: "item.private", item_id: ITEM, private: true })] } })).status, 403);
  }
  // Sam makes Brood his; Thomas cannot undo it (for him it is gone).
  allOk(await send(env, sam, [op({ type: "item.private", item_id: "item-priv-brood1", private: true })]));
  const [r] = await send(env, thomas, [op({ type: "item.private", item_id: "item-priv-brood1", private: false })]);
  assert.equal(r.error, "not_found");
  assert.equal((await env.DB.prepare("SELECT private_to FROM items WHERE id = 'item-priv-brood1'").first()).private_to, samId);
  // The same again is nothing new.
  const [again] = await send(env, sam, [op({ type: "item.private", item_id: "item-priv-brood1", private: true })]);
  assert.deepEqual(again.result, { already: true });
});

test("imports: the importer (made by the owner) still lands purchases on it; they stay private", async () => {
  const { env, thomas, sam, importer } = await household();
  allOk(await send(env, thomas, [op({ type: "item.private", item_id: ITEM, private: true })]));
  allOk(await send(env, importer, [
    op({ type: "receipt.save", id: "ah-priv-receipt2", store: "Albert Heijn", bought_on: "2026-10-30", total_cents: 499, lines: [{ name: "Kruidvat Voetzalf", brand: "Kruidvat", size: "75 ml", qty: 1, price_cents: 499 }] }),
    op({ type: "purchase.add", id: "purchase-priv-zalf2", item_id: "item-priv-new0001", title: "Voetzalf", bought_on: "2026-10-30", store: "Albert Heijn", qty: 1, price_cents: 499,
      source: "receipt", receipt_id: "ah-priv-receipt2", pantry: true, product: { id: PRODUCT, name: "Kruidvat Voetzalf", brand: "Kruidvat", size: "75 ml" } }),
  ]));
  const t = await sync(env, thomas);
  assert.equal(t.purchases.find((p) => p.id === "purchase-priv-zalf2").item_id, ITEM, "on the private item, not a new one");
  const s = await sync(env, sam);
  assert.ok(!mentions(s));
  assert.deepEqual(s.receipts.find((r) => r.id === "ah-priv-receipt2").lines, []);
});

test("widget: the other member's widget and suggestion names have nothing of it", async () => {
  const { env, thomas, sam } = await household();
  allOk(await send(env, thomas, [
    op({ type: "item.private", item_id: ITEM, private: true }),
    op({ type: "entry.add", id: "entry-priv-zalf2", item_id: ITEM, title: "Voetzalf" }),
  ]));
  const w = await json(await call(env, "GET", "/api/widget", sam));
  assert.equal(w.status, 200);
  assert.ok(!mentions(w.body), JSON.stringify(w.body));
  assert.ok(JSON.stringify(w.body).includes("Brood"));
  const names = (await json(await call(env, "GET", "/api/widget/names", sam))).body;
  assert.ok(!mentions(names));
  assert.ok(names.names.some((x) => x.n === "Brood"));
  assert.ok(mentions((await json(await call(env, "GET", "/api/widget", thomas))).body));
  assert.ok((await json(await call(env, "GET", "/api/widget/names", thomas))).body.names.some((x) => x.n === "Voetzalf"));
  // A quick add of its name from Sam's widget is not_found, nothing made.
  const add = await json(await call(env, "POST", "/api/quick-add", { ...sam, body: { text: "voetzalf", op_id: "op-quick-zalf0001" } }));
  assert.deepEqual([add.status, add.body.error], [400, "not_found"]);
});

test("merges: a private item never merges with a public one or moves a product across", async () => {
  const { env, thomas } = await household();
  allOk(await send(env, thomas, [
    op({ type: "item.private", item_id: ITEM, private: true }),
    op({ type: "entry.add", id: "entry-priv-crem1", item_id: "item-priv-creme01", title: "Voetcreme" }),
  ]));
  const refused = await send(env, thomas, [
    op({ type: "item.merge", from_item_id: ITEM, into_item_id: "item-priv-brood1", on: DAY }),
    op({ type: "item.merge", from_item_id: "item-priv-creme01", into_item_id: ITEM, on: DAY }),
    op({ type: "product.move", product_id: PRODUCT, item_id: "item-priv-brood1", on: DAY }),
    op({ type: "product.move", product_id: "product-priv-brood", item_id: ITEM, on: DAY }),
  ]);
  assert.deepEqual(refused.map((r) => r.error), ["private_mismatch", "private_mismatch", "private_mismatch", "private_mismatch"]);
  // Both his own: fine.
  allOk(await send(env, thomas, [
    op({ type: "item.private", item_id: "item-priv-creme01", private: true }),
    op({ type: "item.merge", from_item_id: "item-priv-creme01", into_item_id: ITEM, on: DAY }),
  ]));
});

test("merges: the nightly plan and the dedupe tool leave private items out", () => {
  const facts = (name, privateTo = null) => ({ item: { id: name, name, private_to: privateTo }, bought: 1, rules: 0, rate: false });
  assert.equal(mergeProblem(facts("Voetzalf", "m1"), facts("Voetzalf", null)), "private");
  assert.equal(mergeProblem(facts("Voetzalf", "m1"), facts("Voetzalf", "m2")), "private");
  const data = { items: {
    "item-a": { id: "item-a", name: "Voetzalf", name_key: "voetzalf", private_to: "m1" },
    "item-b": { id: "item-b", name: "Voetzalven", name_key: "voetzalven" },
    "item-c": { id: "item-c", name: "Uien", name_key: "uien" },
    "item-d": { id: "item-d", name: "Ui", name_key: "ui" },
  } };
  const groups = planGroups(data);
  const inGroups = JSON.stringify(groups.clear) + JSON.stringify(groups.doubt);
  assert.ok(!inGroups.includes("item-a"), inGroups);
});

test("engine: item.private writes the item and every row about it again; bad input refused", () => {
  const s = emptyState();
  s.items[ITEM] = { id: ITEM, name: "Voetzalf", name_key: "voetzalf", deleted_at: null };
  s.purchases.p1 = { id: "p1", item_id: ITEM, product_id: PRODUCT, receipt_id: "r1", deleted_at: null };
  s.products[PRODUCT] = { id: PRODUCT, item_id: ITEM, deleted_at: null };
  s.ratings.x1 = { id: "x1", product_id: PRODUCT };
  s.receipts.r1 = { id: "r1", lines: [] };
  const { changed, result } = applyOp(s, { type: "item.private", item_id: ITEM, private: true }, { memberId: "m1", now: "t" });
  assert.deepEqual(result, { private: true });
  assert.deepEqual(changed.map(([k, id]) => `${k}:${id}`).sort(), ["items:" + ITEM, "products:" + PRODUCT, "purchases:p1", "ratings:x1", "receipts:r1"].sort());
  assert.throws(() => applyOp(s, { type: "item.private", item_id: ITEM, private: false }, { memberId: "m2", now: "t" }), (e) => e instanceof OpError && e.code === "not_found");
  assert.throws(() => applyOp(s, { type: "item.private", item_id: ITEM, private: "ja" }, { memberId: "m1", now: "t" }), (e) => e.code === "bad_field");
  assert.ok(OP_TYPES.includes("item.private"));
});

test("privacy helpers: text, offers and rows by name, other names and product", () => {
  const hidden = hiddenOf([
    { k: "i", id: ITEM, name: "Voetzalf", a: "voetzalf" },
    { k: "a", id: "al1", name: "Zalf voor voeten", a: "zalf voor voeten", item_id: ITEM },
    { k: "p", id: PRODUCT, name: "Kruidvat Voetzalf", a: "Kruidvat", b: "75 ml", c: "kruidvat voetzalf|kruidvat|75 ml", item_id: ITEM },
  ]);
  assert.ok(namesHidden("Voetzalf: welke maat?", hidden));
  assert.ok(namesHidden("de zalf voor voeten", hidden));
  assert.ok(!namesHidden("Brood klopt.", hidden));
  assert.ok(rowHidden("offers", { name: "Voetzalf", brand: "Kruidvat", store: "Kruidvat" }, hidden));
  assert.ok(!rowHidden("offers", { name: "Brood", brand: "AH", store: "AH" }, hidden));
  assert.ok(rowHidden("pending_takes", { id: "x", item_id: ITEM }, hidden));
  assert.ok(rowHidden("store_prices", { id: "x", product_id: PRODUCT }, hidden));
  assert.deepEqual(rowFor("receipts", { id: "r", lines: [{ name: "Kruidvat Voetzalf", brand: "Kruidvat", size: "75 ml" }, { name: "Brood" }] }, hidden).lines, [{ name: "Brood" }]);
  const nothing = hiddenOf([]);
  assert.ok(nothing.empty && !rowHidden("items", { id: ITEM }, nothing));
});
