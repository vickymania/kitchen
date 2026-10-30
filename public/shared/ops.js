// The op engine. Every change anyone makes is an op; this file decides what an
// op does to the household's state.
//
// It runs in two places on purpose:
//   - the worker applies an op to the rows it loaded from D1 and writes back
//     what changed (worker/ops-store.js); that result is the truth
//   - the browser applies its unconfirmed ops on top of the last server state,
//     so a tap shows at once, also in a shop without signal (public/app/store.js)
// One function for both means the phone can never show a rule the server does
// not follow.
//
// State: { recipes, items, entries, members, products, ratings, purchases, receipts, cooks, preferences,
// pantry, pantry_events, deal_rules, pending_takes, cook_prompts, recipe_ratings, store_prices, reviews, auto_changes }
// each {id: row}. Rows hold parsed JSON (ingredients, steps, amounts, sources,
// lines), not strings.
import { UNIT_CODES, nameKey, mergeAmounts } from "./ingredients.js";
import { isExcluded } from "./excluded.js";
import { canonicalStore } from "./stores.js";
import { isStarValue } from "./recipe-ratings.js";
import { fromEntry, matchPurchase, round2, entryPantryId, purchasePantryId, parseLowAt, LOW_AT_MAX, drainRows, rowRate, rateEventId, RATE_MAX, RATE_MIN, RATE_SOURCES, RATE_RANK, pendingFits, pendingNeed, pendingEventId, PENDING_MAX } from "./pantry.js";
import { estimateUseBy, addDays, KEEPS, SHELF_DAYS_MAX, SHELF_SOURCES, SHELF_RANK, openedDaysOf, itemShelfDays, openedUseBy } from "./shelf-life.js";
import { CUISINES, MAIN_INGREDIENTS, TIME_CLASSES, MEALS, LABELS_BY, LABEL_FIELDS, sortMeals } from "./labels.js";
import { isKind, kindFromCategory, kindFromName } from "./product-kinds.js";
import { canonicalName } from "./item-names.js";
import { aliasTarget, itemsNamed, findItem } from "./item-find.js";
import { learnRate, onOffer, earlierPurchases } from "./rate-learning.js";
import { LINK_HOWS, LINK_REASONS } from "./recipe-links.js";
import { LANGS, NAME_EN_SOURCES, NAME_EN_RANK, recipeLang, detectLang, cleanTranslation } from "./bilingual.js";
import { PRICE_STORE_NAMES, MAX_PRICE_WRITES, checkPriceRows, matchStorePrices, storePriceId } from "./store-prices.js";

export class OpError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

export const OP_TYPES = [
  "recipe.put", "recipe.delete",
  "entry.add", "entry.update", "entry.check", "entry.delete", "entry.clear_checked",
  "member.update",
  "product.put", "product.shelf", "item.prefer", "item.again", "item.rename", "item.low", "item.not_yet", "item.shelf", "item.rate", "rating.set", "receipt.save", "purchase.add", "purchase.delete",
  "recipe.cooked", "recipe.uncooked", "recipe.cook_prompt", "recipe.rate",
  "preference.set", "preference.clear",
  "pantry.add", "pantry.update", "pantry.use", "pantry.unuse", "pantry.remove", "pantry.pend", "pantry.unpend",
  "deal_rule.set", "deal_rule.clear",
  "item.merge", "product.move", "item.alias", "item.private",
  "prices.sync",
  "review.save", "recipe.links",
  "item.translate", "recipe.translate",
];

export const KINDS = ["recipes", "items", "entries", "members", "products", "ratings", "purchases", "receipts", "cooks", "offers", "preferences", "pantry", "pantry_events", "deal_rules", "pending_takes", "cook_prompts", "recipe_ratings", "aliases", "store_prices", "reviews", "auto_changes"];

export function emptyState() {
  return Object.fromEntries(KINDS.map((k) => [k, {}]));
}

/** The key that makes the same product read from two receipts one row. */
export function productKey(p) {
  return [p.name, p.brand, p.size].map((v) => nameKey(v ?? "")).join("|");
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The nightly report (review.save): at most this many lines per list, each this long. */
export const REVIEW_MAX_LINES = 30;
export const REVIEW_LINE_MAX = 300;
/** The nightly changelog (auto_changes) keeps this many days; review.save tombstones older rows. */
export const AUTO_CHANGES_DAYS = 60;

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PHOTO_RE = /^p\/[A-Za-z0-9_-]{8,64}\.(jpg|webp|png)$/;

function id(v, field = "id") {
  if (typeof v !== "string" || !ID_RE.test(v)) throw new OpError("bad_id", field);
  return v;
}

function text(v, max, field) {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new OpError("bad_field", field);
  return v.replace(/\r/g, "").trim().slice(0, max);
}

function num(v, field, { min = 0, max = 1e6 } = {}) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new OpError("bad_field", field);
  return n;
}

/** Stars from 0.5 to 10 in steps of 0.5 (30-10-2026), else bad_field. */
function starsValue(v) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (!isStarValue(n)) throw new OpError("bad_field", "stars");
  return n;
}

function ingredient(v) {
  if (!v || typeof v !== "object") throw new OpError("bad_field", "ingredients");
  const name = text(v.name, 120, "ingredient.name");
  if (!name) return null;
  const unit = v.unit ?? null;
  if (unit !== null && !UNIT_CODES.includes(unit)) throw new OpError("bad_field", "ingredient.unit");
  return {
    qty: num(v.qty, "ingredient.qty"),
    qty_max: num(v.qty_max, "ingredient.qty_max"),
    unit,
    name,
    note: text(v.note, 200, "ingredient.note"),
    optional: Boolean(v.optional),
    heading: Boolean(v.heading),
    raw: text(v.raw, 300, "ingredient.raw"),
  };
}

function amounts(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 10) throw new OpError("bad_field", "amounts");
  return v.map((a) => {
    if (a && typeof a.text === "string") return { text: text(a.text, 40, "amount.text") };
    const qty = num(a?.qty, "amount.qty", { min: 0.0001 });
    const unit = a?.unit ?? null;
    if (qty === null || (unit !== null && !UNIT_CODES.includes(unit))) throw new OpError("bad_field", "amount");
    return { qty, unit };
  }).filter((a) => a.text !== "");
}

function source(v) {
  if (!v) return null;
  return { recipe_id: id(v.recipe_id, "source.recipe_id"), title: text(v.title, 200, "source.title") };
}

function nutrition(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") throw new OpError("bad_field", "nutrition");
  const out = {};
  for (const k of ["kcal", "carbs_g", "protein_g", "fat_g"]) out[k] = num(v[k], `nutrition.${k}`, { max: 10000 });
  if (out.carbs_g !== null && v.carbs_estimated === true) out.carbs_estimated = true;
  return Object.values(out).some((x) => x !== null) ? out : null;
}

// aliasTarget, itemsNamed and findItem live in ./item-find.js (the ingredient
// resolver needs them without the op engine); re-exported here for every caller.
export { aliasTarget, itemsNamed, findItem };

function openEntryFor(state, itemId, exceptId = null) {
  return Object.values(state.entries).find(
    (e) => e.item_id === itemId && e.id !== exceptId && !e.checked_at && !e.deleted_at,
  ) ?? null;
}

/** The item for this title: the existing one with the same key, or a new one. */
function resolveItem(state, ctx, title, newItemId) {
  const key = nameKey(title);
  if (!key) throw new OpError("title_required");
  const found = findItem(state, key);
  if (found) return found;
  // A plain tombstone of this name (an item a relink left unused, or a
  // merge's alias that was removed): the name is taken in items_name, so it
  // comes back to life instead of a second row.
  const dead = Object.values(state.items).find((i) => i.deleted_at && i.name_key === key && !aliasTarget(state.items, i));
  if (dead) {
    Object.assign(dead, { name: title, deleted_at: null, merged_into: null, created_at: ctx.now });
    ctx.touch("items", dead.id);
    return dead;
  }
  const item = { id: id(newItemId, "item_id"), name: title, name_key: key, created_at: ctx.now, deleted_at: null };
  state.items[item.id] = item;
  ctx.touch("items", item.id);
  return item;
}

/**
 * The item a list line is for. op.item_id naming a known item links to it
 * (a tapped suggestion; a merged one goes to where it went); otherwise the
 * title is looked up (findItem) or makes a new item with op.item_id.
 * made: this line made the item ("Nieuw"); linked: picked by id.
 */
function lineItem(state, ctx, op, title) {
  const known = typeof op.item_id === "string" ? aliasTarget(state.items, state.items[op.item_id]) : null;
  if (known) return { item: known, made: false, linked: true };
  const key = nameKey(title);
  const found = key ? findItem(state, key) : null;
  if (found) return { item: found, made: false, linked: false };
  return { item: resolveItem(state, ctx, title, op.item_id), made: true, linked: false };
}

/** What was typed, kept only when it is not the item's own name ("Pluiz" for "Minoes brokken"), Dutch or English. */
function typedName(typed, item) {
  const t = String(typed ?? "").trim();
  return t && nameKey(t) !== item.name_key && nameKey(t) !== item.name_en_key ? t.slice(0, 120) : null;
}

/** Both items private to the same member, or both the household's. */
export const samePrivacy = (a, b) => (a?.private_to ?? null) === (b?.private_to ?? null);

/** Rows that still point at an item: a live one keeps it alive. */
const ITEM_ROWS = ["entries", "purchases", "products", "pantry", "pantry_events", "preferences", "deal_rules", "pending_takes", "aliases"];

/**
 * A line's own new item after the line went elsewhere: a tombstone when
 * nothing else points at it (worker/ops-store.js loads exactly those rows).
 */
function dropIfUnused(state, ctx, item) {
  if (!item || item.deleted_at) return;
  for (const kind of ITEM_ROWS) {
    for (const row of Object.values(state[kind] ?? {})) if (row.item_id === item.id && !row.deleted_at) return;
  }
  item.deleted_at = ctx.now;
  ctx.touch("items", item.id);
}

/**
 * The alias row of `name` for `item`: the row of that name revived or
 * pointed here, else a new one with `newId`. Returns its id.
 */
function putAlias(state, ctx, item, name, newId) {
  const key = nameKey(name);
  const row = Object.values(state.aliases).find((a) => a.name_key === key) ?? state.aliases[newId];
  if (row) {
    if (row.item_id === item.id && !row.deleted_at) return row.id;
    Object.assign(row, { item_id: item.id, name, name_key: key, deleted_at: null, updated_at: ctx.now });
  } else {
    state.aliases[newId] = { id: newId, item_id: item.id, name, name_key: key, created_by: ctx.memberId ?? null,
      created_at: ctx.now, updated_at: ctx.now, deleted_at: null };
  }
  ctx.touch("aliases", row?.id ?? newId);
  return row?.id ?? newId;
}

function mergeSources(a = [], b = []) {
  const out = [...a];
  for (const s of b) if (s && !out.some((x) => x.recipe_id === s.recipe_id)) out.push(s);
  return out;
}

function mergeInto(target, from, ctx) {
  target.amounts = mergeAmounts(target.amounts, from.amounts);
  target.sources = mergeSources(target.sources, from.sources);
  if (from.note && !target.note.includes(from.note)) target.note = [target.note, from.note].filter(Boolean).join("; ");
  target.updated_at = ctx.now;
  ctx.touch("entries", target.id);
}

function entryOf(state, entryId) {
  const e = state.entries[id(entryId)];
  if (!e || e.deleted_at) throw new OpError("not_found", "entry");
  return e;
}

function cents(v, field, { min = -1e7 } = {}) {
  const n = num(v, field, { min, max: 1e7 });
  return n === null ? null : Math.round(n);
}

function date(v, field = "bought_on") {
  if (typeof v !== "string" || !DATE_RE.test(v)) throw new OpError("bad_field", field);
  return v;
}

/** A receipt clears basket lines ticked from this many days before its day... */
export const BASKET_BEFORE_DAYS = 7;
/** ...up to this many days after it (a receipt read the morning after). */
export const BASKET_AFTER_DAYS = 1;

/**
 * A receipt purchase of `item` confirms the basket: its checked, live lines
 * of the same thing (the item, or one with the same canonical name:
 * item-names.js SAME) ticked within BASKET_BEFORE_DAYS before and
 * BASKET_AFTER_DAYS after `boughtOn` get a tombstone, as entry.clear_checked
 * does. Returns their ids. `except`: the line this purchase ticked itself.
 */
function clearBasketFor(state, ctx, item, boughtOn, except = null) {
  const key = canonicalName(item.name).key;
  const from = addDays(boughtOn, -BASKET_BEFORE_DAYS);
  const to = addDays(boughtOn, BASKET_AFTER_DAYS);
  const cleared = [];
  for (const e of Object.values(state.entries)) {
    if (!e || e.deleted_at || !e.checked_at || e.id === except) continue;
    const day = String(e.checked_at).slice(0, 10);
    if (day < from || day > to) continue;
    if (e.item_id !== item.id && canonicalName(state.items[e.item_id]?.name ?? e.title).key !== key) continue;
    e.deleted_at = ctx.now;
    e.updated_at = ctx.now;
    ctx.touch("entries", e.id);
    cleared.push(e.id);
  }
  return cleared;
}

/**
 * Was the item on the list around `day`: an open line of it, or a checked
 * line of the same thing ticked in clearBasketFor's window (the lines the
 * purchase.add loader fetches)? Then a receipt of it is no rebuy.
 */
function listedAround(state, item, day) {
  const key = canonicalName(item.name).key;
  const from = addDays(day, -BASKET_BEFORE_DAYS);
  const to = addDays(day, BASKET_AFTER_DAYS);
  return Object.values(state.entries).some((e) => {
    if (!e || e.deleted_at) return false;
    if (!e.checked_at) return e.item_id === item.id;
    const on = String(e.checked_at).slice(0, 10);
    return on >= from && on <= to && (e.item_id === item.id || canonicalName(state.items[e.item_id]?.name ?? e.title).key === key);
  });
}

