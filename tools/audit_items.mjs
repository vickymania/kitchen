// Which products sit under an item of another kind (28-10-2026: the
// AH import had put "Knorr Goodpasta", a snack cup, under "Pasta", and made it
// his AH product for "500 g pasta"). Reads the live data, never writes it
// unless --push is given.
//
//     node tools/audit_items.mjs --preview [origin]   read /api/sync, write migration/ah/audit-items.txt, print a summary
//     node tools/audit_items.mjs --preview --no-fetch  the same without asking AH for missing categories
//     node tools/audit_items.mjs --push <origin>      re-point the mismatched purchases and fix the import's preferences
//
// A product's kind: its stored kind, else AH's category (fetched once per
// webshop id into migration/ah/categories.json, tools/ah_pull.mjs
// pullCategories), else the name rules (public/shared/product-kinds.js). An
// item's kind: "ingredient" when a live recipe uses it or it is a cooking
// basic, else the kind most of its purchases have.
//
// --push never hard-deletes: a purchase moves as a purchase.add with a new id
// (hashed from the old one, so a second run changes nothing) plus a
// purchase.delete (a tombstone) of the old one. A product the reviewed table
// (tools/ah_items.mjs) maps to its current item is reported, never moved.
// Only preferences the AH import made (its own ids) are changed; one a person
// chose stays. The Bearer token comes from mcp/.env and is never printed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nameKey } from "../public/shared/ingredients.js";
import { isExcluded } from "../public/shared/excluded.js";
import { canonicalStore } from "../public/shared/stores.js";
import { categoryText, itemKinds, kindFits, kindFromCategory, kindFromName, isKind } from "../public/shared/product-kinds.js";
import { stableId } from "./import_todo.mjs";
import { AH_ITEMS, AH_BRAND_ITEMS } from "./ah_items.mjs";
import { AH_DIR, STORE, bareTitle, mapProduct, ownItemName, itemIdFor, pushOps, readToken, MIN_PREFERENCE_RECEIPTS } from "./import_ah.mjs";

export const REPORT_FILE = path.join(AH_DIR, "audit-items.txt");

const byId = (rows) => Object.fromEntries((rows ?? []).filter((r) => r && !r.deleted_at).map((r) => [r.id, r]));

/** The webshop id in an AH product id ("ah-product-62025"), or null. */
export const webshopIdOf = (productId) => /^ah-product-(\d+)$/.exec(String(productId ?? ""))?.[1] ?? null;

/** The id the AH import gives its preference for an item (tools/import_ah.mjs buildOps). */
export const importPreferenceId = (itemName) => stableId("pref", `ah:${nameKey(itemName)}`);

/**
 * The live data with each product's category and kind filled in: its own,
 * else AH's from `categories` ({ webshopId: { main, sub } | null }), else the
 * name rules. `kindSource` says which.
 */
export function withKinds(data, categories = {}) {
  const products = {};
  for (const p of Object.values(data.products ?? {})) {
    const w = webshopIdOf(p.id);
    const cat = p.category || (w && categories[w] ? categoryText(categories[w].main, categories[w].sub) : "");
    let kind = isKind(p.kind) ? p.kind : null;
    let kindSource = kind ? "stored" : null;
    if (!kind && cat) { kind = kindFromCategory(cat); kindSource = kind ? "ah" : null; }
    if (!kind) { kind = kindFromName(p.name, p.brand); kindSource = kind ? "rule" : null; }
    products[p.id] = { ...p, category: cat || null, kind, kindSource };
  }
  return { ...data, products };
}

/**
 * The audit, pure: { mismatches, merged, kinds }.
 * mismatches: [{ item, itemKind, why, products: [{ product, kind, kindSource, purchases, receipts,
 *   preference: "import" | "person" | null, table, target }] , purchases }] sorted by purchases.
 * merged: items whose products are clearly two different things.
 */
