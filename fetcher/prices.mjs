// The daily shelf prices of the stores near home from Checkjebon, on Thomas's
// home server after the receipts (run.sh). Polite: first one small question to
// GitHub for the day of the file's last commit; only when that day is newer
// than the last one sent is the file (~10 MB) fetched, once, and the rows of
// the near stores are kept in prices-cache.json.gz. On every other run the
// cached rows are matched again with the same day, under a new op id, so a
// product bought yesterday is matched at the very next run. The matching runs
// HERE (31-10-2026: in the worker it exceeded the free plan's CPU limit): the
// household's products, items, preferences, purchase counts and open list
// come from GET /api/prices/inputs (importer only, private items of others
// left out), storePriceResults (public/shared/comparable-prices.js) finds his
// exact prices and the comparables, and one prices.sync op per store
// (public/shared/store-prices.js PRICE_STORES) carries only those results to
// /api/ops as the importer device ("Thuisserver AH"); the worker checks them
// and writes the diff. A store with fewer than MIN_STORE_ROWS rows is
// skipped (its old prices stay and show their date); Checkjebon or the
// inputs unreachable leaves everything as it was. A dry run reads the inputs
// too when there is a token (a GET, nothing written) and logs the counts.
//
//   node fetcher/prices.mjs dry-run   fetch and log counts per store, send nothing
//   node fetcher/prices.mjs push      send the stores that changed
//   node fetcher/prices.mjs push --force   send even when the day was sent before
//
// Next to run.sh: config.env (KITCHEN_ORIGIN; PRICES_MODE, read by run.sh),
// importer-token (made by "node fetcher/ah_import.mjs pair"),
// prices-state.json (the last day sent) and prices-cache.json.gz (that day's
// filtered rows; never in git). No token is ever printed or logged.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { politeJson } from "./sources.mjs";
import { CHECKJEBON_URL, CHECKJEBON_COMMITS, PRICE_STORES, MIN_STORE_ROWS, parseCheckjebon } from "../public/shared/store-prices.js";
import { storePriceResults } from "../public/shared/comparable-prices.js";

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMPORTER_TOKEN_FILE = path.join(HOME, "importer-token");
const STATE_FILE = path.join(HOME, "prices-state.json");
const CACHE_FILE = path.join(HOME, "prices-cache.json.gz");
try {
  process.loadEnvFile(path.join(HOME, "config.env"));
} catch {
  // No config.env: the defaults below.
}
const ORIGIN = (process.env.KITCHEN_ORIGIN || "https://groceries.vexed.works").replace(/\/+$/, "");
const HEADERS = { Accept: "application/json", "User-Agent": "vexed-kitchen-fetcher/1.0 (one household, once a day; +https://vexed.works)" };

const log = (...a) => console.log(new Date().toISOString(), "prices", ...a);

/** "2026-10-29": the day of the file's last commit, in Dutch time; null when unknown. */
export function commitDay(commits) {
  const at = Array.isArray(commits) ? commits[0]?.commit?.committer?.date ?? commits[0]?.commit?.author?.date : null;
  const ms = typeof at === "string" ? Date.parse(at) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" }) : null;
}

/**
 * The answer of /api/prices/inputs as the state the matcher reads: rows by
 * id, the open list as entries, the purchase counts as they came.
 */
export function inputsState(inputs) {
  const byId = (list) => Object.fromEntries((Array.isArray(list) ? list : []).filter((r) => r?.id).map((r) => [r.id, r]));
  const listItems = Array.isArray(inputs?.list_items) ? inputs.list_items : [];
  return {
    products: byId(inputs?.products), items: byId(inputs?.items), preferences: byId(inputs?.preferences),
    entries: Object.fromEntries(listItems.map((id, i) => [`list-${i}`, { id: `list-${i}`, item_id: id }])),
    purchase_counts: inputs?.purchase_counts && typeof inputs.purchase_counts === "object" ? inputs.purchase_counts : {},
  };
}

/**
 * One prices.sync op per store with enough rows, its rows the results of the
 * matching against `state` (inputsState); the op id makes a resend of one day
 * a replay. A re-check passes `recheck` (the run's stamp) so its ids are new.
 */
export function priceOps(perStore, day, state, recheck = "") {
  const ops = [];
  const skipped = {};
  for (const [slug, store] of Object.entries(PRICE_STORES)) {
    const rows = perStore[slug] ?? [];
    if (rows.length < MIN_STORE_ROWS) {
      skipped[slug] = rows.length;
      continue;
    }
    ops.push({ op_id: `prices-${slug}-${day}${recheck ? `-r${recheck}` : ""}`, type: "prices.sync", store, day, rows: storePriceResults(state, rows, store) });
  }
  return { ops, skipped };
}

