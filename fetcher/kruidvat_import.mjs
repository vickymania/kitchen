// The daily Kruidvat run on the home server, after Action (run.sh): his
// new Kruidvat store purchases to /api/ops, built like the AH, Lidl and
// Action receipts (tools/import_ah.mjs buildOps): store "Kruidvat", ids
// "kruidvat-<order code>", products "kruidvat-product-<product code>",
// purchases and ops hashed from receipt and line, so a second run changes nothing.
//
//   node fetcher/kruidvat_import.mjs init      make kruidvat-state/ (mode 700): an empty sent.json for
//                                              KITCHEN_ORIGIN and the item names, copied from
//                                              ah-state/history-titles.json. Once, before the first run.
//   node fetcher/kruidvat_import.mjs dry-run   pull the purchases, write kruidvat-state/preview.txt, send nothing
//   node fetcher/kruidvat_import.mjs push      pull, send the new purchases' ops
//
// Next to run.sh: config.env (KITCHEN_ORIGIN; KRUIDVAT_MODE, read by run.sh;
// optionally KRUIDVAT_SESSION_FILE, KRUIDVAT_STATE_DIR), kruidvat-session.json
// (made by fetcher/kruidvat-login.mjs on the PC) and importer-token (the device
// "Thuisserver AH"). No token or cookie is ever printed or logged.
//
// Kruidvat keeps only the last 90 days: the cache here keeps every order once
// seen, but a gap of more than 90 days without a working run loses purchases.
//
// What becomes a product: the product's own category address decides
// (/eten-en-drinken/ food, /verzorging/ /beauty/ /gezondheid/ care,
// /huishouden/ household, /dier.../ pet); durable goods (trimmers, hair
// dryers, scales, thermometers... `DURABLE`) and every other section (gifts,
// toys, photo prints, electronics, home) stay on the receipt as kind "other"
// lines: no product, no pantry row, no "need it again" rate.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createKruidvatClient } from "./kruidvat_client.mjs";
import { nameKey } from "../public/shared/ingredients.js";
import { isExcluded, isExcludedLookalike } from "../public/shared/excluded.js";
import { kindFromName } from "../public/shared/product-kinds.js";
import { buildOps, mapProduct } from "../tools/import_ah.mjs";
import { toCents } from "../tools/import_lidl.mjs";
import { initState as initReceiptState, newOps, previewText, runImport, TITLES_FILE } from "./receipt_run.mjs";

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(path.join(HOME, "config.env"));
} catch {
  // No config.env: the defaults below.
}
const ORIGIN = (process.env.KITCHEN_ORIGIN || "https://groceries.vexed.works").replace(/\/+$/, "");
const SESSION_FILE = path.resolve(HOME, process.env.KRUIDVAT_SESSION_FILE || "kruidvat-session.json");
const STATE_DIR = path.resolve(HOME, process.env.KRUIDVAT_STATE_DIR || "kruidvat-state");
const AH_STATE_DIR = path.resolve(HOME, process.env.AH_STATE_DIR || "ah-state");
const IMPORTER_TOKEN_FILE = path.join(HOME, "importer-token");
const TIMEZONE = "Europe/Amsterdam";

export const STORE = "Kruidvat";
export { TITLES_FILE };

const CONSUMABLE_KINDS = new Set(["ingredient", "ready_meal", "snack", "drink", "household", "personal_care", "pet"]);

// Things that are never used up, wherever Kruidvat files them (tested on the name and the category address).
export const DURABLE = /\b(trimmers?|baardtrimmer\w*|neustrimmer\w*|scheerapparaa?t\w*|epilator\w*|ipl|haardroger\w*|fohn|stijltang\w*|krultang\w*|elektrische tandenborstel\w*|elektrische tandenborstels|weegschaal|weegschalen|thermometer\w*|bloeddrukmeter\w*|apparaat|apparaten|haarborstel\w*|kam|toilettas\w*|spiegel\w*|massage\w*|oplader\w*|koptelefoon\w*|speelgoed|knuffel\w*)\b/;

// The first part of a category address -> kind (null: food, its kind from the name).
const SECTIONS = [
  [/^(eten en drinken|voeding|snoep)/, null],
  [/^(verzorging|beauty|make up|parfum|gezondheid|baby|mondverzorging|haarverzorging|lichaamsverzorging|huidverzorging)/, "personal_care"],
  [/^(huishouden|schoonmaak|wassen)/, "household"],
  [/^(dier|huisdier)/, "pet"],
];

