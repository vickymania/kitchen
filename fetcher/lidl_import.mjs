// The daily Lidl Plus run on the home server, after the deals and the AH
// receipts (run.sh): his new Lidl receipts to /api/ops (tools/import_lidl.mjs
// builds the ops, as the AH import does), then his current Lidl Plus coupons
// to /api/offers/sync as source "lidl_plus". Each part fails on its own: a
// broken coupon fetch never stops the receipts, and the other way round.
//
//   node fetcher/lidl_import.mjs init      make lidl-state/ (mode 700): an empty sent.json for
//                                          KITCHEN_ORIGIN and Thomas's item names, copied from
//                                          ah-state/history-titles.json. Once, before the first run.
//   node fetcher/lidl_import.mjs dry-run   pull new receipts and the coupons, write
//                                          lidl-state/preview.txt, log counts, send nothing
//   node fetcher/lidl_import.mjs push      pull, send the new receipts' ops, sync the coupons
//
// Next to run.sh: config.env (KITCHEN_ORIGIN; LIDL_MODE, read by run.sh;
// optionally LIDL_TOKEN_FILE, LIDL_STATE_DIR), lidl-tokens.json (the Lidl
// session, made by fetcher/lidl-login.mjs on the PC), importer-token (the
// device "Thuisserver AH": the same importer rights, see worker/auth.js) for
// the receipts, token (the device "Thuisserver", role fetcher) for the
// coupons. No token is ever printed or logged.
//
// Coupons are only read and shown. Activating one stays Thomas's tap in the
// Lidl Plus app; nothing here can activate one (fetcher/lidl_client.mjs has
// no such call).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLidlClient } from "./lidl_client.mjs";
import { cleanOffer, isExcludedOffer, LIDL_PLUS } from "../public/shared/offers.js";
import { writeSent, pushOps, vocabulary } from "../tools/import_ah.mjs";
import { newReceiptOps, previewText, readCache, readOwners, receiptFile, buildLidlOps, isOwn } from "../tools/import_lidl.mjs";
import { writeNewPurchases } from "../tools/import_ah.mjs";

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(path.join(HOME, "config.env"));
} catch {
  // No config.env: the defaults below.
}
const ORIGIN = (process.env.KITCHEN_ORIGIN || "https://groceries.vexed.works").replace(/\/+$/, "");
const LIDL_TOKEN_FILE = path.resolve(HOME, process.env.LIDL_TOKEN_FILE || "lidl-tokens.json");
const STATE_DIR = path.resolve(HOME, process.env.LIDL_STATE_DIR || "lidl-state");
const AH_STATE_DIR = path.resolve(HOME, process.env.AH_STATE_DIR || "ah-state");
const IMPORTER_TOKEN_FILE = path.join(HOME, "importer-token");
const FETCHER_TOKEN_FILE = path.join(HOME, "token");

export const TITLES_FILE = "history-titles.json";

const log = (...a) => console.log(new Date().toISOString(), "lidl", ...a);
const count = (ops, type) => ops.filter((o) => o.type === type).length;
const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback);

