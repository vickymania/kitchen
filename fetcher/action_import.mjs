// The daily Action run on the home server, after Lidl Plus (run.sh): his
// new Action receipts to /api/ops, built like the AH and Lidl receipts
// (tools/import_ah.mjs buildOps): store "Action", ids "action-<Action id>",
// products "action-product-<code>", purchases and ops hashed from receipt and
// line, so a second run changes nothing.
//
//   node fetcher/action_import.mjs init      make action-state/ (mode 700): an empty sent.json for
//                                            KITCHEN_ORIGIN and the item names, copied from
//                                            ah-state/history-titles.json. Once, before the first run.
//   node fetcher/action_import.mjs dry-run   pull new receipts, write action-state/preview.txt, send nothing
//   node fetcher/action_import.mjs push      pull, send the new receipts' ops
//
// Next to run.sh: config.env (KITCHEN_ORIGIN; ACTION_MODE, read by run.sh;
// optionally ACTION_SESSION_FILE, ACTION_STATE_DIR), action-session.json (the
// session, made by fetcher/action-login.mjs on the PC) and importer-token (the
// device "Thuisserver AH"). No token or cookie is ever printed or logged.
//
// Action is mostly not groceries. A line becomes a product, a purchase (and,
// for the last PANTRY_DAYS, a pantry row) only when it is a consumable of a
// known kind (food, drink, snack, household, care, pet: product-kinds.js's
// name rules plus ACTION_CONSUMABLE below). Electronics, lamps, decor,
// kitchen tools (recipe-links.js TOOL_WORDS), clothes and toys, and anything
// the rules do not know, stay on the receipt as kind "other" lines, like a
// bag at AH: no product, no pantry, no "need it again" rate. The preview lists
// them, so a consumable the rules miss can get a word here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createActionClient } from "./action_client.mjs";
import { nameKey } from "../public/shared/ingredients.js";
import { isExcluded, isExcludedLookalike } from "../public/shared/excluded.js";
import { kindFromName } from "../public/shared/product-kinds.js";
import { TOOL_WORDS } from "../public/shared/recipe-links.js";
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
const SESSION_FILE = path.resolve(HOME, process.env.ACTION_SESSION_FILE || "action-session.json");
const STATE_DIR = path.resolve(HOME, process.env.ACTION_STATE_DIR || "action-state");
const AH_STATE_DIR = path.resolve(HOME, process.env.AH_STATE_DIR || "ah-state");
const IMPORTER_TOKEN_FILE = path.join(HOME, "importer-token");
const TIMEZONE = "Europe/Amsterdam";

export const STORE = "Action";
export { TITLES_FILE };

/** Kinds that make a line a household consumable (product-kinds.js KINDS minus "other"). */
const CONSUMABLE_KINDS = new Set(["ingredient", "ready_meal", "snack", "drink", "household", "personal_care", "pet"]);

// Things Action sells that are never used up. Checked before the kind rules:
// "koekenpan" would read as a snack (koek...), "led kaars" as a candle.
const NOT_CONSUMABLE = new RegExp(`\\b(${[
  "led\\w*", "lamp\\w*", "lampje\\w*", "verlichting", "lichtsnoer\\w*", "lichtslinger\\w*", "lichtstrip\\w*", "strip", "spot\\w*",
  "smart", "slimme?", "wifi", "bluetooth", "usb\\w*", "stekker\\w*", "kabel\\w*", "oplader\\w*", "adapter\\w*", "verlengsnoer\\w*",
  "stopcontact\\w*", "powerbank\\w*", "speaker\\w*", "koptelefoon\\w*", "oordop\\w*", "earbuds", "muis", "toetsenbord", "telefoonhoes\\w*",
  "snijplank\\w*", "fontein", "mok", "mokken", "bord", "borden", "bestek", "glazen", "drinkbeker\\w*", "beker", "bekers", "vaas", "vazen",
  "fotolijst\\w*", "kunstplant\\w*", "kussen\\w*", "plaid", "deken", "kleed", "gordijn\\w*", "decoratie\\w*", "kerstbal\\w*", "kerstboom\\w*",
  "slinger\\w*", "spiegel\\w*", "klok", "wekker", "opberg\\w*", "mand\\w*", "krat\\w*", "emmer\\w*", "haak", "haken", "kapstok\\w*",
  "gereedschap\\w*", "schroevendraaier\\w*", "boor\\w*", "hamer", "tang", "zaag", "speelgoed", "puzzel\\w*", "knuffel\\w*", "bal",
  "sokken", "shirt\\w*", "trui", "muts", "sjaal", "handschoen\\w*", "pantoffel\\w*", "slippers", "tas", "rugzak\\w*", "paraplu\\w*",
  "pen", "pennen", "stift\\w*", "schaar", "notitieboek\\w*", "schrift\\w*", "map", "batterijlader", "thermometer", "weegschaal",
  "waterkoker", "broodrooster", "mixer", "föhn", "fohn", "stijltang", "trimmer\\w*", "scheerapparaat", "tandenborstel elektrisch",
].join("|")})\\b`, "i");

