// The Lidl Plus login for the home server's receipt and coupon import. Run on
// the PC, with Thomas at the keyboard (never on the server, never by Claude):
//
//   node fetcher/lidl-login.mjs [--host user@home-server.local]
//
// Edge (or Chrome) opens Lidl's own login page (accounts.lidl.com, the Lidl
// Plus app's OAuth client, PKCE) in a fresh temporary profile with the
// DevTools protocol on. Thomas types his phone number and password there, and
// the code Lidl sends him by SMS (Lidl asks for it on a new device); this
// tool never sees any of them. Lidl then sends the browser to
// com.lidlplus.app://callback?code=..., an address only the app can open:
// the DevTools protocol catches it (or Thomas pastes it from F12 > Network).
// The one-time code and this run's PKCE verifier are exchanged for tokens,
// written to a temporary file (mode 600), copied over SSH to
// ~/kitchen-fetcher/lidl-tokens.json (chmod 600) and the temporary folder is
// deleted. A visible browser on purpose: Lidl's login has reCAPTCHA
// Enterprise, which refuses headless browsers.
//
// No token, code or password is printed or logged. When the server's session
// dies (the log says "Lidl refresh refused" or "no Lidl session"), run this
// again; nothing else changes.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { AUTH_BASE, CLIENT_ID, REDIRECT_URI, SCOPES, COUNTRY, LANGUAGE, basicAuth, tokensFrom } from "./lidl_client.mjs";

const REMOTE = "kitchen-fetcher/lidl-tokens.json";
const TIMEOUT_MS = 10 * 60 * 1000;
const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** PKCE: a random verifier and its S256 challenge. */
export function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Lidl's authorize address for the Lidl Plus app's client, in Dutch for NL. */
export function authUrl(challenge) {
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    Country: COUNTRY,
    language: `${LANGUAGE}-${COUNTRY}`,
  });
  return `${AUTH_BASE}/connect/authorize?${q}`;
}

/** The code from a com.lidlplus.app://callback address (also as JSON-escaped text), or undefined. */
export function extractCode(text) {
  const s = String(text ?? "").replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  const m = /com\.lidlplus\.app:\/\/callback\/?\?([^"\s\\]*)/.exec(s);
  return m ? new URLSearchParams(m[1]).get("code") ?? undefined : undefined;
}

/** The one-time code and the verifier -> tokens. Throws without the answer's body (it can hold a token). */
export async function exchangeCode(code, verifier, { fetch = globalThis.fetch, now = Date.now } = {}) {
  const res = await fetch(`${AUTH_BASE}/connect/token`, {
    method: "POST",
    headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token || !body.refresh_token) throw new Error(`Lidl refused the code: HTTP ${res.status}`);
  return tokensFrom(body, {}, now());
}

/**
 * The steps after the browser, with the code, the exchange and the upload
 * passed in so a test runs them without a browser, Lidl or a server: the
 * tokens go to a new temporary folder (mode 600), then to `upload`, and the
 * folder is always deleted. Returns what upload returned.
 */
export async function finishLogin({ code, verifier, exchange = exchangeCode, upload, tmpRoot = os.tmpdir() }) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "kitchen-lidl-login-"));
  try {
    const tokens = await exchange(code, verifier);
    if (typeof tokens?.refreshToken !== "string" || !tokens.refreshToken) throw new Error("the login gave no refresh token; nothing was copied");
    const file = path.join(dir, "lidl-tokens.json");
    fs.writeFileSync(file, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return await upload(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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

/** Opens the browser on `url` and resolves with the code from the callback redirect. */
async function captureViaBrowser(browserPath, url, signal) {
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "kitchen-lidl-browser-"));
  const browser = spawn(browserPath, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-sync", "--disable-features=msImplicitSignin,msEdgeSyncConsentDialog", "--new-window", url,
  ], { stdio: "ignore" });
  let socket;
  const cleanup = async () => {
    try { socket?.send(JSON.stringify({ id: 999_999, method: "Browser.close" })); } catch { /* closed already */ }
    await sleep(1000);
    if (browser.exitCode === null) browser.kill();
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); return; } catch { await sleep(1000); }
    }
  };
  const code = new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("stopped")));
    browser.once("exit", () => reject(new Error("the browser window was closed before the login finished")));
    (async () => {
      let ws;
      for (let i = 0; i < 60 && !ws; i++) {
        try { ws = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(250); }
      }
      if (!ws) throw new Error("no DevTools connection to the browser");
      socket = new WebSocket(ws);
      let next = 1;
      const send = (method, params = {}, sessionId) => socket.send(JSON.stringify({ id: next++, method, params, ...(sessionId ? { sessionId } : {}) }));
      const attached = new Set();
      const attach = (t) => {
        if (t.type !== "page" || attached.has(t.targetId)) return;
        attached.add(t.targetId);
        send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      };
      socket.addEventListener("open", () => { send("Target.setDiscoverTargets", { discover: true }); send("Target.getTargets"); });
      socket.addEventListener("message", (event) => {
        const raw = String(event.data);
        // The redirect shows in a Location header, a navigation or a failed request: look in every message.
        if (raw.includes("com.lidlplus.app")) {
          const found = extractCode(raw);
          if (found) { resolve(found); return; }
        }
        const msg = JSON.parse(raw);
        if (msg.method === "Target.targetCreated") attach(msg.params.targetInfo);
        else if (msg.method === "Target.attachedToTarget") { send("Network.enable", {}, msg.params.sessionId); send("Page.enable", {}, msg.params.sessionId); }
        else if (msg.result?.targetInfos) msg.result.targetInfos.forEach(attach);
      });
    })().catch(reject);
  });
  return { code, cleanup };
}

