// A second AH login, for the home server's receipt import. Run on the PC,
// with Thomas at the keyboard:
//
//   node fetcher/ah-login.mjs [--host user@home-server.local]
//
// It runs the albert-heijn MCP's own login (Custom MCPs/albert-heijn-mcp,
// dist/login.js: Edge or Chrome opens AH's login page, Thomas types his own
// credentials there, the DevTools protocol catches the appie://login-exit
// code) with AH_DATA_DIR pointed at a new temporary folder, so the tokens land
// there and never in the PC's ~/.albert-heijn-mcp/tokens.json. They are then
// copied over SSH to ~/kitchen-fetcher/ah-tokens.json (mode 600) and the
// temporary folder is deleted. Nothing here reads, prints or logs a token
// beyond checking the file has one; the PC's token file is only stat-ed.
//
// AH rotates refresh tokens: one token set shared by PC and server would log
// one of them out at every refresh. Two logins are two sessions, each with
// its own refresh chain.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AH_MCP = process.env.AH_MCP_DIR
  ?? "C:\\path\\to\\the\\workspace\\Custom MCPs\\albert-heijn-mcp";
/** The PC's own session (the MCP's default AH_DATA_DIR). Never written here. */
export const PC_TOKEN_FILE = path.join(os.homedir(), ".albert-heijn-mcp", "tokens.json");
const REMOTE = "kitchen-fetcher/ah-tokens.json";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const stamp = (file) => {
  try {
    const s = fs.statSync(file);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return null;
  }
};

/** Copies the token file to the server: written beside, chmod 600, renamed over the old one. */
function sshUpload(host, file) {
  const remote = [
    "umask 077",
    "mkdir -p ~/kitchen-fetcher",
    `cat > ~/${REMOTE}.new`,
    `chmod 600 ~/${REMOTE}.new`,
    `mv ~/${REMOTE}.new ~/${REMOTE}`,
    `echo "saved ~/${REMOTE} ($(stat -c %a ~/${REMOTE}))"`,
  ].join(" && ");
  const r = spawnSync("ssh", ["-o", "BatchMode=yes", host, remote], { input: fs.readFileSync(file), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`copy to ${host} failed (${r.status}): ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * The steps, with the login and the upload passed in so a test can run them
 * without a browser or a server. Returns what upload returned.
 */
export function secondLogin({
  runLogin, upload, pcTokenFile = PC_TOKEN_FILE, tmpRoot = os.tmpdir(), warn = console.warn,
}) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "kitchen-ah-login-"));
  try {
    if (path.resolve(dir) === path.resolve(path.dirname(pcTokenFile))) throw new Error("the temporary folder is the PC's AH folder");
    const before = stamp(pcTokenFile);
    const status = runLogin({ ...process.env, AH_DATA_DIR: dir });
    if (status !== 0) throw new Error(`the AH login did not finish (exit ${status}); nothing was copied`);
    const file = path.join(dir, "tokens.json");
    let ok = false;
    try {
      const t = JSON.parse(fs.readFileSync(file, "utf8"));
      ok = typeof t.accessToken === "string" && typeof t.refreshToken === "string";
    } catch {
      ok = false;
    }
    if (!ok) throw new Error("the login wrote no tokens; nothing was copied");
    if (stamp(pcTokenFile) !== before) {
      // The PC's running MCP may refresh its own session meanwhile; this tool never writes that file.
      warn(`Note: ${pcTokenFile} changed during the login. This tool does not write it; the MCP running on this PC may have refreshed its own session.`);
    }
    return upload(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = arg("host", "user@home-server.local");
  const loginScript = path.join(AH_MCP, "dist", "login.js");
  try {
    if (!fs.existsSync(loginScript)) throw new Error(`no ${loginScript}: run "npm run build" in the AH MCP's folder`);
    console.log(`A second AH session for the home server (${host}). The PC's own session is left alone.\n`);
    const out = secondLogin({
      runLogin: (env) => spawnSync(process.execPath, [loginScript], { env, stdio: "inherit" }).status,
      upload: (file) => sshUpload(host, file),
    });
    console.log(`\n${out}`);
    console.log("Done. Ignore the MCP's line about restarting Claude: the PC's session did not change.");
  } catch (e) {
    console.error(`\nFAILED: ${e.message}`);
    process.exitCode = 1;
  }
}
