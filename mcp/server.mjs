// MCP server "kitchen": lets Claude read and change the household's recipes
// and grocery list, through the same API and op engine as the phones. It
// replaces the mstodo server for food; the skills `add-recipe` and
// `weekly-groceries` use it (skills/).
//
// No dependencies: MCP over stdio is newline-delimited JSON-RPC, and the four
// methods a tool server needs are small enough to write out.
//
// Reads KITCHEN_TOKEN and KITCHEN_ORIGIN from mcp/.env (tools/admin.mjs
// bootstrap writes them), or with KITCHEN_TOKEN_FILE set only that file's
// token (the home server's nightly check). Register once:
//   claude mcp add --scope user kitchen -- node "<path>/kitchen/mcp/server.mjs"
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { parseListInput, parseAmount, scaleIngredient, amountOf, nameKey, formatQty } from "../public/shared/ingredients.js";
import { parseRecipeText } from "../public/shared/recipe-text.js";
import { dueItems, localToday } from "../public/shared/intervals.js";
import { isExcluded } from "../public/shared/excluded.js";
import { currentOffers, offerMatches, productOfferMatches, isCoupon, brandedName } from "../public/shared/offers.js";
import { resolveProduct, preferencesOf } from "../public/shared/preferences.js";
import { canonicalStore, sameStore } from "../public/shared/stores.js";
import { pantryGroups, displayAmount, daysLeft, wasteCounts, withUsage, rowRate, RATE_MAX } from "../public/shared/pantry.js";
import { dealsFor, liveRules, liveLineOffers, REGULAR_STORES } from "../public/shared/deals.js";
import { pricesOf, oldPricesDay, shortStore } from "../public/shared/store-prices.js";
import { lowStock, LOW_DEFAULT } from "../public/shared/low-stock.js";
import { didYouMean } from "../public/shared/suggest.js";
import { compactKey } from "../public/shared/item-names.js";
import { findItem } from "../public/shared/ops.js";
import { listTargets, itemFinder } from "../public/shared/ingredient-match.js";
import { addDays } from "../public/shared/shelf-life.js";

/** kitchen_recent_purchases: candidate items per purchase, and the output size (Claude cannot read more). */
const CANDIDATES_MAX = 15;
const RECENT_CHARS_MAX = 14_000;
import { starsByRecipe } from "../public/shared/recipe-ratings.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  // The home server's nightly check (fetcher/review.mjs) passes its own
  // device's token file (role reviewer): then mcp/.env is never read.
  const tokenFile = process.env.KITCHEN_TOKEN_FILE;
  if (tokenFile) {
    let fileToken = null;
    try {
      fileToken = fs.readFileSync(tokenFile, "utf8").trim() || null;
    } catch {
      // handled by api(): no token
    }
    return { token: fileToken, origin: (process.env.KITCHEN_ORIGIN ?? "https://recipes.vexed.works").replace(/\/$/, "") };
  }
  const file = path.join(HERE, ".env");
  const env = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return { token: process.env.KITCHEN_TOKEN ?? env.KITCHEN_TOKEN, origin: (process.env.KITCHEN_ORIGIN ?? env.KITCHEN_ORIGIN ?? "https://recipes.vexed.works").replace(/\/$/, "") };
}

const { token, origin } = loadEnv();
const newId = () => randomBytes(12).toString("base64url");

// ------------------------------------------------------------------ API