/** The kind of a consumable line, or null for one that stays on the receipt only. */
export function kruidvatKind({ name, categoryUrl = "" }) {
  const url = String(categoryUrl).toLowerCase();
  const section = url.split("/").filter(Boolean)[0]?.replace(/-/g, " ") ?? "";
  if (DURABLE.test(`${nameKey(name)} ${url.replace(/[/-]+/g, " ")}`)) return null;
  const byName = kindFromName(name);
  if (section) {
    const hit = SECTIONS.find(([re]) => re.test(section));
    if (!hit) return null; // gifts, toys, photo prints, electronics, home...
    if (hit[1]) return hit[1];
    // Food: what the name says, else a snack (Kruidvat's food is mostly sweets and snacks).
    return CONSUMABLE_KINDS.has(byName) && byName !== "household" && byName !== "personal_care" ? byName : "snack";
  }
  return CONSUMABLE_KINDS.has(byName) ? byName : null;
}

/** "King C. Gillette Baardolie 30ml" with brand "King C" -> { brand, bare: "Gillette Baardolie", size: "30 ml" }. */
export function splitKruidvatName(name, brand = "") {
  let bare = String(name ?? "").replace(/\s+/g, " ").trim();
  let size = "";
  const m = bare.match(/(?:^|\s)(\d+(?:[.,]\d+)?)\s?(kg|g|gr|gram|ml|cl|l|ltr|liter|st|stuks)\b\.?/i);
  if (m) {
    const unit = { gr: "g", gram: "g", ltr: "l", liter: "l", stuks: "st" }[m[2].toLowerCase()] ?? m[2].toLowerCase();
    size = `${m[1].replace(".", ",")} ${unit}`;
    bare = `${bare.slice(0, m.index)} ${bare.slice(m.index + m[0].length)}`.replace(/\s+/g, " ").trim();
  }
  const b = String(brand ?? "").trim();
  if (b && nameKey(bare).startsWith(`${nameKey(b)} `)) bare = bare.split(" ").slice(nameKey(b).split(" ").length).join(" ");
  return { brand: b, bare: bare ? bare.charAt(0).toUpperCase() + bare.slice(1) : bare, size };
}

/** "2026-11-03T15:39:45+0100" -> "2026-11-03" (the day in Amsterdam). */
export function kruidvatDay(placed) {
  const v = String(placed ?? "").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+)?$/.test(v)) return v.slice(0, 10);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("sv-SE", { timeZone: TIMEZONE });
}

/**
 * Each entry's line total in cents. Kruidvat's `basePriceWithDiscount` is
 * the line total on a multibuy line (2 x for 11.99: 11.99), as Thomas's first
 * order showed; the order total decides: when the bases add up to it they are
 * line totals, when base x quantity does they are unit prices, otherwise the
 * bases are taken as line totals and `mismatch` says so.
 */
export function linePrices(order) {
  const entries = order?.entries ?? [];
  const base = entries.map((e) => toCents(e.basePriceWithDiscount) ?? toCents(e.priceAtPurchase) ?? toCents(e.price));
  const qty = entries.map((e) => (Number(e.quantity) > 0 ? Number(e.quantity) : 1));
  const total = toCents(order?.total);
  const asLine = base.reduce((s, c) => s + (c ?? 0), 0);
  const asUnit = base.reduce((s, c, i) => s + (c ?? 0) * qty[i], 0);
  if (total !== null && Math.abs(asLine - total) <= 1) return { cents: base, how: "line" };
  if (total !== null && Math.abs(asUnit - total) <= 1) return { cents: base.map((c, i) => (c === null ? null : c * qty[i])), how: "unit" };
  return { cents: base, how: "line", mismatch: total === null ? null : asLine - total };
}

/** One cached order -> { id, day, city, total_cents, lines, dropped, note }, the shape buildOps reads. */
export function normaliseKruidvatOrder(o) {
  const dropped = { excluded: 0, other: 0 };
  const lines = [];
  const prices = linePrices(o);
  (o?.entries ?? []).forEach((e, i) => {
    const name = String(e.name ?? "").replace(/\s+/g, " ").trim();
    if (!name) return;
    const qty = Number(e.quantity) > 0 ? Number(e.quantity) : 1;
    const price = prices.cents[i];
    const { brand, bare, size } = splitKruidvatName(name, e.brand);
    const fullName = brand ? `${brand} ${bare}` : bare;
    if ([name, fullName, bare, brand].some((n) => n && (isExcluded(n) || isExcludedLookalike(n)))) {
      dropped.excluded++;
      return;
    }
    const kind = kruidvatKind({ name, categoryUrl: e.categoryUrl });
    if (!kind || (price ?? 0) < 0) {
      lines.push({ kind: "other", receiptName: name, name: fullName, brand: "", size, qty, price_cents: price });
      dropped.other++;
      return;
    }
    lines.push({
      kind: "product", posId: e.code || null, webshopId: null, code: e.code || null,
      receiptName: name, fullName, name: fullName, bare, brand, size, category: e.category ?? "", productKind: kind, qty,
      price_cents: price === null ? null : Math.max(0, price),
    });
  });
  return {
    id: String(o?.code ?? ""),
    day: kruidvatDay(o?.placed),
    city: o?.town ?? null,
    total_cents: toCents(o?.total),
    lines,
    dropped,
    note: prices.mismatch ? `${o?.code}: the lines add up to ${prices.mismatch > 0 ? "+" : ""}${(prices.mismatch / 100).toFixed(2)} against the total; taken as line totals` : null,
  };
}

