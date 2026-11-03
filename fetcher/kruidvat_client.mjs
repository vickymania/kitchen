// Kruidvat with Thomas's own session, for the store-purchase import on the
// home server (fetcher/kruidvat_import.mjs). The call is the one the site's
// own "Mijn bestellingen > In de winkel" tab makes (SAP Commerce / Spartacus
// OCC), seen on 03-11-2026 in Thomas's signed-in browser:
//
//   GET https://api.kruidvat.nl/api/v2/kvn-spa/users/current/orders/offline?lang=nl&curr=EUR
//       -> { orders: [{ code, placed, total, deliveryAddress (the shop), entries: [...] }] }
//
// Only the last 90 days, no paging seen. The session (KRUIDVAT_SESSION_FILE,
// on the server ~/kitchen-fetcher/kruidvat-session.json, mode 600) is made by
// fetcher/kruidvat-login.mjs on the PC: the site's cookies, Spartacus' OAuth
// token when it has one, and its public OAuth client for the refresh. Both
// the bearer token and the cookies go along; rotated cookies and a refreshed
// token are written back. No token or cookie is ever printed or logged.
//
// !! Akamai answered 403 to anonymous fetches from outside a browser
// (03-11-2026). Such a refusal is named as Akamai's, never worked around.
import { applySetCookies, cookieHeader, readSessionFile, setCookiesOf, writeSessionFile } from "./cookie_session.mjs";

export const API = "https://api.kruidvat.nl";
export const PURCHASES_URL = `${API}/api/v2/kvn-spa/users/current/orders/offline?lang=nl&curr=EUR`;
export const TOKEN_URL = `${API}/authorizationserver/oauth/token`;
const SITE = "https://www.kruidvat.nl";
export const LOGIN_HOW = "node fetcher/kruidvat-login.mjs";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MAX_RETRIES = 3;
const FALLBACK_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";

