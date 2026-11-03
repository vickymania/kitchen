// The PC side of a cookie-session login (fetcher/action-login.mjs,
// fetcher/kruidvat-login.mjs), never deployed: a visible Edge (or Chrome)
// window in a fresh temporary profile with the DevTools protocol on, where
// Thomas types his own credentials on the shop's own login page. This module
// only watches responses (never request bodies: Network.enable with
// maxPostDataSize 0, so a typed password never even crosses the socket),
// reads the session the shop set once the login succeeded, writes it to a
// temporary file (mode 600), copies that over SSH to the home server (chmod
// 600, renamed over the old one) and deletes the temporary folder. Nothing is
// printed but counts.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const findBrowser = (override) => override?.trim() || BROWSERS.find((b) => fs.existsSync(b));

/**
 * The steps after the browser, testable without one: the session goes to a
 * new temporary folder (mode 600), `check(file)` may try it (and rewrite
 * rotated cookies into it), then `upload(file)`; the folder is always
 * deleted. Returns { checked, uploaded }.
 */
export async function finishSessionLogin({ session, check = null, upload, tmpRoot = os.tmpdir(), name = "session.json" }) {
  if (!Array.isArray(session?.cookies) || !session.cookies.length) throw new Error("the login gave no cookies; nothing was copied");
  const dir = fs.mkdtempSync(path.join(tmpRoot, "kitchen-login-"));
  try {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(session, null, 2), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    const checked = check ? await check(file) : null;
    return { checked, uploaded: await upload(file) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Copies `file` to ~/<remote> on `host`: written beside, chmod 600, renamed over the old one. */
export function sshUpload(host, file, remote) {
  const cmd = [
    "umask 077",
    "mkdir -p ~/kitchen-fetcher",
    `cat > ~/${remote}.new`,
    `chmod 600 ~/${remote}.new`,
    `mv ~/${remote}.new ~/${remote}`,
    `echo "saved ~/${remote} ($(stat -c %a ~/${remote}))"`,
  ].join(" && ");
  const r = spawnSync("ssh", ["-o", "BatchMode=yes", host, cmd], { input: fs.readFileSync(file), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`copy to ${host} failed (${r.status}): ${r.stderr}`);
  return r.stdout.trim();
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Opens the browser on `url` and returns { done, call, evaluate, userAgent, cleanup }.
 * `done` resolves when `isLoggedIn(response)` is true for a response seen
 * in any tab (response: { url, status }). `call(method, params)` sends a
 * browser-level DevTools command; `evaluate(expression)` runs it in the
 * page that saw the login (or the newest tab) and returns its value.
 */
export async function openLoginBrowser(browserPath, url, { isLoggedIn, signal }) {
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-login-browser-"));
  const browser = spawn(browserPath, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-sync", "--disable-features=msImplicitSignin,msEdgeSyncConsentDialog", "--new-window", url,
  ], { stdio: "ignore" });
  let socket;
  let version = {};
  const pending = new Map();
  let next = 1;
  let loginSession = null;
  const pageSessions = [];
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const cleanup = async () => {
    try { socket?.send(JSON.stringify({ id: 999_999, method: "Browser.close" })); } catch { /* closed already */ }
    await sleep(1000);
    if (browser.exitCode === null) browser.kill();
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); return; } catch { await sleep(1000); }
    }
  };
  const done = new Promise((resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("stopped")));
    browser.once("exit", () => reject(new Error("the browser window was closed before the login finished")));
    (async () => {
      let ws;
      for (let i = 0; i < 60 && !ws; i++) {
        try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); ws = version.webSocketDebuggerUrl; } catch { await sleep(250); }
      }
      if (!ws) throw new Error("no DevTools connection to the browser");
      socket = new WebSocket(ws);
      const attached = new Set();
      const attach = (t) => {
        if (t.type !== "page" || attached.has(t.targetId)) return;
        attached.add(t.targetId);
        send("Target.attachToTarget", { targetId: t.targetId, flatten: true }).catch(() => {});
      };
      socket.addEventListener("open", () => {
        send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
        send("Target.getTargets").then((r) => r.targetInfos.forEach(attach)).catch(() => {});
      });
      socket.addEventListener("message", (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
          return;
        }
        if (msg.method === "Target.targetCreated") attach(msg.params.targetInfo);
        else if (msg.method === "Target.attachedToTarget") {
          pageSessions.push(msg.params.sessionId);
          // No request bodies at all: the password Thomas types never reaches this script.
          send("Network.enable", { maxPostDataSize: 0 }, msg.params.sessionId).catch(() => {});
        } else if (msg.method === "Network.responseReceived") {
          const r = msg.params.response;
          if (isLoggedIn({ url: r.url, status: r.status })) {
            loginSession = msg.sessionId;
            resolve();
          }
        }
      });
    })().catch(reject);
  });
  const evaluate = async (expression) => {
    // The page that saw the login, else (Thomas pressed Enter) the newest tab.
    const session = loginSession ?? pageSessions.at(-1);
    if (!session) throw new Error("no page to read");
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);
    return r?.result?.value;
  };
  return { done, call: (m, p) => send(m, p), evaluate, userAgent: () => version["User-Agent"] ?? "", cleanup };
}

/** Resolves when Thomas presses Enter (the fallback when the login is not seen by itself). */
export function waitForEnter(signal) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    signal?.addEventListener("abort", () => { rl.close(); reject(new Error("stopped")); });
    rl.question("", () => { rl.close(); resolve(); });
  });
}

/**
 * What a captured session holds, by name only (for --dry): the cookie names
 * and the token's field names, never a value.
 */
export function describeSession(session) {
  const cookies = (session?.cookies ?? []).map((c) => c.name).sort();
  const lines = [`cookies (${cookies.length}): ${cookies.join(", ") || "none"}`];
  if (session?.token && typeof session.token === "object") {
    const fields = Object.entries(session.token).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k]) => k).sort();
    lines.push(`token fields: ${fields.join(", ") || "none"}`);
  } else lines.push("token: none");
  if (session && "oauth" in session) lines.push(`OAuth client for refresh: ${session.oauth?.clientId ? "found" : "not found"}`);
  lines.push(`user agent: ${session?.userAgent ? "saved" : "none"}`);
  return lines.join("\n");
}
