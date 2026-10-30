// Thomas's Albert Heijn receipts into kitchen: every product line becomes a
// product (store "Albert Heijn"), a purchase on that day and, per item, the
// AH product he bought most often becomes his AH preference, unless he
// already has one there. Sent through /api/ops like any phone's change.
//
//     node tools/import_ah.mjs --pull                fetch new receipts into migration/ah/ (sequential, cached)
//     node tools/import_ah.mjs --preview             write migration/ah/preview.txt, send nothing
//     node tools/import_ah.mjs --push <origin>       only receipts not sent to that origin before
//     node tools/import_ah.mjs --push <origin> --all every receipt again (still idempotent)
//
// A push also puts the purchases of the last PANTRY_DAYS days into the
// pantry (phase 4), filling in what ticking the list put there.
//
// The pull goes through the albert-heijn MCP's own modules (tools/ah_pull.mjs);
// this tool never touches its tokens. migration/ah/ is personal data and stays
// out of git. Ids come from AH's own ids, so a second run changes nothing:
// receipt "ah-<AH receipt id>", product "ah-product-<webshop id>" (the AH id the
// products table has no column for), purchase and op ids hashed from receipt
// and line.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nameKey, parseListInput } from "../public/shared/ingredients.js";
import { isExcluded, isExcludedLookalike } from "../public/shared/excluded.js";
import { VAGUE_NAMES as EXCLUDED_VAGUE_NAMES } from "../public/shared/excluded-words.js";
import { canonicalName, isGeneric, SAME } from "../public/shared/item-names.js";
import { productKey } from "../public/shared/ops.js";
import { addDays } from "../public/shared/shelf-life.js";
import { stableId } from "./import_todo.mjs";
import { categoryText, kindFromCategory, kindFromName, kindFits, NOT_FOR_INGREDIENTS } from "../public/shared/product-kinds.js";
import { AH_ITEMS, AH_BRAND_ITEMS, OTHER_PEOPLE_CITIES, OWNERS } from "./ah_items.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const AH_DIR = path.join(ROOT, "migration", "ah");
export const STORE = "Albert Heijn";
// The AH account is shared: receipts paid in OTHER_PEOPLE_CITIES (nameKey)
// are someone else's (Noor) and are left out entirely, no receipt, purchase,
// product or preference. Every other receipt is Thomas's, also one without
// an address (28-10-2026). The towns and the owners.json names are
// household data, so they live in the private table tools/ah_items.mjs.
export { OTHER_PEOPLE_CITIES, OWNERS };
// An automatic AH preference only for a product on this many receipts or more.
export const MIN_PREFERENCE_RECEIPTS = 2;
// Phase 4: only receipts of the last days fill the pantry. Two years of
// purchases are history, not what is in the cupboard now.
export const PANTRY_DAYS = 10;
const TIMEZONE = "Europe/Amsterdam";

// Till lines that are no groceries (the MCP's own list, plus a few).
const NOT_GROCERIES = /\b(draagtas|tas|tasje|statiegeld|emballage|koopzegels?|spaarzegels?|vergoeding|bonuskaart|retour)\b/i;
const DEPOSIT = /\b(statiegeld|emballage)\b/i;

