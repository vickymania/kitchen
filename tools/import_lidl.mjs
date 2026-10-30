// Thomas's Lidl Plus receipts into kitchen, like his AH receipts
// (tools/import_ah.mjs, whose op building this reuses): every product line
// becomes a product (store "Lidl"), a purchase on that day, and per item the
// Lidl product on the most receipts (2 or more) becomes his Lidl preference,
// unless he already has one there. The last PANTRY_DAYS days fill the pantry.
//
//     node tools/import_lidl.mjs --preview [--dir <state dir>]       write <dir>/preview.txt, send nothing
//     node tools/import_lidl.mjs --push <origin> [--dir <state dir>] only receipts not sent to that origin
//
// The pull runs on the home server (fetcher/lidl_import.mjs, with the server's
// own Lidl session); its state folder (~/kitchen-fetcher/lidl-state) can be
// copied here into migration/lidl/ (git-ignored, personal data) to preview.
//
// A Lidl receipt (tickets API v3) has the store (with its town) and the
// printed receipt as HTML whose article spans carry data-art-id,
// data-art-description, data-unit-price and, for weighed or counted lines,
// data-art-quantity; a bold label followed by a bold negative amount is a
// discount on the article above it. Older answers (v2) have `itemsLine`
// instead; both are read. Ids: receipt "lidl-<Lidl id>", product
// "lidl-product-<article>" (or "lidl-name-<till name>"), purchases and ops
// hashed from receipt and line, so a second run changes nothing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nameKey } from "../public/shared/ingredients.js";
import { isExcluded, isExcludedLookalike } from "../public/shared/excluded.js";
import { addDays } from "../public/shared/shelf-life.js";
import { kindFromName } from "../public/shared/product-kinds.js";
import {
  buildOps, localDay, mapProduct, vocabulary, readSent, writeSent, pushOps, readToken, historyTitles,
  OTHER_PEOPLE_CITIES, OWNERS, PANTRY_DAYS, MIN_PREFERENCE_RECEIPTS,
} from "./import_ah.mjs";
import { LIDL_BRANDS, LIDL_BRAND_ITEMS, LIDL_ITEMS, lidlTableLine } from "./lidl_items.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LIDL_DIR = path.join(ROOT, "migration", "lidl");
export const STORE = "Lidl";
const TIMEZONE = "Europe/Amsterdam";

const NOT_GROCERIES = /\b(draagtas|tas|tasje|tassen|statiegeld|leeggoed|emballage|retour|retourbon|zegels?|cadeaukaart|tegoed|korting)\b/i;
// "4-pk blik st.geld": the till's short word for statiegeld.
const DEPOSIT = /\b(statiegeld|st\.?geld|leeggoed|emballage)\b/i;

