// Shelf life per item, looked up by Claude (28-10-2026: "als de app
// een product nog niet kent, zoekt de server het op en onthoudt het").
//
// After an op batch that bought something or put it in the pantry, the items
// (and, since 0016, the products bought on a receipt) without a shelf life are sent to Claude Haiku in ONE request (name plus the
// product names and brands we know for it); the answer is written as item.shelf
// ops with source "claude", so the phones get it through the delta sync and a
// person's value is never overwritten (the op engine's rank). It runs after the
// answer went out (ctx.waitUntil): nobody waits for it.
//
// Also the batch route POST /api/items/shelf-fill, used by
// tools/fill_shelf_life.mjs for the items that existed before this.
//
// Never an excluded thing (public/shared/excluded.js): such an item is skipped, no name of it goes to Claude.
// Every lookup is paid: the daily counter goes up before the call.
import { isExcluded } from "../public/shared/excluded.js";
import { KEEPS, SHELF_DAYS_MAX } from "../public/shared/shelf-life.js";
import { applyOps } from "./ops-store.js";
import { askClaude, takeSome, CHEAP_MODEL } from "./claude.js";

export const SHELF_DAILY_LIMIT = 200;        // items looked up after purchases, per household per day
export const SHELF_FILL_DAILY_LIMIT = 2000;  // items through the batch route, per household per day
export const SHELF_BATCH = 25;               // items per Claude request
const PRODUCTS_PER_ITEM = 3;

export const SHELF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["n", "shelf_days", "opened_days", "kind"],
        properties: {
          n: { type: "integer", description: "The number of the item in the list" },
          shelf_days: { type: "integer", description: "Days it keeps unopened, stored normally; -1 when it keeps a year or more, or it is no food" },
          opened_days: { type: "integer", description: "Days it keeps once opened; 0 when that does not matter or is unknown" },
          kind: { type: "string", description: "A few words: what kind of product this is and how it is stored" },
        },
      },
    },
  },
};

const PROMPT = [
  "For each product of a Dutch household's groceries (names are Dutch, bought at Dutch supermarkets such as Albert Heijn and Dirk),",
  "give a conservative average shelf life in whole days:",
  "- shelf_days: unopened, stored normally (fresh things in the fridge, dry things in the cupboard, frozen in the freezer).",
  "  Use the typical date on the pack for packaged fresh products, a shorter time when in doubt.",
  "  -1 when it keeps a year or more (tins, dry pasta, rice, frozen food, salt) or it is not food (toilet paper, soap).",
  "- opened_days: once opened (a pack of milk, a jar of pesto, a bag of grated cheese); 0 when not relevant (an apple, bread) or unknown.",
  "Answer every numbered product exactly once, with its number as n.",
].join("\n");

const ID_CHUNK = 90;

async function rowsByIds(env, hh, sql, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const { results } = await env.DB.prepare(sql.replace("(?)", `(${chunk.map(() => "?").join(",")})`)).bind(hh, ...chunk).all();
    out.push(...results);
  }
  return out;
}

/**
 * The items of `itemIds` that still need a shelf life, each with up to three
 * product names we know for it. An excluded thing (the item or one of its products) is
 * counted in `excluded` and never returned.
 */
export async function shelfCandidates(env, hh, itemIds) {
  const ids = [...new Set(itemIds.filter((x) => typeof x === "string"))];
  if (!ids.length) return { items: [], excluded: 0 };
  const items = await rowsByIds(env, hh,
    "SELECT id, name FROM items WHERE household_id = ? AND id IN (?) AND deleted_at IS NULL AND shelf_source IS NULL", ids);
  const products = items.length ? await rowsByIds(env, hh,
    "SELECT item_id, name, brand FROM products WHERE household_id = ? AND item_id IN (?) AND deleted_at IS NULL ORDER BY updated_at DESC",
    items.map((i) => i.id)) : [];
  const byItem = new Map();
  for (const p of products) {
    const list = byItem.get(p.item_id) ?? [];
    list.push([p.brand, p.name].filter(Boolean).join(" ").trim());
    byItem.set(p.item_id, list);
  }
  let excluded = 0;
  const out = [];
  for (const item of items) {
    const names = byItem.get(item.id) ?? [];
    if (isExcluded(item.name) || names.some((n) => isExcluded(n))) {
      excluded++;
      continue;
    }
    out.push({ id: item.id, name: item.name, products: [...new Set(names)].slice(0, PRODUCTS_PER_ITEM) });
  }
  return { items: out, excluded };
}

