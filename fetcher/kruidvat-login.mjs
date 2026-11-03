// The Kruidvat login for the home server's store-purchase import. Run on the
// PC, with Thomas at the keyboard (never on the server, never by Claude):
//
//   node fetcher/kruidvat-login.mjs [--host user@home-server.local] [--no-check] [--dry]
//
// Edge (or Chrome) opens www.kruidvat.nl/login in a fresh temporary profile
// with the DevTools protocol on (fetcher/browser_login.mjs). Thomas types his
// own email and password there; this script never sees them (no request
// bodies are read). When Thomas presses Enter here once he sees his account
// (Spartacus also fetches tokens before a login, so a token call alone does
// not say he is in; its address is kept for the refresh), it reads through DevTools,
// not page script (the session cookies are httpOnly):
//   - every kruidvat.nl cookie (Storage.getCookies),
//   - Spartacus' token from localStorage "spartacus⚿⚿auth" (access token,
//     refresh token, expiry), when the site keeps one,
//   - the site's public OAuth client id (and secret, if it has one) from its
//     own JavaScript, so the server can refresh the token,
//   - the browser's user agent.
// That goes to a temporary file (mode 600), is tried once with the store
// purchases call (unless --no-check), copied over SSH to
// ~/kitchen-fetcher/kruidvat-session.json (chmod 600), and the temporary
// folder is deleted. Nothing but counts and names is printed.
//
// --dry: only says whether a session was captured and what it holds, by name
// (cookie names and token field names, never a value); nothing is tried,
// written or copied.
//
// !! Akamai answered 403 to anonymous fetches from outside a browser
// (03-11-2026). The check here says at once whether a plain request with this
// session gets through; the home server may still be refused.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeSession, finishSessionLogin, findBrowser, openLoginBrowser, sshUpload, waitForEnter } from "./browser_login.mjs";
import { siteCookies } from "./cookie_session.mjs";

export const REMOTE = "kitchen-fetcher/kruidvat-session.json";
export const LOGIN_PAGE = "https://www.kruidvat.nl/login";
export const AUTH_KEY = "spartacus⚿⚿auth";
const TIMEOUT_MS = 10 * 60 * 1000;

/** Spartacus' OAuth token call, 2xx (its address is kept for the server's refresh). */
export function isKruidvatLogin({ url, status }) {
  return status >= 200 && status < 300 && /^https:\/\/[a-z.]*kruidvat\.nl\/authorizationserver\/oauth\/token\b/.test(String(url));
}

/** Spartacus' stored auth (the localStorage value, a JSON string) -> { accessToken, refreshToken, expiresAt, tokenType } or null. */
export function tokenFrom(raw, now = Date.now()) {
  let auth;
  try { auth = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
  const t = auth?.token ?? auth;
  if (!t || typeof t.access_token !== "string" || !t.access_token) return null;
  const expiresAt = Number.isFinite(Number(t.expires_at)) && Number(t.expires_at) > 0
    ? Number(t.expires_at)
    : Number.isFinite(Number(t.expires_in)) ? (Number(t.access_token_stored_at) || now) + Number(t.expires_in) * 1000 : null;
  return { accessToken: t.access_token, refreshToken: typeof t.refresh_token === "string" ? t.refresh_token : null, expiresAt, tokenType: t.token_type ?? "bearer" };
}

/** Run in the page: the public OAuth client of the site's own scripts, or null. Never Thomas's data. */
export const FIND_CLIENT = `(async () => {
  const srcs = [...document.scripts].map((s) => s.src).filter((s) => s && new URL(s).hostname.endsWith("kruidvat.nl"));
  for (const src of srcs) {
    try {
      const t = await (await fetch(src)).text();
      const id = /client_id\\s*:\\s*["']([^"']+)["']/.exec(t);
      if (!id) continue;
      const secret = /client_secret\\s*:\\s*["']([^"']*)["']/.exec(t);
      return { clientId: id[1], clientSecret: secret ? secret[1] : "" };
    } catch {}
  }
  return null;
})()`;

/** The session file's content. */
export function kruidvatSession({ cookies, authRaw, oauth, userAgent, tokenUrl, now = Date.now() }) {
  return {
    cookies: siteCookies(cookies, "kruidvat.nl"),
    token: tokenFrom(authRaw, now),
    oauth: oauth?.clientId ? { clientId: String(oauth.clientId), clientSecret: String(oauth.clientSecret ?? ""), tokenUrl: tokenUrl ?? null } : null,
    userAgent: String(userAgent ?? ""),
    savedAt: new Date(now).toISOString(),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--host");
  const host = i > 0 ? process.argv[i + 1] : "user@home-server.local";
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
  const browserPath = findBrowser(process.env.KRUIDVAT_BROWSER);
  let win;
  let tokenUrl = null;
  try {
    if (!browserPath) throw new Error("no Edge or Chrome found (set KRUIDVAT_BROWSER to its path)");
    console.log(`A Kruidvat session for the home server (${host}).\n`);
    win = await openLoginBrowser(browserPath, LOGIN_PAGE, {
      isLoggedIn: (r) => {
        const yes = isKruidvatLogin(r);
        if (yes) tokenUrl = String(r.url).split("?")[0];
        return yes;
      },
      signal: controller.signal,
    });
    console.log("A browser window opens with Kruidvat's login. Log in there with your own email and password.");
    console.log("When you see your account (Mijn account), press Enter here.\n");
    // Only Enter goes on: Spartacus also asks tokens before anyone logs in. A closed window still stops it.
    await Promise.race([waitForEnter(controller.signal), win.done.then(() => new Promise(() => {}))]);
    const { cookies } = await win.call("Storage.getCookies", {});
    const authRaw = await win.evaluate(`localStorage.getItem(${JSON.stringify(AUTH_KEY)})`).catch(() => null);
    const oauth = await win.evaluate(FIND_CLIENT).catch(() => null);
    const session = kruidvatSession({ cookies, authRaw, oauth, userAgent: win.userAgent(), tokenUrl });
    console.log(`${session.cookies.length} cookies for kruidvat.nl read, token ${session.token ? "found" : "not found"} (values not shown).`);
    if (process.argv.includes("--dry")) {
      console.log(`\n--dry: nothing tried, written or copied.\n${describeSession(session)}`);
      process.exitCode = session.cookies.length || session.token ? 0 : 1;
    } else {
      // The client (fetcher/kruidvat_client.mjs) is loaded only here, so --dry works without it.
      const { checkKruidvatSession, KruidvatAuthError } = await import("./kruidvat_client.mjs").catch(() => ({}));
      const out = await finishSessionLogin({
        session,
        name: "kruidvat-session.json",
        check: process.argv.includes("--no-check") || !checkKruidvatSession ? null : async (file) => {
          try {
            return await checkKruidvatSession(file);
          } catch (e) {
            // A dead session is never copied; anything else (Akamai, a changed answer) is said and copied anyway.
            if (KruidvatAuthError && e instanceof KruidvatAuthError) throw new Error(`the new session is refused already: ${e.message}`);
            return `could not try the session (${e.message}); copied anyway`;
          }
        },
        upload: (file) => sshUpload(host, file, REMOTE),
      });
      if (out.checked) console.log(out.checked);
      console.log(`\n${out.uploaded}\nDone.`);
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