const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback);
export const receiptFile = (dir, id) => path.join(dir, "receipts", `${String(id).replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

/** "1,29", "1.29", "-0,50", 1.29 -> cents; anything else null. */
export function toCents(v) {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/[^\d,.-]/g, "");
  if (!/\d/.test(s)) return null;
  // The last , or . is the decimal mark; the others group thousands.
  const at = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  const n = at < 0 ? Number(s) : Number(`${s.slice(0, at).replace(/[,.]/g, "")}.${s.slice(at + 1)}`);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const toNumber = (v) => {
  const c = toCents(v);
  return c === null ? null : c / 100;
};

const decode = (s) => String(s ?? "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&euro;/g, "€").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

function attrsOf(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_:-]+)\s*=\s*"([^"]*)"/g)) out[m[1].toLowerCase()] = decode(m[2]);
  return out;
}

/**
 * The printed receipt's lines: [{ artId, name, qty, weighed, price_cents, discount_cents }].
 * An article span whose text does not start with its description is the
 * second line of the one above ("0,345 kg x 6,99 EUR/kg", "2 x 1,29") and is
 * skipped; the same product scanned twice is two lines.
 */
export function parseReceiptHtml(html) {
  const lines = [];
  let pending = null; // a bold label waiting for its amount
  // Each span's own text, up to the next tag: a span wrapping others (the purchase list) has none.
  for (const m of String(html ?? "").matchAll(/<span\b([^>]*)>([^<]*)/g)) {
    const a = attrsOf(m[1]);
    const text = decode(m[2]).replace(/\s+/g, " ").trim();
    const cls = ` ${a.class ?? ""} `;
    if (cls.includes(" article ") && a["data-art-description"]) {
      pending = null;
      const name = a["data-art-description"].replace(/\s+/g, " ").trim();
      const prev = lines.at(-1);
      if (prev && prev.artId === (a["data-art-id"] ?? "") && !text.toLowerCase().startsWith(name.toLowerCase().slice(0, 6))) continue;
      const unit = toNumber(a["data-unit-price"]);
      const hasQty = a["data-art-quantity"] !== undefined;
      const q = hasQty ? toNumber(a["data-art-quantity"]) : 1;
      const weighed = hasQty && q !== null && !Number.isInteger(q);
      lines.push({
        artId: a["data-art-id"] ?? "",
        name,
        qty: weighed ? 1 : (q || 1),
        weighed,
        price_cents: unit === null ? null : Math.round(unit * (q ?? 1) * 100),
        discount_cents: 0,
      });
      continue;
    }
    if (!cls.includes(" css_bold ")) continue;
    if (pending && /^-\s?\d/.test(text)) {
      const c = toCents(text);
      if (c !== null && lines.length) lines.at(-1).discount_cents += c;
      pending = null;
    } else if (/[a-z]/i.test(text) && !/^(totaal|te betalen|total|subtotaal|totaal korting|total discount)$/i.test(text)) {
      pending = text;
    } else pending = null;
  }
  return lines;
}

/** The older JSON answer's lines (`itemsLine`), in the same shape. */
export function parseItemsLine(items) {
  return (Array.isArray(items) ? items : []).map((it) => {
    const weighed = Boolean(it?.isWeight);
    const q = toNumber(it?.quantity) ?? 1;
    const total = toCents(it?.originalAmount) ?? (toCents(it?.currentUnitPrice) !== null ? Math.round(toCents(it.currentUnitPrice) * q) : null);
    const discount = (Array.isArray(it?.discounts) ? it.discounts : []).reduce((s, d) => s - Math.abs(toCents(d?.amount) ?? 0), 0);
    return {
      artId: String(it?.codeInput ?? ""), name: String(it?.name ?? "").replace(/\s+/g, " ").trim(),
      qty: weighed ? 1 : q || 1, weighed, price_cents: total, discount_cents: discount,
    };
  }).filter((l) => l.name);
}

/** "Milbona Halfvolle melk 1L" -> { brand: "Milbona", bare: "Halfvolle melk", size: "1 l" }. */
export function splitName(name) {
  let bare = String(name ?? "").replace(/\s+/g, " ").trim();
  let brand = "";
  for (const b of LIDL_BRANDS) {
    if (nameKey(bare).startsWith(`${nameKey(b)} `)) {
      brand = b;
      bare = bare.split(" ").slice(b.split(" ").length).join(" ");
      break;
    }
  }
  let size = "";
  const m = bare.match(/\s(\d+(?:[.,]\d+)?)\s?(kg|g|gr|gram|ml|cl|l|ltr|liter|st|stuks)\.?$/i);
  if (m) {
    const unit = { gr: "g", gram: "g", ltr: "l", liter: "l", stuks: "st" }[m[2].toLowerCase()] ?? m[2].toLowerCase();
    size = `${m[1].replace(".", ",")} ${unit}`;
    bare = bare.slice(0, m.index).trim();
  }
  bare = bare.replace(/\s\d{5,}$/, "").trim(); // a code at the end ("Wortelen 0082755")
  return { brand, bare: bare ? bare.charAt(0).toUpperCase() + bare.slice(1) : bare, size };
}

/**
 * One raw Lidl receipt -> { id, day, city, total_cents, lines, dropped }, the
 * shape tools/import_ah.mjs builds ops from. A line the reviewed table pins
 * to an existing product carries `pin`.
 */
export function normaliseReceipt(raw, table = LIDL_ITEMS) {
  const dropped = { excluded: 0, other: 0 };
  const parsed = raw?.htmlPrintedReceipt ? parseReceiptHtml(raw.htmlPrintedReceipt) : parseItemsLine(raw?.itemsLine);
  const lines = [];
  for (const p of parsed) {
    const price = p.price_cents === null ? null : p.price_cents + (p.discount_cents ?? 0);
    if (DEPOSIT.test(p.name)) {
      lines.push({ kind: "deposit", receiptName: p.name, name: p.name, brand: "", size: "", qty: p.qty, price_cents: price });
      continue;
    }
    if (NOT_GROCERIES.test(p.name) || (price ?? 0) < 0) {
      lines.push({ kind: "other", receiptName: p.name, name: p.name, brand: "", size: "", qty: p.qty, price_cents: price });
      dropped.other++;
      continue;
    }
    const { brand, bare, size } = splitName(p.name);
    const fullName = brand ? `${brand} ${bare}` : bare;
    if ([p.name, fullName, bare].some((n) => isExcluded(n) || isExcludedLookalike(n))) {
      dropped.excluded++;
      continue;
    }
    const key = nameKey(p.name);
    const row = lidlTableLine({ artId: p.artId, key }, table);
    lines.push({
      kind: "product",
      posId: p.artId || null,
      webshopId: null,
      artId: p.artId || null,
      receiptName: p.name,
      fullName,
      name: fullName,
      bare,
      brand,
      size,
      category: "",
      productKind: kindFromName(fullName, brand),
      qty: p.qty,
      price_cents: price === null ? null : Math.max(0, price),
      ...(row ? { tableItem: row.item } : {}),
      ...(row?.pin ? { pin: row.pin } : {}),
    });
  }
  const store = raw?.store ?? {};
  return {
    id: String(raw?.id ?? ""),
    day: localDay(raw?.date ?? raw?.dateTime),
    city: typeof store.locality === "string" && store.locality.trim() ? store.locality.trim() : null,
    total_cents: toCents(raw?.totalAmount),
    lines,
    dropped,
  };
}

/** Every cached receipt, oldest first. */
export function readCache(dir = LIDL_DIR, table = LIDL_ITEMS) {
  const list = readJson(path.join(dir, "receipts.json"), []);
  return list
    .filter((s) => fs.existsSync(receiptFile(dir, s.id)))
    .map((s) => normaliseReceipt(readJson(receiptFile(dir, s.id)), table))
    .filter((r) => r.id && /^\d{4}-\d{2}-\d{2}$/.test(r.day))
    .sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
}

export const readOwners = (dir = LIDL_DIR) => readJson(path.join(dir, "owners.json"), {});

/** Thomas's receipt? owners.json decides first; else every town but OTHER_PEOPLE_CITIES (Noor's). */
export function isOwn(receipt, owners = {}) {
  const override = owners[receipt.id];
  if (override === OWNERS.own) return true;
  if (OWNERS.others.includes(override) || override === "skip") return false;
  const town = nameKey(receipt.city ?? "");
  return !OTHER_PEOPLE_CITIES.some((c) => town === c || town.split(" ").includes(c));
}

/** The item for a Lidl line: the reviewed table, else the AH import's rules (with its snack guard). */
export function mapLine(line, vocab) {
  if (line.tableItem) {
    const name = vocab.get(nameKey(line.tableItem))?.name ?? line.tableItem;
    return { item: name, how: "rule", table: true };
  }
  return mapProduct(line, vocab, {}, LIDL_BRAND_ITEMS);
}

export const receiptIdOf = (lidlId) => `lidl-${String(lidlId).replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 64).padEnd(8, "-");
export const productIdOf = (l) => (l.artId
  ? `lidl-product-${String(l.artId).replace(/[^A-Za-z0-9_-]/g, "")}`
  : `lidl-name-${nameKey(l.receiptName).replace(/[^a-z0-9]+/g, "-")}`).slice(0, 64).padEnd(8, "-");

/** Receipts -> { ops, products, preferred, totals }: tools/import_ah.mjs's buildOps at Lidl. */
export function buildLidlOps(receipts, vocab, { only = null, pantrySince = null } = {}) {
  return buildOps(receipts, vocab, {
    only, pantrySince, store: STORE, prefix: "lidl", receiptIdOf, productIdOf, map: (l) => mapLine(l, vocab),
  });
}

/** The ops for Thomas's Lidl receipts in `dir` not yet sent to `origin` (used by fetcher/lidl_import.mjs). */
export function newReceiptOps(dir, origin, { titles, today = new Date().toLocaleDateString("sv-SE", { timeZone: TIMEZONE }), all: everything = false } = {}) {
  const all = readCache(dir);
  const owners = readOwners(dir);
  const receipts = all.filter((r) => isOwn(r, owners));
  const sent = everything ? new Set() : readSent(dir, origin);
  const only = new Set(receipts.map((r) => r.id).filter((id) => !sent.has(id)));
  const built = buildLidlOps(receipts, vocabulary(titles), { only, pantrySince: addDays(today, -PANTRY_DAYS) });
  return { ...built, only, account: all.length, own: receipts.length, otherPeople: all.length - receipts.length };
}

export function previewText(built, all, owners = {}) {
  const { products, preferred, totals, ops } = built;
  const fmt = (c) => (c === null || c === undefined ? "?" : `€${(c / 100).toFixed(2).replace(".", ",")}`);
  const how = (p) => (p.table ? "table" : p.how);
  const pad = (s, n) => String(s).padEnd(n);
  const own = all.filter((r) => isOwn(r, owners));
  const towns = new Map();
  for (const r of all) towns.set(r.city ?? "(unknown)", (towns.get(r.city ?? "(unknown)") ?? 0) + 1);
  const guesses = products.filter((p) => p.how === "guess").sort((a, b) => b.receipts.size - a.receipts.size || a.name.localeCompare(b.name));
  return [
    `Lidl import preview (${new Date().toISOString().slice(0, 10)})`,
    "",
    `Receipts on the account: ${all.length}; Thomas's (every town but ${OTHER_PEOPLE_CITIES.join(", ")}): ${own.length}.`,
    `Per town: ${[...towns].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(", ")}`,
    `Product lines: ${totals.lines}   products: ${products.length}   dropped: ${totals.excluded} excluded, ${totals.other} bags/deposits/returns`,
    `Preferences (top product on ${MIN_PREFERENCE_RECEIPTS}+ receipts): ${preferred.size}`,
    `Ops: ${ops.length} (${ops.filter((o) => o.type === "receipt.save").length} receipts, ${ops.filter((o) => o.type === "purchase.add").length} purchases, ${ops.filter((o) => o.pantry).length} into the pantry, ${ops.filter((o) => o.type === "product.put").length} products, ${ops.filter((o) => o.type === "preference.set").length} preferences)`,
    "",
    "== Preferred Lidl product per item ==",
    ...[...preferred.values()].map((p) => `${pad(p.item, 26)} ${pad(p.name + (p.size ? ` (${p.size})` : ""), 50)} ${String(p.receipts.size).padStart(3)}x  ${p.last}  ${fmt(p.price)}  ${how(p)}`),
    "",
    `== Guess mappings (${guesses.length}): add a line to tools/lidl_items.mjs to correct one ==`,
    ...guesses.map((p) => `${pad(p.item, 26)} <- ${p.name}  ${p.receipts.size}x  till "${[...p.receiptNames].join('", "')}"  art ${p.posId ?? "-"}`),
    "",
    "== Every product -> item ==",
    ...[...products].sort((a, b) => a.item.localeCompare(b.item)).map((p) => `${pad(p.item, 26)} ${pad(how(p), 6)} ${p.name}${p.size ? ` (${p.size})` : ""}  ${p.receipts.size}x${p.pinned ? `  [pinned ${p.id}]` : ""}`),
  ].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dirAt = args.indexOf("--dir");
  const dir = dirAt >= 0 ? path.resolve(args[dirAt + 1]) : LIDL_DIR;
  const titles = readJson(path.join(dir, "history-titles.json"), null) ?? historyTitles();
  if (args.includes("--preview")) {
    const all = readCache(dir);
    const owners = readOwners(dir);
    const built = buildLidlOps(all.filter((r) => isOwn(r, owners)), vocabulary(titles));
    const text = previewText(built, all, owners);
    fs.writeFileSync(path.join(dir, "preview.txt"), text);
    console.log(text.split("\n").slice(0, 8).join("\n"));
    console.log(`Written: ${path.join(dir, "preview.txt")}`);
  }
  const at = args.indexOf("--push");
  if (at >= 0) {
    const origin = (args[at + 1] ?? "").replace(/\/$/, "");
    if (!/^https?:\/\//.test(origin)) throw new Error("--push needs an origin, e.g. https://groceries.vexed.works");
    const built = newReceiptOps(dir, origin, { titles, all: args.includes("--all") });
    if (!built.only.size) console.log("No new receipts.");
    else {
      const failed = await pushOps(built.ops, origin, readToken());
      console.log(`\nSent ${built.ops.length} ops.`);
      if (failed.length) {
        console.log(`Refused: ${JSON.stringify(failed.slice(0, 20))}`);
        process.exitCode = 1;
      } else writeSent(dir, origin, built.only);
    }
  }
  if (!args.includes("--preview") && at < 0) console.log("Use --preview or --push <origin> (see the top of this file).");
}