/**
 * The products of `productIds` bought without a shelf life of their own
 * (28-10-2026: houdbare melk is no fresh milk): "AH Halfvolle melk
 * 1 l" with its item's name. Excluded things are counted and never returned.
 */
export async function productCandidates(env, hh, productIds) {
  const ids = [...new Set(productIds.filter((x) => typeof x === "string"))];
  if (!ids.length) return { items: [], excluded: 0 };
  const rows = await rowsByIds(env, hh,
    "SELECT p.id, p.name, p.brand, p.size, i.name AS item_name FROM products p LEFT JOIN items i ON i.id = p.item_id AND i.household_id = p.household_id " +
    "WHERE p.household_id = ? AND p.id IN (?) AND p.deleted_at IS NULL AND p.shelf_source IS NULL", ids);
  let excluded = 0;
  const out = [];
  for (const p of rows) {
    const name = [p.brand, p.name, p.size].filter(Boolean).join(" ").trim();
    if (isExcluded(name) || isExcluded(p.name) || (p.item_name && isExcluded(p.item_name))) {
      excluded++;
      continue;
    }
    out.push({ kind: "product", id: p.id, name, products: p.item_name ? [p.item_name] : [] });
  }
  return { items: out, excluded };
}

/** The list Claude reads: "1. Melk (AH Halfvolle melk; Campina Halfvolle melk)", a product as "2. AH Houdbare melk 1 l (Melk)". */
export function shelfPrompt(items) {
  const lines = items.map((it, i) => `${i + 1}. ${it.name}${it.products.length ? ` (${it.products.join("; ")})` : ""}`);
  return `${PROMPT}\n\nProducts:\n${lines.join("\n")}`;
}

/** Claude's answer, checked, as item.shelf fields per item id. A wrong row is left out. */
export function shelfAnswers(items, answer) {
  const out = new Map();
  for (const a of Array.isArray(answer?.items) ? answer.items : []) {
    const item = items[Number(a?.n) - 1];
    if (!item || out.has(item.id)) continue;
    const days = Number(a.shelf_days);
    if (!Number.isInteger(days) || !(days === KEEPS || (days >= 1 && days <= SHELF_DAYS_MAX))) continue;
    const opened = Number(a.opened_days);
    const openedDays = Number.isInteger(opened) && opened >= 1 && opened <= SHELF_DAYS_MAX
      ? (days === KEEPS ? opened : Math.min(opened, days)) : null;
    out.set(item.id, { shelf_days: days, opened_days: openedDays, kind: typeof a.kind === "string" ? a.kind.slice(0, 80) : "" });
  }
  return out;
}

/**
 * Look up and store the shelf life of `itemIds` (those without one; excluded things
 * skipped). `bucket` and `limit` are the daily counter. Resolves to
 * { asked, written, excluded, failed, limited, results: [{ id, name, shelf_days, opened_days, kind }] }.
 */
