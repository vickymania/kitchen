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
// Never an excluded thing (public/shared/excluded.js): such a product is skipped, its name never goes to Claude.
// Every lookup is paid: the daily counter goes up before the call, like
// worker/shelf.js.
import { isExcluded } from "../public/shared/excluded.js";
import { KINDS } from "../public/shared/product-kinds.js";
import { applyOps } from "./ops-store.js";
import { askClaude, takeSome, CHEAP_MODEL } from "./claude.js";

export const KIND_DAILY_LIMIT = 200;   // products per household per day
export const KIND_BATCH = 40;          // products per Claude request

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

/** The list Claude reads: "1. Knorr Goodpasta carbonara". */
export function kindPrompt(products) {
  return `${PROMPT}\n\nProducts:\n${products.map((p, i) => `${i + 1}. ${p.label}`).join("\n")}`;
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
export async function lookupKinds(env, who, ids, { bucket = "kind", limit = KIND_DAILY_LIMIT } = {}) {
  const out = { asked: 0, written: 0, excluded: 0, failed: 0, limited: false };
  if (!env.ANTHROPIC_API_KEY) return { ...out, off: true };
  const found = await kindCandidates(env, who.householdId, ids);
  out.excluded = found.excluded;
  let todo = found.products;
  if (!todo.length) return out;
  const allowed = await takeSome(env, bucket, who.householdId, todo.length, limit);
  if (allowed < todo.length) out.limited = true;
  todo = todo.slice(0, allowed);
  for (let i = 0; i < todo.length; i += KIND_BATCH) {
    const chunk = todo.slice(i, i + KIND_BATCH);
    out.asked += chunk.length;
    const res = await askClaude(env, {
      what: "product kind",
      model: CHEAP_MODEL,
      schema: KIND_SCHEMA,
      maxTokens: 200 + chunk.length * 30,
      content: [{ type: "text", text: kindPrompt(chunk) }],
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
    const results = ops.length ? await applyOps(env.DB, who, ops) : [];
    out.written += results.filter((r) => r.ok).length;
  }
  return out;
}