export function auditItems(data) {
  const kinds = itemKinds(data);
  const prefsByItem = new Map();
  for (const pr of Object.values(data.preferences ?? {})) {
    if (!pr || pr.deleted_at || !pr.product_id) continue;
    prefsByItem.set(pr.item_id, [...(prefsByItem.get(pr.item_id) ?? []), pr]);
  }
  // Per item, per product: the live purchases.
  const groups = new Map();
  for (const x of Object.values(data.purchases ?? {})) {
    if (!x || x.deleted_at || !x.product_id || !x.item_id) continue;
    const item = data.items?.[x.item_id];
    const product = data.products?.[x.product_id];
    if (!item || item.deleted_at || !product || product.deleted_at) continue;
    if (!groups.has(item.id)) groups.set(item.id, new Map());
    const per = groups.get(item.id);
    if (!per.has(product.id)) per.set(product.id, []);
    per.get(product.id).push(x);
  }
  const vocab = vocabOf(data, kinds);
  const itemKindOf = (name) => {
    const it = Object.values(data.items ?? {}).find((i) => !i.deleted_at && i.name_key === nameKey(name));
    return (it && kinds.get(it.id)?.kind) ?? kindFromName(name);
  };
  const mismatches = [];
  const merged = [];
  for (const [itemId, per] of groups) {
    const item = data.items[itemId];
    const k = kinds.get(itemId) ?? { kind: null, why: null, counts: {} };
    const bad = [];
    for (const [productId, list] of per) {
      const p = data.products[productId];
      if (kindFits(k.kind, p.kind)) continue;
      const prefs = (prefsByItem.get(itemId) ?? []).filter((pr) => pr.product_id === productId);
      const preference = prefs.length ? (prefs.some((pr) => pr.id === importPreferenceId(item.name)) ? "import" : "person") : null;
      const w = webshopIdOf(productId);
      const table = Boolean(w && AH_ITEMS[w] && nameKey(AH_ITEMS[w]) === item.name_key);
      bad.push({
        product: p, kind: p.kind, kindSource: p.kindSource, purchases: list.length,
        receipts: new Set(list.map((x) => x.receipt_id).filter(Boolean)).size,
        preference, prefs, table, list,
        target: table ? null : targetItem(p, item, vocab, itemKindOf),
      });
    }
    if (bad.length) {
      bad.sort((a, b) => b.purchases - a.purchases);
      mismatches.push({ item, itemKind: k.kind, why: k.why, products: bad, purchases: bad.reduce((n, b) => n + b.purchases, 0) });
    }
    // Two different things under one name: two kinds (or two AH main
    // categories of two kinds) each with at least 2 purchases and a fifth of them.
    const total = [...per.values()].reduce((n, l) => n + l.length, 0);
    const kindCount = {};
    const mainCount = {};
    for (const [productId, list] of per) {
      const p = data.products[productId];
      if (p.kind) kindCount[p.kind] = (kindCount[p.kind] ?? 0) + list.length;
      const main = p.category ? p.category.split(" > ")[0] : null;
      if (main) mainCount[main] = (mainCount[main] ?? 0) + list.length;
    }
    const strong = (counts) => Object.entries(counts).filter(([, n]) => n >= 2 && n >= total / 5);
    const strongKinds = strong(kindCount);
    const strongMains = strong(mainCount);
    if (strongKinds.length >= 2 || strongMains.length >= 3) {
      merged.push({ item, total, kinds: kindCount, mains: mainCount,
        products: [...per].map(([pid, l]) => ({ product: data.products[pid], purchases: l.length })).sort((a, b) => b.purchases - a.purchases) });
    }
  }
  mismatches.sort((a, b) => b.purchases - a.purchases || a.item.name.localeCompare(b.item.name));
  const unknownMap = new Map();
  for (const [itemId, per] of groups) for (const [productId, list] of per) {
    const p = data.products[productId];
    if (p.kind) continue;
    const u = unknownMap.get(productId) ?? { product: p, purchases: 0, items: [] };
    u.purchases += list.length;
    u.items.push(data.items[itemId].name);
    unknownMap.set(productId, u);
  }
  const unknown = [...unknownMap.values()].sort((a, b) => b.purchases - a.purchases);
  merged.sort((a, b) => b.total - a.total);
  return { mismatches, merged, unknown, kinds };
}

