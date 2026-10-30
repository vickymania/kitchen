// Lidl Plus with Thomas's own session, for the receipt and coupon import on
// the home server (fetcher/lidl_import.mjs). Lidl has no public API: the
// calls are the Lidl Plus app's, as read (not run) from the open-source
// clients on 28-10-2026: RoryDotGG/iLidl 0.2.0 (ilidl/client.py, auth.py;
// the maintained one) and Andre0512/lidl-plus (lidlplus/api.py, older).
//
//   token     POST https://accounts.lidl.com/connect/token  (Basic LidlPlusNativeClient:secret,
//             grant_type=refresh_token; the answer may carry a new refresh token)
//   receipts  GET  https://tickets.lidlplus.com/api/v2/NL/tickets?pageNumber=N&onlyFavorite=false
//   receipt   GET  https://tickets.lidlplus.com/api/v3/NL/tickets/<id>   (store + HTML receipt)
//   coupons   GET  https://coupons.lidlplus.com/app/api/v2/promotionsList (header Country: NL)
//
// Coupons are only read. Activating one is Thomas's tap in the Lidl Plus app:
// this client has no activation call on purpose.
//
// The tokens live in their own file (LIDL_TOKEN_FILE, on the server
// ~/kitchen-fetcher/lidl-tokens.json, mode 600), made by fetcher/lidl-login.mjs
// and rewritten after every refresh. No token is ever printed or logged.
import fs from "node:fs";
import path from "node:path";

export const AUTH_BASE = "https://accounts.lidl.com";
export const TICKETS_BASE = "https://tickets.lidlplus.com/api";
export const COUPONS_BASE = "https://coupons.lidlplus.com/app/api";
export const CLIENT_ID = "LidlPlusNativeClient";
export const REDIRECT_URI = "com.lidlplus.app://callback";
export const SCOPES = "openid profile offline_access lpprofile lpapis";
export const COUNTRY = "NL";
export const LANGUAGE = "nl";
/** The API refuses made-up app versions (iLidl's README); a real one, overridable. */
const APP_VERSION = process.env.LIDL_APP_VERSION?.trim() || "16.45.5";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MAX_RETRIES = 3;
/** Polite: one request at a time with a pause between, like the AH and folder fetchers. */
const PAUSE_MS = 1000;
/** At most this many receipt list pages per run (Lidl answers 25 or so a page). */
const MAX_PAGES = 40;

export class LidlAuthError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const basicAuth = () => `Basic ${Buffer.from(`${CLIENT_ID}:secret`).toString("base64")}`;

export function readTokenFile(file) {
  try {
    const t = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof t?.refreshToken === "string" && t.refreshToken) return t;
  } catch {
    // handled below
  }
  throw new LidlAuthError(`no Lidl session in ${file}: run "node fetcher/lidl-login.mjs" on the PC (Thomas logs in)`);
}

/** Written beside the old file and renamed over it, mode 600: a crash never leaves half a file. */
export function writeTokenFile(file, tokens) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** The token answer as the file keeps it. */
export function tokensFrom(body, previous = {}, now = Date.now()) {
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? previous.refreshToken,
    expiresAt: now + Number(body.expires_in ?? 0) * 1000,
    savedAt: new Date(now).toISOString(),
  };
}

/**
 * { listReceipts, getReceipt, listCoupons } on the session in `tokenFile`.
 * `fetch`, `now` and `pause` are for the tests.
 */
export function createLidlClient({ tokenFile, fetch = globalThis.fetch, now = Date.now, pause = PAUSE_MS } = {}) {
  if (!tokenFile) throw new Error("createLidlClient needs a tokenFile");
  let refreshing = null;
  let calls = 0;

  async function refresh(current) {
    refreshing ??= (async () => {
      try {
        const res = await fetch(`${AUTH_BASE}/connect/token`, {
          method: "POST",
          headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken }).toString(),
        });
        const body = await res.json().catch(() => ({}));
        // Never the body in the message: it can hold a token.
        if (!res.ok || !body.access_token) throw new LidlAuthError(`Lidl refresh refused: HTTP ${res.status}`);
        const tokens = tokensFrom(body, current, now());
        writeTokenFile(tokenFile, tokens);
        return tokens;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function accessToken(force) {
    const tokens = readTokenFile(tokenFile);
    if (force || !tokens.accessToken || now() > (tokens.expiresAt ?? 0) - REFRESH_MARGIN_MS) return (await refresh(tokens)).accessToken;
    return tokens.accessToken;
  }

  async function get(url, extra = {}) {
    if (calls++ && pause) await sleep(pause);
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await accessToken(false);
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "App-Version": APP_VERSION,
          "Operating-System": "iOs",
          App: "com.lidl.eci.lidl.plus",
          "Accept-Language": LANGUAGE,
          Accept: "application/json",
          ...extra,
        },
      });
      if (res.ok) return res.json();
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await accessToken(true);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`Lidl ${res.status} on ${new URL(url).pathname}`);
    }
  }

  return {
    /**
     * Receipt summaries [{ id, date, total }], newest first. Stops at the
     * first page whose receipts `known` all has: the daily run needs only
     * what is new since the last one.
     */
    async listReceipts({ known = new Set() } = {}) {
      const out = [];
      let pages = 1;
      for (let page = 1; page <= Math.min(pages, MAX_PAGES); page++) {
        const data = await get(`${TICKETS_BASE}/v2/${COUNTRY}/tickets?pageNumber=${page}&onlyFavorite=false`);
        const tickets = Array.isArray(data?.tickets) ? data.tickets : [];
        if (page === 1 && data?.size > 0) pages = Math.ceil((data.totalCount ?? 0) / data.size);
        for (const t of tickets) if (t?.id) out.push({ id: String(t.id), date: t.date ?? null, total: t.totalAmount ?? null });
        if (!tickets.length || tickets.every((t) => known.has(String(t.id)))) break;
      }
      return out;
    },
    /** One receipt in full: { id, date, totalAmount, store: { locality, ... }, htmlPrintedReceipt | itemsLine }. */
    async getReceipt(id) {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(id))) throw new Error("bad Lidl receipt id");
      return get(`${TICKETS_BASE}/v3/${COUNTRY}/tickets/${encodeURIComponent(id)}`);
    },
    /** Thomas's current coupons, raw (fetcher/lidl_import.mjs normalises them). Read only. */
    async listCoupons() {
      return get(`${COUPONS_BASE}/v2/promotionsList`, { Country: COUNTRY });
    },
  };
}