const fileOf = (dir, id) => path.join(dir, "receipts", `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback);
const toCents = (amount) => (typeof amount === "number" ? Math.round(amount * 100) : null);

export function localDay(dateTime) {
  return new Date(dateTime).toLocaleDateString("sv-SE", { timeZone: TIMEZONE });
}

/** Letters and digits only, upper case: how a till abbreviation is compared. */
const compact = (s) => String(s ?? "").normalize("NFD").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

function commonPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * The product lines a discount belongs to, or null when that is not clear.
 * "AH AVOCADO" -> the line "AH AVOCADO"; "COOLBEST100%" -> both COOLBEST
 * lines (one product); "ALLEMORACLAS" ("all Mora classics") -> null.
 */
export function discountTarget(discountName, lines) {
  const key = compact(discountName).replace(/^(ALLE|MB)/, "");
  if (key.length < 4) return null;
  let best = 0;
  let hits = [];
  for (const line of lines) {
    const lk = compact(line.receiptName);
    const n = commonPrefix(key, lk);
    const full = n === lk.length && n >= 4;
    if (n < 6 && !full) continue;
    if (n > best) { best = n; hits = [line]; } else if (n === best) hits.push(line);
  }
  if (!hits.length) return null;
  return new Set(hits.map((l) => l.posId)).size === 1 ? hits : null;
}

/** A product's own name without its brand in front: "AH Beenham" -> "Beenham". */
export function bareTitle(title, brand) {
  let t = String(title ?? "").trim();
  for (const b of [brand, "AH Biologisch", "AH Terra", "AH Excellent", "AH Basic", "AH"]) {
    if (b && t.toLowerCase().startsWith(`${b.toLowerCase()} `)) { t = t.slice(b.length + 1); break; }
  }
  return t;
}

/** A till abbreviation as a name: "AH SOJA" -> { brand: "AH", name: "Soja" }. */
function fromAbbreviation(receiptName) {
  const words = String(receiptName).trim().split(/\s+/);
  const brand = words[0] === "AH" ? "AH" : "";
  const rest = (brand ? words.slice(1) : words).join(" ").toLowerCase();
  return { brand, name: rest.charAt(0).toUpperCase() + rest.slice(1) };
}

/**
 * One raw AH receipt -> { id, day, total_cents, lines, dropped }. Lines carry
 * kind product / discount / deposit / other; a discount that clearly belongs
 * to one product lowers that product's lines and is not kept as its own line.
 */
export function normaliseReceipt(summary, raw, posMap, cards, city = null, categories = {}) {
  const dropped = { excluded: 0, other: 0 };
  const lines = [];
  for (const p of raw?.products ?? []) {
    const amount = toCents(p.amount?.amount ?? p.price?.amount);
    if (DEPOSIT.test(p.name)) {
      lines.push({ kind: "deposit", receiptName: p.name, name: p.name, brand: "", size: "", qty: p.quantity || 1, price_cents: amount });
      continue;
    }
    if (NOT_GROCERIES.test(p.name) || (amount ?? 0) < 0) {
      lines.push({ kind: "other", receiptName: p.name, name: p.name, brand: "", size: "", qty: p.quantity || 1, price_cents: amount });
      dropped.other++;
      continue;
    }
    const webshopId = p.id > 0 && posMap[String(p.id)] > 0 ? posMap[String(p.id)] : null;
    const card = webshopId ? cards[String(webshopId)] : null;
    const named = card ? { brand: card.brand ?? "", name: bareTitle(card.title, card.brand) } : fromAbbreviation(p.name);
    const fullName = card ? card.title : `${named.brand ? `${named.brand} ` : ""}${named.name}`;
    const cat = webshopId ? categories[String(webshopId)] : null;
    const category = cat ? categoryText(cat.main, cat.sub) : "";
    if ([p.name, fullName, named.brand, `${named.brand} ${named.name}`].some((n) => isExcluded(n) || isExcludedLookalike(n))) {
      dropped.excluded++;
      continue;
    }
    lines.push({
      kind: "product",
      posId: p.id > 0 ? p.id : null,
      webshopId,
      receiptName: p.name,
      fullName,
      name: fullName,
      bare: named.name,
      brand: named.brand,
      size: card?.size ?? "",
      category,
      productKind: kindFromCategory(category) ?? kindFromName(fullName),
      qty: p.quantity || 1,
      price_cents: amount,
    });
  }
  for (const d of raw?.discounts ?? []) {
    const cents = toCents(d.amount?.amount);
    const target = cents ? discountTarget(d.name, lines.filter((l) => l.kind === "product")) : null;
    if (target) {
      const sum = target.reduce((s, l) => s + (l.price_cents ?? 0), 0);
      let left = cents;
      target.forEach((l, i) => {
        const share = i === target.length - 1 ? left : Math.round((cents * (l.price_cents ?? 0)) / (sum || 1));
        left -= share;
        l.price_cents = Math.max(0, (l.price_cents ?? 0) + share);
      });
    } else {
      lines.push({ kind: "discount", receiptName: d.name, name: d.name, brand: "", size: "", qty: 1, price_cents: cents });
    }
  }
  return {
    id: summary.id,
    day: localDay(summary.dateTime),
    city,
    total_cents: toCents(summary.total ?? raw?.total?.amount),
    lines,
    dropped,
  };
}

/** Every cached receipt, oldest first. */
export function readCache(dir = AH_DIR) {
  const list = readJson(path.join(dir, "receipts.json"), []);
  const posMap = readJson(path.join(dir, "pos-to-webshop.json"), {});
  const cards = readJson(path.join(dir, "products.json"), {});
  const cities = readJson(path.join(dir, "cities.json"), {});
  const categories = readJson(path.join(dir, "categories.json"), {});
  return list
    .filter((s) => fs.existsSync(fileOf(dir, s.id)))
    .map((s) => normaliseReceipt(s, readJson(fileOf(dir, s.id)), posMap, cards, cities[s.id] ?? null, categories))
    .sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
}

/** The optional per-receipt override, migration/ah/owners.json: { AH receipt id: "thomas" | "noor" | "skip" }. */
export function readOwners(dir = AH_DIR) {
  return readJson(path.join(dir, "owners.json"), {});
}

/**
 * Is this Thomas's receipt? An override in owners.json decides ("thomas" in,
 * "noor" and "skip" out); otherwise every town but OTHER_PEOPLE_CITIES.
 */
export function isOwn(receipt, owners = {}) {
  const override = owners[receipt.id];
  if (override === OWNERS.own) return true;
  if (OWNERS.others.includes(override) || override === "skip") return false;
  return !OTHER_PEOPLE_CITIES.includes(nameKey(receipt.city ?? ""));
}

/* ------------------------------------------------------------ mapping */

// Names from the old lists that are too short or too vague to match on.
const STOP = new Set(["aa", "a4", "up", "tp", "cd", "ace", "glas", "alles", "vuur", "minoes", "cups", "soon", ...EXCLUDED_VAGUE_NAMES]);

/**
 * The item names Thomas uses: the To Do history's titles, grouped like
 * "need it again" groups them, plus the canonical names of SAME. Each key
 * gets the spelling he wrote most often.
 */
export function vocabulary(titles, extra = [...Object.values(AH_ITEMS), ...Object.values(AH_BRAND_ITEMS)]) {
  const byKey = new Map();
  const add = (title, n = 1) => {
    if (!title || isGeneric(title) || isExcluded(title)) return;
    const { key } = canonicalName(title);
    if (!key || STOP.has(key) || key.split(" ").length > 3) return;
    const clean = canonicalName(String(title).replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim()).name;
    if (!byKey.has(key)) byKey.set(key, { key, count: 0, spellings: new Map() });
    const v = byKey.get(key);
    v.count += n;
    // A capitalised spelling wins over the same word in lower case.
    v.spellings.set(clean, (v.spellings.get(clean) ?? 0) + n + (/^[A-Z][^A-Z]*$/.test(clean) ? 0.5 : 0));
  };
  for (const t of titles) add(t);
  // The names this import itself maps to count too, so the long tail finds them.
  for (const name of new Set([...Object.values(SAME), ...extra])) add(name, 0);
  const out = new Map();
  for (const [key, v] of byKey) {
    const name = [...v.spellings].sort((a, b) => b[1] - a[1])[0][0];
    out.set(key, { key, name: name.charAt(0).toUpperCase() + name.slice(1).toLowerCase(), count: v.count });
  }
  return out;
}

/**
 * Where vocabulary entry `vKey` names the product with these words: the
 * position of its last word, or -1. The last word counts whole or as the end
 * of a compound ("beenham" is ham).
 */
function fitAt(vKey, words) {
  const vw = vKey.split(" ");
  const last = vw.at(-1);
  if (!vw.slice(0, -1).every((w) => words.includes(w))) return -1;
  return words.findIndex((w) => w === last || (last.length >= 3 && w.length > last.length && w.endsWith(last)));
}

/** The words that say what a product is: flavours and extras ("met knoflook", "in water") cut off. */
export function headWords(bare) {
  const head = String(bare ?? "").split(/\s+(?:met|in|op|en|&|voor|van)\s+|,/i)[0];
  return nameKey(head).split(" ").filter(Boolean);
}

/** A new item's name from the product itself, in the style of his list. */
export function guessName(bare) {
  const words = headWords(String(bare ?? "").replace(/['’]/g, "")).filter((w) => !/\d/.test(w));
  const name = words.slice(0, 3).join(" ");
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : bare;
}

/**
 * { item, how } for one product line. how: "exact" (its own name is one of
 * his items), "rule" (an item's words are in it, the brand rule, or the
 * reviewed table tools/ah_items.mjs, then `table` is true) or "guess".
 */
export function mapProduct(line, vocab, table = AH_ITEMS, brands = AH_BRAND_ITEMS, { itemKindOf = defaultItemKind } = {}) {
  const named = (name) => vocab.get(canonicalName(name).key)?.name ?? canonicalName(name).name;
  const tableKey = line.webshopId ? String(line.webshopId) : `pos:${line.posId}`;
  if (table[tableKey]) return { item: named(table[tableKey]), how: "rule", table: true };
  // The brand first: "Crispy's Paprika" is chips, not paprika.
  const brand = brands[nameKey(line.brand)] ?? (line.webshopId && line.brand ? null : brands[nameKey(line.receiptName.split(" ")[0])]);
  if (brand) return { item: named(brand), how: "rule" };
  // A snack, cup or ready meal (or a drink, household, care or pet product)
  // is never the product for an ingredient item (28-10-2026: Knorr
  // Goodpasta became "Pasta"). Such a match gets its own item instead.
  const kind = line.productKind ?? kindFromName(line.fullName ?? line.name ?? line.bare, line.brand);
  const fits = (itemName) => !NOT_FOR_INGREDIENTS.has(kind) || itemKindOf(itemName) !== "ingredient";
  const bareKey = canonicalName(line.bare).key;
  if (vocab.has(bareKey) && fits(vocab.get(bareKey).name)) return { item: vocab.get(bareKey).name, how: "exact" };
  // The entry with the most words wins, then the one named first (the noun
  // comes before the flavour: "Roomyoghurt perzik"), then the longer one.
  const words = headWords(line.bare);
  let best = null;
  for (const v of vocab.values()) {
    const at = fitAt(v.key, words);
    if (at < 0) continue;
    const n = v.key.split(" ").length;
    const better = !best || n > best.n || (n === best.n && (at < best.at || (at === best.at && (v.key.length > best.v.key.length || (v.key.length === best.v.key.length && v.count > best.v.count)))));
    if (better) best = { v, n, at };
  }
  if (best && fits(best.v.name)) return { item: best.v.name, how: "rule" };
  if (best) return { item: ownItemName(line, best.v.name), how: "guess", kindGuard: best.v.name };
  return { item: guessName(line.bare), how: "guess" };
}

/** An item's kind at import time, by its name: "Pasta" is an ingredient, "Pasta beker" a ready meal. */
export function defaultItemKind(name) {
  return kindFromName(name);
}

/**
 * The item for a product kept off an ingredient item: "<item> beker" for a
 * cup ("Knorr Goodpasta" -> "Pasta beker"), else the product's short name.
 */
export function ownItemName(line, ingredientName) {
  const text = nameKey(`${line.fullName ?? ""} ${line.bare ?? ""} ${line.receiptName ?? ""}`);
  if (/\b(goodpasta|beker|cup|pot)\b/.test(text)) return `${ingredientName} beker`;
  return guessName(line.bare);
}

/* ---------------------------------------------------------------- ops */

/**
 * Each item's expected kind during an import (nameKey -> kind): its name's
 * kind ("Pasta": ingredient), else the kind most of its products' receipts
 * have. The live site also knows the recipes; tools/audit_items.mjs uses that.
 */
export function importItemKinds(products) {
  const tally = new Map();
  for (const p of products) {
    const key = nameKey(p.item);
    if (!tally.has(key)) tally.set(key, { name: p.item, counts: {} });
    if (p.kind) tally.get(key).counts[p.kind] = (tally.get(key).counts[p.kind] ?? 0) + p.receipts.size;
  }
  const out = new Map();
  for (const [key, { name, counts }] of tally) {
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    out.set(key, defaultItemKind(name) ?? top?.[0] ?? null);
  }
  return out;
}

const receiptId = (ahId) => `ah-${ahId}`.slice(0, 64);
export const itemIdFor = (name) => stableId("item", `history:${nameKey(name)}`);

/**
 * Receipts -> { ops, report }. `only` (a Set of AH receipt ids) limits the
 * receipts, products and preferences sent to those receipts; preferences
 * are still chosen from every receipt. `pantrySince` (YYYY-MM-DD): the
 * purchases of receipts from that day on also go into the pantry (filling in
 * what a tick on the list already put there); null: none do.
 */
export function buildOps(receipts, vocab, {
  only = null, table = AH_ITEMS, pantrySince = null,
  // The Lidl import (tools/import_lidl.mjs) runs the same op building with
  // its own store, id prefix, product ids and mapping; the defaults are AH's
  // and keep every AH id as it was.
  store = STORE, prefix = "ah", receiptIdOf = receiptId,
  productIdOf = (l) => (l.webshopId ? `ah-product-${l.webshopId}` : `ah-pos-${l.posId ?? nameKey(l.receiptName).replace(/ /g, "-")}`),
  map = (l) => mapProduct(l, vocab, table),
} = {}) {
  const products = new Map(); // product id -> { id, name, brand, size, item, how, count, last, price, receiptNames }
  const byKey = new Map(); // productKey -> product id: two AH ids with one name|brand|size are one product
  const purchases = [];
  const totals = { receipts: receipts.length, lines: 0, excluded: 0, other: 0, discountsKept: 0 };

  for (const r of receipts) {
    totals.excluded += r.dropped.excluded;
    totals.other += r.dropped.other;
    r.lines.forEach((l, i) => {
      if (l.kind !== "product") { if (l.kind === "discount") totals.discountsKept++; return; }
      totals.lines++;
      // A pinned product (a reviewed table line naming an existing product) keeps its own id.
      const own = l.pin?.id ?? productIdOf(l);
      const key = l.pin ? `pin:${l.pin.id}` : productKey(l);
      const pid = byKey.get(key) ?? own;
      byKey.set(key, pid);
      if (!products.has(pid)) {
        const named = l.pin ? { name: l.pin.name, brand: l.pin.brand ?? "", size: l.pin.size ?? "" } : { name: l.name, brand: l.brand, size: l.size };
        products.set(pid, { id: pid, ...named, category: l.category ?? "", kind: l.productKind ?? null, ...map(l), count: 0, receipts: new Set(), last: "", price: null, receiptNames: new Set(), webshopId: l.webshopId, posId: l.posId, pinned: Boolean(l.pin) });
      }
      const p = products.get(pid);
      p.count += l.qty;
      p.receipts.add(r.id);
      p.receiptNames.add(l.receiptName);
      if (r.day >= p.last) {
        p.last = r.day;
        p.price = l.price_cents !== null && l.qty ? Math.round(l.price_cents / l.qty) : l.price_cents;
      }
      purchases.push({ r, i, l, pid });
    });
  }

  // Per item, the product on the most receipts, then the most recent; one
  // bought on a single receipt is no preference, and neither is one whose
  // kind does not fit the item (a snack for an ingredient item).
  const kindOfItem = importItemKinds(products.values());
  const byItem = new Map();
  for (const p of products.values()) {
    if (p.receipts.size < MIN_PREFERENCE_RECEIPTS) continue;
    if (!kindFits(kindOfItem.get(nameKey(p.item)), p.kind)) continue;
    const cur = byItem.get(nameKey(p.item));
    if (!cur || p.receipts.size > cur.receipts.size || (p.receipts.size === cur.receipts.size && p.last > cur.last)) {
      byItem.set(nameKey(p.item), p);
    }
  }

  const send = (ahId) => !only || only.has(ahId);
  const ops = [];
  for (const r of receipts) {
    if (!send(r.id)) continue;
    ops.push({
      op_id: stableId("op", `${prefix}:receipt:${r.id}`),
      type: "receipt.save",
      id: receiptIdOf(r.id),
      store,
      bought_on: r.day,
      total_cents: r.total_cents,
      lines: r.lines.slice(0, 150).map((l) => ({ name: l.name, brand: l.brand, size: l.size, qty: l.qty, price_cents: l.price_cents, kind: l.kind })),
    });
  }
  for (const { r, i, l, pid } of purchases) {
    if (!send(r.id)) continue;
    const p = products.get(pid);
    ops.push({
      op_id: stableId("op", `${prefix}:purchase:${r.id}:${i}`),
      type: "purchase.add",
      id: stableId("purchase", `${prefix}:${r.id}:${i}`),
      item_id: itemIdFor(p.item),
      title: p.item,
      bought_on: r.day,
      store,
      qty: l.qty,
      price_cents: l.price_cents,
      source: "receipt",
      receipt_id: receiptIdOf(r.id),
      product: { id: pid, name: p.name, brand: p.brand, size: p.size },
      ...(pantrySince && r.day >= pantrySince ? { pantry: true } : {}),
    });
  }
  const touched = (p) => [...p.receipts].some(send);
  for (const p of products.values()) {
    // A pinned product is a person's row (name, size, "alleen bij"): the purchase links it, nothing renames it.
    if (!touched(p) || p.pinned) continue;
    ops.push({
      op_id: stableId("op", `${prefix}:product:${p.id}:${p.last}`),
      type: "product.put",
      id: p.id,
      product: {
        name: p.name, brand: p.brand, size: p.size, store,
        ...(p.category ? { category: p.category } : {}), ...(p.kind ? { kind: p.kind } : {}),
        ...(p.price !== null && p.price >= 0 ? { last_price_cents: p.price } : {}),
      },
    });
  }
  for (const [key, p] of byItem) {
    if (!touched(p)) continue;
    ops.push({
      op_id: stableId("op", `${prefix}:prefer:${key}`),
      type: "preference.set",
      id: stableId("pref", `${prefix}:${key}`),
      item_id: itemIdFor(p.item),
      title: p.item,
      product_id: p.id,
      store,
      // Never replaces a preference Thomas set (or cleared) at this store.
      only_if_unset: true,
    });
  }
  return { ops, products: [...products.values()], preferred: byItem, totals };
}

/* ------------------------------------------------------------ preview */

/** The To Do history's titles (read only), for the vocabulary. */
export function historyTitles() {
  const dirs = [path.join(ROOT, "migration", "export"), process.env.KITCHEN_EXPORT,
    "C:\\path\\to\\the\\workspace\\VEXED.WORKS\\kitchen\\migration\\export"].filter(Boolean);
  const dir = dirs.find((d) => fs.existsSync(path.join(d, "history.json")));
  if (!dir) return [];
  return ["history.json", "history-2019-2024.json"]
    .filter((f) => fs.existsSync(path.join(dir, f)))
    .flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
    .map((row) => parseListInput(String(row?.title ?? "")).title);
}

export function previewText(built, all = null, owners = {}) {
  const { products, preferred, totals, ops } = built;
  const items = new Set(products.map((p) => nameKey(p.item)));
  const fmt = (c) => (c === null || c === undefined ? "?" : `€${(c / 100).toFixed(2).replace(".", ",")}`);
  const how = (p) => (p.table ? "table" : p.how);
  const pad = (s, n) => String(s).padEnd(n);
  const prefs = [...preferred.values()].sort((a, b) => b.receipts.size - a.receipts.size || a.item.localeCompare(b.item));
  const guesses = products.filter((p) => p.how === "guess").sort((a, b) => b.receipts.size - a.receipts.size || a.name.localeCompare(b.name));
  const counts = { exact: 0, rule: 0, table: 0, guess: 0 };
  for (const p of products) counts[how(p)]++;
  const byCity = new Map();
  for (const r of all ?? []) {
    const city = r.city ? r.city.charAt(0).toUpperCase() + r.city.slice(1).toLowerCase() : "(unknown)";
    const c = byCity.get(city) ?? { n: 0, own: 0 };
    c.n++;
    if (isOwn(r, owners)) c.own++;
    byCity.set(city, c);
  }
  const own = (all ?? []).filter((r) => isOwn(r, owners));
  const noTown = own.filter((r) => !r.city);
  const out = [
    `AH import preview (${new Date().toISOString().slice(0, 10)})`,
    "",
    ...(all ? [
      `Receipts on the account: ${all.length}; Thomas's (every town but ${OTHER_PEOPLE_CITIES.join(", ")}, or "${OWNERS.own}" in owners.json): ${own.length}. The rest is left out entirely.`,
      `Thomas's receipts without a town (imported, check them): ${noTown.length ? noTown.map((r) => `${r.id} ${r.day}`).join(", ") : "none"}`,
      `Per town (receipts, of which imported): ${[...byCity].sort((a, b) => b[1].n - a[1].n).map(([c, x]) => `${c} ${x.n}${x.own ? ` (${x.own} in)` : ""}`).join(", ")}`,
      ...(Object.keys(owners).length ? [`owners.json overrides: ${Object.keys(owners).length}`] : []),
    ] : []),
    "",
    `Receipts: ${totals.receipts}   product lines: ${totals.lines}   products: ${products.length}   items: ${items.size}`,
    `Dropped: ${totals.excluded} excluded lines, ${totals.other} bags/returns; discounts kept as their own receipt line (not clearly one product): ${totals.discountsKept}`,
    `Preferences: one per item whose top product is on ${MIN_PREFERENCE_RECEIPTS}+ receipts: ${preferred.size} of ${items.size} items.`,
    `Mappings: ${counts.exact} exact, ${counts.rule} rule, ${counts.table} table (reviewed, counted as rule), ${counts.guess} guess`,
    `Ops: ${ops.length} (${ops.filter((o) => o.type === "receipt.save").length} receipts, ${ops.filter((o) => o.type === "purchase.add").length} purchases, ${ops.filter((o) => o.type === "product.put").length} products, ${ops.filter((o) => o.type === "preference.set").length} preferences; a preference is skipped where one exists at AH)`,
    "",
    "== Preferred AH product per item (receipts, last bought, last price, how mapped) ==",
    ...prefs.map((p) => `${pad(p.item, 26)} ${pad(`${p.brand ? "" : ""}${p.name}${p.size ? ` (${p.size})` : ""}`, 64)} ${String(p.receipts.size).padStart(3)}x  ${p.last}  ${pad(fmt(p.price), 7)} ${how(p)}${p.webshopId ? `  [${p.webshopId}]` : ""}`),
    "",
    `== Guess mappings (${guesses.length}): product -> new item; add a line to tools/ah_items.mjs to correct one ==`,
    ...guesses.map((p) => `${pad(p.item, 26)} <- ${p.name}${p.size ? ` (${p.size})` : ""}  ${p.receipts.size}x  till "${[...p.receiptNames].join('", "')}"  key ${p.webshopId ?? `pos:${p.posId}`}`),
    "",
    ...(all ? [
      `== Imported receipts (${own.length}): AH id, day, town, total, top 5 lines by price ==`,
      ...own.map((r) => `${r.id}  ${r.day}  ${pad(r.city ?? "?", 12)} ${pad(fmt(r.total_cents), 8)} ${r.lines.filter((l) => l.kind === "product").sort((a, b) => (b.price_cents ?? 0) - (a.price_cents ?? 0)).slice(0, 5).map((l) => l.name).join("; ")}`),
      "",
    ] : []),
    "== Every product -> item ==",
    ...[...products].sort((a, b) => a.item.localeCompare(b.item) || b.receipts.size - a.receipts.size)
      .map((p) => `${pad(p.item, 26)} ${pad(how(p), 6)} ${p.name}${p.size ? ` (${p.size})` : ""}  ${p.receipts.size}x`),
  ];
  return out.join("\n");
}

