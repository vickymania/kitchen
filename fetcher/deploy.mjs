// Installs the fetcher on the home server over SSH (key login).
//
//   node fetcher/deploy.mjs [--host user@home-server.local] [--cron] [--run-dry]
//
// Copies the fetcher, the AH receipt import (fetcher/ah_import.mjs and the
// tools/ files it runs) and the shared files they import (public/shared/: one
// source of truth for the offer shape, the never-suggest filter and the op engine)
// to ~/kitchen-fetcher, keeping the repo's layout so the imports are the same.
// config.env, token, importer-token, reviewer-token, ah-tokens.json, lidl-tokens.json,
// ah-state/, lidl-state/, review-state/, prices-state.json and prices-cache.json.gz there are never overwritten.
// The nightly check (fetcher/review.sh) also needs mcp/server.mjs and its shared files.
// --cron installs (or replaces) one crontab line, daily
// 06:17 Dutch time, for run.sh; MODE and AH_MODE in config.env say whether
// that run pushes. --run-dry runs a dry run of the deals after.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = "kitchen-fetcher";
const CRON = `17 6 * * * $HOME/${DIR}/run.sh`;

// [from (repo), to (on the server, under ~/kitchen-fetcher)]. Every shared file
// one of these imports must be here too (tests/preferences.test.mjs "fetcher files").
const FILES = [
  ["fetcher/fetch.mjs", "fetcher/fetch.mjs"],
  ["fetcher/sources.mjs", "fetcher/sources.mjs"],
  ["fetcher/normalise.mjs", "fetcher/normalise.mjs"],
  ["fetcher/ah_import.mjs", "fetcher/ah_import.mjs"],
  ["fetcher/ah_client.mjs", "fetcher/ah_client.mjs"],
  ["fetcher/lidl_import.mjs", "fetcher/lidl_import.mjs"],
  ["fetcher/lidl_client.mjs", "fetcher/lidl_client.mjs"],
  ["fetcher/prices.mjs", "fetcher/prices.mjs"],
  ["fetcher/review.mjs", "fetcher/review.mjs"],
  ["fetcher/review.sh", "fetcher/review.sh"],
  ["fetcher/review-prompt.md", "fetcher/review-prompt.md"],
  // Optional (third field): the household's own rules are not in the public copy.
  ["fetcher/review-household.md", "fetcher/review-household.md", "optional"],
  ["mcp/server.mjs", "mcp/server.mjs"],
  ["tools/import_ah.mjs", "tools/import_ah.mjs"],
  ["tools/ah_pull.mjs", "tools/ah_pull.mjs"],
  ["tools/ah_items.mjs", "tools/ah_items.mjs"],
  ["tools/import_lidl.mjs", "tools/import_lidl.mjs"],
  ["tools/lidl_items.mjs", "tools/lidl_items.mjs"],
  ["tools/import_todo.mjs", "tools/import_todo.mjs"],
  // The nightly check's merges: the dedupe tool's rules and op ids, and the household's targets (private, optional).
  ["tools/dedupe_items.mjs", "tools/dedupe_items.mjs"],
  ["tools/dedupe-household.js", "tools/dedupe-household.js", "optional"],
  ["public/shared/dedupe.js", "public/shared/dedupe.js"],
  ["public/shared/recipe-links.js", "public/shared/recipe-links.js"],
  ["public/shared/offers.js", "public/shared/offers.js"],
  ["public/shared/excluded.js", "public/shared/excluded.js"],
  ["public/shared/excluded-words.js", "public/shared/excluded-words.js"],
  ["public/shared/ingredients.js", "public/shared/ingredients.js"],
  ["public/shared/item-names.js", "public/shared/item-names.js"],
  ["public/shared/item-find.js", "public/shared/item-find.js"],
  ["public/shared/ingredient-match.js", "public/shared/ingredient-match.js"],
  ["public/shared/ingredient-lexicon.js", "public/shared/ingredient-lexicon.js"],
  ["public/shared/stores.js", "public/shared/stores.js"],
  ["public/shared/ops.js", "public/shared/ops.js"],
  ["public/shared/pantry.js", "public/shared/pantry.js"],
  ["public/shared/shelf-life.js", "public/shared/shelf-life.js"],
  ["public/shared/usage-rates.js", "public/shared/usage-rates.js"],
  ["public/shared/rate-learning.js", "public/shared/rate-learning.js"],
  ["public/shared/default-portions.js", "public/shared/default-portions.js"],
  ["public/shared/labels.js", "public/shared/labels.js"],
  ["public/shared/intervals.js", "public/shared/intervals.js"],
  ["public/shared/again-scope.js", "public/shared/again-scope.js"],
  ["public/shared/product-kinds.js", "public/shared/product-kinds.js"],
  ["public/shared/recipe-text.js", "public/shared/recipe-text.js"],
  ["public/shared/bilingual.js", "public/shared/bilingual.js"],
  ["public/shared/store-prices.js", "public/shared/store-prices.js"],
  ["public/shared/comparable-prices.js", "public/shared/comparable-prices.js"],
  ["public/shared/deal-math.js", "public/shared/deal-math.js"],
  ["public/shared/preferences.js", "public/shared/preferences.js"],
  ["public/shared/deals.js", "public/shared/deals.js"],
  ["public/shared/low-stock.js", "public/shared/low-stock.js"],
  ["public/shared/suggest.js", "public/shared/suggest.js"],
  ["public/shared/recipe-ratings.js", "public/shared/recipe-ratings.js"],
  ["fetcher/run.sh", "run.sh"],
  ["fetcher/config.example.env", "config.example.env"],
];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status}): ${String(r.stderr || r.stdout)}`);
  return r.stdout;
}

const host = arg("host", "user@home-server.local");
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-fetcher-"));
try {
  for (const [from, to, optional] of FILES) {
    if (optional && !fs.existsSync(path.join(ROOT, from))) continue;
    const dest = path.join(stage, to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Line endings as Linux wants them: a CR breaks the shell script.
    fs.writeFileSync(dest, fs.readFileSync(path.join(ROOT, from), "utf8").replace(/\r\n/g, "\n"));
  }
  fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
  // To stdout from inside the stage: a Windows path as an argument reads as a remote host to GNU tar.
  const tarball = run("tar", ["-cf", "-", "."], { cwd: stage, encoding: "buffer", maxBuffer: 64 << 20 });

  const remote = [
    `mkdir -p ~/${DIR}`,
    `tar -xf - -C ~/${DIR} --no-same-owner --no-same-permissions`,
    `chmod 755 ~/${DIR}/run.sh ~/${DIR}/fetcher/review.sh`,
    `chmod 700 ~/${DIR}`,
    `[ -f ~/${DIR}/config.env ] || cp ~/${DIR}/config.example.env ~/${DIR}/config.env`,
    ...["token", "importer-token", "reviewer-token", "ah-tokens.json", "lidl-tokens.json"].map((f) => `{ [ ! -f ~/${DIR}/${f} ] || chmod 600 ~/${DIR}/${f}; }`),
    `{ [ ! -d ~/${DIR}/ah-state ] || chmod 700 ~/${DIR}/ah-state; }`,
    `{ [ ! -d ~/${DIR}/lidl-state ] || chmod 700 ~/${DIR}/lidl-state; }`,
    `{ [ ! -d ~/${DIR}/review-state ] || chmod 700 ~/${DIR}/review-state; }`,
    ...(process.argv.includes("--cron")
      ? [`(crontab -l 2>/dev/null | grep -v '${DIR}/run.sh'; echo '${CRON}') | crontab -`]
      : []),
    `echo installed; grep '^MODE=\\|^AH_MODE=\\|^LIDL_MODE=\\|^PRICES_MODE=\\|^REVIEW_MODE=' ~/${DIR}/config.env; (crontab -l 2>/dev/null | grep '${DIR}' || echo 'no crontab line')`,
  ].join(" && ");
  process.stdout.write(run("ssh", ["-o", "BatchMode=yes", host, remote], { input: tarball }));

  if (process.argv.includes("--run-dry")) {
    process.stdout.write(run("ssh", ["-o", "BatchMode=yes", host, `cd ~/${DIR} && /usr/bin/node fetcher/fetch.mjs dry-run`], { timeout: 900_000 }));
  }
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
