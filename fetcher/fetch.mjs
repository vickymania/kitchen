// The daily deals run on the home server (AH answers there; from
// Cloudflare it answers 403). Installed in ~/kitchen-fetcher by
// fetcher/deploy.mjs, started by run.sh from crontab.
//
//   node fetcher/fetch.mjs dry-run   fetch everything, print counts per store, send nothing
//   node fetcher/fetch.mjs push      fetch everything, send the full set to /api/offers/sync
//   node fetcher/fetch.mjs pair      link this server as the device "Thuisserver" with a
//                                    fetcher code (node tools/admin.mjs code --fetcher),
//                                    typed on stdin; the token goes to ./token (mode 600)
//
// config.env next to run.sh: KITCHEN_ORIGIN, MODE (read by run.sh), and
// optionally FOLDER_SHOPS (comma-separated allefolders slugs).
// The token is never printed, logged or sent anywhere but KITCHEN_ORIGIN.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { ahBonus, shopOffers, DEFAULT_SHOPS } from "./sources.mjs";
import { fromAhBonus, fromFolder, prepare, countByStore, dutchDay } from "./normalise.mjs";

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_FILE = path.join(HOME, "token");
try {
  process.loadEnvFile(path.join(HOME, "config.env"));
} catch {
  // No config.env: the defaults below.
}
const ORIGIN = (process.env.KITCHEN_ORIGIN || "https://groceries.vexed.works").replace(/\/+$/, "");
const SHOPS = process.env.FOLDER_SHOPS?.trim() ? process.env.FOLDER_SHOPS.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_SHOPS;

/** Below this many offers something went wrong; pushing would tombstone good rows. */
const MIN_OFFERS = 50;

const log = (...a) => console.log(new Date().toISOString(), ...a);

/** Everything, from every source. Any source failing throws: a partial set is never pushed. */
export async function collect(today) {
  const raw = [];
  const sources = {};
  const { period, items } = await ahBonus(today);
  raw.push(...items.map((i) => fromAhBonus(i, period)));
  sources.ah = { period: `${period.bonusStartDate}..${period.bonusEndDate}`, items: items.length };
  for (const slug of SHOPS) {
    const { brochures, offers } = await shopOffers(slug);
    raw.push(...offers.map(fromFolder));
    sources[slug] = { brochures, offers: offers.length };
  }
  return { raw, sources, ...prepare(raw, today) };
}

async function readToken() {
  try {
    const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (token.length >= 20) return token;
  } catch {
    // handled below
  }
  throw new Error(`no token in ${TOKEN_FILE}: run "node fetcher/fetch.mjs pair" first`);
}

async function run(mode) {
  const today = dutchDay(new Date().toISOString());
  log(`${mode}: fetching for ${today} (AH + ${SHOPS.length} folder shops)`);
  const { sources, offers, dropped } = await collect(today);
  log("sources", JSON.stringify(sources));
  log("dropped", JSON.stringify(dropped));
  log("offers per store", JSON.stringify(countByStore(offers)));
  log(`total ${offers.length}`);
  if (mode === "dry-run") {
    const shown = new Set();
    for (const o of offers) {
      if (shown.has(o.store)) continue;
      shown.add(o.store);
      log("sample", JSON.stringify(o));
    }
    return;
  }
  if (offers.length < MIN_OFFERS) throw new Error(`only ${offers.length} offers: not pushed`);
  const token = await readToken();
  const res = await fetch(`${ORIGIN}/api/offers/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ offers }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`sync refused: HTTP ${res.status} ${body.error ?? ""}`);
  log("synced", JSON.stringify(body));
}

/**
 * Pairs this server as a device with a code typed on stdin and keeps the token
 * in `file` (mode 600). Used for "Thuisserver" (fetcher code) here and for
 * "Thuisserver AH" (importer code) by fetcher/ah_import.mjs.
 */
export async function pairDevice({ origin = ORIGIN, file, label, prompt }) {
  if (fs.existsSync(file) && !process.argv.includes("--force")) {
    throw new Error(`${file} exists; add --force to pair again`);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = (await new Promise((r) => rl.question(prompt, r))).trim();
  rl.close();
  const res = await fetch(`${origin}/api/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ code, label }),
  });
  if (!res.ok) throw new Error(`pairing failed: HTTP ${res.status}`);
  const token = res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
  if (!token) throw new Error("pairing gave no token");
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  console.log(`Linked as "${label}". Token saved in ${file} (mode 600).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  try {
    if (mode === "dry-run" || mode === "push") await run(mode);
    else if (mode === "pair") await pairDevice({ file: TOKEN_FILE, label: "Thuisserver", prompt: "Fetcher code (6 digits): " });
    else {
      console.log("Usage: node fetcher/fetch.mjs dry-run|push|pair  (see the top of this file)");
      process.exitCode = 2;
    }
  } catch (e) {
    log("FAILED", e.message);
    process.exitCode = 1;
  }
}