/** An excluded thing never becomes a purchase, a product or a preference (public/shared/excluded.js). */
function noExcluded(...names) {
  if (names.some((n) => n && isExcluded(n))) throw new OpError("excluded");
}

function liveProduct(state, productId) {
  const p = state.products[id(productId, "product_id")];
  if (!p || p.deleted_at) throw new OpError("not_found", "product");
  return p;
}

const PRODUCT_FIELDS = {
  name: (v) => text(v, 120, "name"),
  brand: (v) => text(v, 60, "brand"),
  size: (v) => text(v, 40, "size"),
  store: (v) => canonicalStore(text(v, 40, "store")),
  last_price_cents: (v) => cents(v, "last_price_cents", { min: 0 }),
  store_only: (v) => {
    if (typeof v !== "boolean" && v !== 0 && v !== 1) throw new OpError("bad_field", "store_only");
    return v ? 1 : 0;
  },
  // AH's own category ("Main > Sub") and the kind (public/shared/product-kinds.js).
  category: (v) => text(v, 120, "category") || null,
  kind: (v) => {
    if (v === null || v === undefined || v === "") return null;
    if (!isKind(v)) throw new OpError("bad_field", "kind");
    return v;
  },
};

/**
 * Create or patch a product. A new product whose name|brand|size is already
 * known patches that row instead, so two receipts never make two rows.
 * store_only (28-10-2026: "alleen bij deze winkel") needs a store. A
 * patch without store_only (a receipt, the AH import) never clears it and
 * never moves such a product to another store: the Lidl macaroni herbs on an
 * AH receipt keep saying "haal bij Lidl".
 */
function putProduct(state, ctx, productId, patch) {
  if (!patch || typeof patch !== "object") throw new OpError("bad_field", "product");
  let row = state.products[id(productId, "product_id")];
  if (!row || row.deleted_at) {
    const draft = { name: "", brand: "", size: "" };
    for (const f of ["name", "brand", "size"]) if (f in patch) draft[f] = PRODUCT_FIELDS[f](patch[f]);
    const same = Object.values(state.products).find((p) => p.product_key === productKey(draft));
    row = same ?? row;
  }
  row = row ? { ...row } : {
    id: productId, item_id: null, name: "", brand: "", size: "", store: "", store_only: 0, category: null, kind: null,
    last_price_cents: null, created_at: ctx.now, deleted_at: null,
  };
  const keepStore = row.store_only && !("store_only" in patch) ? row.store : null;
  for (const [field, clean] of Object.entries(PRODUCT_FIELDS)) {
    if (field in patch) row[field] = clean(patch[field]);
  }
  if (keepStore && row.store) row.store = keepStore;
  row.store_only = row.store_only ? 1 : 0;
  // No kind given: AH's category says it, else the name rules; a kind
  // someone set stays until a new category comes in. Still unknown: null,
  // and worker/kinds.js asks Claude after the batch.
  if (!("kind" in patch) && (!row.kind || "category" in patch)) {
    row.kind = kindFromCategory(row.category) ?? row.kind ?? kindFromName(row.name, row.brand);
  }
  row.category = row.category ?? null;
  row.kind = row.kind ?? null;
  if (!row.name) throw new OpError("name_required");
  if (row.store_only && !row.store) throw new OpError("store_required");
  noExcluded(row.name, `${row.brand} ${row.name}`);
  row.product_key = productKey(row);
  if (Object.values(state.products).some((p) => p.id !== row.id && p.product_key === row.product_key)) {
    throw new OpError("duplicate_product");
  }
  row.updated_at = ctx.now;
  row.deleted_at = null;
  state.products[row.id] = row;
  ctx.touch("products", row.id);
  return row;
}

/** The store and recipe a preference holds for: '' is any. */
function scopeOf(op) {
  return {
    store: canonicalStore(text(op.store, 40, "store")),
    recipeId: op.recipe_id ? id(op.recipe_id, "recipe_id") : "",
  };
}

/** The row of a scope, live or a tombstone: a scope has one row, ever. */
function scopeRow(state, itemId, store, recipeId) {
  const key = nameKey(store);
  return Object.values(state.preferences).find((p) =>
    p.item_id === itemId && nameKey(p.store) === key && p.recipe_id === recipeId) ?? null;
}

function liveRecipe(state, recipeId) {
  if (!recipeId) return;
  const r = state.recipes[recipeId];
  if (!r || r.deleted_at) throw new OpError("not_found", "recipe");
}

/**
 * Make `product` the one to buy for `item` at this store and recipe. The
 * same product again writes nothing; a cleared scope gets its row back.
 */
function setPreference(state, ctx, item, product, store, recipeId, newRowId) {
  noExcluded(item.name, product.name, `${product.brand} ${product.name}`);
  const prev = scopeRow(state, item.id, store, recipeId);
  if (prev && !prev.deleted_at && prev.product_id === product.id && prev.store === store) return prev;
  const row = prev ? { ...prev } : {
    id: newRowId, item_id: item.id, recipe_id: recipeId, created_by: ctx.memberId, created_at: ctx.now,
  };
  Object.assign(row, { store, product_id: product.id, updated_at: ctx.now, deleted_at: null });
  state.preferences[row.id] = row;
  ctx.touch("preferences", row.id);
  if (!product.item_id) {
    product.item_id = item.id;
    product.updated_at = ctx.now;
    ctx.touch("products", product.id);
  }
  return row;
}

function clearPreference(state, ctx, itemId, store, recipeId) {
  const prev = scopeRow(state, itemId, store, recipeId);
  if (!prev || prev.deleted_at) return;
  prev.deleted_at = ctx.now;
  prev.updated_at = ctx.now;
  ctx.touch("preferences", prev.id);
}

// What a deal rule may hold (public/shared/deal-math.js checks it). Booleans
// are 0 / 1, as D1 stores them.
const DEAL_UNITS = ["kg", "l", "piece"];
const RULE_FIELDS = {
  max_price_cents: (v) => cents(v, "max_price_cents", { min: 1 }),
  offer_only: (v) => (v ? 1 : 0),
  min_discount_pct: (v) => pct(v, "min_discount_pct"),
  max_unit_price_cents: (v) => cents(v, "max_unit_price_cents", { min: 1 }),
  unit: (v) => {
    if (v === null || v === undefined || v === "") return null;
    if (!DEAL_UNITS.includes(v)) throw new OpError("bad_field", "unit");
    return v;
  },
  detour: (v) => (v ? 1 : 0),
  match_words: (v) => ruleWords(v, "match_words"),
  require_words: (v) => ruleWords(v, "require_words"),
  exclude_words: (v) => ruleWords(v, "exclude_words"),
  detour_min_discount_pct: (v) => pct(v, "detour_min_discount_pct"),
};
const RULE_EMPTY = {
  max_price_cents: null, offer_only: 0, min_discount_pct: null, max_unit_price_cents: null, unit: null, detour: 0,
  match_words: null, require_words: null, exclude_words: null, detour_min_discount_pct: null,
};

/** A whole percentage from 1 to 95, or null. */
function pct(v, field) {
  const n = num(v, field, { min: 1, max: 95 });
  if (n !== null && !Number.isInteger(n)) throw new OpError("bad_field", field);
  return n;
}
const MAX_RULE_WORDS = 12;

/**
 * A rule's words: a list or a comma-separated text ("felix, sheba") to a
 * sorted list of nameKeys without doubles, or null for none. An excluded word is
 * refused, like everywhere else.
 */
function ruleWords(v, field) {
  if (v === null || v === undefined || v === "") return null;
  const list = typeof v === "string" ? v.split(",") : v;
  if (!Array.isArray(list) || list.length > MAX_RULE_WORDS * 2) throw new OpError("bad_field", field);
  const out = new Set();
  for (const w of list) {
    if (typeof w !== "string") throw new OpError("bad_field", field);
    const key = nameKey(w.slice(0, 60));
    if (!key) continue;
    if (key.length < 2) throw new OpError("bad_field", field);
    noExcluded(key);
    out.add(key);
  }
  if (out.size > MAX_RULE_WORDS) throw new OpError("bad_field", field);
  return out.size ? [...out].sort() : null;
}
const sameRuleValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The row of an item and product ('' = any), live or a tombstone: one row, ever. */
function ruleRow(state, itemId, productId) {
  return Object.values(state.deal_rules).find((r) => r.item_id === itemId && (r.product_id ?? "") === productId) ?? null;
}

function receiptLine(v) {
  if (!v || typeof v !== "object") throw new OpError("bad_field", "lines");
  return {
    name: text(v.name, 120, "line.name"),
    brand: text(v.brand, 60, "line.brand"),
    size: text(v.size, 40, "line.size"),
    qty: num(v.qty, "line.qty", { max: 1000 }),
    price_cents: cents(v.price_cents, "line.price_cents"),
    kind: ["product", "discount", "deposit", "other"].includes(v.kind) ? v.kind : "product",
  };
}

/** One word from a fixed list, or null for "not labelled". */
const oneOf = (list, field) => (v) => {
  if (v === null || v === undefined || v === "") return null;
  if (!list.includes(v)) throw new OpError("bad_field", field);
  return v;
};

