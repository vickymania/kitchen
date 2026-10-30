// Both languages in the data (30-10-2026): an item's English name next to
// its Dutch one, a recipe's translation into the other language, picked by
// the member's language everywhere (screens, widget, MCP), and filled in the
// Claude calls that already happen (receipt, import, labeller, the shelf and
// kinds Haiku requests), never by a call of its own where one goes anyway.
// Fictional household: Thomas, Sam, the guest Henk.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import { applyOp, emptyState, findItem, OP_TYPES } from "../public/shared/ops.js";
import { nameKey } from "../public/shared/ingredients.js";
import { suggest } from "../public/shared/suggest.js";
import {
  itemLabel, localName, detectLang, recipeLang, recipeFingerprint, shownRecipe, needsTranslation, freshTranslation, cleanTranslation,
} from "../public/shared/bilingual.js";
import { reviewerMayApply, importerMayApply, guestMayApply } from "../worker/auth.js";
import { PHOTO_SCHEMA, PAGE_SCHEMA, draftOf } from "../worker/recipe-import.js";
import { SCHEMA as RECEIPT_SCHEMA, reviewOf } from "../worker/receipts.js";
import { LABEL_TRANSLATE_SCHEMA } from "../worker/labels.js";
import { TRANSLATE_DAILY_LIMIT } from "../worker/translate.js";
import { kindPrompt, nameAnswers } from "../worker/kinds.js";
import { exportData, opsFromFile, simulate, FORMAT } from "../tools/fill_translations.mjs";
import { hiddenOf, namesHidden } from "../worker/privacy.js";

const HOST = "groceries.localhost:8787";
const RECIPES = "recipes.localhost:8787";
const KEY = { ANTHROPIC_API_KEY: "test-key-not-real" };