/** The household's item names as the import's vocabulary: { key, name, count }. */
function vocabOf(data, kinds) {
  const counts = new Map();
  for (const x of Object.values(data.purchases ?? {})) if (x && !x.deleted_at) counts.set(x.item_id, (counts.get(x.item_id) ?? 0) + 1);
  const vocab = new Map();
  for (const it of Object.values(data.items ?? {})) {
    if (!it || it.deleted_at || isExcluded(it.name) || !it.name_key || it.name_key.split(" ").length > 3) continue;
    const cur = vocab.get(it.name_key);
    const count = counts.get(it.id) ?? 0;
    if (!cur || count > cur.count) vocab.set(it.name_key, { key: it.name_key, name: it.name, count, kind: kinds.get(it.id)?.kind ?? null });
  }
  return vocab;
}

/**
 * The better item for a product of the wrong kind: the import's own mapping
 * with the kind guard, without the reviewed table; when that lands on the same
 * item, "<item> beker" for a cup or the product's short name.
 */
export function targetItem(product, item, vocab, itemKindOf) {
  const bare = bareTitle(product.name, product.brand);
  const line = { bare, brand: product.brand ?? "", fullName: product.name, name: product.name, receiptName: product.name, productKind: product.kind, webshopId: null, posId: null };
  const fitting = new Map([...vocab].filter(([, v]) => kindFits(v.kind, product.kind)));
  const mapped = mapProduct(line, fitting, {}, AH_BRAND_ITEMS, { itemKindOf });
  let name = mapped.item;
  // Nothing of its kind matched, or the same item again: a cup gets "<item>
  // beker", anything else its own short name.
  if (mapped.how === "guess" || nameKey(name) === item.name_key) name = ownItemName(line, item.name);
  if (nameKey(name) === item.name_key) return null;
  return name;
}

/* ------------------------------------------------------------ report */

const pad = (s, n) => String(s).padEnd(n);

export function reportText({ mismatches, merged, unknown = [] }, { at = new Date().toISOString().slice(0, 10), origin = "" } = {}) {
  const lines = [];
  const all = mismatches.flatMap((m) => m.products.map((p) => ({ ...p, item: m.item, itemKind: m.itemKind, why: m.why })));
  const purchases = all.reduce((n, p) => n + p.purchases, 0);
  const prefs = all.filter((p) => p.preference);
  lines.push(`Item audit (${at})${origin ? ` against ${origin}` : ""}`, "");
  lines.push(`Products of the wrong kind for their item: ${all.length} (${purchases} purchases) under ${mismatches.length} items.`);
  lines.push(`Of those a preference now: ${prefs.length} (${prefs.filter((p) => p.preference === "import").length} made by the AH import, ${prefs.filter((p) => p.preference === "person").length} chosen by a person).`);
  lines.push(`Kept by the reviewed table (tools/ah_items.mjs), never moved by --push: ${all.filter((p) => p.table).length}.`);
  lines.push(`Suspected merged items (two different things under one name): ${merged.length}.`);
  lines.push(`Products whose kind nobody knows yet (no AH category, no name rule; Claude Haiku asks after the next purchase): ${unknown.length}.`, "");
  lines.push("Kind of an item: recipe = a live recipe uses it, basic = a cooking basic, products = most of its purchases, name = the name rules.");
  lines.push("Kind of a product: stored, ah = AH's category, rule = the name rules.", "");
  lines.push("== Top mismatches: item <- product (kind, purchases, preference?) -> where --push moves it ==");
  for (const p of [...all].sort((a, b) => b.purchases - a.purchases || a.item.name.localeCompare(b.item.name))) {
    lines.push(`${pad(p.item.name, 24)} <- ${pad([p.product.brand && !p.product.name.startsWith(p.product.brand) ? p.product.brand : "", p.product.name].filter(Boolean).join(" "), 52)} (${p.kind}, ${p.purchases}x${p.preference ? `, PREFERENCE ${p.preference}` : ""})${p.table ? "  [table: stays]" : p.target ? `  -> ${p.target}` : "  [no better item]"}`);
  }
  lines.push("", "== Per item ==");
  for (const m of mismatches) {
    lines.push(`${m.item.name}  (item kind ${m.itemKind ?? "?"} by ${m.why ?? "?"}; ${m.purchases} purchases of the wrong kind)`);
    for (const p of m.products) {
      lines.push(`    ${pad(p.product.name, 50)} ${pad(`${p.kind} (${p.kindSource})`, 24)} ${String(p.purchases).padStart(3)}x  ${p.product.category ?? ""}${p.preference ? `  PREFERENCE (${p.preference})` : ""}`);
    }
  }
  lines.push("", `== Unknown kind (${unknown.length}), by purchases ==`);
  for (const u of unknown) lines.push(`    ${pad(u.product.name, 50)} ${String(u.purchases).padStart(3)}x  under ${u.items.join(", ")}`);
  lines.push("", "== Suspected merged items: purchases per kind and per AH main category ==");
  for (const m of merged) {
    lines.push(`${m.item.name}  (${m.total} purchases)  kinds: ${Object.entries(m.kinds).map(([k, n]) => `${k} ${n}`).join(", ")}  |  AH: ${Object.entries(m.mains).map(([k, n]) => `${k} ${n}`).join(", ")}`);
    for (const p of m.products.slice(0, 8)) lines.push(`    ${pad(p.product.name, 50)} ${pad(p.product.kind ?? "?", 14)} ${String(p.purchases).padStart(3)}x  ${p.product.category ?? ""}`);
  }
  return lines.join("\n");
}