async function api(method, pathname, body, type = "application/json") {
  if (!token) throw new Error("No KITCHEN_TOKEN in kitchen/mcp/.env: run `node tools/admin.mjs bootstrap` first.");
  const res = await fetch(origin + pathname, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": type } : {}) },
    body: body === undefined ? undefined : type === "application/json" ? JSON.stringify(body) : body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${pathname}: ${res.status} ${data.error ?? ""}`.trim());
  return data;
}

// The server process lives as long as the Claude session, so it keeps the
// household in memory and asks only for what changed since its last look,
// like the phones do. A full load happens once per session, not per tool call.
const KINDS = ["recipes", "entries", "members", "items", "products", "ratings", "purchases", "preferences", "offers", "pantry", "pantry_events", "deal_rules", "recipe_ratings", "aliases", "store_prices"];
const cache = { rev: 0, ...Object.fromEntries(KINDS.map((k) => [k, new Map()])) };

async function state() {
  const s = await api("GET", `/api/sync?since=${cache.rev}`);
  if (s.full) for (const kind of KINDS) cache[kind].clear();
  for (const kind of KINDS) {
    for (const row of s[kind] ?? []) {
      if (row.deleted_at || row.removed_at) cache[kind].delete(row.id);
      else cache[kind].set(row.id, row);
    }
  }
  cache.rev = s.rev;
  return {
    recipes: [...cache.recipes.values()],
    entries: [...cache.entries.values()],
    members: Object.fromEntries([...cache.members.values()].map((m) => [m.id, m.name])),
    // The shape public/shared/intervals.js reads.
    view: Object.fromEntries(["items", "entries", "purchases", "pantry", "recipes"].map((k) => [k, Object.fromEntries(cache[k])])),
    // The pantry (phase 4), the shape public/shared/pantry.js reads.
    pantry: Object.fromEntries(cache.pantry),
    pantryEvents: Object.fromEntries(cache.pantry_events),
    products: [...cache.products.values()],
    ratings: [...cache.ratings.values()],
    items: cache.items,
    // Checkjebon's shelf prices of their products (public/shared/store-prices.js).
    storePrices: Object.fromEntries(cache.store_prices),
    // The shape public/shared/suggest.js reads (names, other names, purchases).
    names: Object.fromEntries(["items", "aliases", "purchases"].map((k) => [k, Object.fromEntries(cache[k])])),
    // Stars per recipe (public/shared/recipe-ratings.js): Map recipe_id -> { average, count, byMember }.
    recipeStars: starsByRecipe(Object.fromEntries(cache.recipe_ratings)),
    // The shape public/shared/preferences.js and offers.js read.
    data: Object.fromEntries(["preferences", "products", "recipes", "offers"].map((k) => [k, Object.fromEntries(cache[k])])),
    // The shape public/shared/deals.js reads.
    deals: Object.fromEntries(["items", "entries", "purchases", "pantry", "pantry_events", "offers", "preferences", "products", "recipes", "deal_rules"]
      .map((k) => [k, Object.fromEntries(cache[k])])),
  };
}

const productLabel = (p) => [brandedName(p), p.size].filter(Boolean).join(", ");
const euros = (c) => (c === null || c === undefined ? "" : `€${(c / 100).toFixed(2).replace(".", ",")}`);

/** Products matching a query on name, brand or item; never an excluded thing. */
function findProducts(s, query) {
  const q = nameKey(query ?? "");
  return s.products.filter((p) => !isExcluded(p.name) && (!q
    || nameKey(`${p.brand} ${p.name}`).includes(q)
    || nameKey(s.items.get(p.item_id)?.name ?? "").includes(q)));
}

async function send(ops) {
  const stamped = ops.map((o) => ({ op_id: newId(), ...o }));
  const { results } = await api("POST", "/api/ops", { ops: stamped });
  const refused = results.filter((r) => !r.ok);
  if (refused.length) throw new Error(`Refused: ${refused.map((r) => r.error).join(", ")}`);
  return results;
}

// ------------------------------------------------------------- formatting

const UNIT_NL = { g: "gr", tbsp: "el", tsp: "tl", clove: "teen", can: "blik", cube: "blokje", pinch: "snufje", packet: "zakje",
  pack: "pak", bunch: "bos", handful: "handje", sprig: "takje", dash: "scheutje", slice: "plak", piece: "stuk", cup: "kopje",
  sheet: "vel", jar: "pot", bottle: "fles", bowl: "bakje" };

function amountText(a) {
  if (!a) return "";
  if (a.text !== undefined) return a.text;
  if (a.qty === null || a.qty === undefined) return "";
  return [formatQty(a.qty) + (a.qty_max ? `-${formatQty(a.qty_max)}` : ""), a.unit ? UNIT_NL[a.unit] ?? a.unit : ""].filter(Boolean).join(" ");
}

const forProductText = (s, r) => (r.product_id && s.deals.products[r.product_id] ? ` (${productLabel(s.deals.products[r.product_id])})` : "");

function offerText(o) {
  return [o.store, isCoupon(o) ? "Lidl Plus coupon (activate it in the Lidl Plus app)" : null, [o.brand && !nameKey(o.name).includes(nameKey(o.brand)) ? o.brand : null, o.name].filter(Boolean).join(" "),
    o.size, o.deal, euros(o.price_cents), `until ${o.valid_until}`].filter(Boolean).join(" · ");
}

/**
 * What to buy for a line: every preference of its item that holds for it
 * (any recipe or one of the line's recipes), "product (store, for recipe)".
 */
function preferredText(data, e) {
  const recipes = new Set((e.sources ?? []).map((x) => x.recipe_id));
  return preferencesOf(data.preferences, e.item_id)
    .filter((p) => (!p.recipe_id || recipes.has(p.recipe_id)) && data.products[p.product_id])
    .sort((a, b) => Number(Boolean(b.recipe_id)) - Number(Boolean(a.recipe_id)) || a.store.localeCompare(b.store))
    .map((p) => {
      const where = [p.store || "any store", p.recipe_id ? `for ${data.recipes[p.recipe_id]?.title ?? "a recipe"}` : null].filter(Boolean).join(", ");
      return `${productLabel(data.products[p.product_id])} (${where})`;
    })
    .join("; ");
}

function entryLine(e, members) {
  const parts = [e.title];
  const amounts = (e.amounts ?? []).map(amountText).filter(Boolean).join(" + ");
  if (amounts) parts.push(amounts);
  if (e.sources?.length) parts.push(`for ${e.sources.map((s) => s.title).join(", ")}`);
  if (e.note) parts.push(e.note);
  if (e.added_by && members[e.added_by]) parts.push(`added by ${members[e.added_by]}`);
  return `- ${parts.join(" — ")}  [id: ${e.id}]`;
}

/** "4.5/5 from 2 (Thomas 5, Sam 4)", or null without stars. */
function starsLine(stars, members) {
  if (!stars) return null;
  const who = Object.entries(stars.byMember).map(([m, n]) => `${members[m] ?? "?"} ${n}`).join(", ");
  return `${stars.average}/5 from ${stars.count} (${who})`;
}

function recipeSummary(r, stars = null, members = {}) {
  const ings = r.ingredients.filter((i) => !i.heading);
  const kind = !ings.length && !r.steps.length ? "idea (only a title)" : `${ings.length} ingredients, ${r.steps.length} steps`;
  const rated = starsLine(stars, members);
  return `- ${r.title}${r.servings ? ` (${r.servings} p)` : ""} — ${kind}${r.photo ? ", photo" : ""}${rated ? `, stars ${rated}` : ""}  [id: ${r.id}]`;
}

function recipeFull(r, stars = null, members = {}) {
  const lines = [`# ${r.title}`, r.servings ? `Serves ${r.servings}` : "Servings not set"];
  lines.push(`Stars: ${starsLine(stars, members) ?? "none yet"}`);
  if (r.nutrition?.carbs_g != null) lines.push(`Carbs per serving (from the source): ${r.nutrition.carbs_g} g`);
  lines.push("", "Ingredients:");
  for (const i of r.ingredients) {
    lines.push(i.heading ? `  ${i.name}:` : `  - ${[amountText(i), i.name].filter(Boolean).join(" ")}${i.note ? ` (${i.note})` : ""}${i.optional ? " [optional]" : ""}`);
  }
  lines.push("", "Method:", ...r.steps.map((s, n) => `  ${n + 1}. ${s}`));
  if (r.notes) lines.push("", "Notes:", r.notes);
  if (r.source_url) lines.push("", `Source: ${r.source_url}`);
  lines.push("", `[id: ${r.id}]`);
  return lines.join("\n");
}

const UNIT_EN = { kg: "kg", l: "litre", piece: "piece" };

/** "at most €1,25 each; only on offer; at most €4,00 per kg; only at Albert Heijn and Dirk" */
function ruleText(rule) {
  return [
    rule.max_price_cents != null ? `at most ${euros(rule.max_price_cents)} each (multi-buys per piece)` : null,
    rule.offer_only ? `only on offer${rule.min_discount_pct ? ` with at least ${rule.min_discount_pct}% off` : ""}` : null,
    rule.max_unit_price_cents != null ? `at most ${euros(rule.max_unit_price_cents)} per ${UNIT_EN[rule.unit] ?? rule.unit}` : null,
    rule.require_words?.length ? `only when the offer says ${rule.require_words.join(" and ")} (no kind named: a check hit)` : null,
    !rule.detour ? `only at ${REGULAR_STORES.join(" and ")}`
      : rule.detour_min_discount_pct ? `worth a detour (other stores from ${rule.detour_min_discount_pct}% off)` : "worth a detour (any store)",
    rule.match_words?.length ? `also found by: ${rule.match_words.join(", ")}` : null,
    rule.exclude_words?.length ? `never when it says: ${rule.exclude_words.join(", ")}` : null,
  ].filter(Boolean).join("; ");
}

const LOW_EN = {
  pantry_empty: () => "nothing left in the pantry",
  pantry_low: (r) => `little left in the pantry (${displayAmount(r.amount)})`,
  pantry_use_by: (r) => `what is left must be used by ${r.use_by}`,
  again_due: (r) => `due again: last bought ${r.since} days ago, usually every ~${r.interval} days`,
  again_soon: (r) => `due again in ~${r.days} days, before the offer ends`,
  pantry_runs_out: (r) => `counted down at its usage rate, runs out in ~${r.days} days`,
};

/** "6 per week", "1 every 30 days": a rate per day as people say it. */
function rateEn(perDay) {
  const near = (x) => Math.abs(x - Math.round(x)) < 0.02 && Math.round(x) >= 1;
  if (perDay >= 1 && near(perDay)) return `${Math.round(perDay)} per day`;
  if (near(perDay * 7)) return `${Math.round(perDay * 7)} per week`;
  if (near(perDay * 30)) return `${Math.round(perDay * 30)} per month`;
  // Only from every other day: a learned 0.83 a day is "5.8 per week", not "1 every 1 days".
  if (perDay <= 0.5) return `1 every ${Math.round(1 / perDay)} days`;
  return `${Math.round(perDay * 70) / 10} per week`;
}
const RATE_BY = { person: "set by the household", claude: "estimated by Claude", rule: "default estimate for household goods" };
/** Where a rate comes from; a learned one says how many signals it rests on (public/shared/rate-learning.js). */
function rateBy(source, item) {
  if (source === "learned") {
    const n = Math.max(1, Number(item?.rate_samples) || 0);
    return `learned from ${n} time${n === 1 ? "" : "s"} (op, list, Nog niet, rebuys)`;
  }
  return RATE_BY[source] ?? "set";
}

/** "€1,19 each, €0,03 per piece, 57% off" from effectivePrice(). */
function effText(eff) {
  const parts = [];
  if (eff.piece_cents !== null) parts.push(`${euros(Math.round(eff.piece_cents))} each${eff.min_qty > 1 ? ` (buy ${eff.min_qty})` : ""}`);
  for (const u of ["kg", "l", "piece"]) {
    if (eff.per[u] !== null && !(u === "piece" && eff.per.piece === eff.piece_cents)) parts.push(`${euros(Math.round(eff.per[u]))} per ${UNIT_EN[u]}`);
  }
  if (eff.discount_pct !== null) parts.push(`${Math.round(eff.discount_pct)}% off`);
  return parts.join(", ");
}

/**
 * "AH €2,19 · Dirk €1,89 (cheapest) · Jumbo €2,05", with "prices of 26 Oct" when older
 * than two days; "" without a matched price. With a store only that store's.
 */
function shelfPrices(s, product, shop = null) {
  const today = localToday();
  const list = pricesOf(s.storePrices, product, today, { store: shop });
  if (!list.length) return "";
  const old = oldPricesDay(list, today);
  return list.map((x) => `${shortStore(x.store)} ${euros(x.cents)}${x.cheapest ? " (cheapest)" : ""}`).join(" · ") + (old ? ` (prices of ${old})` : "");
}

// ----------------------------------------------------------------- photos

const PHOTO_TYPES = { "image/jpeg": "image/jpeg", "image/jpg": "image/jpeg", "image/png": "image/png", "image/webp": "image/webp" };

async function photoFromUrl(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (kitchen MCP)" } });
  if (!res.ok) throw new Error(`photo: ${res.status}`);
  const type = PHOTO_TYPES[(res.headers.get("Content-Type") ?? "").split(";")[0].trim()];
  if (!type) throw new Error("photo: not a JPEG, PNG or WebP");
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > 5 * 1024 * 1024) throw new Error("photo: larger than 5 MB, pick a smaller version");
  return (await api("POST", "/api/photos", body, type)).key;
}