const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback);
export const receiptFile = (dir, id) => path.join(dir, "receipts", `${String(id).replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

/** Every cached order, oldest first. */
export function readKruidvatCache(dir) {
  return readJson(path.join(dir, "receipts.json"), [])
    .filter((s) => fs.existsSync(receiptFile(dir, s.id)))
    .map((s) => normaliseKruidvatOrder(readJson(receiptFile(dir, s.id))))
    .filter((r) => r.id && /^\d{4}-\d{2}-\d{2}$/.test(r.day ?? ""))
    .sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
}

export const receiptIdOf = (code) => `kruidvat-${String(code).replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 64).padEnd(8, "-");
export const productIdOf = (l) => (l.code
  ? `kruidvat-product-${String(l.code).replace(/[^A-Za-z0-9_-]/g, "")}`
  : `kruidvat-name-${nameKey(l.receiptName).replace(/[^a-z0-9]+/g, "-")}`).slice(0, 64).padEnd(8, "-");

/** Receipts -> { ops, products, preferred, totals }: tools/import_ah.mjs's buildOps at Kruidvat. */
export function buildKruidvatOps(receipts, vocab, { only = null, pantrySince = null } = {}) {
  return buildOps(receipts, vocab, {
    only, pantrySince, store: STORE, prefix: "kruidvat", receiptIdOf, productIdOf, map: (l) => mapProduct(l, vocab, {}),
  });
}

/** The ops for Thomas's Kruidvat purchases in `dir` not yet sent to `origin`. */
export function newKruidvatOps(dir, origin, { titles, today } = {}) {
  const built = newOps(dir, origin, { titles, ...(today ? { today } : {}), readCache: readKruidvatCache, build: buildKruidvatOps });
  return { ...built, notes: built.all.map((r) => r.note).filter(Boolean) };
}

/** kruidvat-state/ with an empty sent.json for `origin` and the item names. Refuses to replace a sent.json. */
export function initState({ stateDir = STATE_DIR, origin = ORIGIN, titlesFrom = path.join(AH_STATE_DIR, TITLES_FILE) } = {}) {
  return initReceiptState({ stateDir, origin, titlesFrom });
}

/** The purchases of the last 90 days into the cache: each order written once (receipts/<code>.json). */
export async function pullKruidvat(dir, { api, log: say = () => {} }) {
  fs.mkdirSync(path.join(dir, "receipts"), { recursive: true });
  const listFile = path.join(dir, "receipts.json");
  const list = readJson(listFile, []);
  const byId = new Map(list.map((r) => [r.id, r]));
  const orders = await api.listPurchases();
  let fresh = 0;
  for (const o of orders) {
    if (!byId.has(o.code)) byId.set(o.code, { id: o.code, placed: o.placed });
    if (fs.existsSync(receiptFile(dir, o.code))) continue;
    fs.writeFileSync(receiptFile(dir, o.code), JSON.stringify(o));
    fresh++;
  }
  fs.writeFileSync(listFile, JSON.stringify([...byId.values()], null, 1));
  say(`${orders.length} store purchases in the last 90 days, ${fresh} new in the cache`);
  return { listed: orders.length, fetched: fresh };
}

const log = (...a) => console.log(new Date().toISOString(), "kruidvat", ...a);

/** One run. Returns { sent, newReceipts }. */
export async function runReceipts(mode, { stateDir = STATE_DIR, origin = ORIGIN, api, post = fetch, token = null, today, log: say = log } = {}) {
  return runImport(mode, {
    label: STORE, script: "fetcher/kruidvat_import.mjs", stateDir, origin, post, token, tokenFile: IMPORTER_TOKEN_FILE, today, log: say,
    pull: (dir, line) => pullKruidvat(dir, { api, log: line }),
    build: (dir, o, titles, day) => newKruidvatOps(dir, o, { titles, today: day }),
    preview: (built) => previewText(STORE, built, "a consumable here needs its section in SECTIONS or a fix in DURABLE (fetcher/kruidvat_import.mjs)"),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === "init") {
    try {
      log(`initialised ${initState()}`);
    } catch (e) {
      log("FAILED", e.message);
      process.exitCode = 1;
    }
  } else if (mode === "dry-run" || mode === "push") {
    log(`${mode}: Kruidvat, state ${STATE_DIR}`);
    try {
      await runReceipts(mode, { api: createKruidvatClient({ sessionFile: SESSION_FILE }) });
    } catch (e) {
      log("receipts FAILED", e.message);
      process.exitCode = 1;
    }
  } else {
    console.log("Usage: node fetcher/kruidvat_import.mjs init|dry-run|push  (see the top of this file)");
    process.exitCode = 2;
  }
}