/* -------------------------------------------------------------- push */

/**
 * The ops that fix the audit: per moved purchase a purchase.add (new id
 * hashed from the old) and a purchase.delete of the old; per moved product a
 * product.put with its kind, category and new item; per item whose import
 * preference was of the wrong kind a preference.clear at that scope, then the
 * item's best fitting AH product (2+ receipts) as its AH preference.
 */
export function fixOps(data, audit) {
  const ops = [];
  const items = Object.values(data.items ?? {}).filter((i) => !i.deleted_at);
  const itemIdOf = (name) => items.find((i) => i.name_key === nameKey(name))?.id ?? itemIdFor(name);
  const fixedPrefs = new Set();
  for (const m of audit.mismatches) {
    for (const p of m.products) {
      if (p.table || !p.target || isExcluded(p.target)) continue;
      const targetId = itemIdOf(p.target);
      for (const x of p.list) {
        ops.push({
          op_id: stableId("op", `audit-kind:add:${x.id}`),
          type: "purchase.add",
          id: stableId("purchase", `audit-kind:${x.id}`),
          item_id: targetId, title: p.target, bought_on: x.bought_on, store: x.store ?? "", qty: x.qty ?? null,
          price_cents: x.price_cents ?? null, source: x.source,
          ...(x.source === "receipt" && x.receipt_id ? { receipt_id: x.receipt_id } : {}),
          ...(x.source === "receipt" ? { product: { id: p.product.id, name: p.product.name, brand: p.product.brand ?? "", size: p.product.size ?? "" } } : {}),
        });
        ops.push({ op_id: stableId("op", `audit-kind:delete:${x.id}`), type: "purchase.delete", id: x.id });
      }
      ops.push({
        op_id: stableId("op", `audit-kind:product:${p.product.id}:${targetId}`),
        type: "product.put", id: p.product.id,
        product: { ...(p.product.kind ? { kind: p.product.kind } : {}), ...(p.product.category ? { category: p.product.category } : {}), item_id: targetId },
      });
      for (const pr of p.prefs) {
        if (pr.id !== importPreferenceId(m.item.name)) continue;
        ops.push({
          op_id: stableId("op", `audit-kind:clear:${pr.id}:${pr.product_id}`),
          type: "preference.clear", item_id: m.item.id, store: pr.store ?? "", recipe_id: pr.recipe_id ?? "",
        });
        fixedPrefs.add(m.item.id);
      }
    }
  }
  // A new AH preference for each item whose import preference was cleared:
  // the fitting product on the most receipts (then the newest), 2 or more.
  for (const itemId of fixedPrefs) {
    const item = data.items[itemId];
    const itemKind = audit.kinds.get(itemId)?.kind ?? null;
    const tally = new Map();
    for (const x of Object.values(data.purchases ?? {})) {
      if (!x || x.deleted_at || x.item_id !== itemId || !x.product_id || canonicalStore(x.store) !== STORE || !x.receipt_id) continue;
      const p = data.products[x.product_id];
      if (!p || !kindFits(itemKind, p.kind)) continue;
      const t = tally.get(p.id) ?? { receipts: new Set(), last: "" };
      t.receipts.add(x.receipt_id);
      if (x.bought_on > t.last) t.last = x.bought_on;
      tally.set(p.id, t);
    }
    const best = [...tally].filter(([, t]) => t.receipts.size >= MIN_PREFERENCE_RECEIPTS)
      .sort((a, b) => b[1].receipts.size - a[1].receipts.size || b[1].last.localeCompare(a[1].last))[0];
    if (!best) continue;
    ops.push({
      op_id: stableId("op", `audit-kind:prefer:${itemId}:${best[0]}`),
      type: "preference.set", id: stableId("pref", `audit-kind:${itemId}`), item_id: itemId, product_id: best[0], store: STORE,
    });
    void item;
  }
  return ops;
}

