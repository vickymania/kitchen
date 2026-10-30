// Seeds the home server's AH import state, once, from the PC's import:
//
//   node fetcher/ah-seed.mjs [--host user@home-server.local] [--from <dir>] [--force]
//
// Copies migration/ah/ (read only; the main kitchen folder's when run from a
// worktree) to ~/kitchen-fetcher/ah-state/ (mode 700): sent.json, so the
// receipts already imported are not sent again; the cached receipts, till-code
// map, product cards and towns, so the server neither fetches two years again
// nor chooses other preferences; owners.json if there is one. Plus
// history-titles.json: Thomas's To Do item names (titles only), the import's
// vocabulary, so the server names items as the PC did. preview.txt stays.
// An existing ah-state/sent.json on the server is never replaced without --force.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AH_DIR, historyTitles, readSent } from "../tools/import_ah.mjs";

const MAIN_AH_DIR = "C:\\path\\to\\the\\workspace\\VEXED.WORKS\\kitchen\\migration\\ah";
const ORIGIN = "https://groceries.vexed.works";
/** What the server's state holds; receipts/ is the folder of raw receipts. */
export const SEED_FILES = ["sent.json", "receipts.json", "pos-to-webshop.json", "products.json", "cities.json", "categories.json", "owners.json"];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

/** The seed in `stage`, ready to tar. Returns counts for the report. */
export function stageSeed(from, stage, titles) {
  if (!fs.existsSync(path.join(from, "sent.json"))) throw new Error(`no sent.json in ${from}`);
  if (!titles.length) throw new Error("no To Do history titles found (migration/export/history*.json)");
  for (const f of SEED_FILES) {
    if (fs.existsSync(path.join(from, f))) fs.copyFileSync(path.join(from, f), path.join(stage, f));
  }
  fs.cpSync(path.join(from, "receipts"), path.join(stage, "receipts"), { recursive: true });
  fs.writeFileSync(path.join(stage, "history-titles.json"), JSON.stringify(titles));
  return {
    sent: readSent(from, ORIGIN).size,
    receipts: fs.readdirSync(path.join(stage, "receipts")).length,
    titles: titles.length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = arg("host", "user@home-server.local");
  const from = arg("from", fs.existsSync(path.join(AH_DIR, "sent.json")) ? AH_DIR : MAIN_AH_DIR);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-ah-seed-"));
  try {
    const counts = stageSeed(from, stage, historyTitles());
    console.log(`From ${from}: ${counts.sent} receipts sent to ${ORIGIN}, ${counts.receipts} cached receipts, ${counts.titles} history titles.`);
    // To stdout from inside the stage: a Windows path as an argument reads as a remote host to GNU tar.
    const tar = spawnSync("tar", ["-cf", "-", "."], { cwd: stage, maxBuffer: 256 << 20 });
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
    const guard = process.argv.includes("--force")
      ? "true"
      : "[ ! -f ~/kitchen-fetcher/ah-state/sent.json ] || { echo 'ah-state/sent.json exists on the server; add --force to replace it' >&2; exit 3; }";
    const remote = [
      guard,
      "umask 077",
      "mkdir -p ~/kitchen-fetcher/ah-state",
      "chmod 700 ~/kitchen-fetcher/ah-state",
      "tar -xf - -C ~/kitchen-fetcher/ah-state --no-same-owner --no-same-permissions",
      "echo \"seeded: $(ls ~/kitchen-fetcher/ah-state/receipts | wc -l) receipts in ~/kitchen-fetcher/ah-state\"",
    ].join(" && ");
    const r = spawnSync("ssh", ["-o", "BatchMode=yes", host, remote], { input: tar.stdout, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`seeding ${host} failed (${r.status}): ${r.stderr}`);
    console.log(r.stdout.trim());
  } catch (e) {
    console.error(`FAILED: ${e.message}`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
