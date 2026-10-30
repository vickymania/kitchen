// Albert Heijn with Thomas's own session, for the receipt import on the home
// server (fetcher/ah_import.mjs). Ported from Custom MCPs/albert-heijn-mcp/src
// (28-10-2026): the token refresh from auth.ts, the request and retry rules
// from api.ts, the receipt queries and the till-code conversion from
// receipts.ts, the product cards from products.ts. Same client id, headers
// and calls as the Appie app the MCP poses as.
//
// The tokens live in their own file (AH_TOKEN_FILE, on the server
// ~/kitchen-fetcher/ah-tokens.json, mode 600): a separate AH login, made by
// fetcher/ah-login.mjs, never the PC's ~/.albert-heijn-mcp/tokens.json. AH
// rotates the refresh token, so the file is rewritten after every refresh.
// No token is ever printed or logged.
import fs from "node:fs";
import path from "node:path";

const API_BASE = "https://api.ah.nl";
const CLIENT_ID = "appie";
const CLIENT_VERSION = process.env.AH_CLIENT_VERSION?.trim() || "9.28";
const USER_AGENT = process.env.AH_USER_AGENT?.trim() || `Appie/${CLIENT_VERSION}`;
/** Refresh a few minutes before expiry, so a run never breaks halfway. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MAX_RETRIES = 3;

export class AhAuthError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HEADERS = {
  Accept: "application/json",
  "User-Agent": USER_AGENT,
  "x-client-name": CLIENT_ID,
  "x-client-version": CLIENT_VERSION,
  "x-application": "AHWEBSHOP",
};

/** The same shape as the MCP's StoredTokens, so its login output works here. */
export function readTokenFile(file) {
  try {
    const t = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof t?.accessToken === "string" && typeof t?.refreshToken === "string") return t;
  } catch {
    // handled below
  }
  throw new AhAuthError(`no AH session in ${file}: run "node fetcher/ah-login.mjs" on the PC (Thomas logs in)`);
}

/** Written next to the old file and renamed over it: a crash never leaves half a file (and no session). */
export function writeTokenFile(file, tokens) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/**
 * { listReceipts, getReceipt, convertPosIds, getProductsByIds, ahGraphQL }:
 * the functions tools/ah_pull.mjs takes, on the session in `tokenFile`.
 */
export function createAhClient({ tokenFile, fetch = globalThis.fetch, now = Date.now } = {}) {
  if (!tokenFile) throw new Error("createAhClient needs a tokenFile");
  let refreshing = null;

  async function refresh(current) {
    // One refresh at a time: AH may revoke the old refresh token once it issued a new one.
    refreshing ??= (async () => {
      try {
        const res = await fetch(`${API_BASE}/mobile-auth/v1/auth/token/refresh`, {
          method: "POST",
          headers: { ...HEADERS, "Content-Type": "application/json" },
          body: JSON.stringify({ clientId: CLIENT_ID, refreshToken: current.refreshToken }),
        });
        const body = await res.json().catch(() => ({}));
        // Never the body in the message: it can hold a token.
        if (!res.ok || !body.access_token) throw new AhAuthError(`AH refresh refused: HTTP ${res.status}`);
        const tokens = {
          accessToken: body.access_token,
          refreshToken: body.refresh_token ?? current.refreshToken,
          expiresAt: now() + body.expires_in * 1000,
          memberId: /^(\d+)_/.exec(body.access_token)?.[1] ?? current.memberId,
          savedAt: new Date(now()).toISOString(),
        };
        writeTokenFile(tokenFile, tokens);
        return tokens;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function userToken(force) {
    const tokens = readTokenFile(tokenFile);
    if (force || now() > (tokens.expiresAt ?? 0) - REFRESH_MARGIN_MS) return (await refresh(tokens)).accessToken;
    return tokens.accessToken;
  }

  async function ahRequest(route, { method = "GET", body } = {}) {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await userToken(false);
      const res = await fetch(`${API_BASE}${route}`, {
        method,
        headers: { ...HEADERS, Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.ok) return res.json();
      // A token AH already revoked: one fresh try.
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await userToken(true);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 500 * 2 ** attempt);
        continue;
      }
      throw new Error(`Albert Heijn ${res.status} on ${route.split("?")[0]}`);
    }
  }

  async function ahGraphQL(query, variables = {}) {
    const out = await ahRequest("/graphql", { method: "POST", body: { query, variables } });
    if (out?.errors?.length) throw new Error(`Albert Heijn GraphQL: ${out.errors.map((e) => e.message).join("; ")}`);
    if (!out?.data) throw new Error("Albert Heijn GraphQL gave no data");
    return out.data;
  }

  const RECEIPTS_QUERY = `query FetchPosReceipts($offset: Int!, $limit: Int!) {
  posReceiptsPage(pagination: {offset: $offset, limit: $limit}) {
    posReceipts { id dateTime totalAmount { amount } }
  }
}`;
  const RECEIPT_DETAIL_QUERY = `query FetchReceipt($id: String!) {
  posReceiptDetails(id: $id) {
    id
    products { id quantity name price { amount } amount { amount } }
    discounts { name amount { amount } }
    total { amount }
  }
}`;

  return {
    ahGraphQL,
    async listReceipts(offset, limit) {
      const data = await ahGraphQL(RECEIPTS_QUERY, { offset, limit });
      return data.posReceiptsPage?.posReceipts ?? [];
    },
    async getReceipt(id) {
      const data = await ahGraphQL(RECEIPT_DETAIL_QUERY, { id });
      const detail = data.posReceiptDetails;
      detail.products ??= [];
      detail.discounts ??= [];
      return detail;
    },
    /** Till ids -> webshop ids (absent: no webshop product). tools/ah_pull.mjs keeps the map. */
    async convertPosIds(posIds) {
      const result = new Map();
      const ids = [...new Set(posIds)].filter((id) => id > 0);
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        // Aliases must be literal; the ids are integers.
        const query = `query Convert { ${chunk.map((id, n) => `p${n}: productConvertId(sourceId: ${Math.trunc(id)})`).join(" ")} }`;
        const data = await ahGraphQL(query);
        chunk.forEach((id, n) => { if (data[`p${n}`] > 0) result.set(id, data[`p${n}`]); });
      }
      return result;
    },
    async getProductsByIds(ids) {
      const result = new Map();
      const unique = [...new Set(ids.filter((id) => id > 0))];
      for (let i = 0; i < unique.length; i += 30) {
        const params = new URLSearchParams({ sortOn: "INPUT_PRODUCT_IDS" });
        for (const id of unique.slice(i, i + 30)) params.append("ids", String(id));
        for (const p of await ahRequest(`/mobile-services/product/search/v2/products?${params}`)) result.set(p.webshopId, p);
      }
      return result;
    },
  };
}