const RECIPE_FIELDS = {
  title: (v) => text(v, 200, "title"),
  servings: (v) => {
    const n = num(v, "servings", { min: 1, max: 100 });
    return n === null ? null : Math.round(n);
  },
  ingredients: (v) => {
    if (!Array.isArray(v) || v.length > 200) throw new OpError("bad_field", "ingredients");
    return v.map(ingredient).filter(Boolean);
  },
  steps: (v) => {
    if (!Array.isArray(v) || v.length > 200) throw new OpError("bad_field", "steps");
    return v.map((s) => text(s, 2000, "step")).filter(Boolean);
  },
  notes: (v) => text(v, 20000, "notes"),
  nutrition,
  photo: (v) => {
    if (v === null || v === "") return null;
    if (typeof v !== "string" || !PHOTO_RE.test(v)) throw new OpError("bad_field", "photo");
    return v;
  },
  // "Credits" (30-10-2026): a link to the original, or just a name
  // ("Henk", "Noor"). A link must be http(s); anything else is plain text.
  source_url: (v) => {
    if (v === null || v === "") return null;
    if (typeof v !== "string") throw new OpError("bad_field", "source_url");
    const text = v.replace(/\s+/g, " ").trim();
    if (!text) return null;
    if (/^https?:\/\//i.test(text) ? !/^https?:\/\/\S{3,500}$/.test(text) : text.length > 120) throw new OpError("bad_field", "source_url");
    return text;
  },
  cuisine: oneOf(CUISINES, "cuisine"),
  main_ingredient: oneOf(MAIN_INGREDIENTS, "main_ingredient"),
  time_class: oneOf(TIME_CLASSES, "time_class"),
  time_minutes: (v) => {
    const n = num(v, "time_minutes", { min: 1, max: 1440 });
    return n === null ? null : Math.round(n);
  },
  meals: (v) => {
    if (v === null || v === undefined) return null;
    if (!Array.isArray(v) || v.length > MEALS.length || v.some((m) => !MEALS.includes(m))) throw new OpError("bad_field", "meals");
    return sortMeals(v);
  },
  labels_by: oneOf(LABELS_BY, "labels_by"),
  // The language it is written in (0029); a recipe without one gets it from its text on save.
  lang: oneOf(LANGS, "lang"),
};

// ---------------------------------------------------------------- pantry

/** The day an op happened: the phone's own day when it says so (op.on), else the server's. */
function dayOf(op, ctx) {
  return op.on !== undefined && op.on !== null ? date(op.on, "on") : ctx.now.slice(0, 10);
}

/** Packs or pieces: a number from 0 to 1000, two decimals at most. */
function packs(v, field = "amount") {
  const n = num(v, field, { max: 1000 });
  return n === null ? null : round2(n);
}

function pantryRow(state, rowId) {
  const r = state.pantry[id(rowId)];
  if (!r || r.deleted_at) throw new OpError("not_found", "pantry");
  return r;
}

function finishIfEmpty(row, ctx) {
  if (row.amount > 0) return;
  row.amount = 0;
  if (!row.deleted_at) row.deleted_at = ctx.now;
}

/**
 * A ticked list line goes into the pantry (Thomas, phase 4). Its row id
 * comes from the line, so ticking, unticking and ticking again is one row,
 * and the phone and the worker agree on it without the op naming it (the
 * Android widget's ticks too). An excluded thing never gets a row.
 */
function stockFromEntry(state, ctx, e, day) {
  if (isExcluded(e.title) || !e.item_id) return;
  const pid = entryPantryId(e.id);
  const prev = state.pantry[pid];
  // Still there, already eaten from, or already a receipt's row: leave it.
  if (prev && (!prev.deleted_at || prev.taken > 0 || prev.source_purchase_id)) return;
  const { amount, pack_size } = fromEntry(e);
  state.pantry[pid] = {
    created_by: ctx.memberId, created_at: ctx.now, ...(prev ?? {}),
    id: pid, item_id: e.item_id, product_id: null, title: e.title, amount, taken: 0, pack_size, added_on: day, amount_on: null,
    use_by: estimateUseBy(day, e.title, state.items[e.item_id]), use_by_source: "estimate", source_entry_id: e.id, source_purchase_id: null,
    updated_at: ctx.now, deleted_at: null,
  };
  ctx.touch("pantry", pid);
}

/** Unticked (a mistap): the row goes again, unless something was already taken from it or a receipt filled it in. */
function unstockEntry(state, ctx, e) {
  const row = state.pantry[entryPantryId(e.id)];
  if (!row || row.deleted_at || row.taken > 0 || row.source_purchase_id) return;
  row.deleted_at = ctx.now;
  row.updated_at = ctx.now;
  ctx.touch("pantry", row.id);
}

/**
 * A purchase from a receipt (with pantry: true) fills in the row its tick
 * made (matchPurchase in public/shared/pantry.js), or adds one. Filling in
 * never counts twice: the amount becomes what was bought minus what was
 * already taken out.
 */
function stockFromPurchase(state, ctx, op, purchase, product) {
  const qty = purchase.qty > 0 ? round2(Math.min(purchase.qty, 100)) : 1;
  const names = [product ? `${product.brand} ${product.name}` : null, purchase.title].filter(Boolean);
  const ownId = op.pantry_id ? id(op.pantry_id, "pantry_id") : purchasePantryId(purchase.id);
  if (state.pantry[ownId]) return ownId;               // a replay
  const match = matchPurchase(state.pantry, { item_id: purchase.item_id, bought_on: purchase.bought_on });
  const row = match ?? {
    id: ownId, item_id: purchase.item_id, title: purchase.title, amount: qty, taken: 0, pack_size: "",
    added_on: purchase.bought_on, use_by_source: "estimate", source_entry_id: op.entry_id ? id(op.entry_id, "entry_id") : null,
    created_by: ctx.memberId, created_at: ctx.now, deleted_at: null,
  };
  if (match) {
    match.amount = round2(Math.max(0, qty - (match.taken ?? 0)));
    // What was bought minus what was taken, as of the day it came in: a countdown runs from there.
    match.amount_on = null;
    if (match.amount > 0) match.deleted_at = null;
    else finishIfEmpty(match, ctx);
  }
  row.product_id = product?.id ?? row.product_id ?? null;
  if (product?.size) row.pack_size = product.size;
  row.source_purchase_id = purchase.id;
  if (row.use_by_source !== "person") {
    // The product's own shelf life first, then the item's, then the rules on the names.
    row.use_by = estimateUseBy(row.added_on, ...names, product, state.items[purchase.item_id]);
    row.use_by_source = "estimate";
  }
  row.updated_at = ctx.now;
  state.pantry[row.id] = row;
  ctx.touch("pantry", row.id);
  payPending(state, ctx, row);
  return row.id;
}

/**
 * Cooked before the receipt was in (public/shared/pantry.js, pendingFits):
 * the pending takes this row pays are taken off it now, oldest cook first,
 * each as a "cooked" event on the cook's day, so the row is what was bought
 * minus what was cooked. A take the row cannot cover in full is done with
 * what it had (the rest was in the house already). Unsure amounts wait.
 */
function payPending(state, ctx, row) {
  const open = Object.values(state.pending_takes).filter((p) => pendingFits(p, row, state.items))
    .sort((a, b) => a.cooked_on.localeCompare(b.cooked_on) || a.id.localeCompare(b.id));
  for (const p of open) {
    if (!(row.amount > 0)) break;
    const need = pendingNeed(p, row);
    if (!need || !(need.packs > 0)) continue;
    const amount = round2(Math.min(need.packs, row.amount));
    if (!(amount > 0)) continue;
    row.amount = round2(row.amount - amount);
    row.taken = round2((row.taken ?? 0) + amount);
    finishIfEmpty(row, ctx);
    openedRow(state, row, p.cooked_on > row.added_on ? p.cooked_on : row.added_on);
    row.updated_at = ctx.now;
    ctx.touch("pantry", row.id);
    const eid = pendingEventId(p.id);
    state.pantry_events[eid] = {
      id: eid, pantry_id: row.id, item_id: row.item_id, product_id: row.product_id ?? null, reason: "cooked",
      amount, recipe_id: p.recipe_id ?? null, happened_on: p.cooked_on, member_id: p.member_id ?? null, created_at: ctx.now, deleted_at: null,
    };
    ctx.touch("pantry_events", eid);
    Object.assign(p, { status: "done", pantry_id: row.id, event_id: eid, updated_at: ctx.now });
    ctx.touch("pending_takes", p.id);
  }
}

const USE_REASONS = ["used", "thrown", "cooked"];

/**
 * Part of a pack taken (a fraction left, "op" partly or cooking): that pack
 * is open now, so the date becomes min(current, day + the item's
 * opened_days), still an estimate. A person's date stays; an item without
 * opened_days changes nothing.
 */
function openedRow(state, row, day) {
  if (row.deleted_at || row.use_by_source === "person" || !(row.amount > 0)) return;
  if (Number.isInteger(round2(row.amount))) return;           // whole packs left: none of them open
  const opened = openedDaysOf(row.product_id ? state.products[row.product_id] : null, state.items[row.item_id]);
  if (opened === null) return;
  row.use_by = openedUseBy(row.use_by, day, opened);
  row.use_by_source = "estimate";
}

/**
 * A counted-down item (public/shared/pantry.js, drainRows) settled on `day`:
 * each of its live rows gets what is left then as its amount, and `day` as
 * the day that is true (amount_on), so a correction, an "op", cooking or a
 * new rate starts from what was shown. A row that ran out is "op": a
 * tombstone and a "used" event on the day it ran out. `except` is a row the
 * op sets itself. Items that are not counted down write nothing.
 */
function settleUsage(state, ctx, itemId, day, { except = null, item = state.items[itemId] } = {}) {
  const rows = Object.values(state.pantry).filter((r) => r.item_id === itemId && !r.deleted_at);
  for (const [rowId, cur] of drainRows(rows, item, day)) {
    const row = state.pantry[rowId];
    if (!cur || rowId === except || (row.amount_on || row.added_on) >= day) continue;
    const had = row.amount;
    row.amount = cur.amount;
    row.amount_on = cur.amount > 0 ? day : cur.empty_on;
    row.updated_at = ctx.now;
    ctx.touch("pantry", row.id);
    if (cur.amount > 0) continue;
    finishIfEmpty(row, ctx);
    const eid = rateEventId(row.id);
    if (state.pantry_events[eid] && !state.pantry_events[eid].deleted_at) continue;
    state.pantry_events[eid] = {
      id: eid, pantry_id: row.id, item_id: row.item_id, product_id: row.product_id ?? null, reason: "used",
      amount: had, recipe_id: null, happened_on: cur.empty_on, member_id: null, created_at: ctx.now, deleted_at: null,
    };
    ctx.touch("pantry_events", eid);
  }
}

/** A rate for item.rate: packs or pieces a day, RATE_MIN..RATE_MAX, 0 (no countdown) or null; stored as sent (6/7 stays 6/7). */
function ratePerDay(v) {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > RATE_MAX || (v > 0 && v < RATE_MIN)) throw new OpError("bad_field", "use_per_day");
  return v;
}

/** The live rows of one item, as they are now (copies: a later settle or take does not change them). */
function itemRows(state, itemId) {
  return Object.values(state.pantry).filter((r) => r.item_id === itemId && !r.deleted_at).map((r) => ({ ...r }));
}

/**
 * A signal teaches the item's rate (public/shared/rate-learning.js): rows are
 * the item's rows as they were before the op, day the op's own day. With
 * settle, the item's rows are settled at the old rate first, so what is shown
 * today stays (as item.rate does). The rate becomes "learned", one more
 * sample. Returns the lesson or null.
 */
function teach(state, ctx, item, signal, rows, day, { settle = false } = {}) {
  if (!item || item.deleted_at || isExcluded(item.name)) return null;
  const lesson = learnRate(signal, item, rows, day);
  if (!lesson) return null;
  if (settle) settleUsage(state, ctx, item.id, day, { item: { ...item } });
  item.use_per_day = lesson.use_per_day;
  item.rate_source = "learned";
  item.rate_samples = lesson.samples;
  ctx.touch("items", item.id);
  return lesson;
}

/** Days for item.shelf: an integer 1..SHELF_DAYS_MAX, KEEPS where allowed, or null. */
function shelfDays(v, field, { keeps }) {
  if (v === null) return null;
  if (!Number.isInteger(v) || !((v >= 1 && v <= SHELF_DAYS_MAX) || (keeps && v === KEEPS))) throw new OpError("bad_field", field);
  return v;
}

/**
 * The shelf-life patch of item.shelf and product.shelf on `row` (an item or a
 * product): "kept" when a lower source would replace a higher one, "same"
 * when nothing changes, else "changed" (row patched; daysChanged says whether
 * shelf_days moved). Validates like item.shelf always did.
 */
function patchShelf(row, op, source) {
  if (!SHELF_SOURCES.includes(source)) throw new OpError("bad_field", "source");
  if (!("shelf_days" in op) && !("opened_days" in op)) throw new OpError("bad_field", "shelf_days");
  const next = {
    shelf_days: "shelf_days" in op ? shelfDays(op.shelf_days, "shelf_days", { keeps: true }) : row.shelf_days ?? null,
    opened_days: "opened_days" in op ? shelfDays(op.opened_days, "opened_days", { keeps: false }) : row.opened_days ?? null,
  };
  if (source !== "person" && next.shelf_days === null) throw new OpError("bad_field", "shelf_days");
  if (next.shelf_days !== null && next.shelf_days !== KEEPS && next.opened_days !== null) {
    next.opened_days = Math.min(next.opened_days, next.shelf_days);
  }
  const had = row.shelf_source ?? null;
  if (had && SHELF_RANK[source] < SHELF_RANK[had]) return { outcome: "kept" };
  // Everything cleared by a person: back to the item, then the rules table.
  next.shelf_source = next.shelf_days === null && next.opened_days === null ? null : source;
  if (next.shelf_days === (row.shelf_days ?? null) && next.opened_days === (row.opened_days ?? null)
    && next.shelf_source === had) return { outcome: "same" };
  const daysChanged = next.shelf_days !== (row.shelf_days ?? null);
  Object.assign(row, next);
  return { outcome: "changed", daysChanged };
}

/** Live, unopened rows with an estimated date get added_on + days (KEEPS: no date). */
function reestimate(state, ctx, rows, days) {
  if (days === null) return;                                  // cleared: the rows keep what they have
  for (const row of rows) {
    if (row.deleted_at || row.use_by_source !== "estimate" || (row.taken ?? 0) > 0) continue;
    const useBy = days === KEEPS ? null : addDays(row.added_on, days);
    if ((row.use_by ?? null) === useBy) continue;
    row.use_by = useBy;
    row.updated_at = ctx.now;
    ctx.touch("pantry", row.id);
  }
}

/** The one "… gekookt?" row of a recipe and a shopping day (migrations/0016_product_shelf.sql). */
export function cookPromptId(recipeId, day) {
  return `cp-${String(day).replace(/-/g, "")}-${recipeId}`.slice(0, 64);
}

/**
 * A list line with recipes was ticked or bought on `day`: each of its
 * recipes gets (or keeps) its "… gekookt?" row for that day, naming the line.
 */
function notePrompt(state, ctx, e, day) {
  const listed = String(e.created_at || ctx.now).slice(0, 10);
  for (const src of e.sources ?? []) {
    if (!src?.recipe_id || !ID_RE.test(src.recipe_id)) continue;
    const pid = cookPromptId(src.recipe_id, day);
    const prev = state.cook_prompts[pid];
    if (prev && !prev.deleted_at) {
      const ids = prev.entry_ids ?? [];
      const firstListed = prev.listed_on < listed ? prev.listed_on : listed;
      if (ids.includes(e.id) && firstListed === prev.listed_on) continue;
      prev.entry_ids = [...new Set([...ids, e.id])].slice(-50);
      prev.listed_on = firstListed;
      prev.updated_at = ctx.now;
    } else {
      state.cook_prompts[pid] = {
        id: pid, recipe_id: src.recipe_id, listed_on: listed > day ? day : listed, shopped_on: day, entry_ids: [e.id],
        snoozed_on: null, dismissed_at: null, created_at: prev?.created_at ?? ctx.now, updated_at: ctx.now, deleted_at: null,
      };
    }
    ctx.touch("cook_prompts", pid);
  }
}

/** A tick taken back: the line leaves its rows; a row without lines is gone. */
function unnotePrompt(state, ctx, e) {
  for (const row of Object.values(state.cook_prompts)) {
    if (row.deleted_at || !(row.entry_ids ?? []).includes(e.id)) continue;
    row.entry_ids = row.entry_ids.filter((x) => x !== e.id);
    if (!row.entry_ids.length) row.deleted_at = ctx.now;
    row.updated_at = ctx.now;
    ctx.touch("cook_prompts", row.id);
  }
}

const PROMPT_ACTIONS = ["snooze", "dismiss"];

/** One pending take of pantry.pend, validated. */
function pendingInput(v) {
  if (!v || typeof v !== "object") throw new OpError("bad_field", "pending");
  const name = text(v.name, 120, "name");
  const key = nameKey(name);
  if (!key) throw new OpError("bad_field", "name");
  const qty = num(v.qty, "qty", { max: 100000 });
  if (qty === null || !(qty > 0)) throw new OpError("bad_field", "qty");
  const unit = v.unit === undefined || v.unit === null ? null : v.unit;
  if (unit !== null && !UNIT_CODES.includes(unit)) throw new OpError("bad_field", "unit");
  return {
    id: id(v.id, "pending.id"), item_id: v.item_id ? id(v.item_id, "item_id") : null,
    name, name_key: key, qty, unit, default_portion: v.default_portion ? 1 : 0,
  };
}

// ---------------------------------------------------------- moving rows

/** What item.merge and product.move moved, per kind (for the confirm, the MCP tool and the dry run). */
function emptyMoved() {
  return { purchases: 0, products: 0, pantry: 0, pantry_events: 0, entries: 0, entries_merged: 0, preferences: 0, deal_rules: 0, pending_takes: 0 };
}

/** One row of `kind` now belongs to `item` (a list line, a purchase and a pantry row also take its name). */
function moveRow(ctx, kind, row, item) {
  row.item_id = item.id;
  if (kind === "entries" || kind === "purchases" || kind === "pantry") row.title = item.name;
  if (kind !== "purchases" && kind !== "pantry_events") row.updated_at = ctx.now;
  ctx.touch(kind, row.id);
}

const PREFERENCE_COPY = ["store", "product_id"];

