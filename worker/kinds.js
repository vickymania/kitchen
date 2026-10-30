// A product's kind, asked of Claude Haiku when neither AH's category nor the
// name rules (public/shared/product-kinds.js) know it (28-10-2026: a
// snack, cup or ready meal is never the product for an ingredient item).
//
// After an op batch that wrote products without a kind (a receipt photo, a
// product typed in), those still without one are sent in ONE request per
// KIND_BATCH to `claude-haiku-5-5`; each answer is written as a product.put
// with only `kind`, so the phones get it through the delta sync. It runs
// after the answer went out (ctx.waitUntil): nobody waits for it.
//
// The same request also names new items in English (items.name_en, Thomas
// 30-10-2026: "never add a separate Claude call where one already happens"):
// an item made without any Claude call (typed on the list, the AH and Lidl
// imports) goes in the `items` part of this request, so a product's kind and
// its item's English name cost one call. Each answer is an item.translate
// with source "claude" (a person's English name is never replaced).
//
// Never an excluded thing (public/shared/excluded.js): such a product or item is skipped, its name never goes to Claude.
// Every lookup is paid: the daily counter goes up before the call, like
// worker/shelf.js.
import { isExcluded } from "../public/shared/excluded.js";
import { KINDS } from "../public/shared/product-kinds.js";
import { nameKey } from "../public/shared/ingredients.js";
import { applyOps } from "./ops-store.js";
import { askClaude, takeSome, CHEAP_MODEL } from "./claude.js";

export const KIND_DAILY_LIMIT = 200;   // products per household per day
export const KIND_BATCH = 40;          // products per Claude request
export const NAME_EN_DAILY_LIMIT = 200; // English item names per household per day
export const NAME_EN_BATCH = 60;        // items per Claude request (next to up to KIND_BATCH products)

const NAMES_PROPERTY = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["n", "name_en"],
    properties: {
      n: { type: "integer", description: "The number of the item in the item list" },
      name_en: { type: "string", description: "The item's usual English name, as on a shopping list (\"Semi-skimmed milk\", \"Cat litter\")" },
    },
  },
};

export const KIND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["products"],
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["n", "kind"],
        properties: {
          n: { type: "integer", description: "The number of the product in the list" },
          kind: { type: "string", enum: KINDS },
        },
      },
    },
  },
};

const PROMPT = [
  "Classify each product of a Dutch household's groceries (names are Dutch, bought at Dutch supermarkets) as one kind:",
  "- ingredient: something one cooks or eats as a basic food (pasta, rice, vegetables, meat, cheese, milk, bread, spices, sauces, a seasoning mix).",
  "- ready_meal: a meal or cup ready to eat or heat (a pasta or noodle cup, a ready meal, a pizza, a filled sandwich, a soup in a bag).",
  "- snack: sweets, crisps, biscuits, chocolate, ice cream, fried snacks, desserts.",
  "- drink: soft drinks, juice, water, coffee, tea, energy drinks.",
  "- household: cleaning, paper, bags, candles, batteries.",
  "- personal_care: toothpaste, soap, deodorant, medicine, vitamins.",
  "- pet: food or litter for a cat or dog.",
  "- other: none of these.",
  "Answer every numbered product exactly once, with its number as n.",
].join("\n");

const ID_CHUNK = 90;

/** The products of `ids` still without a kind, excluded things counted and left out. */
export async function kindCandidates(env, hh, ids) {
  const want = [...new Set(ids.filter((x) => typeof x === "string"))];
  const out = [];
  let excluded = 0;
  for (let i = 0; i < want.length; i += ID_CHUNK) {
    const chunk = want.slice(i, i + ID_CHUNK);
    const { results } = await env.DB.prepare(
      `SELECT id, name, brand FROM products WHERE household_id = ? AND id IN (${chunk.map(() => "?").join(",")}) AND deleted_at IS NULL AND kind IS NULL`,
    ).bind(hh, ...chunk).all();
    for (const p of results) {
      const label = [p.brand, p.name].filter(Boolean).join(" ").trim();
      if (isExcluded(p.name) || isExcluded(label)) { excluded++; continue; }
      out.push({ id: p.id, label });
    }
  }
  return { products: out, excluded };
}

/** The answer's shape: `products` (kinds) and, when items are asked too, `items` (English names). */
export function kindSchema({ products = true, items = false } = {}) {
  return {
    type: "object",
    additionalProperties: false,
    required: [...(products ? ["products"] : []), ...(items ? ["items"] : [])],
    properties: {
      ...(products ? { products: KIND_SCHEMA.properties.products } : {}),
      ...(items ? { items: NAMES_PROPERTY } : {}),
    },
  };
}

const NAMES_PROMPT = [
  "Give each item of a Dutch household's shopping list (Dutch names) its usual English name, as an English shopping list would say it:",
  "short, the same thing (no brand unless the item is one), singular or plural as the Dutch is. Answer every item exactly once, with its number as n.",
].join("\n");

/**
 * The list Claude reads: "1. Knorr Goodpasta carbonara"; items to name in
 * English come first as "Item 1: Halfvolle melk", so the product list keeps
 * its numbers and ends the text.
 */