// ------------------------------------------------------------------ tools

const TOOLS = [
  {
    name: "kitchen_list_get",
    description: "The shared grocery list: what still has to be bought (amounts, for which recipe, added by whom), the household's preferred product per line (per store and per recipe: e.g. store-brand tortilla chips for one recipe, the brand otherwise), offers on those products, and how much is in the cart already. With 'store', each line names the one product to buy there and only that store's offers. A product sold at one store only says 'haal bij <store>' with any store or none.",
    inputSchema: {
      type: "object",
      properties: {
        include_cart: { type: "boolean", description: "Also list what is checked off in the cart" },
        store: { type: "string", description: "The store being shopped at, e.g. 'AH' or 'Dirk'" },
      },
    },
    async run({ include_cart = false, store = "" }) {
      const s = await state();
      const shop = canonicalStore(store) || null;
      const deals = currentOffers(s.data.offers, localToday());
      const hits = dealsFor(s.deals, localToday());
      const open = s.entries.filter((e) => !e.checked_at).sort((a, b) => b.created_at.localeCompare(a.created_at));
      const cart = s.entries.filter((e) => e.checked_at);
      const out = [`To get (${open.length})${shop ? ` at ${shop}` : ""}:`];
      for (const e of open) {
        out.push(entryLine(e, s.members));
        const resolved = resolveProduct(s.data, e, shop);
        if (resolved?.onlyAt) {
          // Sold at one store only: "haal bij Lidl", whatever store is chosen.
          out.push(`    haal bij ${resolved.onlyAt}: ${productLabel(resolved.product)} (only sold at ${resolved.onlyAt})${resolved.why.recipe ? ` (for ${resolved.why.recipe})` : ""}`);
        } else if (shop) {
          if (resolved) out.push(`    buy at ${shop}: ${productLabel(resolved.product)}${resolved.why.recipe ? ` (for ${resolved.why.recipe})` : ""}`);
        } else {
          const prefs = preferredText(s.data, e);
          if (prefs) out.push(`    preferred: ${prefs}`);
        }
        const { mine, named } = liveLineOffers(e, resolved?.product, deals, hits, shop);
        if (mine.length) out.push(`    their product on offer: ${mine.slice(0, 3).map(offerText).join(" | ")}`);
        else if (named.length) out.push(`    on offer by name: ${named.slice(0, 2).map(offerText).join(" | ")}`);
        const priced = resolved?.product ?? resolveProduct(s.data, e, null)?.product;
        const prices = priced ? shelfPrices(s, priced, shop) : "";
        if (prices) out.push(`    shelf prices: ${prices}`);
      }
      out.push("", `In the cart: ${cart.length}`);
      if (include_cart) out.push(...cart.map((e) => entryLine(e, s.members)));
      return out.join("\n");
    },
  },
  {
    name: "kitchen_list_add",
    description: "Put things on the shared grocery list. If an item is already open on the list, the app adds the amount to that line (one line per product). Give each item a short Dutch title like the existing ones ('Champignons'), and an amount when there is one ('250 gr', '2').",
    inputSchema: {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["title"],
            properties: {
              title: { type: "string" },
              amount: { type: "string", description: "E.g. '250 gr', '2', '1 pak'" },
              note: { type: "string", description: "E.g. 'AH bonus t/m zondag: 2e halve prijs'" },
              recipe_id: { type: "string", description: "When it is for a recipe" },
            },
          },
        },
      },
    },
    async run({ items }) {
      const s = await state();
      const ops = items.map((it) => {
        const typed = parseListInput(`${it.amount ?? ""} ${it.title}`.trim());
        const recipe = it.recipe_id ? s.recipes.find((r) => r.id === it.recipe_id) : null;
        return {
          type: "entry.add", id: newId(), item_id: newId(), title: it.amount ? it.title.trim() : typed.title,
          amounts: it.amount ? parseAmount(it.amount) : typed.amounts,
          note: it.note ?? "", ...(recipe ? { source: { recipe_id: recipe.id, title: recipe.title } } : {}),
        };
      });
      const results = await send(ops);
      // Which item each line went to (an exact name, an other name or the
      // same without spaces links; anything else makes a new item), so a
      // wrong or new link is said, not silent (30-10-2026).
      const after = await state();
      const lines = ops.map((op, i) => {
        const r = results[i]?.result ?? {};
        const item = after.items.get(r.item_id);
        const name = item?.name ?? op.title;
        const how = r.new_item ? "NEW item" : compactKey(op.title) === compactKey(name) ? "linked" : `linked by another name of "${name}"`;
        const merged = r.merged_into ? ", added to the line already open" : "";
        const meant = r.new_item ? didYouMean(after.names, op.title, r.item_id) : null;
        return `- "${op.title}" → ${name} (${how}${merged})${meant ? `; did you mean "${meant.item.name}"? Then kitchen_item_merge it into that, so the name links next time` : ""}`;
      });
      return [`${items.length} put on the list:`, ...lines].join("\n");
    },
  },
  {
    name: "kitchen_list_check",
    description: "Check lines off (into the cart) or put them back on the list. Ids come from kitchen_list_get.",
    inputSchema: { type: "object", required: ["ids"], properties: { ids: { type: "array", items: { type: "string" } }, checked: { type: "boolean", default: true } } },
    async run({ ids, checked = true }) {
      await send(ids.map((id) => ({ type: "entry.check", id, checked })));
      return `${ids.length} ${checked ? "checked off" : "back on the list"}.`;
    },
  },
  {
    name: "kitchen_list_remove",
    description: "Remove lines from the list (delete, not check off). Ids come from kitchen_list_get.",
    inputSchema: { type: "object", required: ["ids"], properties: { ids: { type: "array", items: { type: "string" } } } },
    async run({ ids }) {
      await send(ids.map((id) => ({ type: "entry.delete", id })));
      return `${ids.length} removed.`;
    },
  },
  {
    name: "kitchen_recipes_search",
    description: "Search the recipe book by title or ingredient. Without a query: every recipe. Ideas (only a title) are marked. Each recipe shows the household's stars (1-5, average and per person); the best rated come first and low-rated ones (under 3) last, so suggest from the top.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    async run({ query = "" }) {
      const s = await state();
      const q = nameKey(query);
      const hits = s.recipes
        .filter((r) => !q || nameKey(r.title).includes(q) || r.ingredients.some((i) => nameKey(i.name).includes(q)))
        // Rated recipes by their average, unrated as a neutral 3: low-rated ones sink.
        .sort((a, b) => (s.recipeStars.get(b.id)?.average ?? 3) - (s.recipeStars.get(a.id)?.average ?? 3) || a.title.localeCompare(b.title, "nl"));
      return hits.length ? `${hits.length} recipe${hits.length === 1 ? "" : "s"}:\n${hits.map((r) => recipeSummary(r, s.recipeStars.get(r.id), s.members)).join("\n")}` : "Nothing found.";
    },
  },
  {
    name: "kitchen_recipe_get",
    description: "One recipe in full: the household's stars, ingredients with amounts, steps, notes.",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    async run({ id }) {
      const s = await state();
      const r = s.recipes.find((x) => x.id === id);
      return r ? recipeFull(r, s.recipeStars.get(r.id), s.members) : "No recipe with that id.";
    },
  },
  {
    name: "kitchen_recipe_save",
    description: "Create a recipe, or fill/change an existing one (with id, e.g. an idea that was only a title). Ingredients as separate Dutch lines with the amount first ('300 gr rijst', '2 ui', 'optioneel: maïzena'; a line ending in ':' is a heading). Steps as whole sentences, one action per step. A photo URL (JPEG/PNG/WebP, max 5 MB) is uploaded.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Empty = new recipe" },
        title: { type: "string" },
        servings: { type: "integer" },
        ingredients: { type: "array", items: { type: "string" } },
        steps: { type: "array", items: { type: "string" } },
        notes: { type: "string", description: "Tips or variations, no URL" },
        source_url: { type: "string" },
        photo_url: { type: "string" },
      },
    },
    async run(args) {
      const id = args.id || newId();
      const recipe = {};
      if (args.title !== undefined) recipe.title = args.title;
      if (args.servings !== undefined) recipe.servings = args.servings;
      if (args.ingredients !== undefined) recipe.ingredients = parseRecipeText(args.ingredients.join("\n")).ingredients;
      if (args.steps !== undefined) recipe.steps = args.steps;
      if (args.notes !== undefined) recipe.notes = args.notes;
      if (args.source_url !== undefined) recipe.source_url = args.source_url || null;
      let photoNote = "";
      if (args.photo_url) {
        try {
          recipe.photo = await photoFromUrl(args.photo_url);
        } catch (e) {
          photoNote = ` Photo not added (${e.message}).`;
        }
      }
      await send([{ type: "recipe.put", id, recipe }]);
      const n = recipe.ingredients?.filter((i) => !i.heading).length;
      return `${args.id ? "Updated" : "Created"}: ${args.title ?? "recipe"}${n !== undefined ? `, ${n} ingredients` : ""}${recipe.steps ? `, ${recipe.steps.length} steps` : ""}.${photoNote} [id: ${id}]`;
    },
  },
  {
    name: "kitchen_recipe_to_list",
    description: "Put a recipe's ingredients on the list, scaled to the number of people, marked with the recipe's name. Name in 'skip' the ingredients that are at home already (names as in the recipe). Optional ingredients only go along when named in 'include_optional'.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        servings: { type: "integer" },
        skip: { type: "array", items: { type: "string" } },
        include_optional: { type: "array", items: { type: "string" } },
      },
    },
    async run({ id, servings, skip = [], include_optional = [] }) {
      const s = await state();
      const r = s.recipes.find((x) => x.id === id);
      if (!r) return "No recipe with that id.";
      const skipKeys = new Set(skip.map(nameKey));
      const optKeys = new Set(include_optional.map(nameKey));
      const picked = r.ingredients
        .filter((i) => !i.heading && !skipKeys.has(nameKey(i.name)) && (!i.optional || optKeys.has(nameKey(i.name))))
        .map((i) => scaleIngredient(i, r.servings, servings ?? r.servings));
      if (!picked.length) return "Nothing to add.";
      // Each line on the household's own item, as the app's "Op de lijst" does
      // (public/shared/ingredient-match.js listTargets): "wit patentbloem" is Bloem.
      const names = { items: Object.fromEntries(s.items), aliases: s.names.aliases };
      const find = itemFinder(names);
      await send(picked.reverse().flatMap((i) => {
        const a = amountOf(i);
        const targets = listTargets(i.name, names, find);
        return targets.map((t) => ({ type: "entry.add", id: newId(), item_id: t.item?.id ?? newId(), title: t.title,
          amounts: a && targets.length === 1 ? [a] : [], source: { recipe_id: r.id, title: r.title } }));
      }));
      return `${picked.length} ingredients of ${r.title} put on the list${servings ? ` (for ${servings} people)` : ""}.`;
    },
  },
  {
    name: "kitchen_due_items",
    description: "What the household usually buys again and is due now (or soon), from the purchase history: per item the usual interval (median gap, from 3 purchases) and days since the last purchase. Things on the household's never-suggest list are never included, nor are things bought only for a recipe (cooking basics like oil and butter stay) or hidden in the app. Use it to suggest additions to the list; ask before adding.",
    inputSchema: { type: "object", properties: { include_later: { type: "boolean", description: "Also list items that are not due yet" } } },
    async run({ include_later = false }) {
      const s = await state();
      // Without recipe ingredients (cooking basics stay) and without what was hidden; deals use the full list.
      const all = dueItems(s.view, localToday(), { visibleOnly: true });
      const shown = include_later ? all : all.filter((d) => d.due);
      if (!shown.length) return include_later ? "No regular purchases known yet." : "Nothing is due.";
      return shown.map((d) => `- ${d.name}: last ${d.since} days ago, usually every ~${d.interval} days${d.due ? " (due)" : ""}${d.on_list ? " [on the list already]" : ""}${d.in_pantry ? " [still in the pantry]" : ""}`).join("\n");
    },
  },
  {
    name: "kitchen_pantry_get",
    description: "What is in the house (the pantry): per thing the amount in packs or pieces (a fraction like 0.5 is half a pack), the pack size when known, and the use-by date (estimated or typed in), and how long the item keeps closed and once opened when known. Things to use up soon (use-by within 2 days or past) come first. Filled by ticking the list and by receipts, emptied by cooking and by 'op' / 'weggegooid'. Things used at a steady rate (cat food, filters, toothpaste) are counted down every day by their usage rate; the amount shown is what is left today, with the days left. Use it before suggesting groceries: do not suggest what is already there, and suggest recipes that use up what is due. Never contains anything on the household's never-suggest list.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const s = await state();
      const today = localToday();
      // What is left today: things used at a steady rate are counted down (never written daily).
      const live = withUsage({ pantry: s.pantry, items: Object.fromEntries(s.items), pantry_events: s.pantryEvents }, today);
      const { due, rest } = pantryGroups(live.pantry, today);
      if (!due.length && !rest.length) return "The pantry is empty (nothing ticked off or read from a receipt recently).";
      const waste = wasteCounts(s.pantryEvents);
      const line = (r) => {
        const days = daysLeft(r, today);
        const date = r.use_by ? `use by ${r.use_by}${r.use_by_source === "estimate" ? " (estimated)" : ""}${days < 0 ? `, ${-days} days past` : days <= 2 ? `, ${days === 0 ? "today" : `in ${days} days`}` : ""}` : "no date";
        const thrown = waste[r.item_id]?.count ? `, thrown away ${waste[r.item_id].count}x before` : "";
        const it = s.items.get(r.item_id);
        const keeps = it && Number.isInteger(it.shelf_days)
          ? `, keeps ${it.shelf_days === -1 ? "a long time" : `~${it.shelf_days} days`} closed${Number.isInteger(it.opened_days) ? `, ~${it.opened_days} days open` : ""}${it.shelf_source === "claude" ? " (estimated)" : ""}`
          : "";
        const usage = r.per_day > 0 ? `, used ~${rateEn(r.per_day)} (${rateBy(r.rate_source, it)}), ~${Math.floor(r.days_left ?? 0)} days left` : "";
        return `- ${r.title}: ${displayAmount(r.amount)}${r.pack_size ? ` x ${r.pack_size}` : ""}, ${date}${usage}${thrown}${keeps}`;
      };
      return [
        due.length ? `Use up soon:\n${due.map(line).join("\n")}` : "Nothing has to be used up soon.",
        rest.length ? `In the house:\n${rest.map(line).join("\n")}` : null,
      ].filter(Boolean).join("\n\n");
    },
  },
  {
    name: "kitchen_low_stock",
    description: "What is running low in the pantry ('Bijna op', shown above the list in the app): things under their threshold (by default under a quarter pack; per item settable in the app, e.g. 'rijst: under 300 g', or switched off), things with too little left for a recipe that uses them (the one cooked with it most recently first), things counted down at a usage rate with less than a week of supply left, and things that ran out through cooking, 'op' or their countdown in the last week. Each with what is left and why. Never suggests excluded products, never what is on the list already. Use it when putting the groceries together: suggest these, ask before adding (kitchen_list_add with the item name shown).",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const s = await state();
      const today = localToday();
      const lows = lowStock(s.deals, today);
      if (!lows.length) return "Nothing is running low (or it is on the list already).";
      const left = (l) => (l.left.base === "g" || l.left.base === "ml"
        ? `${Math.round(l.left.qty)} ${l.left.base} left`
        : l.left.base === "piece" ? `${l.left.qty} pieces left` : `${displayAmount(l.left.packs)} pack left`);
      const why = (l) => {
        if (l.code === "empty") return `ran out on ${l.on} (${l.via === "cooked" ? "cooking" : "marked 'op'"})`;
        if (l.code === "recipe") return `${left(l)}, not enough for ${l.recipe.title}`;
        if (!l.low_at && l.days_left !== null) return `${left(l)}, ~${Math.floor(l.days_left)} days left at ${rateEn(l.per_day)}`;
        return `${left(l)}, under ${l.low_at ?? `${LOW_DEFAULT} pack (the default)`}`;
      };
      return lows.map((l) => `- ${l.title}${l.pack_size ? ` (pack ${l.pack_size})` : ""}: ${why(l)}`).join("\n");
    },
  },
  {
    name: "kitchen_pantry_rate_set",
    description: "Set how fast an item is used when nothing but time uses it (cat food, the cat's tuna, a water filter, toothpaste), so the pantry counts it down by itself. The item is its Dutch name as on the list or in the pantry, e.g. 'Minoes eten' (made when it does not exist). Give exactly one of per_day, per_week, per_month (packs or pieces, in the unit the pantry counts the item in) or every_days (1 piece every N days). estimate: true when it is your own estimate rather than something the household said (a household's value, or a rate the pantry learned, is never replaced by an estimate). Every rate keeps learning from what the household does ('op', putting it on the list, 'Nog niet', rebuys); a rate set here restarts that learning from this value. off: true never counts it down (also no default); clear: true goes back to the default for household goods. Never for an excluded product. Changing a rate does not change what is shown as left today; correct the amount in the app or with the pantry itself.",
    inputSchema: {
      type: "object",
      required: ["item"],
      properties: {
        item: { type: "string" },
        per_day: { type: "number", exclusiveMinimum: 0 },
        per_week: { type: "number", exclusiveMinimum: 0 },
        per_month: { type: "number", exclusiveMinimum: 0 },
        every_days: { type: "number", exclusiveMinimum: 0 },
        estimate: { type: "boolean" },
        off: { type: "boolean" },
        clear: { type: "boolean" },
      },
    },
    async run({ item, per_day, per_week, per_month, every_days, estimate = false, off = false, clear = false }) {
      if (isExcluded(item)) throw new Error("Refused: on the household's never-suggest list");
      const given = [per_day, per_week, per_month, every_days].filter((v) => v !== undefined);
      if (given.length + Number(off) + Number(clear) !== 1) throw new Error("Give exactly one of per_day, per_week, per_month, every_days, off or clear.");
      let perDay = off ? 0 : clear ? null
        : per_day ?? (per_week !== undefined ? per_week / 7 : per_month !== undefined ? per_month / 30 : 1 / every_days);
      if (perDay !== null && perDay > 0) perDay = Math.min(RATE_MAX, perDay);
      if (estimate && !(perDay > 0)) throw new Error("An estimate needs a rate.");
      const s = await state();
      const known = [...s.items.values()].find((i) => i.name_key === nameKey(item));
      const [res] = await send([{ type: "item.rate", ...(known ? { item_id: known.id } : { title: item, item_id: newId() }),
        use_per_day: perDay, source: estimate ? "claude" : "person", on: localToday() }]);
      if (res.result?.kept) return `Kept the household's own rate for ${known?.name ?? item} (set or learned); an estimate never replaces it.`;
      const after = await state();
      const it = after.items.get(res.result.item_id);
      const rate = it ? rowRate({ title: it.name, pack_size: "" }, it) : null;
      return `${it?.name ?? item}: ${rate ? `${rateEn(rate.per_day)} (${rateBy(rate.source, it)})` : "not counted down"}.`;
    },
  },
  {
    name: "kitchen_item_merge",
    description: "Merge two items of one thing into one (e.g. 'Tonijn' into 'Minoestuna': the receipts put the cat's tuna under the first, its rate sits on the second). Both are Dutch item names exactly as on the list or in the pantry; both must exist. Everything of `from` moves to `into`: purchases, products, pantry rows, list lines (an open line joins into's open line), preferences and deal rules (into's own wins), and the settings `into` lacks (its own rate, set or learned, stays). `from` disappears, and its name means `into` from now on: a receipt, a list line or a tool that says it lands on `into`. Cannot be undone by a tool. dry_run: true says what would move without changing anything. To move one product instead of a whole item, use the app's product screen.",
    inputSchema: {
      type: "object",
      required: ["from", "into"],
      properties: { from: { type: "string" }, into: { type: "string" }, dry_run: { type: "boolean" } },
    },
    async run({ from, into, dry_run = false }) {
      const s = await state();
      const byName = (name) => [...s.items.values()].find((i) => i.name_key === nameKey(name)) ?? null;
      const a = byName(from);
      const b = byName(into);
      if (!a) throw new Error(`No item "${from}".`);
      if (!b) throw new Error(`No item "${into}".`);
      if (a.id === b.id) throw new Error(`"${from}" and "${into}" are the same item.`);
      const WORDS = { entries: "list lines", entries_merged: "list lines joined to its open line", pantry: "pantry rows", pantry_events: "pantry events", pending_takes: "pending takes" };
      const counts = (moved) => Object.entries(moved).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${WORDS[k] ?? k.replace(/_/g, " ")}`).join(", ") || "nothing but the name";
      if (dry_run) {
        const mine = (rows) => rows.filter((r) => r.item_id === a.id && !r.deleted_at).length;
        return `Would merge ${a.name} into ${b.name}: ${counts({
          purchases: mine([...cache.purchases.values()]), products: mine(s.products), pantry: mine(Object.values(s.pantry)),
          entries: mine(s.entries), preferences: mine(Object.values(s.data.preferences)), deal_rules: mine([...cache.deal_rules.values()]),
        })}. After it, "${a.name}" means ${b.name}.`;
      }
      const [res] = await send([{ type: "item.merge", from_item_id: a.id, into_item_id: b.id, on: localToday() }]);
      return `Merged ${a.name} into ${b.name}: ${counts(res.result?.moved ?? {})}. "${a.name}" now means ${b.name}.`;
    },
  },
  {
    name: "kitchen_item_alias",
    description: "Give an item another name, or remove one (30-10-2026: 'Pluizenbolbrokkenman' is 'Minoes brokken'; by 'Cola' he means 'Sodastream cola'). From then on a list line, a receipt or a tool that says that name lands on the item, in the app, the widget and here. `item` is the Dutch item name as on the list (or one of its other names). A live item's own name cannot become another item's name; another item's other name (also one left by a merge) moves to this item. remove: true removes the name. Without `name`: lists the item's other names.",
    inputSchema: {
      type: "object",
      required: ["item"],
      properties: { item: { type: "string" }, name: { type: "string" }, remove: { type: "boolean" } },
    },
    async run({ item, name, remove = false }) {
      const s = await state();
      const target = findItem({ items: Object.fromEntries(s.items), aliases: s.names.aliases }, nameKey(item));
      if (!target) throw new Error(`No item "${item}".`);
      const others = () => Object.values(s.names.aliases).filter((a) => a.item_id === target.id).map((a) => a.name).sort();
      if (!name) return others().length ? `${target.name} is also called: ${others().join(", ")}.` : `${target.name} has no other names.`;
      const [r] = await send([{ type: "item.alias", id: newId(), item_id: target.id, name, ...(remove ? { remove: true } : {}) }]);
      if (r.result?.already) return remove ? `"${name}" was not a name of ${target.name}.` : `"${name}" already means ${target.name}.`;
      if (remove) return `"${name}" no longer means ${target.name}.`;
      const from = r.result?.taken_from ? s.items.get(r.result.taken_from)?.name ?? "another item" : null;
      return `"${name}" now means ${target.name}${from ? ` (it meant ${from} before)` : ""}.`;
    },
  },
  {
    name: "kitchen_product_move",
    description: "Move one product to another item that already exists, with what was bought of it, its pantry rows and the preferences and deal rules that name it (e.g. tuna in water bought as 'Tonijn' belongs to the cat's own tuna item). Both items stay; nothing is merged. Undo: move it back, here or in the app (product screen, 'Hoort bij iets anders…'). product_id from kitchen_recent_purchases or kitchen_product_ratings; item is the Dutch item name as on the list (or one of its other names) and must exist. Never an excluded product (refused). dry_run: true says what would move without changing anything.",
    inputSchema: {
      type: "object",
      required: ["product_id", "item"],
      properties: { product_id: { type: "string" }, item: { type: "string" }, dry_run: { type: "boolean" } },
    },
    async run({ product_id, item, dry_run = false }) {
      const s = await state();
      const p = s.products.find((x) => x.id === product_id);
      if (!p) throw new Error(`No product ${product_id}.`);
      if (isExcluded(p.name) || isExcluded(`${p.brand ?? ""} ${p.name}`)) throw new Error("Refused: on the household's never-suggest list, never touched.");
      const target = findItem({ items: Object.fromEntries(s.items), aliases: s.names.aliases }, nameKey(item));
      if (!target) throw new Error(`No item "${item}". A product moves only to an item that exists.`);
      if (isExcluded(target.name)) throw new Error("Refused: on the household's never-suggest list, never touched.");
      const fromName = s.items.get(p.item_id)?.name ?? "no item";
      if (p.item_id === target.id) return `${productLabel(p)} is already under ${target.name}.`;
      if (dry_run) {
        const bought = [...cache.purchases.values()].filter((r) => r.product_id === p.id && !r.deleted_at).length;
        return `Would move ${productLabel(p)} from ${fromName} to ${target.name}, with ${bought} purchase${bought === 1 ? "" : "s"}.`;
      }
      const [res] = await send([{ type: "product.move", product_id: p.id, item_id: target.id, on: localToday() }]);
      const moved = res.result?.moved ?? {};
      return `Moved ${productLabel(p)} from ${fromName} to ${target.name} (${moved.purchases ?? 0} purchases, ${moved.pantry ?? 0} pantry rows). Undo: move it back to ${fromName}.`;
    },
  },
  {
    name: "kitchen_recent_purchases",
    description: "What was bought lately on receipts (AH, Lidl, a receipt photo), never excluded products, compact and capped: per purchase the day, store, how many, the product (with its id) and the item it is linked to (with the item's other names, whether it is counted down at a usage rate, and the item's other products), then at most 15 CANDIDATE items that might fit better (items sharing a word with the product or its item, and items counted down at a usage rate). Use it to check product-to-item links. days: how far back by the day the purchase was added (default 2). The output stops at a fixed size with a note when cut.",
    inputSchema: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 30 } } },
    async run({ days = 2 }) {
      const s = await state();
      const since = addDays(localToday(), -days);
      const purchases = [...cache.purchases.values()];
      const products = new Map(s.products.map((p) => [p.id, p]));
      const aliasesByItem = new Map();
      for (const a of Object.values(s.names.aliases)) {
        if (a.deleted_at) continue;
        if (!aliasesByItem.has(a.item_id)) aliasesByItem.set(a.item_id, []);
        aliasesByItem.get(a.item_id).push(a.name);
      }
      const aliasesOf = (itemId) => (aliasesByItem.get(itemId) ?? []).sort();
      const bad = (txt) => isExcluded(txt ?? "");
      const groups = new Map();
      for (const r of purchases) {
        if (r.deleted_at || r.source !== "receipt") continue;
        if (String(r.created_at ?? "").slice(0, 10) < since && String(r.bought_on ?? "") < since) continue;
        const p = products.get(r.product_id);
        const it = s.items.get(r.item_id);
        if (bad(r.title) || bad(it?.name) || (p && (bad(p.name) || bad(`${p.brand ?? ""} ${p.name}`)))) continue;
        const key = `${r.bought_on}|${r.store}|${r.product_id ?? r.title}|${r.item_id}`;
        const g = groups.get(key) ?? { r, p, it, n: 0 };
        g.n += Number(r.qty) || 1;
        groups.set(key, g);
      }
      // Candidates: every live, non-excluded item with the words that name it
      // (its name, other names and its products' names) and its usage rate.
      const productsByItem = new Map();
      for (const p of s.products) {
        if (!p.item_id) continue;
        if (!productsByItem.has(p.item_id)) productsByItem.set(p.item_id, []);
        productsByItem.get(p.item_id).push(p);
      }
      const stemsOf = (text) => new Set(String(text ?? "").toLowerCase().split(/[^a-z0-9À-ɏ]+/).filter((w) => w.length >= 4).map((w) => w.slice(0, 5)));
      const pool = [...s.items.values()].filter((i) => !i.deleted_at && !bad(i.name)).map((i) => {
        const aka = aliasesOf(i.id);
        const own = productsByItem.get(i.id) ?? [];
        const rate = rowRate({ title: i.name, pack_size: "" }, i);
        return { i, aka, rate, stems: stemsOf([i.name, ...aka, ...own.filter((x) => !bad(x.name)).slice(0, 8).map((x) => x.name)].join(" ")) };
      });
      const candidatesFor = (p, it) => {
        const want = stemsOf(`${p?.name ?? ""} ${it?.name ?? ""}`);
        return pool.filter((c) => c.i.id !== it?.id)
          .map((c) => ({ c, shared: [...want].filter((w) => c.stems.has(w)).length }))
          .filter((x) => x.shared > 0 || x.c.rate)
          .sort((a, b) => (b.shared * 2 + Number(Boolean(b.c.rate))) - (a.shared * 2 + Number(Boolean(a.c.rate))) || a.c.i.name.localeCompare(b.c.i.name, "nl"))
          .slice(0, CANDIDATES_MAX)
          .map(({ c }) => `${c.i.name} [item: ${c.i.id}]${c.aka.length ? ` (aka ${c.aka.slice(0, 3).join(", ")})` : ""}${c.rate ? ` {${rateEn(c.rate.per_day)}}` : ""}`);
      };
      const blocks = [...groups.values()].sort((a, b) => String(b.r.bought_on).localeCompare(String(a.r.bought_on)) || (a.it?.name ?? "").localeCompare(b.it?.name ?? ""))
        .map(({ r, p, it, n }) => {
          const others = it ? s.products.filter((x) => x.item_id === it.id && x.id !== p?.id && !bad(x.name)).slice(0, 3).map(productLabel) : [];
          const rate = it ? rowRate({ title: it.name, pack_size: "" }, it) : null;
          const names = it ? aliasesOf(it.id) : [];
          const cands = candidatesFor(p, it);
          return `- ${r.bought_on} ${r.store ?? "?"} ${n}x ${p ? `${productLabel(p)} [product: ${p.id}]` : `"${r.title}" (no product)`} → item ${it ? `${it.name} [item: ${it.id}]` : "(none)"}`
            + `${names.length ? `; other names: ${names.slice(0, 5).join(", ")}` : ""}${rate ? `; counted down: ${rateEn(rate.per_day)}` : ""}`
            + `${others.length ? `; other products of this item: ${others.join("; ")}` : ""}`
            + `${cands.length ? `\n    candidate items: ${cands.join(" | ")}` : ""}`;
        });
      if (!blocks.length) return `No receipt purchases since ${since}.`;
      let text = `Receipt purchases since ${since} (${blocks.length}):`;
      let shown = 0;
      for (const b of blocks) {
        if (text.length + b.length + 1 > RECENT_CHARS_MAX) break;
        text += `\n${b}`;
        shown++;
      }
      if (shown < blocks.length) text += `\n(cut off: ${blocks.length - shown} more purchases not shown; ask again with days 1)`;
      return text;
    },
  },
  {
    name: "kitchen_offers",
    description: "This week's offers (the AH bonus and other stores' folders, synced daily), never suggests excluded products. With a query: offers whose name matches it. Without one: the offers for what is open on the list. Offers on a preferred product of the household are marked [their product: ...] and come first. Optional store, e.g. 'AH' or 'Dirk'.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, store: { type: "string" } } },
    async run({ query = "", store = "" }) {
      const s = await state();
      const shop = canonicalStore(store) || null;
      const deals = currentOffers(s.data.offers, localToday()).filter((o) => !shop || sameStore(o.store, shop));
      const preferred = Object.values(s.data.preferences)
        .filter((p) => !p.deleted_at && s.data.products[p.product_id])
        .map((p) => ({ product: s.data.products[p.product_id], item: s.items.get(p.item_id)?.name ?? "" }));
      const theirs = (o) => preferred.find((x) => productOfferMatches(x.product, o));
      const mark = (o) => {
        const hit = theirs(o);
        return `- ${offerText(o)}${hit ? ` [their product: ${productLabel(hit.product)} for ${hit.item}]` : ""}`;
      };
      if (query.trim()) {
        const key = nameKey(query);
        const hits = deals.filter((o) => offerMatches(key, o))
          .sort((a, b) => Number(Boolean(theirs(b))) - Number(Boolean(theirs(a))) || a.valid_until.localeCompare(b.valid_until));
        if (!hits.length) return `No current offers for "${query}"${shop ? ` at ${shop}` : ""}.`;
        return hits.slice(0, 40).map(mark).join("\n");
      }
      const out = [];
      const dealHits = dealsFor(s.deals, localToday());
      for (const e of s.entries.filter((x) => !x.checked_at)) {
        const resolved = resolveProduct(s.data, e, shop);
        const { mine, named } = liveLineOffers(e, resolved?.product, deals, dealHits, shop);
        if (!mine.length && !named.length) continue;
        out.push(`${e.title}:`, ...mine.slice(0, 3).map(mark), ...named.slice(0, 3).map((o) => `- ${offerText(o)}`));
      }
      return out.length ? out.join("\n") : `No offers for the open list lines${shop ? ` at ${shop}` : ""}.`;
    },
  },
  {
    name: "kitchen_prices",
    description: "Regular shelf prices of their own products at other stores near home (Albert Heijn, Dirk, Jumbo, PLUS, ALDI, Hoogvliet, SPAR), from Checkjebon, updated daily; only products matched exactly (same brand and pack), never excluded products, no offers (see kitchen_offers). With a query: products whose name, brand or item matches it. Without one: the products of the open list lines. Optional store, e.g. 'Dirk'. The cheapest is marked; prices older than two days say their date. With count: true only a read-only tally over ALL their products: how many have a price, per store, and how many at a store other than Albert Heijn.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, store: { type: "string" }, count: { type: "boolean", description: "Only count: how many of all their products have a shelf price" } } },
    async run({ query = "", store = "", count = false }) {
      const s = await state();
      const shop = canonicalStore(store) || null;
      const out = [];
      if (count) {
        const today = localToday();
        const all = findProducts(s, "");
        const perStore = {};
        let priced = 0;
        let elsewhere = 0;
        for (const p of all) {
          const list = pricesOf(s.storePrices, p, today, { store: shop });
          if (!list.length) continue;
          priced++;
          if (list.some((x) => !sameStore(x.store, "Albert Heijn"))) elsewhere++;
          for (const x of list) perStore[shortStore(x.store)] = (perStore[shortStore(x.store)] ?? 0) + 1;
        }
        return [`${priced} of ${all.length} products have a shelf price${shop ? ` at ${shop}` : ""} (${elsewhere} at a store other than Albert Heijn).`,
          `Per store: ${Object.entries(perStore).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}.`].join("\n");
      }
      if (query.trim()) {
        for (const p of findProducts(s, query)) {
          const prices = shelfPrices(s, p, shop);
          if (prices) out.push(`- ${productLabel(p)} (${s.items.get(p.item_id)?.name ?? "?"}): ${prices}`);
        }
        return out.length ? out.slice(0, 40).join("\n") : `No shelf prices for "${query}"${shop ? ` at ${shop}` : ""}.`;
      }
      for (const e of s.entries.filter((x) => !x.checked_at)) {
        const product = (resolveProduct(s.data, e, shop) ?? resolveProduct(s.data, e, null))?.product;
        const prices = product ? shelfPrices(s, product, shop) : "";
        if (prices) out.push(`- ${e.title}: ${productLabel(product)}: ${prices}`);
      }
      return out.length ? out.join("\n") : `No shelf prices for the open list lines${shop ? ` at ${shop}` : ""}.`;
    },
  },
  {
    name: "kitchen_deals",
    description: "The offers that meet the household's deal rules right now (the 'Deals' tab), plus, without a rule, current Albert Heijn and Dirk offers on what they buy often (3+ days in the past year), marked [you buy it often]; one that may not be their own product also says [check: they usually buy ...]. Per hit the item, store, deal, the real price per piece and per kg / l / piece in the pack, until when, which rule it meets, and [recommended: why] when the pantry or 'need it again' says they are probably low on it (those come first, then the biggest saving). Only Albert Heijn and Dirk unless the rule is 'worth a detour'. Never suggests excluded products. Also lists the rules. To put a hit on the list use kitchen_list_add with the item name and no note: the list line shows its current offers by itself, and an ended offer disappears.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const s = await state();
      const rules = liveRules(s.deals);
      const hits = dealsFor(s.deals, localToday());
      if (!rules.length && !hits.length) return "No deal rules yet, and nothing they buy often is on offer at Albert Heijn or Dirk. Set a rule with kitchen_deal_rule_set.";
      const forProduct = (r) => (r.product_id && s.deals.products[r.product_id] ? ` (for ${productLabel(s.deals.products[r.product_id])})` : "");
      const lines = hits.slice(0, 40).map((h) => {
        const o = h.offer;
        const name = [o.brand && !nameKey(o.name).includes(nameKey(o.brand)) ? o.brand : null, o.name].filter(Boolean).join(" ");
        return [
          `- ${h.often ? "[you buy it often] " : ""}${h.check ? (h.often ? `[check: they usually buy ${h.check[0]}] ` : `[check: is it ${h.check.join(" ")}?] `) : ""}${h.low ? `[recommended: ${LOW_EN[h.low.code](h.low)}] ` : ""}${h.item.name}: ${o.store}${isCoupon(o) ? " (Lidl Plus coupon: activate it in the app)" : ""}${h.detour ? " (detour)" : ""} · ${name}${o.size ? ` · ${o.size}` : ""} · ${o.deal ?? "folder price"} · ${effText(h.eff)} · until ${o.valid_until}`,
          `  ${h.often ? `no rule: bought on ${h.bought} days in the past year, only on offer` : `rule: ${ruleText(h.rule)}${forProduct(h.rule)}`}`,
        ].join("\n");
      });
      const ruleLines = rules.map((r) => `- ${s.items.get(r.item_id)?.name ?? "?"}${forProduct(r)}: ${ruleText(r)}`);
      return [
        hits.length ? `Deals now:\n${lines.join("\n")}` : "No current offer meets a rule, and nothing they buy often is on offer.",
        ruleLines.length ? `Rules:\n${ruleLines.join("\n")}` : "No deal rules yet. Set one with kitchen_deal_rule_set.",
      ].join("\n\n");
    },
  },
  {
    name: "kitchen_deal_rule_set",
    description: "Set or change the deal rule of an item (its Dutch name as on the list, e.g. 'Vochtig toiletpapier'), optionally for one product of it (product_id from kitchen_product_ratings). Only the fields given change; null removes a condition. max_price: euros per piece, a multi-buy counted per piece ('2 voor 2,40' is 1,20). offer_only: only when on offer; min_discount_pct: at least that discount (implies offer_only). max_unit_price with unit ('kg', 'l', or 'piece' in the pack, e.g. per pouch): to compare bulk packs fairly. detour: also at stores other than Albert Heijn and Dirk. match_words: extra words (Dutch, as in the folders), any of which makes an offer a candidate next to the item's own name, e.g. ['felix', 'sheba', 'pouches'] for cat food. require_words: words the offer must say for a full hit, e.g. ['amandelmelk'] for one Edet kind; an offer of that brand naming no kind shows as a 'check' hit, one naming another kind not at all. exclude_words: an offer saying any of them never counts, e.g. ['salade', 'pizza'] for canned tuna. All three replace the old list; null or [] removes. detour_min_discount_pct: with detour, stores other than Albert Heijn and Dirk count only from this discount (implies detour). clear: true removes the rule. Excluded products are refused.",
    inputSchema: {
      type: "object",
      required: ["item"],
      properties: {
        item: { type: "string" },
        product_id: { type: "string" },
        max_price: { type: ["number", "null"] },
        offer_only: { type: "boolean" },
        min_discount_pct: { type: ["integer", "null"], minimum: 1, maximum: 95 },
        max_unit_price: { type: ["number", "null"] },
        unit: { type: ["string", "null"], enum: ["kg", "l", "piece", null] },
        detour: { type: "boolean" },
        match_words: { type: ["array", "null"], items: { type: "string" }, maxItems: 12 },
        require_words: { type: ["array", "null"], items: { type: "string" }, maxItems: 12 },
        exclude_words: { type: ["array", "null"], items: { type: "string" }, maxItems: 12 },
        detour_min_discount_pct: { type: ["integer", "null"], minimum: 1, maximum: 95 },
        clear: { type: "boolean" },
      },
    },
    async run({ item, product_id = "", clear = false, ...fields }) {
      if (isExcluded(item)) throw new Error("Refused: on the household's never-suggest list");
      const s = await state();
      const known = [...s.items.values()].find((i) => i.name_key === nameKey(item));
      if (clear) {
        if (!known) return `No item called "${item}".`;
        await send([{ type: "deal_rule.clear", item_id: known.id, product_id }]);
        return `Rule removed for ${known.name}.`;
      }
      const op = { type: "deal_rule.set", id: newId(), ...(known ? { item_id: known.id } : { title: item, item_id: newId() }), product_id };
      const toCents = (v) => (v === null ? null : Math.round(v * 100));
      if ("max_price" in fields) op.max_price_cents = toCents(fields.max_price);
      if ("max_unit_price" in fields) op.max_unit_price_cents = toCents(fields.max_unit_price);
      for (const f of ["offer_only", "min_discount_pct", "unit", "detour", "match_words", "require_words", "exclude_words", "detour_min_discount_pct"]) if (f in fields) op[f] = fields[f];
      const [res] = await send([op]);
      const after = await state();
      const rule = liveRules(after.deals).find((r) => r.item_id === res.result.item_id && (r.product_id || "") === product_id);
      return `Rule for ${known?.name ?? item}${rule ? forProductText(after, rule) : ""}: ${rule ? ruleText(rule) : "?"}.`;
    },
  },
  {
    name: "kitchen_product_ratings",
    description: "Known products (from receipts or typed in) with each person's stars (1-5) and note, the last price and store, and whether it is the preferred product of its item. Search by product, brand or item name.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    async run({ query = "" }) {
      const s = await state();
      const hits = findProducts(s, query);
      if (!hits.length) return "No products found.";
      return hits.slice(0, 40).map((p) => {
        const item = s.items.get(p.item_id);
        const rs = s.ratings.filter((r) => r.product_id === p.id)
          .map((r) => `${s.members[r.member_id] ?? "?"} ${r.stars}/5${r.note ? ` "${r.note}"` : ""}`);
        const scopes = preferencesOf(s.data.preferences, p.item_id).filter((x) => x.product_id === p.id)
          .map((x) => [x.store || "any store", x.recipe_id ? `for ${s.data.recipes[x.recipe_id]?.title ?? "a recipe"}` : null].filter(Boolean).join(" "));
        const facts = [euros(p.last_price_cents), p.store_only && p.store ? `only sold at ${p.store}` : p.store, item ? `item: ${item.name}${scopes.length ? ` (preferred: ${scopes.join("; ")})` : ""}` : null].filter(Boolean);
        return `- ${productLabel(p)} [id: ${p.id}] ${facts.join(", ")}${rs.length ? `; ratings: ${rs.join("; ")}` : ""}`;
      }).join("\n");
    },
  },
  {
    name: "kitchen_product_rate",
    description: "Give a product 1-5 stars and an optional short note, as the person behind this connection (stars: 0 removes the rating). The product id comes from kitchen_product_ratings.",
    inputSchema: {
      type: "object",
      required: ["product_id", "stars"],
      properties: { product_id: { type: "string" }, stars: { type: "integer", minimum: 0, maximum: 5 }, note: { type: "string" } },
    },
    async run({ product_id, stars, note = "" }) {
      await send([{ type: "rating.set", id: newId(), product_id, stars: stars || null, note }]);
      return stars ? `Rated ${stars}/5.` : "Rating removed.";
    },
  },
];

// ------------------------------------------------------------ JSON-RPC

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return;                       // a notification
  if (method === "initialize") {
    return write({ jsonrpc: "2.0", id, result: {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "kitchen", version: "1.0.0" },
      instructions: "Recipes and the shared grocery list of Thomas's household (recipes.vexed.works, groceries.vexed.works). The phones see every change within seconds. Recipes and list items are in Dutch; keep them Dutch.",
    } });
  }
  if (method === "ping") return write({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") {
    return write({ jsonrpc: "2.0", id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
  }
  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return write({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool ${params?.name}` } });
    try {
      const text = await tool.run(params.arguments ?? {});
      return write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
    } catch (e) {
      return write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(e.message ?? e) }], isError: true } });
    }
  }
  return write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}

export { TOOLS };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    handle(msg).catch((e) => write({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message: String(e.message ?? e) } }));
  });
}