/**
 * A preference or deal rule row comes to `into`. A scope has one row, ever
 * (preferences_scope, deal_rules_scope, tombstones included), so: into's own
 * live row wins and this one gets a tombstone; into's cleared row is revived
 * with this row's values (and this one gets a tombstone); with no row of its
 * own, the row itself moves. A cleared row of the from-item only moves when
 * into has nothing for that scope. Returns 1 when into gained a live row.
 */
function moveScopedRow(ctx, kind, row, intoRow, into, fields) {
  if (intoRow === row) return 0;
  const bury = (r) => {
    r.deleted_at = ctx.now;
    r.updated_at = ctx.now;
    ctx.touch(kind, r.id);
  };
  if (!intoRow) {
    moveRow(ctx, kind, row, into);
    return row.deleted_at ? 0 : 1;
  }
  if (row.deleted_at) return 0;
  if (!intoRow.deleted_at) {
    bury(row);
    return 0;
  }
  for (const f of fields) intoRow[f] = row[f];
  intoRow.deleted_at = null;
  intoRow.updated_at = ctx.now;
  ctx.touch(kind, intoRow.id);
  bury(row);
  return 1;
}

/** Settle a counted-down item's rows on `day` before its rows or rate change (as item.rate does). */
function settleItem(state, ctx, itemId, day) {
  const item = state.items[itemId];
  if (item) settleUsage(state, ctx, itemId, day, { item: { ...item } });
}

const hasRate = (x) => x.use_per_day !== null && x.use_per_day !== undefined;
/** A rate someone stands behind: a person's, or one the household's use taught (not Claude's guess). */
const ownRate = (x) => hasRate(x) && (x.rate_source === "person" || x.rate_source === "learned");

/**
 * The settings of the from-item that the into-item lacks come along (rate,
 * "Weer nodig", "Bijna op", shelf life, "Nog niet"). The rate: into's own
 * (a person's or learned) stays; else from's when it is its own or into has
 * none at all; Claude's guess on both: into's stays. Returns whether into changed.
 */
function copyMissingSettings(into, from) {
  let changed = false;
  const take = (fields) => {
    for (const f of fields) into[f] = from[f] ?? null;
    changed = true;
  };
  if (!ownRate(into) && hasRate(from) && (ownRate(from) || !hasRate(into))) take(["use_per_day", "rate_source", "rate_samples"]);
  for (const f of ["again", "low_at", "low_off", "not_yet_until"]) {
    if ((into[f] ?? null) === null && (from[f] ?? null) !== null) take([f]);
  }
  if (!into.shelf_source && from.shelf_source) take(["shelf_days", "opened_days", "shelf_source"]);
  return changed;
}

