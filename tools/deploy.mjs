// Put both apps online: recipes.vexed.works and groceries.vexed.works.
//
//     node tools/deploy.mjs            tests, map check, migrations, deploy
//     node tools/deploy.mjs --dry-run  everything except the two remote steps
//
// Refuses with uncommitted changes: the commit becomes BUILD_ID, the version
// the phones' service workers cache under, so what runs is always a commit.
//
// After a live deploy (tools/after_deploy.mjs, never undoes the deploy): the
// branch is pushed to `origin` (the private backup), then the scrubbed public
// copy is published (tools/publish_public.mjs --push) when its clone exists.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publishPublic, pushPrivate } from "./after_deploy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dry = process.argv.includes("--dry-run");

function run(command, { capture = false } = {}) {
  console.log(`> ${command}`);
  const r = spawnSync(command, { cwd: ROOT, shell: true, stdio: capture ? "pipe" : "inherit", encoding: "utf8" });
  if (r.status !== 0) {
    if (capture) console.log(r.stdout, r.stderr);
    throw new Error(`failed: ${command}`);
  }
  return capture ? r.stdout.trim() : "";
}

const dirty = run("git status --porcelain", { capture: true });
if (dirty && !dry) {
  console.log(dirty);
  throw new Error("Uncommitted changes: commit first, the commit is the build id.");
}
run('node --test --test-reporter=dot "tests/*.test.mjs"');
// The map is private: a public copy has no map and no map check.
if (fs.existsSync(path.join(ROOT, "tools", "map_check.py"))) run("py tools/map_check.py");
const build = run("git rev-parse --short HEAD", { capture: true });

if (dry) {
  console.log(`Dry run: would migrate and deploy build ${build}.`);
} else {
  run("wrangler d1 migrations apply kitchen --remote");
  run(`wrangler deploy --var BUILD_ID:${build}`);
  console.log(`Live: build ${build} on https://recipes.vexed.works and https://groceries.vexed.works`);
  pushPrivate(ROOT);
  publishPublic(ROOT);
}