/** The household's inputs for the matching (GET /api/prices/inputs as the importer). */
export async function fetchInputs(origin, token, send = fetch) {
  const res = await send(`${origin}/api/prices/inputs`, {
    method: "GET", headers: { Accept: "application/json", Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`inputs: HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.products) || !Array.isArray(body?.items)) throw new Error("inputs: odd answer");
  return body;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** { day, perStore } of the last file fetched, or null (missing, unreadable, odd). */
export function readCache() {
  try {
    const c = JSON.parse(zlib.gunzipSync(fs.readFileSync(CACHE_FILE)).toString("utf8"));
    return typeof c?.day === "string" && c.perStore && typeof c.perStore === "object" ? c : null;
  } catch {
    return null;
  }
}

function writeCache(cache) {
  const tmp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(cache)));
  fs.renameSync(tmp, CACHE_FILE);
}

/** "202610301517": Dutch date and time to the minute, for the op id of a re-check. */
export function runStamp(now = new Date()) {
  const d = now.toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" }).replaceAll("-", "");
  const t = now.toLocaleTimeString("sv-SE", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit" }).replace(":", "");
  return d + t;
}

function readImporterToken() {
  try {
    const token = fs.readFileSync(IMPORTER_TOKEN_FILE, "utf8").trim();
    if (token.length >= 20) return token;
  } catch {
    // handled below
  }
  throw new Error(`no token in ${IMPORTER_TOKEN_FILE}: run "node fetcher/ah_import.mjs pair" first`);
}

/**
 * One run. get(url) returns parsed JSON (politeJson; tests pass a fake),
 * post is fetch. Returns { day, sent, skipped } for the test.
 */
export async function runPrices(mode, { get = (url, label) => politeJson(url, { headers: HEADERS }, { label }), post = fetch, token = null,
  origin = ORIGIN, state = readState(), saveState = (s) => fs.writeFileSync(STATE_FILE, `${JSON.stringify(s)}\n`), force = false, say = log,
  cache = readCache(), saveCache = writeCache, now = new Date() } = {}) {
  let day = null;
  try {
    day = commitDay(await get(CHECKJEBON_COMMITS, "checkjebon commits"));
  } catch (e) {
    say("commit day unknown:", e.message);
  }
  // A new Checkjebon day (or none known, or --force) means fetch the file. Otherwise the
  // cached rows of that day go out again: the worker writes only what changed, so a
  // product bought since then gets its price now, not when Checkjebon next updates.
  const fresh = !day || day > (state.day ?? "") || force || mode !== "push";
  let perStore;
  let recheck = "";
  if (!fresh && cache) {
    say(`re-check from cache: day ${cache.day} sent again`);
    perStore = cache.perStore;
    day = cache.day;
    recheck = runStamp(now);
  } else {
    let data;
    try {
      data = await get(CHECKJEBON_URL, "checkjebon");
    } catch (e) {
      // Degrade: the prices on the phones stay as they are and show their date.
      say("checkjebon unreachable, nothing sent:", e.message);
      return { day, sent: 0, skipped: {}, unreachable: true };
    }
    // Without a commit day the data counts from today: it was just fetched.
    day ??= new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" });
    perStore = parseCheckjebon(data);
    if (mode === "push") {
      try {
        saveCache({ day, perStore });
      } catch (e) {
        say("cache not saved:", e.message);
      }
    }
    if (fresh) say("new data");
    else {
      say("re-check, no cache yet: the file was fetched and cached");
      recheck = runStamp(now);
    }
  }
  const counts = JSON.stringify(Object.fromEntries(Object.entries(perStore).map(([k, v]) => [k, v.length])));
  // The household's inputs: required to push; a dry run without a token or answer only counts rows.
  let auth = token;
  let inputs = null;
  try {
    auth ??= readImporterToken();
    inputs = await fetchInputs(origin, auth, post);
  } catch (e) {
    if (mode === "push") {
      say("inputs unreachable, nothing sent:", e.message);
      throw new Error(`no inputs: ${e.message}`);
    }
    say("dry-run without inputs:", e.message);
  }
  if (!inputs) {
    say(`day ${day}; rows per store ${counts}`);
    say("dry-run: nothing sent");
    return { day, sent: 0, skipped: {} };
  }
  const { ops, skipped } = priceOps(perStore, day, inputsState(inputs), recheck);
  const found = Object.fromEntries(ops.map((o) => [o.store, `${o.rows.filter((r) => !r.comparable).length}+${o.rows.filter((r) => r.comparable).length}`]));
  say(`day ${day}; rows per store ${counts}; matched exact+comparable ${JSON.stringify(found)}; skipped ${JSON.stringify(skipped)}`);
  if (mode !== "push") {
    say("dry-run: nothing sent");
    return { day, sent: 0, skipped };
  }
  let failed = 0;
  // One store per request: a few hundred results each, and one store failing leaves the others.
  for (const op of ops) {
    try {
      const res = await post(`${origin}/api/ops`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth}` },
        body: JSON.stringify({ ops: [op] }),
        signal: AbortSignal.timeout(120_000),
      });
      const body = await res.json().catch(() => ({}));
      const r = body.results?.[0];
      if (!res.ok || !r?.ok) throw new Error(`HTTP ${res.status} ${body.error ?? r?.error ?? ""}`.trim());
      say(`${op.store}: ${JSON.stringify(r.result)}`);
    } catch (e) {
      failed++;
      say(`${op.store} FAILED: ${e.message}`);
    }
  }
  if (failed) throw new Error(`${failed} of ${ops.length} stores not sent`);
  if (!recheck) saveState({ ...state, day });
  return { day, sent: ops.length, skipped, recheck: Boolean(recheck) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  try {
    if (mode === "dry-run" || mode === "push") await runPrices(mode, { force: process.argv.includes("--force") });
    else {
      console.log("Usage: node fetcher/prices.mjs dry-run|push [--force]  (see the top of this file)");
      process.exitCode = 2;
    }
  } catch (e) {
    log("FAILED", e.message);
    process.exitCode = 1;
  }
}