const HANDLERS = {
  // Creates a recipe or changes the fields that are present (a patch), so
  // setting a photo on one phone does not undo an edit made on another.
  "recipe.put"(state, op, ctx) {
    const rid = id(op.id);
    const patch = op.recipe;
    if (!patch || typeof patch !== "object") throw new OpError("bad_field", "recipe");
    const prev = state.recipes[rid];
    const row = prev ? { ...prev } : {
      id: rid, title: "", servings: null, ingredients: [], steps: [], notes: "", nutrition: null,
      photo: null, source_url: null, cuisine: null, main_ingredient: null, time_class: null, time_minutes: null,
      meals: null, labels_by: null, created_by: ctx.memberId, created_at: ctx.now,
    };
    // Labels always say who set them, or the rule below could not hold.
    if (LABEL_FIELDS.some((f) => f in patch) && !("labels_by" in patch)) throw new OpError("bad_field", "labels_by");
    // Labels a person set are theirs: Claude's labelling never replaces them.
    // One exception: meals came later (28-10-2026), so Claude may fill the
    // meals of a person's recipe while they are still empty, and only those;
    // the labels stay the person's.
    let keepPerson = false;
    if (patch.labels_by === "claude" && prev?.labels_by === "person") {
      const onlyMeals = LABEL_FIELDS.every((f) => f === "meals" || !(f in patch)) && "meals" in patch;
      if (!onlyMeals || prev.meals?.length) throw new OpError("labels_by_person");
      keepPerson = true;
    }
    for (const [field, clean] of Object.entries(RECIPE_FIELDS)) {
      if (field in patch) row[field] = clean(patch[field]);
    }
    if (keepPerson) row.labels_by = "person";
    if (!row.title) throw new OpError("title_required");
    if (!row.lang) row.lang = detectLang(row);
    row.updated_at = ctx.now;
    row.deleted_at = null;
    state.recipes[rid] = row;
    ctx.touch("recipes", rid);
    return {};
  },

  "recipe.delete"(state, op, ctx) {
    const r = state.recipes[id(op.id)];
    if (!r || r.deleted_at) return {};
    r.deleted_at = ctx.now;
    r.updated_at = ctx.now;
    ctx.touch("recipes", r.id);
    return {};
  },

  // Adding something that is already on the list (and not yet in the cart)
  // adds to that line instead: 400 g gehakt + 300 g gehakt is one line of
  // 700 g, "for: Chili, Lasagne".
  "entry.add"(state, op, ctx) {
    const eid = id(op.id);
    if (state.entries[eid]) return {};                 // a replay of an op already applied
    const title = text(op.title, 120, "title");
    const { item, made } = lineItem(state, ctx, op, title);
    const incoming = {
      amounts: amounts(op.amounts),
      sources: op.source ? [source(op.source)] : [],
      note: text(op.note, 500, "note"),
    };
    const open = openEntryFor(state, item.id);
    if (open) {
      mergeInto(open, incoming, ctx);
      return { merged_into: open.id, item_id: item.id, new_item: false };
    }
    // On the list while the countdown said otherwise: it is nearly empty now
    // (rate-learning.js, "list"). Not for a recipe's ingredients.
    if (!incoming.sources.length) teach(state, ctx, item, "list", itemRows(state, item.id), dayOf(op, ctx), { settle: true });
    state.entries[eid] = {
      id: eid, item_id: item.id, title: item.name, typed: typedName(title, item), new_item: made ? 1 : 0, ...incoming,
      added_by: ctx.memberId, checked_at: null, checked_by: null,
      created_at: ctx.now, updated_at: ctx.now, deleted_at: null,
    };
    ctx.touch("entries", eid);
    return { item_id: item.id, new_item: made };
  },

  // With title: the line goes to the item of that name (found or made). With
  // the item_id of a known item ("Koppel aan…", "Bedoel je …?"): the line is
  // linked to that item and keeps what was typed. A line that made its own
  // item (new_item) and is linked elsewhere leaves that item behind unused:
  // it gets a tombstone, so "Mino" does not stay a suggestion forever.
  "entry.update"(state, op, ctx) {
    const e = entryOf(state, op.id);
    if ("title" in op) {
      const title = text(op.title, 120, "title");
      const { item, made, linked } = lineItem(state, ctx, op, title);
      const typed = linked ? (e.typed || e.title) : title;
      const oldItem = e.item_id && e.item_id !== item.id && e.new_item ? state.items[e.item_id] : null;
      if (item.id !== e.item_id) {
        const other = e.checked_at ? null : openEntryFor(state, item.id, e.id);
        if (other) {
          mergeInto(other, e, ctx);
          e.deleted_at = ctx.now;
          e.updated_at = ctx.now;
          ctx.touch("entries", e.id);
          dropIfUnused(state, ctx, oldItem);
          return { merged_into: other.id, item_id: item.id, new_item: false };
        }
        e.item_id = item.id;
      }
      e.title = item.name;
      e.typed = typedName(typed, item);
      e.new_item = made ? 1 : 0;
      dropIfUnused(state, ctx, oldItem);
    }
    if ("amounts" in op) e.amounts = amounts(op.amounts);
    if ("note" in op) e.note = text(op.note, 500, "note");
    e.updated_at = ctx.now;
    ctx.touch("entries", e.id);
    return {};
  },

  "entry.check"(state, op, ctx) {
    const e = entryOf(state, op.id);
    const checked = Boolean(op.checked);
    if (checked === Boolean(e.checked_at)) return {};
    if (checked) {
      e.checked_at = ctx.now;
      e.checked_by = ctx.memberId;
      stockFromEntry(state, ctx, e, dayOf(op, ctx));
      notePrompt(state, ctx, e, dayOf(op, ctx));
    } else {
      unstockEntry(state, ctx, e);
      unnotePrompt(state, ctx, e);
      // Back on the list while someone already added it again: one line.
      const other = openEntryFor(state, e.item_id, e.id);
      if (other) {
        mergeInto(other, e, ctx);
        e.deleted_at = ctx.now;
        e.updated_at = ctx.now;
        ctx.touch("entries", e.id);
        return { merged_into: other.id };
      }
      e.checked_at = null;
      e.checked_by = null;
    }
    e.updated_at = ctx.now;
    ctx.touch("entries", e.id);
    return {};
  },

  "entry.delete"(state, op, ctx) {
    const e = state.entries[id(op.id)];
    if (!e || e.deleted_at) return {};
    e.deleted_at = ctx.now;
    e.updated_at = ctx.now;
    ctx.touch("entries", e.id);
    return {};
  },

  // Clears exactly the lines the person saw in the cart, not whatever another
  // phone checked in the meantime.
  "entry.clear_checked"(state, op, ctx) {
    if (!Array.isArray(op.ids) || op.ids.length > 500) throw new OpError("bad_field", "ids");
    let cleared = 0;
    for (const eid of op.ids) {
      const e = state.entries[id(eid)];
      if (!e || e.deleted_at || !e.checked_at) continue;
      e.deleted_at = ctx.now;
      e.updated_at = ctx.now;
      ctx.touch("entries", e.id);
      cleared++;
    }
    return { cleared };
  },

  "member.update"(state, op, ctx) {
    const m = state.members[id(op.id)];
    if (!m || m.removed_at) throw new OpError("not_found", "member");
    if (m.id !== ctx.memberId && !ctx.isAdmin) throw new OpError("forbidden");
    if ("name" in op) {
      const name = text(op.name, 60, "name");
      if (!name) throw new OpError("name_required");
      m.name = name;
    }
    if ("locale" in op) {
      if (!["nl", "en"].includes(op.locale)) throw new OpError("bad_field", "locale");
      m.locale = op.locale;
    }
    ctx.touch("members", m.id);
    return {};
  },

  // A product typed in by hand, or a correction to one read from a receipt.
  "product.put"(state, op, ctx) {
    const row = putProduct(state, ctx, op.id, op.product);
    if (op.product && "item_id" in op.product) {
      row.item_id = op.product.item_id === null ? null : id(op.product.item_id, "item_id");
      if (row.item_id && !state.items[row.item_id]) throw new OpError("not_found", "item");
    }
    return { product_id: row.id };
  },

  // "Weer nodig" scope per item: 'hide', 'show', or null to let the rule decide
  // (public/shared/again-scope.js).
  // Tidy an item's shown name (30-10-2026: "Knoflookpoeder?" is no name
  // for a thing). Only spelling the key ignores (case, "?", punctuation) may
  // change, so every alias, import and list line still finds it.
  "item.rename"(state, op, ctx) {
    const item = state.items[id(op.item_id, "item_id")];
    if (!item || item.deleted_at) throw new OpError("not_found", "item");
    const name = text(op.name, 120, "name");
    if (!name) throw new OpError("name_required", "name");
    if (nameKey(name) !== nameKey(item.name)) throw new OpError("bad_field", "name");
    if (item.name !== name) {
      item.name = name;
      ctx.touch("items", item.id);
    }
    return {};
  },

  // "Alleen voor mij" (30-10-2026: Condooms, a reminder only he
  // sees). { item_id, private: true } makes the item the sender's own
  // (private_to = his member id), false gives it back to the household. Only
  // that member may clear it; for anyone else it does not exist (not_found;
  // worker/ops-store.js hides it before the engine runs). Every row about
  // the item is written again (its rev moves), so the other members' phones
  // get it as gone, or back, on their next pull.
  "item.private"(state, op, ctx) {
    const item = state.items[id(op.item_id, "item_id")];
    if (!item || item.deleted_at) throw new OpError("not_found", "item");
    if (typeof op.private !== "boolean") throw new OpError("bad_field", "private");
    if (!ctx.memberId) throw new OpError("forbidden");
    const owner = item.private_to ?? null;
    if (owner && owner !== ctx.memberId) throw new OpError("not_found", "item");
    const want = op.private ? ctx.memberId : null;
    if (owner === want) return { already: true };
    item.private_to = want;
    ctx.touch("items", item.id);
    const products = new Set();
    for (const p of Object.values(state.products)) if (p.item_id === item.id) products.add(p.id);
    const receipts = new Set();
    for (const kind of [...ITEM_ROWS, "ratings", "store_prices", "auto_changes"]) {
      for (const row of Object.values(state[kind] ?? {})) {
        if (row.item_id !== item.id && !products.has(row.product_id)) continue;
        ctx.touch(kind, row.id);
        if (kind === "purchases" && row.receipt_id) receipts.add(row.receipt_id);
      }
    }
    for (const rid of receipts) if (state.receipts[rid]) ctx.touch("receipts", rid);
    // Text that names it (a nightly report, a recipe linked to it): loaded by the server.
    for (const r of Object.values(state.reviews ?? {})) ctx.touch("reviews", r.id);
    for (const r of Object.values(state.recipes ?? {})) ctx.touch("recipes", r.id);
    return { private: op.private };
  },

  "item.again"(state, op, ctx) {
    const item = state.items[id(op.item_id, "item_id")];
    if (!item || item.deleted_at) throw new OpError("not_found", "item");
    if (op.again !== null && op.again !== "show" && op.again !== "hide") throw new OpError("bad_field", "again");
    if ((item.again ?? null) !== op.again) {
      item.again = op.again;
      ctx.touch("items", item.id);
    }
    return {};
  },

  // "Bijna op" per item (public/shared/low-stock.js), a patch: low_at is the
  // threshold as typed ("300 g", "0,5" packs; null: the default rule), low_off
  // true never warns. The same values again write nothing.
  "item.low"(state, op, ctx) {
    const item = state.items[id(op.item_id, "item_id")];
    if (!item || item.deleted_at) throw new OpError("not_found", "item");
    if (!("low_at" in op) && !("low_off" in op)) throw new OpError("bad_field", "low_at");
    let changed = false;
    if ("low_at" in op) {
      let lowAt = null;
      if (op.low_at !== null) {
        if (typeof op.low_at !== "string") throw new OpError("bad_field", "low_at");
        lowAt = op.low_at.replace(/\s+/g, " ").trim().slice(0, LOW_AT_MAX + 1) || null;
        if (lowAt !== null && !parseLowAt(lowAt)) throw new OpError("bad_field", "low_at");
      }
      if ((item.low_at ?? null) !== lowAt) {
        item.low_at = lowAt;
        changed = true;
      }
    }
    if ("low_off" in op) {
      if (typeof op.low_off !== "boolean" && op.low_off !== 0 && op.low_off !== 1) throw new OpError("bad_field", "low_off");
      const off = op.low_off ? 1 : 0;
      if ((item.low_off ? 1 : 0) !== off) {
        item.low_off = off;
        changed = true;
      }
    }
    if (changed) ctx.touch("items", item.id);
    return {};
  },

  // "Nog niet" in "Al nodig?" (public/shared/needed-soon.js): the item stays
  // out of that section until `until` (a day; null: back at once). Only for
  // what has no countdown; a counted-down thing gets more left instead
  // (pantry.update). The same day again writes nothing.
  "item.not_yet"(state, op, ctx) {
    const item = state.items[id(op.item_id, "item_id")];
    if (!item || item.deleted_at) throw new OpError("not_found", "item");
    const until = op.until === null ? null : date(op.until, "until");
    if ((item.not_yet_until ?? null) !== until) {
      item.not_yet_until = until;
      ctx.touch("items", item.id);
    }
    return {};
  },

  // Shelf life per item (public/shared/shelf-life.js), a patch: shelf_days
  // unopened (-1: keeps for years), opened_days once opened, source who says
  // so. A lower source never replaces a higher one (person > claude > rule):
  // that answers { kept: true } and writes nothing. The same values again
  // write nothing. The item's live, unopened pantry rows with an estimated
  // date get the new estimate; a person's date is never touched.
  "item.shelf"(state, op, ctx) {
    const item = state.items[id(op.item_id, "item_id")];
    if (!item || item.deleted_at) throw new OpError("not_found", "item");
    const { outcome, daysChanged } = patchShelf(item, op, op.source);
    if (outcome === "kept") return { kept: true };
    if (outcome === "same") return {};
    ctx.touch("items", item.id);
    // A row whose product has its own shelf life follows the product, not the item.
    if (daysChanged) {
      reestimate(state, ctx, Object.values(state.pantry).filter((r) => r.item_id === item.id
        && itemShelfDays(r.product_id ? state.products[r.product_id] : null) === null), item.shelf_days ?? null);
    }
    return {};
  },

  // Shelf life per product (28-10-2026: houdbare melk is no fresh
  // milk), the same rules as item.shelf, and the product's values win over its
  // item's. One product ({ product_id, shelf_days?, opened_days?, source }), or
  // from an admin device a batch ({ products: [{ product_id, shelf_days,
  // opened_days }], source }, at most 100) for the prepared map. A batch skips
  // unknown products (missing) and lower sources (kept) instead of refusing.
  "product.shelf"(state, op, ctx) {
    const batch = "products" in op;
    if (batch && !ctx.isAdmin) throw new OpError("forbidden", "products");
    const list = batch ? op.products : [{ ...op }];
    if (!Array.isArray(list) || !list.length || list.length > 100) throw new OpError("bad_field", "products");
    const out = { changed: 0, kept: [], missing: [] };
    for (const one of list) {
      if (!one || typeof one !== "object") throw new OpError("bad_field", "products");
      const p = state.products[id(one.product_id, "product_id")];
      if (!p || p.deleted_at) {
        if (!batch) throw new OpError("not_found", "product");
        out.missing.push(one.product_id);
        continue;
      }
      const { outcome, daysChanged } = patchShelf(p, one, op.source);
      if (outcome === "kept") {
        out.kept.push(p.id);
        continue;
      }
      if (outcome === "same") continue;
      p.updated_at = ctx.now;
      ctx.touch("products", p.id);
      out.changed++;
      if (daysChanged) reestimate(state, ctx, Object.values(state.pantry).filter((r) => r.product_id === p.id), p.shelf_days ?? null);
    }
    if (batch) return out;
    return out.kept.length ? { kept: true } : {};
  },

  // How fast an item goes when nothing but time uses it (public/shared/pantry.js,
  // withUsage): use_per_day packs or pieces a day (0: no countdown, also no
  // default from usage-rates.js; null: back to the default), source who says so.
  // Claude's rate never replaces a person's ({ kept: true }). With title the
  // item is found by name or made. The item's rows are settled on the op's day
  // at the old rate first, so a new rate never changes what is shown today.
  "item.rate"(state, op, ctx) {
    if (!RATE_SOURCES.includes(op.source)) throw new OpError("bad_field", "source");
    if (!("use_per_day" in op)) throw new OpError("bad_field", "use_per_day");
    const perDay = ratePerDay(op.use_per_day);
    if (op.source !== "person" && !(perDay > 0)) throw new OpError("bad_field", "use_per_day");
    let item;
    if (typeof op.title === "string") {
      const title = text(op.title, 120, "title");
      noExcluded(title);
      item = resolveItem(state, ctx, title, op.item_id);
    } else {
      item = state.items[id(op.item_id, "item_id")];
      if (!item || item.deleted_at) throw new OpError("not_found", "item");
    }
    noExcluded(item.name);
    const had = item.rate_source ?? null;
    if (had && RATE_RANK[op.source] < RATE_RANK[had]) return { kept: true, item_id: item.id };
    const source = perDay === null ? null : op.source;
    if ((item.use_per_day ?? null) === perDay && had === source) return { item_id: item.id };
    settleUsage(state, ctx, item.id, dayOf(op, ctx), { item: { ...item } });
    item.use_per_day = perDay;
    item.rate_source = source;
    // Set by hand (or estimated): the learning starts again from this value.
    item.rate_samples = 0;
    ctx.touch("items", item.id);
    return { item_id: item.id };
  },

  // The one product per item of the first phase 2 build, still sent by a phone
  // whose app is older than preferences: it sets or clears the preference at
  // any store and any recipe. items.preferred_product_id is no longer written.
  "item.prefer"(state, op, ctx) {
    const item = state.items[id(op.item_id, "item_id")];
    if (!item || item.deleted_at) throw new OpError("not_found", "item");
    if (op.product_id === null) clearPreference(state, ctx, item.id, "", "");
    else setPreference(state, ctx, item, liveProduct(state, op.product_id), "", "", `pf-${item.id}`.slice(0, 64));
    return {};
  },

  // The product to buy for an item at a store ('' = any) for a recipe ('' =
  // any): "tortilla chips" -> "Doritos" in general, the store brand for the
  // nachos lasagne. With a title instead of a known item, the item is made,
  // so a recipe's ingredient can get one before it was ever on the list.
  // With only_if_unset (tools/import_ah.mjs) a scope that has a row, live or
  // cleared, is left alone.
  "preference.set"(state, op, ctx) {
    const { store, recipeId } = scopeOf(op);
    let item;
    if (typeof op.title === "string" && op.title.trim()) {
      noExcluded(op.title);
      item = resolveItem(state, ctx, text(op.title, 120, "title"), op.item_id);
    } else {
      item = state.items[id(op.item_id, "item_id")];
      if (!item || item.deleted_at) throw new OpError("not_found", "item");
    }
    liveRecipe(state, recipeId);
    const product = liveProduct(state, op.product_id);
    // An import's suggestion (only_if_unset) never replaces a choice someone
    // made for this scope, nor one they cleared.
    const prev = op.only_if_unset === true ? scopeRow(state, item.id, store, recipeId) : null;
    if (prev) return { preference_id: prev.id, item_id: item.id, kept: true };
    const row = setPreference(state, ctx, item, product, store, recipeId, id(op.id));
    return { preference_id: row.id, item_id: item.id };
  },

  "preference.clear"(state, op, ctx) {
    const { store, recipeId } = scopeOf(op);
    clearPreference(state, ctx, id(op.item_id, "item_id"), store, recipeId);
    return {};
  },

  // A deal rule for an item, or one product of it (28-10-2026): a
  // patch, so "omweg waard" can be added to a rule without repeating its
  // price. A minimum discount means "only on offer"; a unit price needs its
  // unit. With a title instead of a known item, the item is made. The same
  // values again write nothing. match_words / require_words / exclude_words
  // and detour_min_discount_pct: see public/shared/deals.js.
  "deal_rule.set"(state, op, ctx) {
    let item;
    if (typeof op.title === "string" && op.title.trim()) {
      noExcluded(op.title);
      item = resolveItem(state, ctx, text(op.title, 120, "title"), op.item_id);
    } else {
      item = state.items[id(op.item_id, "item_id")];
      if (!item || item.deleted_at) throw new OpError("not_found", "item");
    }
    const productId = op.product_id ? id(op.product_id, "product_id") : "";
    const product = productId ? liveProduct(state, productId) : null;
    noExcluded(item.name, product?.name, product ? `${product.brand} ${product.name}` : "");
    const prev = ruleRow(state, item.id, productId);
    const next = { ...RULE_EMPTY };
    if (prev && !prev.deleted_at) for (const f of Object.keys(RULE_FIELDS)) next[f] = prev[f] ?? RULE_EMPTY[f];
    for (const [f, clean] of Object.entries(RULE_FIELDS)) if (f in op) next[f] = clean(op[f]);
    if (next.min_discount_pct) next.offer_only = 1;
    // "Omweg waard vanaf 50%" is a detour.
    if (next.detour_min_discount_pct) next.detour = 1;
    if ((next.max_unit_price_cents === null) !== (next.unit === null)) throw new OpError("bad_field", "unit");
    if (next.max_price_cents === null && !next.offer_only && next.max_unit_price_cents === null && !next.detour
      && !next.match_words && !next.require_words && !next.exclude_words) {
      throw new OpError("empty_rule");
    }
    if (prev && !prev.deleted_at && Object.keys(RULE_FIELDS).every((f) => sameRuleValue(prev[f] ?? RULE_EMPTY[f], next[f]))) {
      return { deal_rule_id: prev.id, item_id: item.id };
    }
    // A new scope never takes an id that another rule has: on 28-10-2026 a
    // set without product_id but with the Edet rule's id replaced that rule
    // and wiped its product and price.
    const taken = !prev && state.deal_rules[id(op.id)];
    if (taken && !taken.deleted_at) throw new OpError("id_taken", "id");
    const row = prev ? { ...prev } : {
      id: id(op.id), item_id: item.id, product_id: productId, created_by: ctx.memberId, created_at: ctx.now,
    };
    Object.assign(row, next, { updated_at: ctx.now, deleted_at: null });
    state.deal_rules[row.id] = row;
    ctx.touch("deal_rules", row.id);
    return { deal_rule_id: row.id, item_id: item.id };
  },

  "deal_rule.clear"(state, op, ctx) {
    const productId = op.product_id ? id(op.product_id, "product_id") : "";
    const prev = ruleRow(state, id(op.item_id, "item_id"), productId);
    if (!prev || prev.deleted_at) return {};
    prev.deleted_at = ctx.now;
    prev.updated_at = ctx.now;
    ctx.touch("deal_rules", prev.id);
    return {};
  },

  // Stars per person per product; stars: null takes the rating away.
  "rating.set"(state, op, ctx) {
    const p = liveProduct(state, op.product_id);
    const prev = Object.values(state.ratings).find((r) => r.member_id === ctx.memberId && r.product_id === p.id);
    if (op.stars === null) {
      if (prev && !prev.deleted_at) {
        prev.deleted_at = ctx.now;
        prev.updated_at = ctx.now;
        ctx.touch("ratings", prev.id);
      }
      return {};
    }
    const stars = starsValue(op.stars);
    const row = prev ?? { id: id(op.id), member_id: ctx.memberId, product_id: p.id, created_at: ctx.now };
    Object.assign(row, { stars, note: text(op.note, 280, "note"), updated_at: ctx.now, deleted_at: null });
    state.ratings[row.id] = row;
    ctx.touch("ratings", row.id);
    return { rating_id: row.id };
  },

  // The receipt itself, after the review screen. Its purchases follow as
  // purchase.add ops with this receipt_id. Excluded lines are dropped here, so
  // a receipt row never names one.
  "receipt.save"(state, op, ctx) {
    const rid = id(op.id);
    if (state.receipts[rid]) return {};
    if (!Array.isArray(op.lines) || op.lines.length > 150) throw new OpError("bad_field", "lines");
    state.receipts[rid] = {
      id: rid,
      store: text(op.store, 40, "store"),
      bought_on: date(op.bought_on),
      total_cents: cents(op.total_cents, "total_cents"),
      lines: op.lines.map(receiptLine).filter((l) => l.name && !isExcluded(l.name) && !isExcluded(`${l.brand} ${l.name}`)),
      created_by: ctx.memberId,
      created_at: ctx.now,
      deleted_at: null,
    };
    ctx.touch("receipts", rid);
    return {};
  },

  // One thing bought. From a receipt it can name the product, check off the
  // list line it was bought for, and make the product the preferred one at
  // that store (and recipe). From the old history it is only a title and a date.
  "purchase.add"(state, op, ctx) {
    const pid = id(op.id);
    if (state.purchases[pid]) return {};
    const source = op.source;
    if (!["receipt", "history"].includes(source)) throw new OpError("bad_field", "source");
    const title = text(op.title, 120, "title");
    noExcluded(title, op.product?.name, op.product && `${op.product.brand ?? ""} ${op.product.name ?? ""}`);
    const item = resolveItem(state, ctx, title, op.item_id);
    const row = {
      id: pid, item_id: item.id, product_id: null, receipt_id: null, title: item.name,
      bought_on: date(op.bought_on), store: text(op.store, 40, "store"),
      qty: num(op.qty, "qty", { max: 1000 }), price_cents: cents(op.price_cents, "price_cents"),
      source, created_by: ctx.memberId, created_at: ctx.now, deleted_at: null,
    };
    const out = {};
    // A rebuy without the item on the list (rate-learning.js, "rebuy"): only a
    // receipt of these days (pantry: true), one at a time, not on offer, not
    // on the list around the day bought, no tick's row to fill in.
    const rebuy = source === "receipt" && op.pantry === true && !op.entry_id && !(row.qty > 1) && !isExcluded(item.name)
      && !listedAround(state, item, row.bought_on)
      && !matchPurchase(state.pantry, { item_id: item.id, bought_on: row.bought_on })
      && !onOffer(row, earlierPurchases(state.purchases, row), op.product?.id ?? null)
      ? itemRows(state, item.id) : null;
    if (source === "receipt") {
      if (op.receipt_id) {
        const r = state.receipts[id(op.receipt_id, "receipt_id")];
        if (!r || r.deleted_at) throw new OpError("not_found", "receipt");
        row.receipt_id = r.id;
      }
      if (op.product) {
        const unit = row.price_cents !== null && row.qty ? Math.round(row.price_cents / row.qty) : row.price_cents;
        const p = putProduct(state, ctx, op.product.id, {
          name: op.product.name, brand: op.product.brand ?? "", size: op.product.size ?? "",
          ...(row.store ? { store: row.store } : {}), ...(unit !== null && unit >= 0 ? { last_price_cents: unit } : {}),
        });
        if (!p.item_id) p.item_id = item.id;
        row.product_id = p.id;
        out.product_id = p.id;
        // "Keep as preferred": this product at this store; with
        // prefer_recipe_id only for that recipe (at this store).
        if (op.prefer || op.prefer_recipe_id) {
          const recipeId = op.prefer_recipe_id ? id(op.prefer_recipe_id, "prefer_recipe_id") : "";
          liveRecipe(state, recipeId);
          setPreference(state, ctx, item, p, canonicalStore(row.store), recipeId, `pf-${pid}`.slice(0, 64));
        }
      }
      if (op.entry_id) {
        const e = state.entries[id(op.entry_id, "entry_id")];
        if (e && !e.deleted_at && !e.checked_at) {
          e.checked_at = ctx.now;
          e.checked_by = ctx.memberId;
          e.updated_at = ctx.now;
          ctx.touch("entries", e.id);
          out.checked = e.id;
          notePrompt(state, ctx, e, row.bought_on);
        }
      } else if (op.pantry === true) {
        // Bought on a receipt while its line (for a recipe) is still open: that
        // recipe was shopped for too ("… gekookt?").
        for (const e of Object.values(state.entries)) {
          if (e.item_id !== item.id || e.deleted_at || e.checked_at || !e.sources?.length) continue;
          if (String(e.created_at).slice(0, 10) > row.bought_on) continue;
          notePrompt(state, ctx, e, row.bought_on);
        }
      }
    }
    // The receipt leads (29-10-2026): the basket lines of this thing
    // ticked around the shopping day are done, the line this purchase just
    // ticked itself too. Never an open line.
    if (source === "receipt") {
      const cleared = clearBasketFor(state, ctx, item, row.bought_on);
      if (cleared.length) out.cleared = cleared;
    }
    // Into the pantry: the photo review always (a receipt of today), the AH
    // import only for the last days' receipts, the old history never.
    if (rebuy && teach(state, ctx, item, "rebuy", rebuy, row.bought_on, { settle: true })) out.learned = true;
    if (source === "receipt" && op.pantry === true && !isExcluded(item.name)) {
      out.pantry_id = stockFromPurchase(state, ctx, op, row, row.product_id ? state.products[row.product_id] : null);
    }
    state.purchases[pid] = row;
    ctx.touch("purchases", pid);
    return out;
  },

  // The household cooked (or ate) this recipe on this day. Twice on one day,
  // from cook mode and the "eaten" button, is one row.
  "recipe.cooked"(state, op, ctx) {
    const cid = id(op.id);
    if (state.cooks[cid]) return {};
    const r = state.recipes[id(op.recipe_id, "recipe_id")];
    if (!r || r.deleted_at) throw new OpError("not_found", "recipe");
    const day = date(op.cooked_on, "cooked_on");
    const same = Object.values(state.cooks).find((c) => !c.deleted_at && c.recipe_id === r.id && c.cooked_on === day);
    if (same) return { cook_id: same.id };
    state.cooks[cid] = {
      id: cid, recipe_id: r.id, member_id: ctx.memberId, cooked_on: day, created_at: ctx.now, deleted_at: null,
    };
    ctx.touch("cooks", cid);
    return { cook_id: cid };
  },

  // A mistap on "eaten" taken back.
  "recipe.uncooked"(state, op, ctx) {
    const c = state.cooks[id(op.id)];
    if (!c || c.deleted_at) return {};
    c.deleted_at = ctx.now;
    ctx.touch("cooks", c.id);
    return {};
  },

  // "… gekookt?" answered "nog niet" (snooze: ask again tomorrow) or never
  // again (dismiss), for every phone of the household.
  "recipe.cook_prompt"(state, op, ctx) {
    const recipeId = id(op.recipe_id, "recipe_id");
    const row = state.cook_prompts[cookPromptId(recipeId, date(op.shopped_on, "shopped_on"))];
    if (!row || row.deleted_at) throw new OpError("not_found", "cook_prompt");
    if (!PROMPT_ACTIONS.includes(op.action)) throw new OpError("bad_field", "action");
    if (op.action === "dismiss") {
      if (row.dismissed_at) return {};
      row.dismissed_at = ctx.now;
    } else {
      const day = dayOf(op, ctx);
      if (row.snoozed_on === day) return {};
      row.snoozed_on = day;
    }
    row.updated_at = ctx.now;
    ctx.touch("cook_prompts", row.id);
    return {};
  },

  // Stars per person per recipe (migrations/0021_recipe_ratings.sql). stars
  // 1-10 sets them, null clears them; skip: true only answers "Hoe was ...
  // gisteren?" without stars. Setting or skipping marks asked_on (the op's
  // day), so the cook of that day or before is not asked about again.
  "recipe.rate"(state, op, ctx) {
    const recipeId = id(op.recipe_id, "recipe_id");
    const r = state.recipes[recipeId];
    if (!r || r.deleted_at) throw new OpError("not_found", "recipe");
    const day = dayOf(op, ctx);
    const skip = op.skip === true;
    let stars = null;
    if (!skip && op.stars !== null) {
      stars = starsValue(op.stars);
    }
    const prev = Object.values(state.recipe_ratings).find((x) => x.member_id === ctx.memberId && x.recipe_id === recipeId);
    const next = { ...(prev ?? {}) };
    if (!skip) next.stars = stars;
    // Clearing stars is no answer to the question; setting or skipping is.
    if ((skip || stars !== null) && !(prev?.asked_on && prev.asked_on >= day)) next.asked_on = day;
    if (prev && !prev.deleted_at && (prev.stars ?? null) === (next.stars ?? null) && (prev.asked_on ?? null) === (next.asked_on ?? null)) return { recipe_rating_id: prev.id };
    if (!prev && !skip && stars === null) return {};
    const row = prev ?? { id: id(op.id), member_id: ctx.memberId, recipe_id: recipeId, stars: null, asked_on: null, created_at: ctx.now };
    Object.assign(row, { stars: next.stars ?? null, asked_on: next.asked_on ?? null, updated_at: ctx.now, deleted_at: null });
    state.recipe_ratings[row.id] = row;
    ctx.touch("recipe_ratings", row.id);
    return { recipe_rating_id: row.id };
  },

  "purchase.delete"(state, op, ctx) {
    const p = state.purchases[id(op.id)];
    if (!p || p.deleted_at) return {};
    p.deleted_at = ctx.now;
    ctx.touch("purchases", p.id);
    return {};
  },

  // Something put in the pantry by hand (what was already in the house).
  // Without use_by the date is estimated; with one it is the person's.
  "pantry.add"(state, op, ctx) {
    const pid = id(op.id);
    if (state.pantry[pid]) return {};
    const title = text(op.title, 120, "title");
    noExcluded(title);
    const item = resolveItem(state, ctx, title, op.item_id);
    const day = dayOf(op, ctx);
    const amount = packs(op.amount) ?? 1;
    if (!(amount > 0)) throw new OpError("bad_field", "amount");
    const person = op.use_by !== undefined;
    state.pantry[pid] = {
      id: pid, item_id: item.id, product_id: null, title: item.name, amount, taken: 0,
      pack_size: text(op.pack_size, 40, "pack_size"), added_on: day, amount_on: null,
      use_by: person ? (op.use_by === null ? null : date(op.use_by, "use_by")) : estimateUseBy(day, item),
      use_by_source: person ? "person" : "estimate", source_entry_id: null, source_purchase_id: null,
      created_by: ctx.memberId, created_at: ctx.now, updated_at: ctx.now, deleted_at: null,
    };
    // Put in partly used ("mayo 30%"): an open jar, so its open shelf life counts.
    if (!person) openedRow(state, state.pantry[pid], day);
    ctx.touch("pantry", pid);
    return { pantry_id: pid };
  },

  // A corrected amount, or the real use-by date (null: it keeps).
  "pantry.update"(state, op, ctx) {
    const row = pantryRow(state, op.id);
    if (op.why !== undefined && op.why !== "not_yet") throw new OpError("bad_field", "why");
    // add_days ("Nog niet", needed-soon.js notYetOp): what the row has left
    // on the op's day plus that many days of use, worked out here when the op
    // is applied, so a change made on another phone in between is kept (the
    // widget sends the op it got minutes or hours earlier).
    if ("add_days" in op && "amount" in op) throw new OpError("bad_field", "add_days");
    if ("add_days" in op || "amount" in op) {
      const day = dayOf(op, ctx);
      let amount;
      if ("add_days" in op) {
        const days = num(op.add_days, "add_days", { min: 1, max: 60 });
        const item = state.items[row.item_id];
        const rate = rowRate(row, item);
        if (days === null || !rate) throw new OpError("bad_field", "add_days");
        const live = Object.values(state.pantry).filter((r) => r.item_id === row.item_id && !r.deleted_at);
        const left = new Map(drainRows(live, item, day)).get(row.id)?.amount ?? row.amount;
        amount = round2(left + days * rate.per_day);
      } else {
        amount = packs(op.amount);
        if (amount === null) throw new OpError("bad_field", "amount");
      }
      // A corrected amount is true today: the countdown starts again from it,
      // and the item's other rows are settled at what they showed.
      const before = op.why === "not_yet" ? itemRows(state, row.item_id) : null;
      settleUsage(state, ctx, row.item_id, day, { except: row.id });
      row.amount = amount;
      row.amount_on = day;
      finishIfEmpty(row, ctx);
      // "Nog niet" (public/shared/needed-soon.js notYetOp): it lasts longer than
      // predicted. A plain correction teaches nothing (it may be a restock).
      if (before) teach(state, ctx, state.items[row.item_id], "not_yet", before, day);
      // A fraction left is an open pack: its open shelf life counts.
      if (!("use_by" in op)) openedRow(state, row, row.added_on);
    }
    if ("use_by" in op) {
      row.use_by = op.use_by === null ? null : date(op.use_by, "use_by");
      row.use_by_source = "person";
    }
    row.updated_at = ctx.now;
    ctx.touch("pantry", row.id);
    return {};
  },

  // Out of the pantry: "op" (used), "weggegooid" (thrown) or cooked. Each
  // take is { event_id, pantry_id, amount } (amount null: all of it); each
  // becomes an event, so it can be undone and thrown things are remembered.
  // Never below zero; a row taken to zero is gone.
  "pantry.use"(state, op, ctx) {
    if (!USE_REASONS.includes(op.reason)) throw new OpError("bad_field", "reason");
    if (!Array.isArray(op.takes) || !op.takes.length || op.takes.length > 40) throw new OpError("bad_field", "takes");
    const recipeId = op.recipe_id ? id(op.recipe_id, "recipe_id") : null;
    const day = dayOf(op, ctx);
    // Taken from what is left today: a counted-down item is settled first.
    // "Op" may teach its rate: keep the item's rows as they were.
    const settled = new Set();
    const before = new Map();
    for (const take of op.takes) {
      const row = typeof take?.pantry_id === "string" ? state.pantry[take.pantry_id] : null;
      if (!row || row.deleted_at || settled.has(row.item_id) || (take.event_id && state.pantry_events[take.event_id])) continue;
      settled.add(row.item_id);
      if (op.reason === "used") before.set(row.item_id, itemRows(state, row.item_id));
      settleUsage(state, ctx, row.item_id, day);
    }
    const tookFrom = new Map();               // item id -> the last event this op made for it
    const events = [];
    for (const take of op.takes) {
      const eid = id(take?.event_id, "event_id");
      if (state.pantry_events[eid]) {
        events.push(eid);
        continue;
      }
      const row = state.pantry[id(take.pantry_id, "pantry_id")];
      // Already gone, on another phone; or its countdown ran out before this
      // "op" (settled above): that still says when it really ran out.
      if (row && before.get(row.item_id)?.some((r) => r.id === row.id) && !tookFrom.has(row.item_id)) tookFrom.set(row.item_id, null);
      if (!row || row.deleted_at) continue;
      const want = take.amount === null || take.amount === undefined ? row.amount : packs(take.amount);
      const amount = round2(Math.min(want, row.amount));
      if (!(amount > 0)) continue;
      row.amount = round2(row.amount - amount);
      row.taken = round2((row.taken ?? 0) + amount);
      finishIfEmpty(row, ctx);
      openedRow(state, row, day);
      row.updated_at = ctx.now;
      ctx.touch("pantry", row.id);
      state.pantry_events[eid] = {
        id: eid, pantry_id: row.id, item_id: row.item_id, product_id: row.product_id ?? null, reason: op.reason,
        amount, recipe_id: recipeId, happened_on: day, member_id: ctx.memberId, created_at: ctx.now, deleted_at: null,
      };
      ctx.touch("pantry_events", eid);
      events.push(eid);
      tookFrom.set(row.item_id, eid);
    }
    // "Op" that leaves nothing of the item: the real time from its start to
    // empty (rate-learning.js, "op"). Thrown away and cooked teach nothing.
    // That event remembers the rate before, so the toast's undo undoes the lesson too.
    for (const [itemId, rows] of before) {
      if (!tookFrom.has(itemId) || Object.values(state.pantry).some((r) => r.item_id === itemId && !r.deleted_at && r.amount > 0)) continue;
      const item = state.items[itemId];
      const was = item ? { use_per_day: item.use_per_day ?? null, rate_source: item.rate_source ?? null, rate_samples: item.rate_samples ?? null } : null;
      const eid = tookFrom.get(itemId);
      if (teach(state, ctx, item, "op", rows, day) && eid) state.pantry_events[eid].rate_before = was;
    }
    return { events };
  },

  // The undo of pantry.use: the events go, the amounts come back.
  "pantry.unuse"(state, op, ctx) {
    if (!Array.isArray(op.event_ids) || !op.event_ids.length || op.event_ids.length > 40) throw new OpError("bad_field", "event_ids");
    for (const eid of op.event_ids) {
      const ev = state.pantry_events[id(eid, "event_id")];
      if (!ev || ev.deleted_at) continue;
      ev.deleted_at = ctx.now;
      ctx.touch("pantry_events", ev.id);
      // The "op" taught the rate: undone too, unless something changed the rate since.
      const item = ev.rate_before ? state.items[ev.item_id] : null;
      if (item && item.rate_source === "learned" && (Number(item.rate_samples) || 0) === (Number(ev.rate_before.rate_samples) || 0) + 1) {
        item.use_per_day = ev.rate_before.use_per_day;
        item.rate_source = ev.rate_before.rate_source;
        item.rate_samples = ev.rate_before.rate_samples;
        ctx.touch("items", item.id);
      }
      // On a phone a used-up row may be gone from its copy: the worker puts it back.
      const row = state.pantry[ev.pantry_id];
      if (!row) continue;
      row.amount = round2(row.amount + ev.amount);
      row.taken = round2(Math.max(0, (row.taken ?? 0) - ev.amount));
      row.deleted_at = null;
      row.updated_at = ctx.now;
      ctx.touch("pantry", row.id);
    }
    return {};
  },

  // What a cook needed but the pantry did not have (public/shared/pantry.js,
  // cookPending): kept until a receipt purchase pays it (payPending).
  // { recipe_id, cook_id?, on, pending: [{ id, item_id?, name, qty, unit, default_portion }] }
  "pantry.pend"(state, op, ctx) {
    if (!Array.isArray(op.pending) || !op.pending.length || op.pending.length > PENDING_MAX) throw new OpError("bad_field", "pending");
    const recipeId = op.recipe_id ? id(op.recipe_id, "recipe_id") : null;
    const cookId = op.cook_id ? id(op.cook_id, "cook_id") : null;
    const day = dayOf(op, ctx);
    const ids = [];
    for (const raw of op.pending) {
      const v = pendingInput(raw);
      ids.push(v.id);
      if (state.pending_takes[v.id]) continue;              // a replay
      state.pending_takes[v.id] = {
        ...v, cook_id: cookId, recipe_id: recipeId, cooked_on: day, status: "pending", pantry_id: null, event_id: null,
        member_id: ctx.memberId, created_at: ctx.now, updated_at: ctx.now, deleted_at: null,
      };
      ctx.touch("pending_takes", v.id);
    }
    return { pending: ids };
  },

  // The cook taken back: its pending takes go; one a receipt already paid
  // gives its amount back to that row.
  "pantry.unpend"(state, op, ctx) {
    if (!Array.isArray(op.ids) || !op.ids.length || op.ids.length > PENDING_MAX) throw new OpError("bad_field", "ids");
    for (const pid of op.ids) {
      const p = state.pending_takes[id(pid, "id")];
      if (!p || p.deleted_at) continue;
      p.deleted_at = ctx.now;
      p.updated_at = ctx.now;
      ctx.touch("pending_takes", p.id);
      const ev = p.event_id ? state.pantry_events[p.event_id] : null;
      if (!ev || ev.deleted_at) continue;
      ev.deleted_at = ctx.now;
      ctx.touch("pantry_events", ev.id);
      const row = state.pantry[ev.pantry_id];
      if (!row) continue;
      row.amount = round2(row.amount + ev.amount);
      row.taken = round2(Math.max(0, (row.taken ?? 0) - ev.amount));
      row.deleted_at = null;
      row.updated_at = ctx.now;
      ctx.touch("pantry", row.id);
    }
    return {};
  },

  // A row that should not be there (a mistake), not something used or thrown.
  "pantry.remove"(state, op, ctx) {
    const row = state.pantry[id(op.id)];
    if (!row || row.deleted_at) return {};
    row.deleted_at = ctx.now;
    row.updated_at = ctx.now;
    ctx.touch("pantry", row.id);
    return {};
  },

  // One store's Checkjebon shelf prices (public/shared/store-prices.js), sent
  // by the home server only (worker/api.js refuses it from anyone else). Of
  // the thousands of rows only his products' prices are kept: one row per
  // product and store, written when its price, name, size or day changed; a
  // row whose product has no match any more gets a tombstone. Data older
  // than what is stored changes nothing. The new and changed prices go
  // first, then the newer days, at most MAX_PRICE_WRITES rows per op.
  "prices.sync"(state, op, ctx) {
    const store = PRICE_STORE_NAMES.find((s) => s === canonicalStore(text(op.store, 40, "store")));
    if (!store) throw new OpError("bad_field", "store");
    const day = date(op.day, "day");
    let rows;
    try {
      rows = checkPriceRows(op.rows);
    } catch (e) {
      throw new OpError("bad_field", e.message);
    }
    const stored = Object.values(state.store_prices).filter((r) => r.store === store);
    if (stored.some((r) => !r.deleted_at && r.price_on > day)) return { stale: true };
    const found = matchStorePrices(Object.values(state.products), state.items, rows, store);
    const writes = [];
    for (const [productId, m] of found) {
      const rid = storePriceId(store, productId);
      const old = state.store_prices[rid];
      const same = old && !old.deleted_at && old.price_cents === m.cents && old.name === m.name && old.size === m.size;
      if (same && old.price_on === day) continue;
      writes.push({ rank: same ? 1 : 0, on: same ? old.price_on : "", run: () => {
        const row = old ?? { id: rid, product_id: productId, store, created_at: ctx.now };
        Object.assign(row, { name: m.name, size: m.size, price_cents: m.cents, price_on: day, updated_at: ctx.now, deleted_at: null });
        state.store_prices[rid] = row;
        ctx.touch("store_prices", rid);
      } });
    }
    for (const r of stored) {
      if (r.deleted_at || found.has(r.product_id)) continue;
      writes.push({ rank: 0, on: "", run: () => {
        r.deleted_at = ctx.now;
        r.updated_at = ctx.now;
        ctx.touch("store_prices", r.id);
      } });
    }
    writes.sort((a, b) => a.rank - b.rank || a.on.localeCompare(b.on));
    for (const w of writes.slice(0, MAX_PRICE_WRITES)) w.run();
    return { matched: found.size, written: Math.min(writes.length, MAX_PRICE_WRITES), left: Math.max(0, writes.length - MAX_PRICE_WRITES) };
  },

  // The nightly check's report (fetcher/review.mjs, sent by the home
  // server's reviewer device only: worker/api.js refuses it from anyone
  // else). One row per day, "review-<day>"; the same day again replaces it.
  // fixed: [{text, undo}], decide and errors: lists of short lines.
  "review.save"(state, op, ctx) {
    const day = date(op.day, "day");
    const rid = `review-${day}`;
    const lines = (v, field) => {
      if (v === undefined || v === null) return [];
      if (!Array.isArray(v) || v.length > REVIEW_MAX_LINES) throw new OpError("bad_field", field);
      return v.map((x) => text(x, REVIEW_LINE_MAX, field)).filter(Boolean);
    };
    if (op.fixed !== undefined && op.fixed !== null && (!Array.isArray(op.fixed) || op.fixed.length > REVIEW_MAX_LINES)) {
      throw new OpError("bad_field", "fixed");
    }
    const fixed = (op.fixed ?? []).map((f) => {
      if (!f || typeof f !== "object") throw new OpError("bad_field", "fixed");
      return { text: text(f.text, REVIEW_LINE_MAX, "fixed.text"), undo: text(f.undo, REVIEW_LINE_MAX, "fixed.undo") };
    }).filter((f) => f.text);
    const old = state.reviews[rid];
    const row = old ?? { id: rid, created_at: ctx.now };
    Object.assign(row, {
      day,
      run_ok: op.run_ok === false ? 0 : 1,
      fixed,
      decide: lines(op.decide, "decide"),
      errors: lines(op.errors, "errors"),
      turns: num(op.turns, "turns", { max: 1000 }),
      cost_cents: num(op.cost_cents, "cost_cents", { max: 100000 }),
      updated_at: ctx.now,
      deleted_at: null,
    });
    if (row.cost_cents !== null) row.cost_cents = Math.round(row.cost_cents);
    if (row.turns !== null) row.turns = Math.round(row.turns);
    state.reviews[rid] = row;
    ctx.touch("reviews", rid);
    // The changelog keeps AUTO_CHANGES_DAYS days: older rows become tombstones.
    const cutoff = addDays(day, -AUTO_CHANGES_DAYS);
    for (const c of Object.values(state.auto_changes ?? {})) {
      if (c.deleted_at || !(c.day < cutoff)) continue;
      c.deleted_at = ctx.now;
      c.updated_at = ctx.now;
      ctx.touch("auto_changes", c.id);
    }
    return { id: rid };
  },

  // Which item each ingredient line of a recipe means, or why none
  // (public/shared/recipe-links.js), from the nightly check only (worker/api.js
  // REVIEWER_ONLY_OPS). Stored on the recipe as ingredient_links { at, lines }
  // for the recipe version `at` (its updated_at); the recipe itself, its
  // updated_at included, stays as it is.
  "recipe.links"(state, op, ctx) {
    const r = state.recipes[id(op.recipe_id, "recipe_id")];
    if (!r || r.deleted_at) throw new OpError("not_found", "recipe");
    if (!Array.isArray(op.lines) || op.lines.length > 200) throw new OpError("bad_field", "lines");
    const lines = op.lines.map((l) => {
      if (!l || typeof l !== "object") throw new OpError("bad_field", "lines");
      const name = text(l.name, 120, "lines.name");
      if (l.item_id !== null && l.item_id !== undefined) {
        if (!LINK_HOWS.includes(l.how)) throw new OpError("bad_field", "lines.how");
        return { name, item_id: id(l.item_id, "lines.item_id"), item: text(l.item, 300, "lines.item"), how: l.how };
      }
      if (!LINK_REASONS.includes(l.reason)) throw new OpError("bad_field", "lines.reason");
      return { name, item_id: null, reason: l.reason };
    });
    const at = typeof op.at === "string" ? op.at.slice(0, 40) : null;
    r.ingredient_links = { at, lines };
    ctx.touch("recipes", r.id);
    return { linked: lines.filter((l) => l.item_id).length, lines: lines.length };
  },

  // Two items of one thing become one (30-10-2026: the receipts put
  // the cat's tuna under "Tonijn" while its rate sat on "Minoestuna"). Every
  // live row of the from-item moves to the into-item: purchases, products,
  // pantry rows and events, pending takes, list lines (an open line merges
  // into into's open line as entry.add does), preferences and deal rules
  // (into's own row wins per scope); the settings into lacks come along
  // (copyMissingSettings). The from-item becomes a tombstone with
  // merged_into: the alias findItem follows, so its name lands on the
  // into-item from now on. `on` (the op's day) is required: counted-down rows
  // are settled on it first, never on the clock. The same merge again writes
  // nothing ({ already: true }). With into_title (and a new into_item_id)
  // instead of into_item_id, the into-item is found by name or made.
  "item.merge"(state, op, ctx) {
    const day = date(op.on, "on");
    const from = state.items[id(op.from_item_id, "from_item_id")];
    if (!from) throw new OpError("not_found", "item");
    const titled = typeof op.into_title === "string" && op.into_title.trim();
    if (from.deleted_at) {
      // Merged before: the same merge again is a replay, anything else is gone.
      const to = from.merged_into ? aliasTarget(state.items, from) : null;
      const want = titled ? findItem(state, nameKey(op.into_title)) : aliasTarget(state.items, state.items[op.into_item_id]);
      if (to && want && want.id === to.id) return { item_id: to.id, already: true, moved: emptyMoved() };
      throw new OpError("not_found", "item");
    }
    const into = titled
      ? resolveItem(state, ctx, text(op.into_title, 120, "into_title"), op.into_item_id)
      : aliasTarget(state.items, state.items[id(op.into_item_id, "into_item_id")]);
    if (!into) throw new OpError("not_found", "item");
    if (into.id === from.id) throw new OpError("same_item");
    // A merge never makes a private item public or the other way round.
    if (!samePrivacy(from, into)) throw new OpError("private_mismatch");
    settleItem(state, ctx, from.id, day);
    settleItem(state, ctx, into.id, day);
    const moved = emptyMoved();
    for (const kind of ["purchases", "products", "pantry", "pantry_events", "pending_takes"]) {
      for (const row of Object.values(state[kind])) {
        if (row.item_id !== from.id || row.deleted_at) continue;
        moveRow(ctx, kind, row, into);
        moved[kind]++;
      }
    }
    for (const e of Object.values(state.entries)) {
      if (e.item_id !== from.id || e.deleted_at) continue;
      const open = e.checked_at ? null : openEntryFor(state, into.id);
      if (open) {
        mergeInto(open, e, ctx);
        e.deleted_at = ctx.now;
        e.updated_at = ctx.now;
        ctx.touch("entries", e.id);
        moved.entries_merged++;
      } else {
        moveRow(ctx, "entries", e, into);
        moved.entries++;
      }
    }
    for (const row of Object.values(state.preferences)) {
      if (row.item_id !== from.id) continue;
      moved.preferences += moveScopedRow(ctx, "preferences", row, scopeRow(state, into.id, row.store, row.recipe_id), into, PREFERENCE_COPY);
    }
    for (const row of Object.values(state.deal_rules)) {
      if (row.item_id !== from.id) continue;
      moved.deal_rules += moveScopedRow(ctx, "deal_rules", row, ruleRow(state, into.id, row.product_id ?? ""), into, Object.keys(RULE_FIELDS));
    }
    if (copyMissingSettings(into, from)) ctx.touch("items", into.id);
    from.deleted_at = ctx.now;
    from.merged_into = into.id;
    ctx.touch("items", from.id);
    // The from-item's other names go along, and its own name becomes one of
    // into's (an alias row, so the phones see it: they keep no tombstones).
    for (const a of Object.values(state.aliases)) {
      if (a.item_id !== from.id || a.deleted_at) continue;
      Object.assign(a, { item_id: into.id, updated_at: ctx.now });
      ctx.touch("aliases", a.id);
    }
    putAlias(state, ctx, into, from.name, `ma-${from.id}`);
    return { item_id: into.id, moved };
  },

  // One product goes to another item, with its purchases, pantry rows and
  // events, and the preferences and product deal rules that name it (into's
  // own row per scope wins, as item.merge). product.put with item_id only
  // relinks the product; this moves what was bought of it too (the Fernandes
  // bottles under "Frisdrank", the red onions under "Uien"). No alias: both
  // items stay. `on` is required (counted-down rows are settled on it). With
  // title (and a new item_id) the item is found or made. The same move again
  // writes nothing.
  "product.move"(state, op, ctx) {
    const day = date(op.on, "on");
    const p = liveProduct(state, op.product_id);
    const target = typeof op.title === "string" && op.title.trim()
      ? resolveItem(state, ctx, text(op.title, 120, "title"), op.item_id)
      : aliasTarget(state.items, state.items[id(op.item_id, "item_id")]);
    if (!target) throw new OpError("not_found", "item");
    const mine = (row) => row.product_id === p.id && !row.deleted_at && row.item_id !== target.id;
    const fromItems = new Set([p.item_id, ...Object.values(state.purchases).filter(mine).map((r) => r.item_id),
      ...Object.values(state.pantry).filter(mine).map((r) => r.item_id)].filter((x) => x && x !== target.id));
    // What was bought of it never goes from a private item to a public one or back.
    for (const itemId of fromItems) {
      if (state.items[itemId] && !samePrivacy(state.items[itemId], target)) throw new OpError("private_mismatch");
    }
    if (fromItems.size) {
      for (const itemId of [...fromItems].sort()) settleItem(state, ctx, itemId, day);
      settleItem(state, ctx, target.id, day);
    }
    const moved = emptyMoved();
    if (p.item_id !== target.id) {
      p.item_id = target.id;
      p.updated_at = ctx.now;
      ctx.touch("products", p.id);
      moved.products++;
    }
    for (const kind of ["purchases", "pantry", "pantry_events"]) {
      for (const row of Object.values(state[kind])) {
        if (!mine(row)) continue;
        moveRow(ctx, kind, row, target);
        moved[kind]++;
      }
    }
    for (const row of Object.values(state.preferences)) {
      if (!mine(row)) continue;
      moved.preferences += moveScopedRow(ctx, "preferences", row, scopeRow(state, target.id, row.store, row.recipe_id), target, PREFERENCE_COPY);
    }
    for (const row of Object.values(state.deal_rules)) {
      if (!mine(row)) continue;
      moved.deal_rules += moveScopedRow(ctx, "deal_rules", row, ruleRow(state, target.id, p.id), target, Object.keys(RULE_FIELDS));
    }
    return { item_id: target.id, moved };
  },

  // Another name for an item (30-10-2026: "Pluizenbolbrokkenman" is
  // "Minoes brokken"). { id, item_id, name } adds it, { item_id, name,
  // remove: true } removes it. A live item's name, or a name that is another
  // item's name or alias without spaces, is refused (name_taken); another
  // item's alias of exactly this name moves here (taken_from): one name never
  // means two things. Its own name, or an alias it has, is { already: true }. One row per name ever: removing is a tombstone, adding
  // it again revives that row. Removing a merged-away name also lets go of the
  // merge's tombstone, so the name can be a new item again.
  // The item's English name (30-10-2026: the NL/EN switch must switch
  // the data too). { item_id, name_en, source? } ('person' unless 'claude');
  // null or "" clears it. Not a key: two items may share one English name
  // (findItem then trusts neither). Claude never replaces a person's
  // ({ kept: true }), like a shelf life.
  "item.translate"(state, op, ctx) {
    const item = aliasTarget(state.items, state.items[id(op.item_id, "item_id")]);
    if (!item) throw new OpError("not_found", "item");
    const source = op.source === undefined ? "person" : op.source;
    if (!NAME_EN_SOURCES.includes(source)) throw new OpError("bad_field", "source");
    const name = text(op.name_en, 120, "name_en");
    const key = name ? nameKey(name) : "";
    if (name && !key) throw new OpError("bad_field", "name_en");
    if (item.name_en_source && NAME_EN_RANK[source] < NAME_EN_RANK[item.name_en_source]) return { kept: true };
    if ((item.name_en ?? null) === (name || null) && (item.name_en_source ?? null) === (name ? source : null)) return {};
    Object.assign(item, { name_en: name || null, name_en_key: key || null, name_en_source: name ? source : null });
    ctx.touch("items", item.id);
    return {};
  },

  // A recipe in the other language (0029): { id, translation: { lang?, title,
  // ingredients: [lines], steps, notes, of?, by? } } or translation null to
  // drop it. `of` is the fingerprint of the original that was translated
  // (public/shared/bilingual.js recipeFingerprint; absent: the recipe as it is
  // now), so a translation of an older version is stale on arrival. The
  // original is never touched; a recipe without a language gets it here.
  "recipe.translate"(state, op, ctx) {
    const r = state.recipes[id(op.id)];
    if (!r || r.deleted_at) throw new OpError("not_found", "recipe");
    if (!r.lang) r.lang = recipeLang(r);
    let next = null;
    if (op.translation !== null) {
      next = cleanTranslation(op.translation, r);
      if (!next) throw new OpError("bad_field", "translation");
    }
    if (JSON.stringify(r.translation ?? null) === JSON.stringify(next)) return {};
    // updated_at stays: the nightly check's line links are made for it (recipe-links.js).
    r.translation = next;
    ctx.touch("recipes", r.id);
    return {};
  },

  "item.alias"(state, op, ctx) {
    const item = aliasTarget(state.items, state.items[id(op.item_id, "item_id")]);
    if (!item) throw new OpError("not_found", "item");
    const name = text(op.name, 120, "name");
    const key = nameKey(name);
    if (!key) throw new OpError("bad_field", "name");
    const row = Object.values(state.aliases).find((a) => a.name_key === key);
    if (op.remove === true) {
      if (!row || row.deleted_at || aliasTarget(state.items, state.items[row.item_id])?.id !== item.id) return { already: true };
      row.deleted_at = ctx.now;
      row.updated_at = ctx.now;
      ctx.touch("aliases", row.id);
      for (const i of Object.values(state.items)) {
        if (!i.deleted_at || !i.merged_into || i.name_key !== key) continue;
        i.merged_into = null;
        ctx.touch("items", i.id);
      }
      return { alias_id: row.id };
    }
    if (key === item.name_key) return { already: true };
    // A live item's own name is never taken over, nor a name that differs
    // only in spaces from another item's name or alias.
    const owner = Object.values(state.items).find((i) => !i.deleted_at && i.name_key === key);
    if (owner) throw new OpError("name_taken", owner.name);
    const { exact, compact } = itemsNamed(state, key);
    const loose = compact.find((i) => i.id !== item.id && !exact.some((x) => x.id === i.id));
    if (loose) throw new OpError("name_taken", loose.name);
    if (exact.length === 1 && exact[0].id === item.id) return { already: true };
    // An alias of another item (an explicit one, or a name merged away) moves
    // here (30-10-2026: "Cola" was merged into Frisdrank, but by
    // "cola" he means Sodastream cola). The merge's tombstone follows, so
    // the server (which reads it) and the phones (which read the alias row)
    // agree.
    const from = exact.find((i) => i.id !== item.id) ?? null;
    for (const i of Object.values(state.items)) {
      if (!i.deleted_at || !i.merged_into || i.name_key !== key || i.merged_into === item.id) continue;
      i.merged_into = item.id;
      ctx.touch("items", i.id);
    }
    const aid = id(op.id);
    if (state.aliases[aid] && state.aliases[aid].name_key !== key) throw new OpError("bad_id", "id");
    return { alias_id: putAlias(state, ctx, item, name, aid), ...(from ? { taken_from: from.id } : {}) };
  },
};