/* ------------------------------------------- new purchases, for the review */

/** The file each daily run writes next to its state: what it found new (fetcher/review.mjs reads it). */
export const NEW_PURCHASES_FILE = "new-purchases.txt";

/**
 * One line per new purchase of a run: "2026-10-30 AH: AH Tonijn in water
 * (3 x 56 g) [product-…] -> Tonijn (guess)". How the line was mapped says
 * how sure the import was: exact, rule, table (reviewed), guess.
 */
export function newPurchasesText(built, label) {
  const products = new Map((built.products ?? []).map((p) => [p.id, p]));
  const lines = built.ops.filter((o) => o.type === "purchase.add").map((o) => {
    const p = products.get(o.product?.id);
    const how = p ? (p.table ? "table" : p.how) : "?";
    const name = [o.product?.brand, o.product?.name].filter(Boolean).join(" ") + (o.product?.size ? ` (${o.product.size})` : "");
    return `${o.bought_on} ${o.store}: ${name} [${o.product?.id ?? "?"}] -> ${o.title} (${how})`;
  });
  return [`${label}: ${lines.length} new purchase${lines.length === 1 ? "" : "s"}`, ...lines].join("\n");
}

/** Writes NEW_PURCHASES_FILE in `dir` (every run, also with none, so an old list is never read as new). */
export function writeNewPurchases(dir, built, label) {
  fs.writeFileSync(path.join(dir, NEW_PURCHASES_FILE), `${newPurchasesText(built, label)}\n`);
}

