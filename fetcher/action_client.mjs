// Action (www.action.com) with Thomas's own session, for the receipt import
// on the home server (fetcher/action_import.mjs). Action has no public API:
// these are the calls the site's own "Mijn digitale kassabonnetjes" page makes,
// seen on 03-11-2026 in Thomas's signed-in browser (never guessed):
//
//   receipts  GET https://www.action.com/api/graphql?operationName=ReceiptList
//             variables { limit } (+ { offset } for the next page), Apollo persisted query
//   receipt   GET https://www.action.com/api/graphql?operationName=ReceiptDetails
//             variables { receiptId }, Apollo persisted query
//   refresh   POST https://www.action.com/api/auth/refresh (then /api/auth/oidc/refresh)
//
// The GraphQL calls need `apollographql-client-name: web`,
// `x-apollo-operation-name` and `content-type: application/json`, or the
// server answers a CSRF error. The session is the site's cookies, kept in
// ACTION_SESSION_FILE (on the server ~/kitchen-fetcher/action-session.json,
// mode 600), made by fetcher/action-login.mjs on the PC and rewritten here
// whenever a response rotates a cookie. No cookie is ever printed or logged.
//
// The query text lives only on Action's server (persisted queries): when it
// answers PersistedQueryNotFound the site changed its query, and this client
// stops with that message instead of guessing a query.
import { applySetCookies, cookieHeader, readSessionFile, setCookiesOf, writeSessionFile } from "./cookie_session.mjs";

export const BASE = "https://www.action.com";
export const GRAPHQL = `${BASE}/api/graphql`;
export const RECEIPTS_PAGE = `${BASE}/nl-nl/mijn-action/mijn-kassabonnetjes/`;
export const LOGIN_PAGE = `${BASE}/nl-nl/inloggen/`;
export const QUERIES = {
  ReceiptList: "adff608bd7a8f11ff6b4ca54a480670ebbaa42f0139f28a3562787cd20bf9025",
  ReceiptDetails: "9bfa4d9ec37b5d8e1e6efcfe62a75bec521d423351cfe73a8f7cec732ca6fdc8",
};
export const PAGE_SIZE = 14;
export const LOGIN_HOW = "node fetcher/action-login.mjs";
/** Two years of receipts at most (Action keeps two years), 14 a page. */
const MAX_PAGES = 60;
const MAX_RETRIES = 3;
/** Polite: one request at a time with a pause between, like the other receipt fetchers. */
const PAUSE_MS = 1000;
/** A browser's user agent when the session file has none (the login saves the real one). */
const FALLBACK_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";

export class ActionAuthError extends Error {}
export class ActionQueryError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The address of one persisted-query call. */
export function graphqlUrl(operationName, variables) {
  const q = new URLSearchParams({
    operationName,
    variables: JSON.stringify(variables),
    extensions: JSON.stringify({ persistedQuery: { sha256Hash: QUERIES[operationName], version: 1 }, headers: { "Accept-Language": "nl-NL" } }),
  });
  return `${GRAPHQL}?${q}`;
}

/** A Cloudflare challenge or block page instead of the API's answer. */
export function isCloudflareBlock(res, text) {
  return (res.status === 403 || res.status === 503) && (Boolean(res.headers.get("cf-mitigated")) || /cloudflare|just a moment|cf-chl|challenge-platform/i.test(text));
}

/** What a GraphQL `errors` list means: "persisted", "auth", or null (something else). */
export function errorKind(errors) {
  for (const e of Array.isArray(errors) ? errors : []) {
    const code = String(e?.extensions?.code ?? "");
    const msg = String(e?.message ?? "");
    if (code === "PERSISTED_QUERY_NOT_FOUND" || /PersistedQueryNotFound/i.test(msg)) return "persisted";
    // Action says USER_LOGGED_OUT when the access cookie expired (seen 04-11-2026).
    if (/UNAUTHENTICATED|UNAUTHORI[SZ]ED|FORBIDDEN|LOGGED_OUT/i.test(code) || /unauthori[sz]ed|unauthenticated|not (logged|signed) in|logged.?out|login required/i.test(msg)) return "auth";
  }
  return null;
}

/**
 * The part of a ReceiptDetails answer that is kept: the barcode, QR code,
 * payment methods, membership id and warranty fields never reach the cache.
 */
export function receiptFields(r) {
  const num = (v) => (typeof v === "number" || typeof v === "string" ? v : null);
  return {
    id: String(r?.id ?? ""),
    dateTime: typeof r?.dateTime === "string" ? r.dateTime : null,
    store: { id: String(r?.store?.id ?? ""), name: String(r?.store?.name ?? ""), address: String(r?.store?.address ?? "") },
    price: {
      total: num(r?.price?.total), subTotal: num(r?.price?.subTotal),
      employeeDiscount: num(r?.price?.employeeDiscount), otherDiscounts: num(r?.price?.otherDiscounts),
      currency: typeof r?.price?.currency === "string" ? r.price.currency : null,
    },
    products: (Array.isArray(r?.products) ? r.products : []).map((p) => ({
      code: String(p?.code ?? ""),
      description: String(p?.description ?? ""),
      quantity: num(p?.quantity),
      totalPriceFormat: typeof p?.totalPriceFormat === "string" ? p.totalPriceFormat : null,
      price: { adjustedSalesPrice: num(p?.price?.adjustedSalesPrice), regularSalesPrice: num(p?.price?.regularSalesPrice) },
    })),
  };
}