/**
 * Apply one op to `state` (mutated in place).
 * ctx: { memberId, isAdmin, now }   (now: ISO time of the op)
 * Returns { result, changed: [[table, id], ...] }. Throws OpError on bad input.
 */
export function applyOp(state, op, ctx) {
  if (!op || typeof op !== "object" || !HANDLERS[op.type]) throw new OpError("unknown_op", String(op?.type));
  if (!state.aliases) state.aliases = {};
  const changed = [];
  const seen = new Set();
  const full = {
    ...ctx,
    touch(table, rowId) {
      const k = `${table}:${rowId}`;
      if (!seen.has(k)) {
        seen.add(k);
        changed.push([table, rowId]);
      }
    },
  };
  const before = ctx.autoLog ? beforeChange(state, op) : null;
  const result = HANDLERS[op.type](state, op, full);
  if (ctx.autoLog) logChange(state, op, result, before, full);
  return { result, changed };
}

/** Ops whose effect the nightly check's changelog records (auto_changes). */
export const LOGGED_OPS = ["item.merge", "product.move", "item.alias", "item.rename", "recipe.links", "item.translate"];

/** What a logged op's row needs from before it ran: the merged item's or the renamed item's name. */
function beforeChange(state, op) {
  if (op.type === "item.merge" || op.type === "item.rename") {
    return { name: state.items[op.type === "item.merge" ? op.from_item_id : op.item_id]?.name ?? "" };
  }
  if (op.type === "item.translate") return { name_en: state.items[op.item_id]?.name_en ?? null };
  return {};
}