/* --------------------------------------------------------------- CLI */

export async function fetchSync(origin, token) {
  const res = await fetch(`${origin}/api/sync`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`/api/sync: ${res.status}`);
  const all = await res.json();
  return {
    items: byId(all.items), recipes: byId(all.recipes), products: byId(all.products),
    purchases: byId(all.purchases), preferences: byId(all.preferences),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const push = args.indexOf("--push");
  const preview = args.includes("--preview");
  if (!preview && push < 0) {
    console.log("Use --preview [origin] or --push <origin>.");
  } else {
    const named = push >= 0 ? args[push + 1] : args.find((a) => /^https?:\/\//.test(a));
    const origin = (named ?? "https://groceries.vexed.works").replace(/\/$/, "");
    if (push >= 0 && !/^https?:\/\//.test(named ?? "")) throw new Error("--push needs an origin, e.g. https://groceries.vexed.works");
    const token = readToken();
    const raw = await fetchSync(origin, token);
    const { pullCategories, readCategories } = await import("./ah_pull.mjs");
    if (!args.includes("--no-fetch")) {
      const ids = Object.keys(raw.products).map(webshopIdOf).filter(Boolean).map(Number);
      await pullCategories(AH_DIR, ids, { log: (l) => console.log(l) });
    }
    const data = withKinds(raw, readCategories(AH_DIR));
    const audit = auditItems(data);
    fs.mkdirSync(AH_DIR, { recursive: true });
    const text = reportText(audit, { origin });
    fs.writeFileSync(REPORT_FILE, text);
    const head = text.split("\n");
    console.log(head.slice(0, 6).join("\n"));
    console.log(head.slice(head.indexOf("== Top mismatches: item <- product (kind, purchases, preference?) -> where --push moves it =="), head.indexOf("== Top mismatches: item <- product (kind, purchases, preference?) -> where --push moves it ==") + 31).join("\n"));
    console.log(`\nWritten: ${REPORT_FILE}`);
    if (push >= 0) {
      const ops = fixOps(data, audit);
      console.log(`Sending ${ops.length} ops to ${origin}...`);
      const failed = await pushOps(ops, origin, token);
      console.log(`\nSent ${ops.length} ops; refused ${failed.length}.`);
      if (failed.length) { console.log(JSON.stringify(failed.slice(0, 20))); process.exitCode = 1; }
    }
  }
}