// Consumables Action sells that the shared name rules do not know (nameKey words), with their kind.
export const ACTION_CONSUMABLE = [
  [/\b(haribo|lolly\w*|gummies|zuurtjes|marshmallows?|toblerone|milka|lindt|ritter sport|kinder|m m s|skittles|pringles|lay s|doritos)\b/, "snack"],
  [/\b(wc ?blok\w*|wc ?reiniger|ontkalker|glasreiniger|vloerreiniger|wasparfum|vaatdoek\w*|schuurspons\w*|stofzuigerzak\w*|vuilniszakken|afvalzakken|wasknijper\w*)\b/, "household"],
  [/\b(bodywash|douchecreme|showergel|deodorant|scheerschuim|scheermesjes|wattenschijfjes|nagellak\w*|haargel|haarwax|lippenbalsem|handcreme|tandzijde|mondspoeling)\b/, "personal_care"],
];

/** "household", "snack"... for a consumable line, or null for one that stays on the receipt only. */
export function actionKind(name) {
  const key = nameKey(name);
  if (!key) return null;
  if (NOT_CONSUMABLE.test(key) || key.split(" ").some((w) => TOOL_WORDS.has(w))) return null;
  for (const [re, kind] of ACTION_CONSUMABLE) if (re.test(key)) return kind;
  const kind = kindFromName(name);
  return CONSUMABLE_KINDS.has(kind) ? kind : null;
}

// Brands seen at Action that stand first on its till lines; the rest of the name is the product.
export const ACTION_BRANDS = [
  "toblerone", "milka", "lindt", "haribo", "ritter sport", "kinder", "pringles", "crispy's", "doritos", "axe", "dove", "nivea", "rexona",
  "andrelon", "palmolive", "sanex", "gillette", "oral-b", "colgate", "aquafresh", "robijn", "ariel", "dreft", "glorix", "cillit bang",
  "dettol", "finish", "sun", "witte reus", "whiskas", "felix", "sheba", "gourmet", "pedigree", "red bull", "monster", "lipton", "nescafe",
];

/** "toblerone 340g melkchocolade" -> { brand: "Toblerone", bare: "Melkchocolade", size: "340 g" }. */
export function splitActionName(description) {
  let bare = String(description ?? "").replace(/\s+/g, " ").trim();
  let size = "";
  const multi = bare.match(/(?:^|\s)(\d+)\s?x\s?(\d+(?:[.,]\d+)?)\s?(kg|g|gr|gram|ml|cl|l|ltr|liter)\b\.?/i);
  const single = bare.match(/(?:^|\s)(\d+(?:[.,]\d+)?)\s?(kg|g|gr|gram|ml|cl|l|ltr|liter|st|stuks)\b\.?/i);
  const unit = (u) => ({ gr: "g", gram: "g", ltr: "l", liter: "l", stuks: "st" }[u.toLowerCase()] ?? u.toLowerCase());
  if (multi) {
    size = `${multi[1]} x ${multi[2].replace(".", ",")} ${unit(multi[3])}`;
    bare = `${bare.slice(0, multi.index)} ${bare.slice(multi.index + multi[0].length)}`;
  } else if (single) {
    size = `${single[1].replace(".", ",")} ${unit(single[2])}`;
    bare = `${bare.slice(0, single.index)} ${bare.slice(single.index + single[0].length)}`;
  }
  bare = bare.replace(/\s+/g, " ").trim();
  let brand = "";
  for (const b of ACTION_BRANDS) {
    if (nameKey(bare) === nameKey(b) || nameKey(bare).startsWith(`${nameKey(b)} `)) {
      brand = b.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      bare = bare.split(" ").slice(b.split(" ").length).join(" ");
      break;
    }
  }
  return { brand, bare: bare ? bare.charAt(0).toUpperCase() + bare.slice(1) : bare, size };
}

