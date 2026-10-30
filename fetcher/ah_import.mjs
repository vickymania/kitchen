// The daily AH receipt import on the home server, right after the deals
// (run.sh). The same code as `node tools/import_ah.mjs --pull --push` on the
// PC: tools/ah_pull.mjs fills the cache, tools/import_ah.mjs builds the ops
// (tools/ah_items.mjs maps them), only receipts not sent before go out. The
// AH calls go through fetcher/ah_client.mjs on the server's own AH session.
//
//   node fetcher/ah_import.mjs dry-run   pull new receipts from AH, log what would be sent, send nothing
//   node fetcher/ah_import.mjs push      pull, then send the new receipts' ops to /api/ops
//   node fetcher/ah_import.mjs pair      link this server as the device "Thuisserver AH" with an
//                                        importer code (node tools/admin.mjs code --importer),
//                                        typed on stdin; the token goes to ./importer-token (mode 600)
//
// Next to run.sh: config.env (KITCHEN_ORIGIN; AH_MODE, read by run.sh;
// optionally AH_TOKEN_FILE and AH_STATE_DIR), ah-tokens.json (the AH session,
// made by fetcher/ah-login.mjs on the PC), importer-token, and ah-state/ (the
// cache and sent.json, seeded once by fetcher/ah-seed.mjs). No token is ever
// printed or logged.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAhClient } from "./ah_client.mjs";
import { pairDevice } from "./fetch.mjs";
import { pullAh } from "../tools/ah_pull.mjs";
import { newReceiptOps, pushOps, readSent, writeSent, writeNewPurchases } from "../tools/import_ah.mjs";

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IMPORTER_TOKEN_FILE = path.join(HOME, "importer-token");
try {
  process.loadEnvFile(path.join(HOME, "config.env"));
} catch {
  // No config.env: the defaults below.
}
const ORIGIN = (process.env.KITCHEN_ORIGIN || "https://groceries.vexed.works").replace(/\/+$/, "");
const AH_TOKEN_FILE = path.resolve(HOME, process.env.AH_TOKEN_FILE || "ah-tokens.json");
const STATE_DIR = path.resolve(HOME, process.env.AH_STATE_DIR || "ah-state");

/** Thomas's To Do titles (his item names), written by fetcher/ah-seed.mjs: without them items get other names. */
export const TITLES_FILE = "history-titles.json";

const log = (...a) => console.log(new Date().toISOString(), "ah", ...a);

const count = (ops, type) => ops.filter((o) => o.type === type).length;

/**
 * One run. `api` is the AH client, `post` is fetch (tests pass fakes for
 * both). Returns { sent, newReceipts } for the test.
 */
export async function runImport(mode, { stateDir = STATE_DIR, origin = ORIGIN, api, post = fetch, token = null, today, log: say = log } = {}) {
  if (!fs.existsSync(path.join(stateDir, "sent.json"))) {
    // Without it every receipt of two years would go out again.
    throw new Error(`no ${path.join(stateDir, "sent.json")}: seed the state first (node fetcher/ah-seed.mjs on the PC)`);
  }
  if (!readSent(stateDir, origin).size) throw new Error(`sent.json has no receipts for ${origin}: seeded for another origin?`);
  const titlesFile = path.join(stateDir, TITLES_FILE);
  if (!fs.existsSync(titlesFile)) throw new Error(`no ${titlesFile}: seed the state first`);
  const titles = JSON.parse(fs.readFileSync(titlesFile, "utf8"));

  await pullAh(stateDir, { api, log: (line) => say("pull", line) });
  const built = newReceiptOps(stateDir, origin, { titles, ...(today ? { today } : {}) });
  const { ops } = built;
  // For the nightly check (fetcher/review.mjs): what this run found new, sent or not.
  writeNewPurchases(stateDir, built, mode === "push" ? "AH" : "AH (dry run, not sent)");
  say(`receipts: ${built.account} on the account, ${built.own} own, ${built.otherPeople} someone else's (left out); new: ${built.only.size}`);
  say(`ops: ${ops.length} (${count(ops, "receipt.save")} receipts, ${count(ops, "purchase.add")} purchases, ${ops.filter((o) => o.pantry).length} of them into the pantry, ${count(ops, "product.put")} products, ${count(ops, "preference.set")} preferences)`);
  if (mode === "dry-run" || !built.only.size) {
    say(mode === "dry-run" ? "dry-run: nothing sent" : "no new receipts");
    return { sent: 0, newReceipts: built.only.size };
  }
  const failed = await pushOps(ops, origin, token ?? readImporterToken(), { post, progress: () => {} });
  if (failed.length) {
    // sent.json is not written: the next run tries these receipts again (the ops are idempotent).
    throw new Error(`refused: ${failed.length} ops, first ${JSON.stringify(failed.slice(0, 5))}`);
  }
  writeSent(stateDir, origin, built.only);
  say(`sent ${ops.length} ops for ${built.only.size} receipts`);
  return { sent: ops.length, newReceipts: built.only.size };
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  try {
    if (mode === "dry-run" || mode === "push") {
      log(`${mode}: AH receipts, state ${STATE_DIR}`);
      await runImport(mode, { api: createAhClient({ tokenFile: AH_TOKEN_FILE }) });
    } else if (mode === "pair") {
      await pairDevice({ origin: ORIGIN, file: IMPORTER_TOKEN_FILE, label: "Thuisserver AH", prompt: "Importer code (6 digits): " });
    } else {
      console.log("Usage: node fetcher/ah_import.mjs dry-run|push|pair  (see the top of this file)");
      process.exitCode = 2;
    }
  } catch (e) {
    log("FAILED", e.message);
    process.exitCode = 1;
  }
}