/* --------------------------------------------------------------- push */

export function readToken() {
  if (process.env.KITCHEN_TOKEN) return process.env.KITCHEN_TOKEN;
  for (const env of [path.join(ROOT, "mcp", ".env"), "C:\\path\\to\\the\\workspace\\VEXED.WORKS\\kitchen\\mcp\\.env"]) {
    const m = fs.existsSync(env) && fs.readFileSync(env, "utf8").match(/^KITCHEN_TOKEN=(\S+)/m);
    if (m) return m[1];
  }
  throw new Error("No token: set KITCHEN_TOKEN or run `node tools/admin.mjs bootstrap` first");
}

/** The AH receipt ids already sent to `origin`, kept in migration/ah/sent.json. */
function sentFile(dir) { return path.join(dir, "sent.json"); }
export function readSent(dir, origin) { return new Set(readJson(sentFile(dir), {})[origin] ?? []); }
export function writeSent(dir, origin, ids) {
  const all = readJson(sentFile(dir), {});
  all[origin] = [...new Set([...(all[origin] ?? []), ...ids])].sort();
  fs.writeFileSync(sentFile(dir), JSON.stringify(all, null, 1));
}

/**
 * Sends ops to `origin`'s /api/ops in batches of 50 and returns the refused
 * ones. `post(url, init)` is fetch (a test passes the worker); the token is
 * only ever put in the Authorization header.
 */
