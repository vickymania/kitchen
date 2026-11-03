// A site session kept as cookies in a file on the home server, for the
// receipt imports whose shop has no app token (Action, Kruidvat). The file is
// made on the PC by a login script (fetcher/action-login.mjs,
// fetcher/kruidvat-login.mjs: Thomas types his own credentials in a visible
// browser window) and rewritten here whenever the site rotates a cookie.
//
// File shape: { cookies: [{ name, value, domain, path, expires, secure, httpOnly }],
//               userAgent, savedAt, ...site-specific fields }
// `expires` is in seconds since 1970 (as the DevTools protocol gives it);
// -1 or missing is a session cookie, kept until the site replaces it.
//
// Nothing here prints or logs a cookie value.
import fs from "node:fs";
import path from "node:path";

/** Reads the session file; throws `ErrorClass` with `how` (the command to run) when it is missing or empty. */
export function readSessionFile(file, { ErrorClass = Error, how } = {}) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(s?.cookies) && s.cookies.length) return s;
  } catch {
    // handled below
  }
  throw new ErrorClass(`no session in ${file}: run "${how}" on the PC (Thomas logs in)`);
}

/** Written beside the old file and renamed over it, mode 600: a crash never leaves half a file. */
export function writeSessionFile(file, session) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** The cookies from the DevTools protocol (Storage.getCookies) that belong to `site` ("action.com"). */
export function siteCookies(cookies, site) {
  return (Array.isArray(cookies) ? cookies : [])
    .filter((c) => c && typeof c.name === "string" && typeof c.value === "string" && domainMatches(site, c.domain))
    .map((c) => ({
      name: c.name, value: c.value, domain: String(c.domain), path: c.path || "/",
      expires: Number.isFinite(c.expires) ? c.expires : -1, secure: Boolean(c.secure), httpOnly: Boolean(c.httpOnly),
    }));
}

/** Does a cookie for `domain` (".action.com", "www.action.com") go to `host`? */
export function domainMatches(host, domain) {
  const h = String(host ?? "").toLowerCase();
  const d = String(domain ?? "").toLowerCase().replace(/^\./, "");
  return Boolean(d) && (h === d || h.endsWith(`.${d}`) || d.endsWith(`.${h}`) || d === h);
}

const live = (c, nowSec) => !(c.expires > 0 && c.expires <= nowSec);

/** The Cookie header for `url`: every live cookie whose domain and path fit. */
export function cookieHeader(cookies, url, now = Date.now()) {
  const u = new URL(url);
  const nowSec = now / 1000;
  return cookies
    .filter((c) => live(c, nowSec) && hostMatches(u.hostname, c.domain) && u.pathname.startsWith(c.path || "/") && (!c.secure || u.protocol === "https:"))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/** A cookie set for `domain` is sent to `host` when host is that domain or under it. */
function hostMatches(host, domain) {
  const d = String(domain ?? "").toLowerCase().replace(/^\./, "");
  const h = host.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/** One Set-Cookie header -> { name, value, domain, path, expires, secure, httpOnly } (expires in seconds; 0 = delete). */
export function parseSetCookie(header, url, now = Date.now()) {
  const [pair, ...attrs] = String(header).split(";");
  const at = pair.indexOf("=");
  if (at <= 0) return null;
  const c = { name: pair.slice(0, at).trim(), value: pair.slice(at + 1).trim(), domain: new URL(url).hostname, path: "/", expires: -1, secure: false, httpOnly: false };
  let maxAge = null;
  for (const a of attrs) {
    const [k, ...v] = a.split("=");
    const key = k.trim().toLowerCase();
    const val = v.join("=").trim();
    if (key === "domain" && val) c.domain = val.startsWith(".") ? val : `.${val}`;
    else if (key === "path" && val) c.path = val;
    else if (key === "expires" && val) { const t = Date.parse(val); if (Number.isFinite(t)) c.expires = t / 1000; }
    else if (key === "max-age" && val) maxAge = Number(val);
    else if (key === "secure") c.secure = true;
    else if (key === "httponly") c.httpOnly = true;
  }
  if (Number.isFinite(maxAge)) c.expires = maxAge <= 0 ? 0 : now / 1000 + maxAge;
  return c;
}

/**
 * The jar after a response's Set-Cookie headers: a cookie of the same name,
 * domain (without the leading dot) and path is replaced, an expired one
 * removed. Returns { cookies, changed }.
 */
export function applySetCookies(cookies, setCookies, url, now = Date.now()) {
  let changed = false;
  let jar = [...cookies];
  const same = (a, b) => a.name === b.name && a.domain.replace(/^\./, "") === b.domain.replace(/^\./, "") && (a.path || "/") === (b.path || "/");
  for (const header of setCookies ?? []) {
    const c = parseSetCookie(header, url, now);
    if (!c) continue;
    const old = jar.find((x) => same(x, c));
    if (c.expires === 0 || (c.expires > 0 && c.expires <= now / 1000)) {
      if (old) { jar = jar.filter((x) => x !== old); changed = true; }
      continue;
    }
    if (old && old.value === c.value && old.expires === c.expires) continue;
    jar = [...jar.filter((x) => x !== old), old ? { ...old, ...c, domain: old.domain } : c];
    changed = true;
  }
  return { cookies: jar, changed };
}

/** Set-Cookie headers of a fetch Response (Node 20+ has getSetCookie). */
export const setCookiesOf = (res) => (typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []);