export class KruidvatAuthError extends Error {}
export class KruidvatBlockedError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Akamai's own refusal page (or header) instead of the API's answer. */
export function isAkamaiBlock(res, text) {
  return res.status === 403 && (/akamai/i.test(res.headers.get("server") ?? "") || /access denied|reference\s*#|edgesuite|akamai/i.test(text));
}

/**
 * The part of one order that is kept: date, total, the shop's town, and per
 * line the product (code, name, brand, category) with its quantity and
 * prices. Loyalty points, addresses beyond the town, images and the rest
 * never reach the cache.
 */
export function orderFields(o) {
  const val = (x) => (x && typeof x === "object" ? (typeof x.value === "number" || typeof x.value === "string" ? x.value : null) : null);
  const town = o?.deliveryAddress?.town ?? String(o?.formattedStoreAddress ?? "").split(",").at(-1)?.trim() ?? null;
  return {
    code: String(o?.code ?? ""),
    placed: typeof o?.placed === "string" ? o.placed : null,
    total: val(o?.total) ?? val(o?.amountToPay),
    town: typeof town === "string" && town ? town : null,
    entries: (Array.isArray(o?.entries) ? o.entries : []).map((e) => ({
      entryNumber: Number.isFinite(Number(e?.entryNumber)) ? Number(e.entryNumber) : null,
      quantity: Number.isFinite(Number(e?.quantity)) ? Number(e.quantity) : null,
      basePriceWithDiscount: val(e?.basePriceWithDiscount),
      code: String(e?.product?.code ?? ""),
      name: String(e?.product?.name ?? ""),
      brand: String(e?.product?.masterBrand?.name ?? ""),
      priceAtPurchase: e?.product?.priceAtPurchase ?? null,
      price: val(e?.product?.price),
      category: String(e?.product?.productCategory?.name ?? ""),
      categoryUrl: String(e?.product?.productCategory?.url ?? ""),
    })),
  };
}

/**
 * { listPurchases, refresh } on the session in `sessionFile`.
 * `fetch` and `now` are for the tests.
 */
export function createKruidvatClient({ sessionFile, fetch = globalThis.fetch, now = Date.now } = {}) {
  if (!sessionFile) throw new Error("createKruidvatClient needs a sessionFile");
  const session = () => readSessionFile(sessionFile, { ErrorClass: KruidvatAuthError, how: LOGIN_HOW });
  const save = (s) => writeSessionFile(sessionFile, { ...s, savedAt: new Date(now()).toISOString() });

  /** One request with the cookies (and the bearer token when there is one); rotated cookies go back into the file. */
  async function send(url, init = {}, s = session()) {
    const res = await fetch(url, {
      ...init,
      headers: {
        "User-Agent": s.userAgent || FALLBACK_UA,
        "Accept-Language": "nl-NL,nl;q=0.9",
        Accept: "application/json",
        Origin: SITE,
        Referer: `${SITE}/my-account/orders`,
        ...init.headers,
        Cookie: cookieHeader(s.cookies ?? [], url, now()),
      },
    });
    const { cookies, changed } = applySetCookies(s.cookies ?? [], setCookiesOf(res), url, now());
    if (changed) save({ ...session(), cookies });
    return res;
  }

  /** Spartacus' refresh with the site's public client. Throws KruidvatAuthError when it cannot or is refused. */
  async function refresh() {
    const s = session();
    if (!s.token?.refreshToken || !s.oauth?.clientId) {
      throw new KruidvatAuthError(`Kruidvat session gone and no way to refresh it (${s.token?.refreshToken ? "no OAuth client" : "no refresh token"}): run "${LOGIN_HOW}" on the PC again`);
    }
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: s.token.refreshToken, client_id: s.oauth.clientId });
    if (s.oauth.clientSecret) body.set("client_secret", s.oauth.clientSecret);
    const res = await send(s.oauth.tokenUrl || TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() }, s);
    const text = await res.text().catch(() => "");
    if (isAkamaiBlock(res, text)) throw new KruidvatBlockedError(`Akamai refused the Kruidvat refresh (HTTP 403): Kruidvat blocks requests from this machine; nothing imported`);
    let t = {};
    try { t = JSON.parse(text); } catch { /* not JSON */ }
    // Never the body in the message: it can hold a token.
    if (!res.ok || typeof t.access_token !== "string") throw new KruidvatAuthError(`Kruidvat refresh refused (HTTP ${res.status}): run "${LOGIN_HOW}" on the PC again`);
    const fresh = session();
    save({
      ...fresh,
      token: {
        accessToken: t.access_token,
        refreshToken: typeof t.refresh_token === "string" ? t.refresh_token : fresh.token.refreshToken,
        expiresAt: Number.isFinite(Number(t.expires_in)) ? now() + Number(t.expires_in) * 1000 : null,
        tokenType: t.token_type ?? "bearer",
      },
    });
    return true;
  }

  async function get(url) {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      let s = session();
      // A token that runs out within minutes is refreshed first, when it can be.
      if (s.token?.expiresAt && now() > s.token.expiresAt - REFRESH_MARGIN_MS && s.token.refreshToken && s.oauth?.clientId && !refreshed) {
        refreshed = true;
        await refresh();
        s = session();
      }
      const auth = s.token?.accessToken ? { Authorization: `Bearer ${s.token.accessToken}` } : {};
      const res = await send(url, { method: "GET", headers: auth }, s);
      const text = await res.text().catch(() => "");
      if (isAkamaiBlock(res, text)) throw new KruidvatBlockedError(`Akamai refused the Kruidvat purchases call (HTTP 403): Kruidvat blocks requests from this machine; nothing imported`);
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await refresh();
        continue;
      }
      if (res.status === 401) throw new KruidvatAuthError(`Kruidvat session gone (still refused after a refresh): run "${LOGIN_HOW}" on the PC again`);
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`Kruidvat ${res.status} on the purchases call`);
      try { return JSON.parse(text); } catch { throw new Error("Kruidvat purchases: no JSON answer"); }
    }
  }

  return {
    refresh,
    /** Thomas's store purchases of the last 90 days, each through orderFields. */
    async listPurchases() {
      const body = await get(PURCHASES_URL);
      // Another shape would read as "no purchases": say so instead.
      if (!Array.isArray(body?.orders)) throw new Error("unexpected Kruidvat answer: no orders");
      return body.orders.map(orderFields).filter((o) => o.code);
    },
  };
}

/** The login's check: one purchases call on the temporary file. */
export async function checkKruidvatSession(file, { fetch = globalThis.fetch } = {}) {
  const list = await createKruidvatClient({ sessionFile: file, fetch }).listPurchases();
  return `the session works: ${list.length} store purchase${list.length === 1 ? "" : "s"} in the last 90 days`;
}