/** A product as the changelog names it: "Tonijn in water (AH)", the brand only when its name lacks it. */
export function changeProductName(p) {
  const name = String(p?.name ?? "").trim();
  const brand = String(p?.brand ?? "").trim();
  return brand && !nameKey(name).startsWith(nameKey(brand)) ? `${name} (${brand})` : name;
}

/**
 * One changelog row for an op of the reviewer device (ctx.autoLog, set by
 * worker/ops-store.js for the role 'reviewer' only) that changed something:
 * a replay, an alias it had, a move with nothing to move or the same
 * spelling writes none. Row id "ac-<op_id>".
 */
function logChange(state, op, result, before, ctx) {
  if (!LOGGED_OPS.includes(op.type) || !result || result.already) return;
  let row = null;
  if (op.type === "item.merge") {
    row = { what: "merge", name: before.name, target: state.items[result.item_id]?.name ?? "", item_id: result.item_id ?? null, product_id: null };
  } else if (op.type === "product.move") {
    if (!Object.values(result.moved ?? {}).some((n) => n > 0)) return;
    const p = state.products[op.product_id];
    row = { what: "move", name: changeProductName(p), target: state.items[result.item_id]?.name ?? "", item_id: result.item_id ?? null, product_id: p?.id ?? null };
  } else if (op.type === "item.alias") {
    if (op.remove === true || !result.alias_id) return;
    const item = aliasTarget(state.items, state.items[op.item_id]);
    // `reason`: why the check thinks so ("spelling"), a few words, only for the changelog.
    row = { what: "alias", name: String(op.name ?? "").trim(), target: item?.name ?? "", item_id: item?.id ?? null, product_id: null,
      reason: typeof op.reason === "string" ? op.reason.replace(/\s+/g, " ").trim().slice(0, 60) || null : null };
  } else if (op.type === "item.rename") {
    const item = state.items[op.item_id];
    if (!item || item.name === before.name) return;
    row = { what: "rename", name: before.name, target: item.name, item_id: item.id, product_id: null };
  } else if (op.type === "item.translate") {
    const item = state.items[op.item_id];
    if (!item || result.kept || (item.name_en ?? null) === before.name_en) return;
    row = { what: "translate", name: item.name, target: item.name_en ?? "", item_id: item.id, product_id: null };
  } else if (op.type === "recipe.links") {
    const r = state.recipes[op.recipe_id];
    const lines = r?.ingredient_links?.lines ?? [];
    row = { what: "recipe", name: r?.title ?? "", target: `${result.linked}/${result.lines}`, item_id: null, product_id: null, lines };
  }
  if (!row?.name) return;
  if (!state.auto_changes) state.auto_changes = {};
  const rid = `ac-${typeof op.op_id === "string" && op.op_id ? op.op_id : `${op.type}-${ctx.now}`}`;
  const day = typeof op.on === "string" && DATE_RE.test(op.on) ? op.on : String(ctx.now).slice(0, 10);
  state.auto_changes[rid] = { id: rid, day, reason: null, lines: null, ...row, created_at: ctx.now, updated_at: ctx.now, deleted_at: null };
  ctx.touch("auto_changes", rid);
}