export async function lookupShelf(env, who, itemIds, { bucket = "shelf", limit = SHELF_DAILY_LIMIT, productIds = [] } = {}) {
  const out = { asked: 0, written: 0, excluded: 0, failed: 0, limited: false, results: [] };
  if (!env.ANTHROPIC_API_KEY) return { ...out, off: true };
  const found = await shelfCandidates(env, who.householdId, itemIds);
  const products = await productCandidates(env, who.householdId, productIds);
  out.excluded = found.excluded + products.excluded;
  // Items first, then the products: one list, one counter, the same requests.
  let todo = [...found.items, ...products.items];
  if (!todo.length) return out;
  const allowed = await takeSome(env, bucket, who.householdId, todo.length, limit);
  if (allowed < todo.length) out.limited = true;
  todo = todo.slice(0, allowed);
  for (let i = 0; i < todo.length; i += SHELF_BATCH) {
    const chunk = todo.slice(i, i + SHELF_BATCH);
    out.asked += chunk.length;
    const res = await askClaude(env, {
      what: "shelf life",
      model: CHEAP_MODEL,
      schema: SHELF_SCHEMA,
      maxTokens: 300 + chunk.length * 80,
      content: [{ type: "text", text: shelfPrompt(chunk) }],
    });
    if (res.failed) {
      out.failed += chunk.length;
      if (res.failed === "rate_limited") break;
      continue;
    }
    const answers = shelfAnswers(chunk, res.answer);
    out.failed += chunk.length - answers.size;
    const kindOf = new Map(chunk.map((c) => [c.id, c.kind ?? "item"]));
    const ops = [...answers].map(([rowId, a]) => (kindOf.get(rowId) === "product"
      ? { type: "product.shelf", op_id: `shelf-${crypto.randomUUID()}`, product_id: rowId }
      : { type: "item.shelf", op_id: `shelf-${crypto.randomUUID()}`, item_id: rowId })).map((o, k) => {
      const a = [...answers.values()][k];
      return { ...o, shelf_days: a.shelf_days, opened_days: a.opened_days, source: "claude" };
    });
    const results = ops.length ? await applyOps(env.DB, who, ops) : [];
    results.forEach((r, k) => {
      const itemId = ops[k].item_id ?? ops[k].product_id;
      if (!r.ok || r.result?.kept) return;
      out.written++;
      const a = answers.get(itemId);
      out.results.push({ id: itemId, name: chunk.find((c) => c.id === itemId)?.name, ...a });
    });
  }
  return out;
}

/** The items of the household without a shelf life, counted for the fill tool's preview (no paid call). */
async function fillPreview(env, hh) {
  const { results } = await env.DB.prepare(
    "SELECT name, shelf_source FROM items WHERE household_id = ? AND deleted_at IS NULL",
  ).bind(hh).all();
  const todo = results.filter((r) => !r.shelf_source);
  const excluded = todo.filter((r) => isExcluded(r.name)).length;
  return {
    todo: todo.length - excluded,
    excluded,
    claude: results.filter((r) => r.shelf_source === "claude").length,
    person: results.filter((r) => r.shelf_source === "person").length,
    rule: results.filter((r) => r.shelf_source === "rule").length,
    batch: SHELF_BATCH,
  };
}

/**
 * POST /api/items/shelf-fill, admins only. body { dry_run: true } counts;
 * body { after?: item id } looks up the next SHELF_BATCH items (by id, after
 * `after`) without a shelf life, in one Claude request, and answers with
 * `next` (null when done). Items that already have a person's or Claude's
 * value are never selected.
 */
export async function shelfFill(env, who, body) {
  if (!who.isAdmin) return { status: 403, error: "forbidden" };
  if (body?.dry_run === true) return { result: await fillPreview(env, who.householdId) };
  if (!env.ANTHROPIC_API_KEY) return { status: 503, error: "shelf_off" };
  const after = typeof body?.after === "string" ? body.after.slice(0, 64) : "";
  const { results } = await env.DB.prepare(
    "SELECT id FROM items WHERE household_id = ? AND deleted_at IS NULL AND shelf_source IS NULL AND id > ? ORDER BY id LIMIT ?",
  ).bind(who.householdId, after, SHELF_BATCH).all();
  if (!results.length) return { result: { next: null, asked: 0, written: 0, excluded: 0, failed: 0, results: [] } };
  const out = await lookupShelf(env, who, results.map((r) => r.id), { bucket: "shelf_fill", limit: SHELF_FILL_DAILY_LIMIT });
  if (out.limited && out.asked === 0) return { status: 429, error: "too_many_shelf" };
  return { result: { ...out, next: results.length < SHELF_BATCH ? null : results.at(-1).id } };
}