export function kindPrompt(products, items = []) {
  const named = items.length ? `${NAMES_PROMPT}\n\nItems:\n${items.map((x, i) => `Item ${i + 1}: ${x.name}`).join("\n")}` : "";
  const kinds = products.length ? `${PROMPT}\n\nProducts:\n${products.map((p, i) => `${i + 1}. ${p.label}`).join("\n")}` : "";
  return [named, kinds].filter(Boolean).join("\n\n");
}

/** The items of `ids` still without an English name, excluded things counted and left out. */
export async function nameCandidates(env, hh, ids) {
  const want = [...new Set(ids.filter((x) => typeof x === "string"))];
  const out = [];
  let excluded = 0;
  for (let i = 0; i < want.length; i += ID_CHUNK) {
    const chunk = want.slice(i, i + ID_CHUNK);
    const { results } = await env.DB.prepare(
      `SELECT id, name FROM items WHERE household_id = ? AND id IN (${chunk.map(() => "?").join(",")}) AND deleted_at IS NULL AND name_en IS NULL`,
    ).bind(hh, ...chunk).all();
    for (const r of results) {
      if (isExcluded(r.name)) { excluded++; continue; }
      out.push({ id: r.id, name: r.name });
    }
  }
  return { items: out, excluded };
}

/** Claude's English names, checked: item id -> name. A wrong row is left out. */
export function nameAnswers(items, answer) {
  const out = new Map();
  for (const a of Array.isArray(answer?.items) ? answer.items : []) {
    const x = items[Number(a?.n) - 1];
    const name = typeof a?.name_en === "string" ? a.name_en.replace(/\s+/g, " ").trim() : "";
    if (!x || out.has(x.id) || !name || name.length > 60 || !nameKey(name) || isExcluded(name)) continue;
    out.set(x.id, name);
  }
  return out;
}

/** Claude's answer, checked: product id -> kind. A wrong row is left out. */
export function kindAnswers(products, answer) {
  const out = new Map();
  for (const a of Array.isArray(answer?.products) ? answer.products : []) {
    const p = products[Number(a?.n) - 1];
    if (!p || out.has(p.id) || !KINDS.includes(a.kind)) continue;
    out.set(p.id, a.kind);
  }
  return out;
}

/**
 * Look up and store the kind of the products `ids` that still have none.
 * Resolves to { asked, written, excluded, failed, limited }.
 */
export async function lookupKinds(env, who, ids, { bucket = "kind", limit = KIND_DAILY_LIMIT, itemIds = [] } = {}) {
  const out = { asked: 0, written: 0, excluded: 0, failed: 0, limited: false, names_asked: 0, named: 0 };
  if (!env.ANTHROPIC_API_KEY) return { ...out, off: true };
  const found = await kindCandidates(env, who.householdId, ids);
  const unnamed = itemIds.length ? await nameCandidates(env, who.householdId, itemIds) : { items: [], excluded: 0 };
  out.excluded = found.excluded + unnamed.excluded;
  let todo = found.products;
  let names = unnamed.items;
  if (!todo.length && !names.length) return out;
  const allowed = await takeSome(env, bucket, who.householdId, todo.length, limit);
  const allowedNames = await takeSome(env, "name_en", who.householdId, names.length, NAME_EN_DAILY_LIMIT);
  if (allowed < todo.length || allowedNames < names.length) out.limited = true;
  todo = todo.slice(0, allowed);
  names = names.slice(0, allowedNames);
  // One request per KIND_BATCH products and NAME_EN_BATCH items, both in the same request.
  const rounds = Math.max(Math.ceil(todo.length / KIND_BATCH), Math.ceil(names.length / NAME_EN_BATCH));
  for (let r = 0; r < rounds; r++) {
    const chunk = todo.slice(r * KIND_BATCH, (r + 1) * KIND_BATCH);
    const naming = names.slice(r * NAME_EN_BATCH, (r + 1) * NAME_EN_BATCH);
    out.asked += chunk.length;
    out.names_asked += naming.length;
    const res = await askClaude(env, {
      what: chunk.length ? "product kind" : "item name",
      model: CHEAP_MODEL,
      schema: naming.length ? kindSchema({ products: chunk.length > 0, items: true }) : KIND_SCHEMA,
      maxTokens: 200 + chunk.length * 30 + naming.length * 30,
      content: [{ type: "text", text: kindPrompt(chunk, naming) }],
    });
    if (res.failed) {
      out.failed += chunk.length;
      if (res.failed === "rate_limited") break;
      continue;
    }
    const answers = kindAnswers(chunk, res.answer);
    out.failed += chunk.length - answers.size;
    const ops = [...answers].map(([id, kind]) => ({
      type: "product.put", op_id: `kind-${crypto.randomUUID()}`, id, product: { kind },
    }));
    const named = [...nameAnswers(naming, res.answer)].map(([itemId, name]) => ({
      type: "item.translate", op_id: `name-${crypto.randomUUID()}`, item_id: itemId, name_en: name, source: "claude",
    }));
    const results = ops.length || named.length ? await applyOps(env.DB, who, [...ops, ...named]) : [];
    out.written += results.slice(0, ops.length).filter((x) => x.ok).length;
    out.named += results.slice(ops.length).filter((x) => x.ok && !x.result?.kept).length;
  }
  return out;
}
