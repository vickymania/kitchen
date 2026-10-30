// Setting up the household from this computer.
//
//   node tools/admin.mjs bootstrap --name Thomas --household Thuis [--local]
//       Once, on an empty database: creates the household and a first code for
//       an admin called --name, then links this computer with it as the device
//       "Claude (tools)". Its token goes to mcp/.env (KITCHEN_TOKEN and
//       KITCHEN_ORIGIN), for the import and the kitchen MCP server.
//
//   node tools/admin.mjs code [--new-member Sam [--admin] | --fetcher | --importer | --reviewer]
//       A six-digit code, through the API: for another device of the member
//       behind the token (a phone), or for a new person, or (--fetcher) for
//       the home server that sends the deals (fetcher/; that device may call
//       /api/offers/sync and nothing else; pair it on the server with
//       `node fetcher/fetch.mjs pair`), or (--importer) for the home server's
//       AH receipt import (a device of yours that may only send the import's
//       ops to /api/ops; pair it with `node fetcher/ah_import.mjs pair`), or
//       (--reviewer) for the home server's nightly Claude check (reads
//       /api/sync, sends only item.alias, product.move and review.save; pair
//       it with `node fetcher/review.mjs pair`).
//
// --local works against `wrangler dev` (http://recipes.localhost:8787) and its
// local database instead of the live one.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashCode, randomCode, randomId } from "../worker/auth.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, "mcp", ".env");
const LIVE = "https://recipes.vexed.works";
const LOCAL = "http://recipes.localhost:8787";

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** The SQL that creates the household (if there is none) and a first admin code. */
export async function bootstrapSql({ household, name, code, now = new Date() }) {
  const at = now.toISOString();
  const expires = new Date(now.getTime() + 15 * 60_000).toISOString();
  return [
    `INSERT INTO households (id, name, rev, created_at) SELECT ${q(randomId())}, ${q(household)}, 0, ${q(at)} WHERE NOT EXISTS (SELECT 1 FROM households);`,
    `INSERT INTO pairing_codes (code_hash, household_id, kind, new_member_name, make_admin, created_at, expires_at) ` +
      `SELECT ${q(await hashCode(code))}, id, 'code', ${q(name)}, 1, ${q(at)}, ${q(expires)} FROM households ORDER BY created_at LIMIT 1;`,
  ].join("\n");
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

function readEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  return Object.fromEntries(fs.readFileSync(ENV_FILE, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }));
}

function writeEnv(values) {
  fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });
  const merged = { ...readEnv(), ...values };
  fs.writeFileSync(ENV_FILE, Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
}

async function bootstrap(local) {
  const origin = local ? LOCAL : LIVE;
  const code = randomCode();
  const sqlFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-")), "bootstrap.sql");
  fs.writeFileSync(sqlFile, await bootstrapSql({ household: arg("household", "Thuis"), name: arg("name", "Thomas"), code }));
  // One command string: wrangler is a .cmd/.ps1 shim on Windows, so it needs a
  // shell, and Node warns when a shell gets an argument list.
  const run = spawnSync(`wrangler d1 execute kitchen ${local ? "--local" : "--remote"} --file "${sqlFile}" --yes`,
    { cwd: ROOT, shell: true, encoding: "utf8" });
  fs.rmSync(path.dirname(sqlFile), { recursive: true, force: true });
  if (run.status !== 0) throw new Error(`wrangler failed:\n${run.stdout}\n${run.stderr}`);

  const res = await fetch(`${origin}/api/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ code, label: "Claude (tools)" }),
  });
  if (!res.ok) throw new Error(`pairing failed: ${res.status} ${await res.text()}`);
  const token = res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
  if (!token) throw new Error("no token in the answer");
  writeEnv({ KITCHEN_TOKEN: token, KITCHEN_ORIGIN: origin });
  console.log(`Linked this computer as "Claude (tools)". Token saved in ${path.relative(ROOT, ENV_FILE)}.`);
}

async function code() {
  const env = readEnv();
  if (!env.KITCHEN_TOKEN) throw new Error("No token yet: run bootstrap first");
  const body = arg("new-member") ? { for: "new_member", name: arg("new-member"), admin: process.argv.includes("--admin") }
    : process.argv.includes("--fetcher") ? { for: "fetcher" }
    : process.argv.includes("--importer") ? { for: "importer" }
    : process.argv.includes("--reviewer") ? { for: "reviewer" } : {};
  const res = await fetch(`${env.KITCHEN_ORIGIN}/api/codes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.KITCHEN_TOKEN}` },
    body: JSON.stringify(body),
  });
  const out = await res.json();
  if (!res.ok) throw new Error(`code failed: ${res.status} ${JSON.stringify(out)}`);
  console.log(`Code: ${out.code}  (once, until ${new Date(out.expires_at).toLocaleTimeString("nl-NL")})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "bootstrap") await bootstrap(process.argv.includes("--local"));
  else if (command === "code") await code();
  else console.log("Usage: node tools/admin.mjs bootstrap|code  (see the top of this file)");
}
