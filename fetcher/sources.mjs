// The two sources, asked the way Custom MCPs/albert-heijn-mcp asks them:
// the AH bonus page through the Appie app's API with an anonymous token, and
// the folders on allefolders.nl through their GraphQL API.
//
// Polite on purpose: one run a day, one request at a time with a pause in
// between, a user agent that says who asks, and back-off on 429, 5xx and
// network errors (Retry-After is honoured).

const AH_API = "https://api.ah.nl";
const AH_CLIENT = "appie";
const AH_VERSION = "9.28";
const AH_HEADERS = {
  Accept: "application/json",
  "User-Agent": `Appie/${AH_VERSION}`,
  "x-client-name": AH_CLIENT,
  "x-client-version": AH_VERSION,
  "x-application": "AHWEBSHOP",
};

const FOLDER_API = "https://api.jafolders.com/graphql";
const FOLDER_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  Origin: "https://www.allefolders.nl",
  Referer: "https://www.allefolders.nl/",
  "jafolders-context": "allefolders;nl;web;1;1",
  "User-Agent": "vexed-kitchen-fetcher/1.0 (one household, once a day; +https://vexed.works)",
};

/** Supermarkets and drugstores on allefolders.nl (slugs). AH comes from its own bonus page. */
// Only shops Thomas can walk to in half an hour from home in The neighbourhood
// (28-10-2026; OpenStreetMap, straight line up to ~1.8 km): Dirk,
// Lidl, Etos and Kruidvat within 600 m, Hoogvliet and ALDI within 1 km,
// Action, SPAR, Jumbo and PLUS within 1.5 km. Albert Heijn comes from its own
// bonus API. Coop, Vomar, DekaMarkt, Poiesz and Nettorama have no shop near.
export const DEFAULT_SHOPS = [
  "dirk", "lidl", "jumbo", "aldi", "plus", "hoogvliet", "spar", "kruidvat", "etos", "action",
];

// AH bonus sections that are not the supermarket or not this week's deal.
const AH_SKIP = new Set(["SPOTLIGHT", "AHONLINE", "GALL", "GALLCARD", "ETOS"]);

const PAUSE_MS = 1000;
const RETRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;

/** fetch, one at a time with a pause, retried with back-off; returns parsed JSON. */
export async function politeJson(url, init, { label = url } = {}) {
  for (let attempt = 0; ; attempt++) {
    const wait = last + PAUSE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    let res;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      if (attempt < RETRIES) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      throw new Error(`${label}: ${e.cause?.code ?? e.name}`);
    }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < RETRIES) {
      const after = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 300) * 1000 : 2000 * 2 ** attempt);
      continue;
    }
    throw new Error(`${label}: HTTP ${res.status}`);
  }
}

// ------------------------------------------------------------------- AH

async function ahToken() {
  const body = await politeJson(`${AH_API}/mobile-auth/v1/auth/token/anonymous`, {
    method: "POST",
    headers: { ...AH_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: AH_CLIENT }),
  }, { label: "AH token" });
  if (!body?.access_token) throw new Error("AH token: no access_token");
  return body.access_token;
}

const ahGet = (token, path, label) =>
  politeJson(`${AH_API}${path}`, { headers: { ...AH_HEADERS, Authorization: `Bearer ${token}` } }, { label });

const mechanism = (labels, fallback) =>
  labels?.find((l) => l.defaultDescription)?.defaultDescription ?? fallback?.toLowerCase() ?? "";

/** The items of one bonus section, as { title, mechanism, category, start, end, price, size }. */
export function parseAhSection(section, category) {
  const out = [];
  for (const entry of section?.bonusGroupOrProducts ?? []) {
    const g = entry.bonusGroup;
    const p = entry.product;
    if (g) {
      out.push({
        title: g.segmentDescription, mechanism: mechanism(g.discountLabels, g.discountDescription),
        category, start: g.bonusStartDate, end: g.bonusEndDate, price: null, size: null,
      });
    } else if (p) {
      out.push({
        title: p.title, mechanism: mechanism(p.discountLabels, p.bonusMechanism),
        category, start: p.bonusStartDate, end: p.bonusEndDate, price: p.currentPrice ?? null,
        size: p.salesUnitSize ?? p.unitSize ?? null,
      });
    }
  }
  return out;
}

/** This week's AH bonus: { period, items }. today: "YYYY-MM-DD". */
export async function ahBonus(today) {
  const token = await ahToken();
  const meta = await ahGet(token, "/mobile-services/bonuspage/v3/metadata", "AH bonus metadata");
  const periods = meta?.periods ?? [];
  const period = periods.find((p) => p.bonusStartDate <= today && today <= p.bonusEndDate) ?? periods[0];
  if (!period) throw new Error("AH bonus: no period");
  // The same section can sit under two tabs.
  const sections = new Map();
  for (const tab of period.tabs ?? []) {
    for (const m of tab.urlMetadataList ?? []) if (!AH_SKIP.has(m.bonusType)) sections.set(m.url, m);
  }
  const seen = new Set();
  const items = [];
  for (const m of sections.values()) {
    const section = await ahGet(token, `/mobile-services/${m.url}`, `AH bonus ${m.description}`);
    for (const item of parseAhSection(section, m.description)) {
      const key = `${item.title}|${item.mechanism}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  return { period, items };
}

// -------------------------------------------------------------- folders

const OFFERS_QUERY = `query Offers($input: OffersInput!, $pagination: PaginationInput!) {
  offers(offers: $input, pagination: $pagination) {
    id name description brandName priceAfterDiscount priceBeforeDiscount discountPercent
    activeFrom expireAfter shop { slug name }
  }
}`;

const BROCHURES_QUERY = `query Brochures($input: BrochuresInput!, $pagination: PaginationInput!) {
  brochures(brochures: $input, pagination: $pagination) { id name activeFrom expireAfter }
}`;

async function folderQuery(query, variables, label) {
  const body = await politeJson(FOLDER_API, { method: "POST", headers: FOLDER_HEADERS, body: JSON.stringify({ query, variables }) }, { label });
  if (body?.errors?.length) throw new Error(`${label}: ${body.errors.map((e) => e.message).join("; ").slice(0, 200)}`);
  if (!body?.data) throw new Error(`${label}: no data`);
  return body.data;
}

const PAGE = 100;
const MAX_PAGES = 15;

/** Every offer in a shop's folders that has not ended yet (a shop has several at once). */
export async function shopOffers(slug, now = Date.now()) {
  const { brochures } = await folderQuery(BROCHURES_QUERY, { input: { shopSlug: slug }, pagination: { limit: 10, offset: 0 } }, `${slug} folders`);
  const current = (brochures ?? []).filter((b) => !b.expireAfter || Date.parse(b.expireAfter) > now);
  const out = [];
  for (const b of current) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const { offers } = await folderQuery(OFFERS_QUERY, {
        input: { brochureId: b.id }, pagination: { limit: PAGE, offset: page * PAGE },
      }, `${slug} folder ${b.name}`);
      out.push(...(offers ?? []));
      if (!offers || offers.length < PAGE) break;
    }
  }
  return { brochures: current.length, offers: out };
}