/** "2026-11-03T15:18:47" (Dutch local time, no zone) -> "2026-11-03"; with a zone, the day in Amsterdam. */
export function actionDay(dateTime) {
  const v = String(dateTime ?? "");
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+)?$/.test(v)) return v.slice(0, 10);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("sv-SE", { timeZone: TIMEZONE });
}

/** The store's town: its name ("Groningen"), else the town in its address ("3031 AG  GRONINGEN,NEDERLAND"). */
export function actionTown(store) {
  const fromAddress = /\d{4}\s?[A-Z]{2}\s+([^,]+)/i.exec(String(store?.address ?? ""))?.[1]?.trim();
  const name = String(store?.name ?? "").trim();
  return name || fromAddress || null;
}

/**
 * One cached Action receipt -> { id, day, city, total_cents, lines, dropped },
 * the shape tools/import_ah.mjs builds ops from. Two lines of one product
 * stay two lines (two purchases of the same product).
 */
export function normaliseActionReceipt(raw) {
  const dropped = { excluded: 0, other: 0 };
  const lines = [];
  for (const p of Array.isArray(raw?.products) ? raw.products : []) {
    const name = String(p?.description ?? "").replace(/\s+/g, " ").trim();
    if (!name) continue;
    const qty = Number(p?.quantity) > 0 ? Number(p.quantity) : 1;
    // The line's total as printed; else the price per piece times the quantity.
    const unit = toCents(p?.price?.adjustedSalesPrice ?? p?.price?.regularSalesPrice);
    const price = toCents(p?.totalPriceFormat) ?? (unit === null ? null : unit * qty);
    const { brand, bare, size } = splitActionName(name);
    const fullName = brand ? `${brand} ${bare}` : bare;
    if ([name, fullName, bare].some((n) => isExcluded(n) || isExcludedLookalike(n))) {
      dropped.excluded++;
      continue;
    }
    const kind = actionKind(name);
    if (!kind || (price ?? 0) < 0) {
      lines.push({ kind: "other", receiptName: name, name: fullName, brand: "", size, qty, price_cents: price });
      dropped.other++;
      continue;
    }
    lines.push({
      kind: "product", posId: p?.code ? String(p.code) : null, webshopId: null, code: p?.code ? String(p.code) : null,
      receiptName: name, fullName, name: fullName, bare, brand, size, category: "", productKind: kind, qty,
      price_cents: price === null ? null : Math.max(0, price),
    });
  }
  // Discounts on the whole receipt stay on it as their own line, so its lines add up.
  for (const [field, label] of [["employeeDiscount", "Personeelskorting"], ["otherDiscounts", "Overige kortingen"]]) {
    const c = toCents(raw?.price?.[field]);
    if (c) lines.push({ kind: "discount", receiptName: label, name: label, brand: "", size: "", qty: 1, price_cents: -Math.abs(c) });
  }
  return {
    id: String(raw?.id ?? ""),
    day: actionDay(raw?.dateTime),
    city: actionTown(raw?.store),
    total_cents: toCents(raw?.price?.total),
    lines,
    dropped,
  };
}