/** lidl-state/ with an empty sent.json for `origin` and the item names. Refuses to replace a sent.json. */
export function initState({ stateDir = STATE_DIR, origin = ORIGIN, titlesFrom = path.join(AH_STATE_DIR, TITLES_FILE) } = {}) {
  if (fs.existsSync(path.join(stateDir, "sent.json"))) throw new Error(`${path.join(stateDir, "sent.json")} exists already`);
  if (!fs.existsSync(titlesFrom)) throw new Error(`no ${titlesFrom}: seed the AH state first (node fetcher/ah-seed.mjs)`);
  fs.mkdirSync(path.join(stateDir, "receipts"), { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);
  fs.copyFileSync(titlesFrom, path.join(stateDir, TITLES_FILE));
  fs.writeFileSync(path.join(stateDir, "sent.json"), JSON.stringify({ [origin]: [] }, null, 1));
  return stateDir;
}

/**
 * New receipts from Lidl into the cache: receipts.json (the list) and
 * receipts/<id>.json (each one in full, fetched once). Sequential.
 */
export async function pullLidl(dir, { api, log: say = () => {} }) {
  fs.mkdirSync(path.join(dir, "receipts"), { recursive: true });
  const listFile = path.join(dir, "receipts.json");
  const list = readJson(listFile, []);
  const known = new Set(list.map((r) => r.id).filter((id) => fs.existsSync(receiptFile(dir, id))));
  const found = await api.listReceipts({ known });
  const byId = new Map(list.map((r) => [r.id, r]));
  for (const r of found) if (!byId.has(r.id)) byId.set(r.id, r);
  let fetched = 0;
  for (const r of byId.values()) {
    if (fs.existsSync(receiptFile(dir, r.id))) continue;
    const raw = await api.getReceipt(r.id);
    fs.writeFileSync(receiptFile(dir, r.id), JSON.stringify(raw));
    fetched++;
  }
  fs.writeFileSync(listFile, JSON.stringify([...byId.values()], null, 1));
  say(`${found.length} receipts listed, ${fetched} fetched`);
  return { listed: found.length, fetched };
}

/** "2026-11-02T23:59:59" -> "2026-11-02" in Dutch time (a bare date stays as it is). */
function dayOf(v) {
  if (typeof v !== "string" || !v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}Z`);
  if (Number.isNaN(d.getTime())) return null;
  // A local time without a zone is Lidl's Dutch time: its date part is the day.
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? d.toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" }) : v.slice(0, 10);
}

/**
 * The coupons answer -> offers ({ store "Lidl", source "lidl_plus", name,
 * deal, valid_from, valid_until }), excluded things out. Reads the promotionsList
 * shape (sections[].promotions[]: title, discount { title, description },
 * validity { start, end }) and the older one (sections[].coupons[]: title,
 * offerTitle, offerDescriptionShort, startValidityDate, endValidityDate).
 */
export function couponOffers(answer) {
  const out = [];
  const seen = new Set();
  const sections = Array.isArray(answer?.sections) ? answer.sections : Array.isArray(answer) ? [{ promotions: answer }] : [];
  for (const s of sections) {
    for (const c of [...(s?.promotions ?? []), ...(s?.coupons ?? [])]) {
      if (!c || seen.has(c.id ?? c.promotionId ?? JSON.stringify(c))) continue;
      seen.add(c.id ?? c.promotionId ?? JSON.stringify(c));
      const deal = [c.discount?.title ?? c.offerTitle, c.discount?.description ?? c.offerDescriptionShort]
        .filter((x) => typeof x === "string" && x.trim()).join(" ").replace(/\s+/g, " ").trim();
      const offer = cleanOffer({
        store: "Lidl",
        source: LIDL_PLUS,
        name: typeof c.title === "string" ? c.title : "",
        brand: typeof c.brand === "string" ? c.brand : null,
        deal: deal || null,
        price_cents: null,
        valid_from: dayOf(c.validity?.start ?? c.startValidityDate),
        valid_until: dayOf(c.validity?.end ?? c.endValidityDate),
        category: null,
      });
      if (offer && !isExcludedOffer(offer)) out.push(offer);
    }
  }
  return out;
}

/** The receipts part. Returns { sent, newReceipts }. */
export async function runReceipts(mode, { stateDir = STATE_DIR, origin = ORIGIN, api, post = fetch, token = null, today, log: say = log } = {}) {
  const sentFile = path.join(stateDir, "sent.json");
  if (!fs.existsSync(sentFile)) throw new Error(`no ${sentFile}: run "node fetcher/lidl_import.mjs init" first`);
  if (!Object.hasOwn(readJson(sentFile, {}), origin)) throw new Error(`sent.json has no entry for ${origin}: made for another origin?`);
  const titlesFile = path.join(stateDir, TITLES_FILE);
  if (!fs.existsSync(titlesFile)) throw new Error(`no ${titlesFile}: run "node fetcher/lidl_import.mjs init" first`);
  const titles = JSON.parse(fs.readFileSync(titlesFile, "utf8"));

  await pullLidl(stateDir, { api, log: (line) => say("pull", line) });
  const built = newReceiptOps(stateDir, origin, { titles, ...(today ? { today } : {}) });
  const { ops } = built;
  // For the nightly check (fetcher/review.mjs): what this run found new, sent or not.
  writeNewPurchases(stateDir, built, mode === "push" ? "Lidl" : "Lidl (dry run, not sent)");
  say(`receipts: ${built.account} on the account, ${built.own} own, ${built.otherPeople} someone else's (left out); new: ${built.only.size}`);
  say(`ops: ${ops.length} (${count(ops, "receipt.save")} receipts, ${count(ops, "purchase.add")} purchases, ${ops.filter((o) => o.pantry).length} of them into the pantry, ${count(ops, "product.put")} products, ${count(ops, "preference.set")} preferences)`);
  if (mode === "dry-run") {
    const all = readCache(stateDir);
    const owners = readOwners(stateDir);
    fs.writeFileSync(path.join(stateDir, "preview.txt"), previewText(buildLidlOps(all.filter((r) => isOwn(r, owners)), vocabulary(titles)), all, owners));
    say(`dry-run: nothing sent; ${path.join(stateDir, "preview.txt")} written`);
    return { sent: 0, newReceipts: built.only.size };
  }
  if (!built.only.size) {
    say("no new receipts");
    return { sent: 0, newReceipts: 0 };
  }
  const failed = await pushOps(ops, origin, token ?? readTokenFile(IMPORTER_TOKEN_FILE, "node fetcher/ah_import.mjs pair"), { post, progress: () => {} });
  if (failed.length) {
    // sent.json is not written: the next run tries these receipts again (the ops are idempotent).
    throw new Error(`refused: ${failed.length} ops, first ${JSON.stringify(failed.slice(0, 5))}`);
  }
  writeSent(stateDir, origin, built.only);
  say(`sent ${ops.length} ops for ${built.only.size} receipts`);
  return { sent: ops.length, newReceipts: built.only.size };
}

/**
 * The coupons part: the full current set of Lidl Plus coupons, as source
 * "lidl_plus". The worker replaces only that source's rows, so the folder
 * offers stay. A failed fetch throws before anything is sent: an empty set
 * would remove every stored coupon.
 */
export async function runCoupons(mode, { origin = ORIGIN, api, post = fetch, token = null, log: say = log } = {}) {
  const answer = await api.listCoupons();
  // An answer of another shape would read as "no coupons" and remove them all.
  if (!Array.isArray(answer?.sections) && !Array.isArray(answer)) throw new Error("unexpected coupon answer: no sections");
  const offers = couponOffers(answer);
  say(`coupons: ${offers.length} (never activated here: that is a tap in the Lidl Plus app)`);
  if (mode === "dry-run") {
    for (const o of offers.slice(0, 3)) say("sample", JSON.stringify(o));
    return { synced: false, coupons: offers.length };
  }
  const res = await post(`${origin}/api/offers/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token ?? readTokenFile(FETCHER_TOKEN_FILE, "node fetcher/fetch.mjs pair")}` },
    body: JSON.stringify({ source: LIDL_PLUS, offers }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`coupon sync refused: HTTP ${res.status} ${body.error ?? ""}`);
  say("coupons synced", JSON.stringify(body));
  return { synced: true, coupons: offers.length, result: body };
}

function readTokenFile(file, how) {
  try {
    const token = fs.readFileSync(file, "utf8").trim();
    if (token.length >= 20) return token;
  } catch {
    // handled below
  }
  throw new Error(`no token in ${file}: run "${how}" first`);
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
    const api = createLidlClient({ tokenFile: LIDL_TOKEN_FILE });
    log(`${mode}: Lidl Plus, state ${STATE_DIR}`);
    // Each part on its own: one failing never stops the other.
    try {
      await runReceipts(mode, { api });
    } catch (e) {
      log("receipts FAILED", e.message);
      process.exitCode = 1;
    }
    try {
      await runCoupons(mode, { api });
    } catch (e) {
      log("coupons FAILED", e.message);
      process.exitCode = 1;
    }
  } else {
    console.log("Usage: node fetcher/lidl_import.mjs init|dry-run|push  (see the top of this file)");
    process.exitCode = 2;
  }
}