/**
 * { listReceipts, getReceipt, refresh } on the session in `sessionFile`.
 * `fetch`, `now` and `pause` are for the tests.
 */
export function createActionClient({ sessionFile, fetch = globalThis.fetch, now = Date.now, pause = PAUSE_MS } = {}) {
  if (!sessionFile) throw new Error("createActionClient needs a sessionFile");
  let calls = 0;

  const session = () => readSessionFile(sessionFile, { ErrorClass: ActionAuthError, how: LOGIN_HOW });

  /** One request with the session's cookies; rotated cookies go back into the file. */
  async function send(url, init = {}) {
    if (calls++ && pause) await sleep(pause);
    const s = session();
    const res = await fetch(url, {
      ...init,
      headers: {
        "User-Agent": s.userAgent || FALLBACK_UA,
        "Accept-Language": "nl-NL,nl;q=0.9",
        Referer: RECEIPTS_PAGE,
        ...init.headers,
        Cookie: cookieHeader(s.cookies, url, now()),
      },
    });
    const { cookies, changed } = applySetCookies(s.cookies, setCookiesOf(res), url, now());
    if (changed) writeSessionFile(sessionFile, { ...s, cookies, savedAt: new Date(now()).toISOString() });
    return res;
  }

  /** The site's own refresh; the second address when the first refuses. Throws ActionAuthError when both do. */
  async function refresh() {
    const statuses = [];
    for (const p of ["/api/auth/refresh", "/api/auth/oidc/refresh"]) {
      const res = await send(`${BASE}${p}`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", Origin: BASE }, body: "{}" });
      const text = await res.text().catch(() => "");
      if (isCloudflareBlock(res, text)) throw new Error(`Cloudflare refused the Action refresh (HTTP ${res.status}): the session may not work from this machine`);
      if (res.ok) return true;
      statuses.push(res.status);
    }
    throw new ActionAuthError(`Action session gone (refresh HTTP ${statuses.join("/")}): run "${LOGIN_HOW}" on the PC again`);
  }

  async function query(operationName, variables) {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const res = await send(graphqlUrl(operationName, variables), {
        method: "GET",
        headers: { Accept: "application/json", "Content-Type": "application/json", "apollographql-client-name": "web", "x-apollo-operation-name": operationName },
      });
      const text = await res.text().catch(() => "");
      if (isCloudflareBlock(res, text)) throw new Error(`Cloudflare refused ${operationName} (HTTP ${res.status}): the session may not work from this machine`);
      let body = null;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      const kind = errorKind(body?.errors);
      if (kind === "persisted") {
        throw new ActionQueryError(`Action no longer knows the ${operationName} query (PersistedQueryNotFound): the site changed; the hash in fetcher/action_client.mjs must be read again from a signed-in session, never guessed`);
      }
      if ((res.status === 401 || kind === "auth") && !refreshed) {
        refreshed = true;
        await refresh();
        continue;
      }
      if (res.status === 401 || kind === "auth") throw new ActionAuthError(`Action session gone (${operationName} still refused after a refresh): run "${LOGIN_HOW}" on the PC again`);
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`Action ${res.status} on ${operationName}`);
      if (!body || typeof body !== "object") throw new Error(`Action ${operationName}: no JSON answer`);
      if (Array.isArray(body.errors) && body.errors.length) {
        const e = body.errors[0];
        throw new Error(`Action ${operationName} error: ${String(e?.extensions?.code ?? e?.message ?? "unknown").slice(0, 120)}`);
      }
      return body.data;
    }
  }

  return {
    refresh,
    /**
     * Receipt summaries [{ id, dateTime, total }], newest first. Pages with
     * `offset` while `hasNext`; stops at the first page whose receipts
     * `known` all has (the daily run needs only what is new) or at `maxPages`.
     */
    async listReceipts({ known = new Set(), maxPages = MAX_PAGES, log = () => {} } = {}) {
      const out = [];
      let offset = null;
      for (let page = 0; page < maxPages; page++) {
        const data = await query("ReceiptList", offset === null ? { limit: PAGE_SIZE } : { limit: PAGE_SIZE, offset });
        const list = data?.receiptList;
        if (!list || !Array.isArray(list.receipts)) throw new Error("unexpected ReceiptList answer: no receiptList.receipts");
        for (const r of list.receipts) if (r?.id) out.push({ id: String(r.id), dateTime: r.dateTime ?? null, total: r.price?.total ?? null });
        if (!list.hasNext || !list.receipts.length || list.receipts.every((r) => known.has(String(r.id)))) break;
        if (list.offset === null || list.offset === undefined || list.offset === offset) {
          log("ReceiptList says there is more but gives no new offset: stopped after this page");
          break;
        }
        offset = list.offset;
      }
      return out;
    },
    /** One receipt, only the fields the import reads (receiptFields). */
    async getReceipt(id) {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(id))) throw new Error("bad Action receipt id");
      const data = await query("ReceiptDetails", { receiptId: String(id) });
      if (!data?.receipt || !Array.isArray(data.receipt.products)) throw new Error("unexpected ReceiptDetails answer: no receipt.products");
      return receiptFields(data.receipt);
    },
  };
}