const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback);
export const receiptFile = (dir, id) => path.join(dir, "receipts", `${String(id).replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

/** Every cached receipt, oldest first. */
export function readActionCache(dir) {
  return readJson(path.join(dir, "receipts.json"), [])
    .filter((s) => fs.existsSync(receiptFile(dir, s.id)))
    .map((s) => normaliseActionReceipt(readJson(receiptFile(dir, s.id))))
    .filter((r) => r.id && /^\d{4}-\d{2}-\d{2}$/.test(r.day ?? ""))
    .sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
}

export const receiptIdOf = (actionId) => `action-${String(actionId).replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 64).padEnd(8, "-");
export const productIdOf = (l) => (l.code
  ? `action-product-${String(l.code).replace(/[^A-Za-z0-9_-]/g, "")}`
  : `action-name-${nameKey(l.receiptName).replace(/[^a-z0-9]+/g, "-")}`).slice(0, 64).padEnd(8, "-");

/** Receipts -> { ops, products, preferred, totals }: tools/import_ah.mjs's buildOps at Action. */
export function buildActionOps(receipts, vocab, { only = null, pantrySince = null } = {}) {
  // No reviewed table (AH's is keyed by AH ids): the brand rules and the vocabulary, with the snack guard.
  return buildOps(receipts, vocab, {
    only, pantrySince, store: STORE, prefix: "action", receiptIdOf, productIdOf, map: (l) => mapProduct(l, vocab, {}),
  });
}

/** The ops for Thomas's Action receipts in `dir` not yet sent to `origin`. */
export function newActionOps(dir, origin, { titles, today } = {}) {
  return newOps(dir, origin, { titles, ...(today ? { today } : {}), readCache: readActionCache, build: buildActionOps });
}

/** action-state/ with an empty sent.json for `origin` and the item names. Refuses to replace a sent.json. */
export function initState({ stateDir = STATE_DIR, origin = ORIGIN, titlesFrom = path.join(AH_STATE_DIR, TITLES_FILE) } = {}) {
  return initReceiptState({ stateDir, origin, titlesFrom });
}

/** New receipts from Action into the cache (receipts.json + receipts/<id>.json, each fetched once). Sequential. */
export async function pullAction(dir, { api, log: say = () => {} }) {
  fs.mkdirSync(path.join(dir, "receipts"), { recursive: true });
  const listFile = path.join(dir, "receipts.json");
  const list = readJson(listFile, []);
  const known = new Set(list.map((r) => r.id).filter((id) => fs.existsSync(receiptFile(dir, id))));
  const found = await api.listReceipts({ known, log: say });
  const byId = new Map(list.map((r) => [r.id, r]));
  for (const r of found) if (!byId.has(r.id)) byId.set(r.id, r);
  let fetched = 0;
  for (const r of byId.values()) {
    if (fs.existsSync(receiptFile(dir, r.id))) continue;
    fs.writeFileSync(receiptFile(dir, r.id), JSON.stringify(await api.getReceipt(r.id)));
    fetched++;
  }
  fs.writeFileSync(listFile, JSON.stringify([...byId.values()], null, 1));
  say(`${found.length} receipts listed, ${fetched} fetched`);
  return { listed: found.length, fetched };
}

const log = (...a) => console.log(new Date().toISOString(), "action", ...a);

/** One run. Returns { sent, newReceipts }. */
export async function runReceipts(mode, { stateDir = STATE_DIR, origin = ORIGIN, api, post = fetch, token = null, today, log: say = log } = {}) {
  return runImport(mode, {
    label: STORE, script: "fetcher/action_import.mjs", stateDir, origin, post, token, tokenFile: IMPORTER_TOKEN_FILE, today, log: say,
    pull: (dir, line) => pullAction(dir, { api, log: line }),
    build: (dir, o, titles, day) => newActionOps(dir, o, { titles, today: day }),
    preview: (built) => previewText(STORE, built, "a consumable here needs a word in ACTION_CONSUMABLE (fetcher/action_import.mjs)"),
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
    log(`${mode}: Action, state ${STATE_DIR}`);
    try {
      await runReceipts(mode, { api: createActionClient({ sessionFile: SESSION_FILE }) });
    } catch (e) {
      log("receipts FAILED", e.message);
      process.exitCode = 1;
    }
  } else {
    console.log("Usage: node fetcher/action_import.mjs init|dry-run|push  (see the top of this file)");
    process.exitCode = 2;
  }
}