/** The fallback: Thomas pastes the com.lidlplus.app://callback?code=... address. */
function askForCode(signal) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    signal.addEventListener("abort", () => { rl.close(); reject(new Error("stopped")); });
    const ask = () => rl.question("", (answer) => {
      const code = extractCode(answer);
      if (code) { rl.close(); resolve(code); } else ask();
    });
    ask();
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--host");
  const host = i > 0 ? process.argv[i + 1] : "user@home-server.local";
  const { verifier, challenge } = pkce();
  const url = authUrl(challenge);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
  const browserPath = process.env.LIDL_BROWSER?.trim() || BROWSERS.find((b) => fs.existsSync(b));
  let cleanup;
  try {
    const sources = [askForCode(controller.signal)];
    console.log(`A Lidl Plus session for the home server (${host}).\n`);
    if (browserPath) {
      const capture = await captureViaBrowser(browserPath, url, controller.signal);
      cleanup = capture.cleanup;
      sources.push(capture.code);
      console.log("A browser window opens with Lidl's login. Log in there with your Lidl Plus phone number and");
      console.log("password, and type the SMS code Lidl sends you. The window closes by itself when it worked.\n");
      console.log("Nothing happens after the login? Open F12 > Network in that window, log in again, find the line");
      console.log("with 'com.lidlplus.app://callback?code=...', paste that address here and press Enter:\n");
    } else {
      console.log("No Edge or Chrome found. Open this address, log in, then paste the");
      console.log("com.lidlplus.app://callback?code=... address from F12 > Network here:\n");
      console.log(`  ${url}\n`);
    }
    const code = await Promise.any(sources);
    controller.abort();
    const out = await finishLogin({ code, verifier, upload: (file) => sshUpload(host, file) });
    console.log(`\n${out}\nDone. The server refreshes this session itself from now on.`);
  } catch (e) {
    const reason = timedOut
      ? "no login within 10 minutes"
      : e instanceof AggregateError ? e.errors.map((x) => x.message).join("; ") : e.message;
    console.error(`\nFAILED: ${reason}`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    await cleanup?.();
    process.stdin.destroy();
  }
}