export async function pushOps(ops, origin, token, { post = fetch, progress = (done, all) => process.stdout.write(`\r${done} / ${all}`) } = {}) {
  const failed = [];
  for (let i = 0; i < ops.length; i += 50) {
    let res;
    // A busy D1 answers 503 now and then; the ops are idempotent, so retry.
    for (let attempt = 0; ; attempt++) {
      res = await post(`${origin}/api/ops`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ops: ops.slice(i, i + 50) }),
      });
      if (res.status < 500 || attempt >= 4) break;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`/api/ops: ${res.status} ${out.error ?? ""}`);
    failed.push(...out.results.filter((r) => !r.ok));
    progress(Math.min(i + 50, ops.length), ops.length);
  }
  return failed;
}

/**
 * The ops for Thomas's receipts in `dir` not yet sent to `origin`: the
 * receipts, products and preferences of those, preferences chosen from all,
 * and the pantry for the last PANTRY_DAYS. Used by the push below and by
 * fetcher/ah_import.mjs on the home server.
 */
export function newReceiptOps(dir, origin, { titles, today = new Date().toLocaleDateString("sv-SE", { timeZone: TIMEZONE }), all: everything = false } = {}) {
  const all = readCache(dir);
  const owners = readOwners(dir);
  const receipts = all.filter((r) => isOwn(r, owners));
  const sent = everything ? new Set() : readSent(dir, origin);
  const only = new Set(receipts.map((r) => r.id).filter((id) => !sent.has(id)));
  const built = buildOps(receipts, vocabulary(titles), { only, pantrySince: addDays(today, -PANTRY_DAYS) });
  return { ...built, only, account: all.length, own: receipts.length, otherPeople: all.length - receipts.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--pull")) {
    const { pullAh } = await import("./ah_pull.mjs");
    await pullAh(AH_DIR);
  }
  const all = readCache(AH_DIR);
  const owners = readOwners(AH_DIR);
  const receipts = all.filter((r) => isOwn(r, owners));
  const vocab = vocabulary(historyTitles());
  if (args.includes("--preview")) {
    const built = buildOps(receipts, vocab);
    fs.writeFileSync(path.join(AH_DIR, "preview.txt"), previewText(built, all, owners));
    console.log(previewText(built, all, owners).split("\n").slice(0, 8).join("\n"));
    console.log(`Written: ${path.join(AH_DIR, "preview.txt")}`);
  }
  const at = args.indexOf("--push");
  if (at >= 0) {
    const origin = (args[at + 1] ?? "").replace(/\/$/, "");
    if (!/^https?:\/\//.test(origin)) throw new Error("--push needs an origin, e.g. https://groceries.vexed.works");
    const built = newReceiptOps(AH_DIR, origin, { titles: historyTitles(), all: args.includes("--all") });
    if (!built.only.size) console.log("No new receipts.");
    else {
      const failed = await pushOps(built.ops, origin, readToken());
      console.log(`\nSent ${built.ops.length} ops.`);
      if (failed.length) {
        console.log(`Refused: ${JSON.stringify(failed.slice(0, 20))}${failed.length > 20 ? ` and ${failed.length - 20} more` : ""}`);
        process.exitCode = 1;
      } else writeSent(AH_DIR, origin, built.only);
    }
  }
  if (!args.some((a) => ["--pull", "--preview", "--push"].includes(a))) console.log("Use --pull, --preview or --push <origin>.");
}
