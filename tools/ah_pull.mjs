// Pulls Thomas's AH receipts into migration/ah/ (git-ignored: personal data).
// On the PC (tools/import_ah.mjs --pull) through the albert-heijn MCP's own
// compiled modules (its own sign-in and token handling; this file never reads
// the tokens); on the home server (fetcher/ah_import.mjs) through
// fetcher/ah_client.mjs, passed in as `api`, on that server's own AH session.
// A receipt never changes, so one already in the cache is never fetched
// again. Requests are sequential.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const AH_MCP = process.env.AH_MCP_DIR
  ?? "C:\\path\\to\\the\\workspace\\Custom MCPs\\albert-heijn-mcp";

const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback);
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 1));
};

const CITY_QUERY = `query FetchReceiptCity($id: String!) { posReceiptDetails(id: $id) { address { city } } }`;

const mod = (name) => import(pathToFileURL(path.join(AH_MCP, "dist", name)).href);

/** The MCP's functions, for a pull on the PC. */
async function mcpApi() {
  const { listReceipts, getReceipt, convertPosIds } = await mod("receipts.js");
  const { getProductsByIds } = await mod("products.js");
  const { ahGraphQL } = await mod("api.js");
  return { listReceipts, getReceipt, convertPosIds, getProductsByIds, ahGraphQL };
}

/**
 * Fills `dir` with:
 *   receipts.json           [{ id, dateTime, total }] every receipt, newest first
 *   receipts/<id>.json      { id, products, discounts, total } as AH sends it
 *   pos-to-webshop.json     { posId: webshopId | -1 }
 *   products.json           { webshopId: { title, brand, size, price } }
 *   cities.json             { receiptId: city | null } where it was paid
 * Returns how many receipts were new.
 */
export async function pullAh(dir, { log = console.log, api = null } = {}) {
  const { listReceipts, getReceipt, convertPosIds, getProductsByIds, ahGraphQL } = api ?? await mcpApi();

  const list = [];
  for (let offset = 0; ; offset += 100) {
    const page = await listReceipts(offset, 100);
    list.push(...page.map((r) => ({ id: r.id, dateTime: r.dateTime, total: r.totalAmount?.amount ?? null })));
    if (page.length < 100) break;
  }
  writeJson(path.join(dir, "receipts.json"), list);

  let fresh = 0;
  for (const r of list) {
    const file = path.join(dir, "receipts", `${r.id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
    if (fs.existsSync(file)) continue;
    writeJson(file, await getReceipt(r.id));
    fresh++;
  }
  log(`${list.length} receipts, ${fresh} new.`);

  const posIds = new Set();
  for (const r of list) {
    const detail = readJson(path.join(dir, "receipts", `${r.id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`), null);
    for (const p of detail?.products ?? []) if (p.id > 0) posIds.add(p.id);
  }
  const mapFile = path.join(dir, "pos-to-webshop.json");
  const known = readJson(mapFile, {});
  const missing = [...posIds].filter((id) => !(String(id) in known));
  if (missing.length) {
    const converted = await convertPosIds(missing);
    for (const id of missing) known[String(id)] = converted.get(id) ?? -1;
    writeJson(mapFile, known);
  }

  const prodFile = path.join(dir, "products.json");
  const products = readJson(prodFile, {});
  const want = [...new Set(Object.values(known).filter((w) => w > 0 && !(String(w) in products)))];
  if (want.length) {
    const cards = await getProductsByIds(want);
    for (const w of want) {
      const c = cards.get(w);
      // A product AH no longer sells has no card: the receipt's own name is used.
      products[String(w)] = c
        ? { title: c.title, brand: c.brand ?? "", size: c.salesUnitSize ?? "", price: c.priceBeforeBonus ?? c.currentPrice ?? null }
        : null;
    }
    writeJson(prodFile, products);
  }
  log(`${posIds.size} till codes, ${missing.length} converted now; ${want.length} product cards fetched.`);

  // AH's own category per product (public/shared/product-kinds.js turns it
  // into a kind): fetched once per webshop id, also for the cards above.
  await pullCategories(dir, Object.keys(products).map(Number), { getProductsByIds, log });

  // The city a receipt was paid in decides whose it is (tools/import_ah.mjs
  // OWN_CITIES). Only the city is kept, never the street.
  const cityFile = path.join(dir, "cities.json");
  const cities = readJson(cityFile, {});
  const noCity = list.filter((r) => !(r.id in cities));
  for (const r of noCity) {
    const data = await ahGraphQL(CITY_QUERY, { id: r.id });
    cities[r.id] = data?.posReceiptDetails?.address?.city ?? null;
  }
  if (noCity.length) writeJson(cityFile, cities);
  log(`${noCity.length} receipt cities fetched.`);
  return fresh;
}

/** AH's categories per webshop id, as cached in `dir`/categories.json: { id: { main, sub } | null }. */
export function readCategories(dir) {
  return readJson(path.join(dir, "categories.json"), {});
}

/**
 * Fills `dir`/categories.json with AH's mainCategory and subCategory for
 * every webshop id in `ids` not there yet: the product search, 30 ids per
 * request, one request at a time with a second between. A product AH no
 * longer sells gets null and is never asked again. `getProductsByIds` is the
 * MCP's (PC) or fetcher/ah_client.mjs's (home server); without it, the MCP's.
 * Returns how many were asked.
 */
export async function pullCategories(dir, ids, { getProductsByIds = null, log = console.log, pause = 1000 } = {}) {
  const file = path.join(dir, "categories.json");
  const known = readCategories(dir);
  const want = [...new Set(ids.filter((id) => Number(id) > 0).map(Number))].filter((id) => !(String(id) in known));
  if (!want.length) return 0;
  const byIds = getProductsByIds ?? (await mod("products.js")).getProductsByIds;
  for (let i = 0; i < want.length; i += 30) {
    if (i) await new Promise((r) => setTimeout(r, pause));
    const chunk = want.slice(i, i + 30);
    const cards = await byIds(chunk);
    for (const id of chunk) {
      const c = cards.get(id);
      known[String(id)] = c && (c.mainCategory || c.subCategory)
        ? { main: c.mainCategory ?? "", sub: c.subCategory ?? "" }
        : null;
    }
    // Written after every request: an interrupted run keeps what it got.
    writeJson(file, known);
  }
  log(`${want.length} product categories fetched.`);
  return want.length;
}
