// The Action login for the home server's receipt import. Run on the PC, with
// Thomas at the keyboard (never on the server, never by Claude):
//
//   node fetcher/action-login.mjs [--host user@home-server.local] [--no-check] [--dry]
//
// --dry: only says whether a session was captured and what it holds, by name
// (cookie names, never a value); nothing is tried, written or copied.
//
// Edge (or Chrome) opens www.action.com/nl-nl/inloggen/ in a fresh temporary
// profile with the DevTools protocol on (fetcher/browser_login.mjs). Thomas
// types his own email and password there; this script never sees them (no
// request bodies are read). When the site's own POST /api/auth/login answers
// 2xx (or Thomas presses Enter here once he sees his account), the
// browser's www.action.com cookies and its user agent (Cloudflare ties its
// cookie to it) are written to a temporary file (mode 600), tried once with
// one ReceiptList call (unless --no-check; rotated cookies are kept), copied
// over SSH to ~/kitchen-fetcher/action-session.json (chmod 600), and the
// temporary folder is deleted. Nothing but counts is printed.
//
// When the server's session dies (the log says "Action session gone" or
// "no session in .../action-session.json"), run this again; nothing else changes.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeSession, finishSessionLogin, findBrowser, openLoginBrowser, sshUpload, waitForEnter } from "./browser_login.mjs";
import { siteCookies } from "./cookie_session.mjs";
import { ActionAuthError, BASE, LOGIN_PAGE, createActionClient } from "./action_client.mjs";

export const REMOTE = "kitchen-fetcher/action-session.json";
const TIMEOUT_MS = 10 * 60 * 1000;

/** The response that says the login worked: the site's own auth route, 2xx. */
export function isActionLogin({ url, status }) {
  return status >= 200 && status < 300 && /^https:\/\/www\.action\.com\/api\/auth\/(login|oidc\/(callback|login|token))\b/.test(String(url));
}

/** The session file's content from the browser's cookies. */
export function actionSession(cookies, userAgent, now = Date.now()) {
  return { cookies: siteCookies(cookies, "action.com"), userAgent: String(userAgent ?? ""), savedAt: new Date(now).toISOString() };
}

/** One ReceiptList page on the temporary file: says how many receipts the session sees. */
export async function checkActionSession(file, { fetch = globalThis.fetch, pause = 0 } = {}) {
  const client = createActionClient({ sessionFile: file, fetch, pause });
  const list = await client.listReceipts({ maxPages: 1 });
  return `the session works: ${list.length} receipt${list.length === 1 ? "" : "s"} on the first page`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--host");
  const host = i > 0 ? process.argv[i + 1] : "user@home-server.local";
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
  const browserPath = findBrowser(process.env.ACTION_BROWSER);
  let win;
  try {
    if (!browserPath) throw new Error("no Edge or Chrome found (set ACTION_BROWSER to its path)");
    console.log(`An Action session for the home server (${host}).\n`);
    win = await openLoginBrowser(browserPath, LOGIN_PAGE, { isLoggedIn: isActionLogin, signal: controller.signal });
    console.log("A browser window opens with Action's login. Log in there with your own email and password.");
    console.log("It goes on by itself when the login worked. Nothing happens after you see your account?");
    console.log("Press Enter here.\n");
    await Promise.any([win.done, waitForEnter(controller.signal)]);
    // A moment for the cookies the pages after the login set.
    await new Promise((r) => setTimeout(r, 3000));
    const { cookies } = await win.call("Storage.getCookies", {});
    const session = actionSession(cookies, win.userAgent());
    console.log(`${session.cookies.length} cookies for ${new URL(BASE).hostname} read (values not shown).`);
    if (process.argv.includes("--dry")) {
      console.log(`\n--dry: nothing tried, written or copied.\n${describeSession(session)}`);
      process.exitCode = session.cookies.length ? 0 : 1;
    } else {
      const out = await finishSessionLogin({
        session,
        name: "action-session.json",
        check: process.argv.includes("--no-check") ? null : async (file) => {
          try {
            return await checkActionSession(file);
          } catch (e) {
            // A dead session is never copied; anything else (Cloudflare, a changed query) is said and copied anyway.
            if (e instanceof ActionAuthError) throw new Error(`the new session is refused already: ${e.message}`);
            return `could not try the session (${e.message}); copied anyway`;
          }
        },
        upload: (file) => sshUpload(host, file, REMOTE),
      });
      if (out.checked) console.log(out.checked);
      console.log(`\n${out.uploaded}\nDone. The server refreshes this session itself from now on.`);
    }
  } catch (e) {
    const reason = timedOut
      ? "no login within 10 minutes"
      : e instanceof AggregateError ? e.errors.map((x) => x.message).join("; ") : e.message;
    console.error(`\nFAILED: ${reason}`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    controller.abort();
    await win?.cleanup();
    process.stdin.destroy();
  }
}

