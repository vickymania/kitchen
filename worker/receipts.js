// Reading a photo of a receipt (any store) with the Claude API. Nothing is
// stored here: the lines go back to the phone's review screen, and only what
// the person saves there becomes ops (receipt.save, purchase.add).
//
// The key is the worker secret ANTHROPIC_API_KEY (`npx wrangler secret put
// ANTHROPIC_API_KEY`). It is never logged or returned, also not in errors.
import { isExcluded } from "../public/shared/excluded.js";
import { askClaude, takeOne, MODEL } from "./claude.js";

export { MODEL };
export const DAILY_LIMIT = 25;          // reads per household per day: each one is a paid call
const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = { "image/jpeg": "image/jpeg", "image/png": "image/png", "image/webp": "image/webp" };

const LINE = {
  type: "object",
  additionalProperties: false,
  required: ["name", "name_en", "brand", "size", "quantity", "price", "kind"],
  properties: {
    name: { type: "string", description: "What the product is, in the receipt's language, written out in full (\"Halfvolle melk\", not \"HV MELK\")" },
    // Its English name in the same call (0029, 30-10-2026: never a second call for it).
    name_en: { type: "string", description: "The same thing in plain English as on a shopping list, without brand (\"Semi-skimmed milk\"); empty for a discount, deposit or other line" },
    brand: { type: "string", description: "Brand or store label when it is on the receipt (\"AH\", \"Calvé\"), else empty" },
    size: { type: "string", description: "Pack size when known (\"1 l\", \"500 g\", \"6 st\"), else empty" },
    quantity: { type: "number", description: "How many were bought; a weighed product is 1" },
    price: { type: "number", description: "What this line costs in total, in euros; discounts are negative" },
    kind: { type: "string", enum: ["product", "discount", "deposit", "other"] },
  },
};

export const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["store", "date", "lines", "total"],
  properties: {
    store: { type: "string", description: "Store name (\"Albert Heijn\", \"Dirk\"), empty if not visible" },
    date: { type: "string", description: "Purchase date as YYYY-MM-DD, empty if not visible" },
    lines: { type: "array", items: LINE },
    total: { type: "number", description: "The total paid, in euros, as printed" },
  },
};

const PROMPT = [
  "This is a photo of a supermarket receipt. Read every line that has a price.",
  "One line per product line on the receipt. A discount or bonus that clearly belongs to the product line above it may be subtracted from that line; otherwise give it its own line with kind \"discount\" and a negative price.",
  "Deposits (statiegeld) are kind \"deposit\". Bags, service costs and anything that is not a product are kind \"other\".",
  "Do not invent lines. If a word is unreadable, write what you can read.",
  "Subtotals, payment lines, VAT tables and loyalty points are not lines.",
].join("\n");

const toCents = (euros) => Math.round(Number(euros) * 100);

function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

/** The structured answer, turned into what the review screen shows. */
export function reviewOf(answer) {
  const lines = [];
  let sum = 0;
  const skipped = { count: 0, cents: 0 };
  for (const l of Array.isArray(answer?.lines) ? answer.lines.slice(0, 150) : []) {
    const price = toCents(l.price);
    if (!Number.isFinite(price)) continue;
    sum += price;
    // An excluded thing counts for the sum but never reaches the screen.
    if (isExcluded(l.name) || isExcluded(`${l.brand ?? ""} ${l.name ?? ""}`)) {
      skipped.count++;
      skipped.cents += price;
      continue;
    }
    lines.push({
      name: String(l.name ?? "").trim().slice(0, 120),
      name_en: typeof l.name_en === "string" && !isExcluded(l.name_en) ? l.name_en.replace(/\s+/g, " ").trim().slice(0, 60) : "",
      brand: String(l.brand ?? "").trim().slice(0, 60),
      size: String(l.size ?? "").trim().slice(0, 40),
      qty: Number.isFinite(Number(l.quantity)) && Number(l.quantity) > 0 ? Number(l.quantity) : 1,
      price_cents: price,
      kind: ["product", "discount", "deposit", "other"].includes(l.kind) ? l.kind : "product",
    });
  }
  const total = toCents(answer?.total);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(answer?.date ?? "") ? answer.date : null;
  return {
    store: String(answer?.store ?? "").trim().slice(0, 40),
    bought_on: date,
    total_cents: Number.isFinite(total) ? total : null,
    sum_cents: sum,
    // A cent of rounding per line is not a reading error.
    sum_ok: Number.isFinite(total) && Math.abs(sum - total) <= 1,
    lines,
    skipped,
  };
}

export async function readReceipt(request, env, who) {
  if (!env.ANTHROPIC_API_KEY) return { status: 503, error: "receipts_off" };
  const type = TYPES[(request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase()];
  if (!type) return { status: 415, error: "bad_type" };
  const body = await request.arrayBuffer();
  if (!body.byteLength) return { status: 400, error: "bad_type" };
  if (body.byteLength > MAX_BYTES) return { status: 413, error: "too_large" };
  if (!(await takeOne(env, "receipt", who.householdId, DAILY_LIMIT))) return { status: 429, error: "too_many_receipts" };

  const out = await askClaude(env, {
    what: "receipt read",
    schema: SCHEMA,
    maxTokens: 8000,
    content: [
      { type: "image", source: { type: "base64", media_type: type, data: base64(body) } },
      { type: "text", text: PROMPT },
    ],
  });
  if (out.failed === "network" || out.failed === "api") return { status: 502, error: "receipt_failed" };
  if (out.failed === "rate_limited") return { status: 429, error: "too_many_receipts" };
  if (out.failed) return { status: 422, error: "receipt_unreadable" };
  const answer = out.answer;
  const review = reviewOf(answer);
  if (!review.lines.length && !review.skipped.count) return { status: 422, error: "receipt_unreadable" };
  return { review };
}