function call(env, method, path, { body, cookie, host = HOST, waits } = {}) {
  const headers = { Origin: `http://${host}` };
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const ctx = waits ? { waitUntil: (p) => waits.push(p) } : undefined;
  return worker.fetch(new Request(`http://${host}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
}
const tokenOf = (res) => res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
let n = 0;
const op = (o) => ({ op_id: `op-bil-${String(++n).padStart(6, "0")}`, ...o });

async function send(env, cookie, ops, { host = HOST } = {}) {
  const waits = [];
  const res = await call(env, "POST", "/api/ops", { cookie, body: { ops }, waits, host });
  const out = await res.json();
  await Promise.all(waits);
  return { status: res.status, results: out.results, error: out.error };
}
const pull = async (env, cookie, host = HOST) => (await call(env, "GET", "/api/sync?since=0", { cookie, host })).json();

async function household(extra = {}) {
  const env = await makeEnv();
  Object.assign(env, extra);
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const thomas = tokenOf(await call(env, "POST", "/api/pair", { body: { code: "123456", label: "phone" } }));
  const me = await (await call(env, "GET", "/api/me", { cookie: thomas })).json();
  return { env, thomas, memberId: me.member.id };
}

/**
 * Claude, told apart by the answer's schema: English names (the kinds
 * request), shelf lives (with name_en when asked), a recipe translation,
 * labels with a translation. Every request is recorded.
 */
function mockClaude({ names = {} } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const schema = body.output_config.format.schema;
    const text = body.messages[0].content.map((c) => c.text ?? "").join("\n");
    let answer;
    let kind;
    const row = schema.properties.items?.items?.properties;
    if (row?.shelf_days) {
      kind = row.name_en ? "shelf+names" : "shelf";
      const lines = text.split("\n").map((l) => l.match(/^(\d+)\. ([^(]+?)(?: \(|$)/)).filter(Boolean);
      answer = { items: lines.map(([, k, name]) => ({ n: Number(k), shelf_days: 5, opened_days: 0, kind: "t", ...(row.name_en ? { name_en: names[name] ?? `${name} EN` } : {}) })) };
    } else if (row?.name_en) {
      kind = schema.properties.products ? "kinds+names" : "names";
      const lines = text.split("\n").map((l) => l.match(/^Item (\d+): (.+)$/)).filter(Boolean);
      answer = { items: lines.map(([, k, name]) => ({ n: Number(k), name_en: names[name] ?? `${name} EN` })), products: [] };
    } else if (schema.properties.cuisine && schema.properties.translation) {
      kind = "labels+translation";
      answer = { cuisine: "other", main_ingredient: "other", time_class: "fast", time_minutes: 20, meals: ["dinner"],
        translation: { title: "Pea soup", ingredients: ["500 g split peas"], steps: ["Cook the peas."], notes: "" } };
    } else if (schema.properties.translation) {
      kind = "translation";
      answer = { translation: { title: "Pea soup, thicker", ingredients: ["600 g split peas", "1 onion"], steps: ["Cook the peas.", "Add the onion."], notes: "" } };
    } else {
      kind = "other";
      answer = { products: [] };
    }
    calls.push({ kind, body, text });
    return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(answer) }] }), { status: 200 });
  };
  return { calls, of: (k) => calls.filter((c) => c.kind === k), restore: () => { globalThis.fetch = original; } };
}

const SOUP = {
  title: "Erwtensoep", servings: 4,
  ingredients: [{ qty: 500, unit: "g", name: "spliterwten", raw: "500 g spliterwten" }],
  steps: ["Kook de erwten met de ui."],
};

// ------------------------------------------------------------ pure parts

test("pick: an item's English name in English, the Dutch name otherwise or when it has none", () => {
  const items = { a: { id: "a", name: "Melk", name_key: "melk", name_en: "Milk" }, b: { id: "b", name: "Hagelslag", name_key: "hagelslag" } };
  assert.equal(itemLabel(items.a, "en"), "Milk");
  assert.equal(itemLabel(items.a, "nl"), "Melk");
  assert.equal(itemLabel(items.b, "en"), "Hagelslag", "no English name: the Dutch one");
  assert.equal(localName({ items }, "en", "Melk"), "Milk", "a line's title, by key");
  assert.equal(localName({ items }, "en", "melk"), "Milk");
  assert.equal(localName({ items }, "nl", "Melk"), "Melk");
  assert.equal(localName({ items }, "en", "Iets anders"), "Iets anders");
});

test("recipes: the language from the text, the translation only while it is of this version, the original on request", () => {
  assert.equal(detectLang(SOUP), "nl");
  assert.equal(detectLang({ title: "Pea soup", steps: ["Cook the peas with the onion until soft."] }), "en");
  const r = { id: "recipe-soup-0001", lang: "nl", ...SOUP, notes: "" };
  r.translation = cleanTranslation({ title: "Pea soup", ingredients: ["500 g split peas"], steps: ["Cook the peas."], notes: "" }, r);
  assert.equal(r.translation.lang, "en");
  assert.equal(r.translation.of, recipeFingerprint(r));
  assert.equal(needsTranslation(r), false);
  const en = shownRecipe(r, "en");
  assert.equal(en.translated, true);
  assert.equal(en.recipe.title, "Pea soup");
  assert.equal(en.recipe.ingredients[0].name, "split peas", "the lines are parsed again for display");
  assert.equal(en.recipe.ingredients[0].qty, 500);
  assert.equal(en.recipe.id, r.id, "the same recipe: servings, photo, id stay");
  assert.equal(shownRecipe(r, "nl").translated, false, "in its own language: the original");
  assert.equal(shownRecipe(r, "en", { original: true }).recipe, r, "Origineel");
  // An edit of the original: stale, the original shows until it is refreshed.
  const edited = { ...r, steps: ["Kook de erwten zacht."] };
  assert.equal(freshTranslation(edited), null);
  assert.equal(needsTranslation(edited), true);
  assert.deepEqual([shownRecipe(edited, "en").translated, shownRecipe(edited, "en").stale], [false, true]);
  assert.equal(cleanTranslation({ lang: "nl", title: "x" }, r), null, "a translation into its own language is none");
});

test("matching: typed in English finds the item; a Dutch name wins; two items with one English name mean neither", () => {
  const s = emptyState();
  const item = (id, name, name_en) => { s.items[id] = { id, name, name_key: nameKey(name), name_en, name_en_key: name_en ? nameKey(name_en) : null }; };
  item("item-melk-0001", "Melk", "Milk");
  item("item-kaas-0001", "Kaas", "Cheese");
  item("item-geit-0001", "Geitenkaas", "Cheese");
  item("item-pind-0001", "Pindakaas", "Peanut butter");
  item("item-oliv-0001", "Olie", "Oil");
  item("item-zonn-0001", "Zonnebloemolie", "Oil");
  assert.equal(findItem(s, "milk")?.id, "item-melk-0001");
  assert.equal(findItem(s, "peanutbutter")?.id, "item-pind-0001", "without spaces, as aliases");
  assert.equal(findItem(s, "kaas")?.id, "item-kaas-0001", "the Dutch name first");
  assert.equal(findItem(s, "cheese"), null, "Kaas and Geitenkaas are both Cheese: ambiguous, never a guess");
  assert.equal(findItem(s, "oil"), null);
  // The add box: "mil" offers Melk, matched through its English name.
  const view = { items: s.items, aliases: {}, purchases: {} };
  assert.equal(suggest(view, "mil", { today: "2026-10-30" })[0]?.item.id, "item-melk-0001");
});

// ------------------------------------------------------------ the ops

test("item.translate: a person's name wins over Claude's, a clear, unknown items refused; who may send it", async () => {
  const { env, thomas } = await household();
  let r = await send(env, thomas, [op({ type: "entry.add", id: "entry-melk-0001", item_id: "item-melk-0001", title: "Melk" })]);
  r = await send(env, thomas, [
    op({ type: "item.translate", item_id: "item-melk-0001", name_en: "Milk", source: "claude" }),
    op({ type: "item.translate", item_id: "item-melk-0001", name_en: "Semi-skimmed milk" }),
    op({ type: "item.translate", item_id: "item-melk-0001", name_en: "Moo", source: "claude" }),
    op({ type: "item.translate", item_id: "item-nope-00001", name_en: "x" }),
    op({ type: "item.translate", item_id: "item-melk-0001", name_en: "x", source: "robot" }),
  ]);
  assert.deepEqual(r.results.map((x) => x.ok), [true, true, true, false, false]);
  assert.deepEqual(r.results[2].result, { kept: true }, "Claude never replaces a person's English name");
  assert.deepEqual(r.results.slice(3).map((x) => x.error), ["not_found", "bad_field"]);
  let melk = (await pull(env, thomas)).items.find((i) => i.id === "item-melk-0001");
  assert.deepEqual([melk.name_en, melk.name_en_key, melk.name_en_source], ["Semi-skimmed milk", "semi skimmed milk", "person"]);
  await send(env, thomas, [op({ type: "item.translate", item_id: "item-melk-0001", name_en: null })]);
  melk = (await pull(env, thomas)).items.find((i) => i.id === "item-melk-0001");
  assert.deepEqual([melk.name_en, melk.name_en_source], [null, null], "cleared");
  // The nightly check may add Claude's, never clear one or write a person's; the importer and a guest never.
  assert.equal(reviewerMayApply({ type: "item.translate", item_id: "i", name_en: "Milk", source: "claude" }), true);
  assert.equal(reviewerMayApply({ type: "item.translate", item_id: "i", name_en: "Milk" }), false);
  assert.equal(reviewerMayApply({ type: "item.translate", item_id: "i", name_en: "", source: "claude" }), false);
  assert.equal(importerMayApply({ type: "item.translate", item_id: "i", name_en: "Milk" }), false);
  assert.equal(guestMayApply({ type: "item.translate" }), false);
  assert.equal(guestMayApply({ type: "recipe.translate" }), false);
  assert.ok(OP_TYPES.includes("item.translate") && OP_TYPES.includes("recipe.translate"));
});

test("item.translate from the reviewer: logged in the changelog; a never-suggest English name refused", async () => {
  const { env, thomas } = await household();
  await send(env, thomas, [op({ type: "entry.add", id: "entry-melk-0002", item_id: "item-melk-0002", title: "Melk" })]);
  const code = await (await call(env, "POST", "/api/codes", { cookie: thomas, body: { for: "reviewer" } })).json();
  const reviewer = tokenOf(await call(env, "POST", "/api/pair", { body: { code: code.code, label: "Thuisserver controle" } }));
  const bad = await send(env, reviewer, [op({ type: "item.translate", item_id: "item-melk-0002", name_en: "Groenhof milk", source: "claude" })]);
  assert.equal(bad.status, 403);
  const ok = await send(env, reviewer, [op({ type: "item.translate", item_id: "item-melk-0002", name_en: "Milk", source: "claude" })]);
  assert.equal(ok.status, 200);
  const log = (await pull(env, thomas)).auto_changes;
  assert.deepEqual(log.map((c) => [c.what, c.name, c.target]), [["translate", "Melk", "Milk"]]);
});

test("the server finds an English name typed on the list, also after a reload of only those rows", async () => {
  const { env, thomas } = await household();
  await send(env, thomas, [
    op({ type: "entry.add", id: "entry-melk-0003", item_id: "item-melk-0003", title: "Melk" }),
    op({ type: "item.translate", item_id: "item-melk-0003", name_en: "Milk" }),
    op({ type: "entry.check", id: "entry-melk-0003", checked: true }),
  ]);
  const r = await send(env, thomas, [op({ type: "entry.add", id: "entry-milk-0001", item_id: "item-milk-new01", title: "milk" })]);
  assert.deepEqual(r.results[0].result, { item_id: "item-melk-0003", new_item: false }, "linked to Melk, no new item");
  const line = (await pull(env, thomas)).entries.find((e) => e.id === "entry-milk-0001");
  assert.equal(line.title, "Melk");
  assert.equal(line.typed, null, "the English name is the item's own name: nothing 'typed'");
});

test("recipe.translate: stored with the recipe's language, stale after an edit, guests see it but never items", async () => {
  const { env, thomas } = await household();
  let r = await send(env, thomas, [
    op({ type: "recipe.put", id: "recipe-soup-0002", recipe: { ...SOUP, labels_by: "person", cuisine: "dutch" } }),
    op({ type: "recipe.translate", id: "recipe-soup-0002", translation: { title: "Pea soup", ingredients: ["500 g split peas"], steps: ["Cook the peas."], notes: "" } }),
    op({ type: "recipe.translate", id: "recipe-soup-0002", translation: { lang: "nl", title: "Erwtensoep" } }),
    op({ type: "recipe.translate", id: "recipe-none-0001", translation: { title: "x" } }),
  ]);
  assert.deepEqual(r.results.map((x) => x.ok), [true, true, false, false]);
  let soup = (await pull(env, thomas)).recipes.find((x) => x.id === "recipe-soup-0002");
  assert.equal(soup.lang, "nl", "set from the text on save");
  assert.equal(soup.translation.title, "Pea soup");
  assert.equal(soup.translation.of, recipeFingerprint(soup));
  assert.equal(shownRecipe(soup, "en").recipe.title, "Pea soup");
  // A photo or a label is no new text: still fresh. A step changed: stale.
  await send(env, thomas, [op({ type: "recipe.put", id: "recipe-soup-0002", recipe: { time_minutes: 90, labels_by: "person" } })]);
  soup = (await pull(env, thomas)).recipes.find((x) => x.id === "recipe-soup-0002");
  assert.equal(needsTranslation(soup), false);
  await send(env, thomas, [op({ type: "recipe.put", id: "recipe-soup-0002", recipe: { steps: ["Kook de erwten zacht."] } })]);
  soup = (await pull(env, thomas)).recipes.find((x) => x.id === "recipe-soup-0002");
  assert.equal(needsTranslation(soup), true);
  assert.equal(shownRecipe(soup, "en").recipe.title, "Erwtensoep", "the original until it is refreshed");

  // The guest Henk: the book with its translations, never the items.
  const link = await (await call(env, "POST", "/api/invites", { cookie: thomas, host: RECIPES, body: { name: "Henk" } })).json();
  const henk = tokenOf(await call(env, "POST", "/api/pair", { host: RECIPES, body: { invite: link.url.match(/#\/join\/([\w-]+)$/)[1] } }));
  const guest = await pull(env, henk, RECIPES);
  assert.equal(guest.recipes.find((x) => x.id === "recipe-soup-0002").translation.title, "Pea soup");
  assert.equal(guest.items, undefined, "no items for a recipes-only guest");
  const refused = await send(env, henk, [op({ type: "recipe.translate", id: "recipe-soup-0002", translation: { title: "x" } })], { host: RECIPES });
  assert.equal(refused.status, 403);
});

// ------------------------------------------------------------ the widget

test("widget: the list, 'Al nodig?' and the add dialog's names in the member's language", async () => {
  const { env, thomas, memberId } = await household();
  await send(env, thomas, [
    op({ type: "entry.add", id: "entry-melk-0004", item_id: "item-melk-0004", title: "Melk" }),
    op({ type: "entry.add", id: "entry-hagel-001", item_id: "item-hagel-0001", title: "Hagelslag" }),
    op({ type: "item.translate", item_id: "item-melk-0004", name_en: "Milk" }),
  ]);
  const titles = async () => (await (await call(env, "GET", "/api/widget", { cookie: thomas })).json()).groups.flatMap((g) => g.lines.map((l) => l.title)).sort();
  assert.deepEqual(await titles(), ["Hagelslag", "Melk"], "Dutch member: Dutch names");
  await send(env, thomas, [op({ type: "member.update", id: memberId, locale: "en" })]);
  assert.deepEqual(await titles(), ["Hagelslag", "Milk"], "English member: English names, Dutch where there is none");
  const names = (await (await call(env, "GET", "/api/widget/names", { cookie: thomas })).json()).names;
  const milk = names.find((x) => x.i === "item-melk-0004");
  assert.equal(milk.n, "Milk");
  assert.deepEqual(milk.a, ["Melk"], "the Dutch name is another name: typing either finds it");
});

// ------------------------------------------------------------ Claude, in the calls that already go

test("new items: the English name comes in the shelf request that goes anyway; alone only in a batched names request", async () => {
  const { env, thomas } = await household(KEY);
  const claude = mockClaude({ names: { Kwark: "Quark" } });
  try {
    await send(env, thomas, [op({ type: "pantry.add", id: "pantry-kwark-001", item_id: "item-kwark-0001", title: "Kwark", amount: 1 })]);
    assert.deepEqual(claude.calls.map((c) => c.kind), ["shelf+names"], "one request: shelf life and English name");
    await send(env, thomas, [
      op({ type: "entry.add", id: "entry-thee-0001", item_id: "item-thee-00001", title: "Thee" }),
      op({ type: "entry.add", id: "entry-zeep-0001", item_id: "item-zeep-00001", title: "Zeep" }),
      op({ type: "entry.add", id: "entry-spru-0001", item_id: "item-spru-00001", title: "Spruitjes" }),
    ]);
    assert.deepEqual(claude.calls.map((c) => c.kind), ["shelf+names", "names"], "typed on the list: one batched names request");
    const asked = claude.of("names")[0].text;
    assert.match(asked, /Item 1: Thee\nItem 2: Zeep$/);
    assert.doesNotMatch(asked, /Spruit/i, "a never-suggest item is never sent");
    const items = (await pull(env, thomas)).items;
    const en = (id) => items.find((i) => i.id === id);
    assert.deepEqual([en("item-kwark-0001").name_en, en("item-kwark-0001").name_en_source], ["Quark", "claude"]);
    assert.equal(en("item-thee-00001").name_en, "Thee EN");
    assert.equal(en("item-spru-00001").name_en, null);
    // A known item on the list again: nothing asked.
    await send(env, thomas, [op({ type: "entry.add", id: "entry-thee-0002", item_id: "item-thee-00002", title: "Thee" })]);
    assert.equal(claude.calls.length, 2);
  } finally {
    claude.restore();
  }
  assert.match(kindPrompt([{ label: "Zwq Krokantje" }], [{ name: "Thee" }]), /^Give each item[\s\S]*Item 1: Thee[\s\S]*1\. Zwq Krokantje$/, "names and kinds in one request");
  assert.deepEqual([...nameAnswers([{ id: "a", name: "Thee" }], { items: [{ n: 1, name_en: "  Tea " }, { n: 2, name_en: "x" }] })], [["a", "Tea"]]);
});

test("recipes: an edit makes the translation stale and Haiku refreshes it in the background, capped per day; a new recipe's comes with the labeller", async () => {
  const { env, thomas } = await household(KEY);
  const claude = mockClaude();
  try {
    // New, unlabelled: no translation call of its own; the labeller's one call brings it.
    await send(env, thomas, [op({ type: "recipe.put", id: "recipe-soup-0003", recipe: SOUP })]);
    assert.equal(claude.calls.length, 0, "a new recipe waits for the labeller");
    const label = await (await call(env, "POST", "/api/recipes/label", { cookie: thomas, body: { id: "recipe-soup-0003" } })).json();
    assert.equal(label.translated, true);
    assert.deepEqual(claude.calls.map((c) => c.kind), ["labels+translation"]);
    let soup = (await pull(env, thomas)).recipes.find((x) => x.id === "recipe-soup-0003");
    assert.deepEqual([soup.translation.title, needsTranslation(soup), soup.cuisine], ["Pea soup", false, "other"]);
    // An edit of the text: stale; the worker translates it again (Haiku), after the answer.
    await send(env, thomas, [op({ type: "recipe.put", id: "recipe-soup-0003", recipe: { ingredients: [...SOUP.ingredients, { name: "ui", qty: 1, raw: "1 ui" }] } })]);
    const tr = claude.of("translation");
    assert.equal(tr.length, 1);
    assert.equal(tr[0].body.model, "claude-haiku-5-5");
    assert.match(tr[0].text, /Translate this home recipe into English[\s\S]*1 ui/);
    soup = (await pull(env, thomas)).recipes.find((x) => x.id === "recipe-soup-0003");
    assert.equal(soup.translation.title, "Pea soup, thicker");
    assert.equal(needsTranslation(soup), false);
    // The daily cap: over it, nothing is asked.
    const hh = (await env.DB.prepare("SELECT id FROM households").first()).id;
    await env.DB.prepare("UPDATE usage_limits SET count = ? WHERE bucket = ?").bind(TRANSLATE_DAILY_LIMIT, `translate:${hh}:${new Date().toISOString().slice(0, 10)}`).run();
    await send(env, thomas, [op({ type: "recipe.put", id: "recipe-soup-0003", recipe: { notes: "Lekker met roggebrood." } })]);
    assert.equal(claude.of("translation").length, 1, "over the cap: no call");
  } finally {
    claude.restore();
  }
});

test("import: the one Claude call returns the recipe's language and its translation; the receipt read names each line in English", () => {
  for (const schema of [PHOTO_SCHEMA, PAGE_SCHEMA]) {
    assert.ok(schema.required.includes("translation") && schema.required.includes("lang"));
    assert.deepEqual(schema.properties.translation.required, ["title", "ingredients", "steps", "notes"]);
  }
  assert.ok(LABEL_TRANSLATE_SCHEMA.required.includes("translation"));
  const draft = draftOf({
    is_recipe: true, title: "Erwtensoep", servings: 4, ingredients: ["500 g spliterwten"], steps: ["Kook."], notes: "",
    cuisine: "dutch", main_ingredient: "vegetarian", time_class: "elaborate", time_minutes: 120, meals: ["dinner"],
    lang: "nl", translation: { title: "Pea soup", ingredients: ["500 g split peas"], steps: ["Cook."], notes: "" },
  });
  assert.equal(draft.lang, "nl");
  assert.deepEqual(draft.translation, { lang: "en", title: "Pea soup", ingredients: ["500 g split peas"], steps: ["Cook."], notes: "" });
  assert.equal(draftOf({ is_recipe: true, title: "X", ingredients: ["1 ei"], steps: ["Bak."], notes: "" }).translation, null, "an answer without one: none");
  assert.ok(RECEIPT_SCHEMA.properties.lines.items.required.includes("name_en"));
  const review = reviewOf({ store: "AH", date: "2026-10-30", total: 2.5, lines: [
    { name: "Halfvolle melk", name_en: "Semi-skimmed milk", brand: "AH", size: "1 l", quantity: 1, price: 1.25, kind: "product" },
    { name: "Thee", name_en: "Groenhof tea", brand: "", size: "", quantity: 1, price: 1.25, kind: "product" },
  ] });
  assert.deepEqual(review.lines.map((l) => l.name_en), ["Semi-skimmed milk", ""], "a never-suggest English name is dropped");
});

// ------------------------------------------------------------ the fill tool

test("fill tool: exports what lacks the other language (no never-suggest items), and a filled file becomes Claude's ops", () => {
  const s = emptyState();
  s.items = {
    "item-melk-0005": { id: "item-melk-0005", name: "Melk", name_key: "melk", name_en: null },
    "item-kaas-0005": { id: "item-kaas-0005", name: "Kaas", name_key: "kaas", name_en: "Cheese", name_en_key: "cheese", name_en_source: "person" },
    "item-spru-0005": { id: "item-spru-0005", name: "Spruitjes", name_key: "spruitjes", name_en: null },
  };
  s.recipes = { "recipe-soup-0005": { id: "recipe-soup-0005", lang: "nl", ...SOUP, notes: "", translation: null } };
  const file = exportData(s, { origin: "http://example.test", now: "2026-10-30T12:00:00Z" });
  assert.equal(file.format, FORMAT);
  assert.deepEqual(file.items, [{ id: "item-melk-0005", name: "Melk", name_en: null }]);
  assert.deepEqual(file.recipes.map((r) => [r.id, r.lang, r.to, r.ingredients]), [["recipe-soup-0005", "nl", "en", ["500 g spliterwten"]]]);
  file.items[0].name_en = "Milk";
  file.recipes[0].translation = { title: "Pea soup", ingredients: ["500 g split peas"], steps: ["Cook the peas with the onion."], notes: "" };
  const { ops, notes } = opsFromFile(file);
  assert.deepEqual(notes, []);
  assert.deepEqual(ops.map((o) => [o.type, o.source ?? o.translation.by]), [["item.translate", "claude"], ["recipe.translate", "claude"]]);
  assert.equal(opsFromFile(file).ops[0].op_id, ops[0].op_id, "stable op ids: a second send is a replay");
  const outcomes = simulate(s, ops);
  assert.ok(outcomes.every((o) => o.ok), JSON.stringify(outcomes));
  assert.equal(s.items["item-melk-0005"].name_en, "Milk");
  assert.equal(shownRecipe(s.recipes["recipe-soup-0005"], "en").recipe.title, "Pea soup");
  assert.equal(recipeLang(s.recipes["recipe-soup-0005"]), "nl");
  assert.equal(applyOp(s, { type: "item.translate", item_id: "item-kaas-0005", name_en: "Hard cheese", source: "claude" }, { now: "2026-10-30T12:00:00Z" }).result.kept, true);
});

// ------------------------------------------------------------ private items (0028)

test("private items: the English name is as private as the item (sync, widget names, typed names, text, item.translate, the reviewer)", async () => {
  const { env, thomas, memberId: thomasId } = await household();
  const code = async (body) => (await (await call(env, "POST", "/api/codes", { cookie: thomas, body })).json()).code;
  const sam = tokenOf(await call(env, "POST", "/api/pair", { body: { code: await code({ for: "new_member", name: "Sam" }), label: "sam phone" } }));
  const reviewer = tokenOf(await call(env, "POST", "/api/pair", { body: { code: await code({ for: "reviewer" }), label: "Thuisserver controle" } }));
  const ZALF = "item-bil-zalf001";
  const own = await send(env, sam, [
    op({ type: "entry.add", id: "entry-bil-zalf01", item_id: ZALF, title: "Voetzalf" }),
    op({ type: "item.private", item_id: ZALF, private: true }),
    op({ type: "item.translate", item_id: ZALF, name_en: "Foot cream" }),
  ]);
  assert.ok(own.results.every((r) => r.ok), JSON.stringify(own.results));
  // Sam sees his own English name.
  assert.equal((await pull(env, sam)).items.find((i) => i.id === ZALF).name_en, "Foot cream");
  // Thomas (English) never: not in sync, not in the widget's names, not as a typed name.
  await send(env, thomas, [op({ type: "member.update", id: thomasId, locale: "en" })]);
  assert.doesNotMatch(JSON.stringify(await pull(env, thomas)), /foot cream|voetzalf/i);
  assert.doesNotMatch(JSON.stringify(await (await call(env, "GET", "/api/widget/names", { cookie: thomas })).json()), /foot cream|voetzalf/i);
  assert.doesNotMatch(JSON.stringify(await (await call(env, "GET", "/api/widget", { cookie: thomas })).json()), /foot cream|voetzalf/i);
  for (const title of ["Foot cream", "footcream"]) {
    const typed = await send(env, thomas, [op({ type: "entry.add", id: `entry-bil-fc-${title.length}x`, item_id: `item-bil-fc-${title.length}x`, title })]);
    assert.equal(typed.results[0].error, "not_found", `"${title}" names Sam's private item`);
  }
  // item.translate of someone else's private item: not_found, from a phone and from the nightly check.
  const theirs = await send(env, thomas, [op({ type: "item.translate", item_id: ZALF, name_en: "Ointment" })]);
  assert.equal(theirs.results[0].error, "not_found");
  const night = await send(env, reviewer, [op({ type: "item.translate", item_id: ZALF, name_en: "Ointment", source: "claude" })]);
  assert.equal(night.results[0].error, "not_found");
  assert.equal((await pull(env, sam)).items.find((i) => i.id === ZALF).name_en, "Foot cream", "nothing changed");
  // A report line that names it only in English is not shown to Thomas.
  const report = await send(env, reviewer, [op({ type: "review.save", day: "2026-10-30", run_ok: true, fixed: [], decide: ["Foot cream: which size?", "Bread is fine."], errors: [] })]);
  assert.ok(report.results[0].ok, JSON.stringify(report.results));
  assert.deepEqual((await pull(env, thomas)).reviews[0].decide, ["Bread is fine."]);
  const hidden = hiddenOf([{ k: "i", id: ZALF, name: "Voetzalf", a: "voetzalf", b: "foot cream" }]);
  assert.equal(namesHidden("Kruidvat Foot Cream 75 ml", hidden), true);
  assert.equal(namesHidden("Cream cheese", hidden), false);
});
