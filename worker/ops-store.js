// D1 side of the op engine: load the rows an op needs, run public/shared/ops.js
// on them, and write back what changed in one atomic batch, together with the
// household's new change counter. Also serves the "what changed since N" pull.
import { applyOp, emptyState, OpError, productKey, cookPromptId, BASKET_BEFORE_DAYS, BASKET_AFTER_DAYS, findItem, aliasTarget, AUTO_CHANGES_DAYS, apartPair, decisionId } from "../public/shared/ops.js";
import { nameKey } from "../public/shared/ingredients.js";
import { entryPantryId, purchasePantryId, MATCH_DAYS, PENDING_DAYS, rowRate, pendingEventId } from "../public/shared/pantry.js";
import { addDays } from "../public/shared/shelf-life.js";
import { OFFER_HISTORY } from "../public/shared/rate-learning.js";
import { canonicalStore } from "../public/shared/stores.js";
import { needsTranslation, recipeFingerprint } from "../public/shared/bilingual.js";
import { hiddenStatement, hiddenOf, loadHidden, rowHidden, rowFor, guardOp, touchesHidden } from "./privacy.js";

const TABLE = {
  recipes: "recipes", entries: "list_entries", items: "items", members: "members",
  products: "products", ratings: "ratings", purchases: "purchases", receipts: "receipts", cooks: "cooks",
  offers: "offers", preferences: "preferences", pantry: "pantry", pantry_events: "pantry_events",
  deal_rules: "deal_rules", pending_takes: "pending_takes", cook_prompts: "cook_prompts", recipe_ratings: "recipe_ratings", aliases: "item_aliases", store_prices: "store_prices",
  reviews: "reviews", auto_changes: "auto_changes", decisions: "item_decisions",
};
const JSON_FIELDS = {
  recipes: ["ingredients", "steps", "nutrition", "meals", "ingredient_links", "translation"], entries: ["amounts", "sources"], items: ["undo_rows"], members: [],
  products: [], ratings: [], purchases: [], receipts: ["lines"], cooks: [], offers: [], preferences: [], pantry: [], pantry_events: ["rate_before"], deal_rules: ["match_words", "require_words", "exclude_words"],
  pending_takes: [], cook_prompts: ["entry_ids"], recipe_ratings: [], aliases: [], store_prices: [], reviews: ["fixed", "decide", "errors"], auto_changes: ["lines", "undo"], decisions: [],
};

// The columns an op may write. Members only change name and language through
// ops; joining and admin rights go through pairing (worker/auth.js).
const COLUMNS = {
  recipes: ["id", "title", "servings", "ingredients", "steps", "notes", "nutrition", "photo", "source_url",
    "cuisine", "main_ingredient", "time_class", "time_minutes", "meals", "labels_by",
    "created_by", "created_at", "updated_at", "deleted_at", "ingredient_links", "lang", "translation"],
  entries: ["id", "item_id", "title", "typed", "new_item", "amounts", "note", "sources", "added_by", "checked_at", "checked_by",
    "created_at", "updated_at", "deleted_at"],
  items: ["id", "name", "name_key", "preferred_product_id", "again", "low_at", "low_off", "not_yet_until",
    "shelf_days", "opened_days", "shelf_source", "use_per_day", "rate_source", "rate_samples", "merged_into", "private_to", "created_at", "deleted_at",
    "name_en", "name_en_key", "name_en_source", "undo_rows"],
  products: ["id", "item_id", "name", "brand", "size", "store", "store_only", "category", "kind", "last_price_cents", "product_key",
    "shelf_days", "opened_days", "shelf_source", "created_at", "updated_at", "deleted_at"],
  ratings: ["id", "member_id", "product_id", "stars", "note", "created_at", "updated_at", "deleted_at"],
  purchases: ["id", "item_id", "product_id", "receipt_id", "title", "bought_on", "store", "qty", "price_cents",
    "source", "created_by", "created_at", "deleted_at"],
  receipts: ["id", "store", "bought_on", "total_cents", "lines", "created_by", "created_at", "deleted_at"],
  cooks: ["id", "recipe_id", "member_id", "cooked_on", "created_at", "deleted_at"],
  preferences: ["id", "item_id", "store", "recipe_id", "product_id", "created_by", "created_at", "updated_at", "deleted_at"],
  pantry: ["id", "item_id", "product_id", "title", "amount", "taken", "pack_size", "added_on", "amount_on", "use_by", "use_by_source",
    "source_entry_id", "source_purchase_id", "created_by", "created_at", "updated_at", "deleted_at"],
  pantry_events: ["id", "pantry_id", "item_id", "product_id", "reason", "amount", "recipe_id", "happened_on", "member_id",
    "created_at", "deleted_at", "rate_before"],
  deal_rules: ["id", "item_id", "product_id", "max_price_cents", "offer_only", "min_discount_pct", "max_unit_price_cents", "unit",
    "detour", "match_words", "require_words", "exclude_words", "detour_min_discount_pct", "created_by", "created_at", "updated_at", "deleted_at"],
  pending_takes: ["id", "cook_id", "recipe_id", "item_id", "name", "name_key", "qty", "unit", "default_portion", "cooked_on", "status",
    "pantry_id", "event_id", "member_id", "created_at", "updated_at", "deleted_at"],
  cook_prompts: ["id", "recipe_id", "listed_on", "shopped_on", "entry_ids", "snoozed_on", "dismissed_at", "created_at", "updated_at", "deleted_at"],
  recipe_ratings: ["id", "member_id", "recipe_id", "stars", "asked_on", "created_at", "updated_at", "deleted_at"],
  aliases: ["id", "item_id", "name", "name_key", "created_by", "created_at", "updated_at", "deleted_at"],
  store_prices: ["id", "product_id", "store", "name", "size", "price_cents", "price_on", "created_at", "updated_at", "deleted_at", "item_id", "comparable"],
  reviews: ["id", "day", "run_ok", "fixed", "decide", "errors", "turns", "cost_cents", "created_at", "updated_at", "deleted_at"],
  auto_changes: ["id", "day", "what", "name", "target", "item_id", "product_id", "reason", "lines", "created_at", "updated_at", "deleted_at", "undo", "undone_at"],
  decisions: ["id", "kind", "a", "b", "a_name", "b_name", "created_by", "created_at", "updated_at", "deleted_at"],
};

// Synced to the phones (pull), in this order. Offers are written by
// worker/offers.js, never by an op.
const SYNCED = ["recipes", "items", "entries", "members", "products", "ratings", "purchases", "receipts", "cooks", "offers", "preferences", "pantry", "pantry_events", "deal_rules", "pending_takes", "cook_prompts", "recipe_ratings", "aliases", "store_prices", "reviews", "auto_changes", "decisions"];

// What a recipes-only person (members.recipes_only) pulls: the book, the
// stars, and the people's names for them. Never the list, the pantry, the
// purchases, receipts, offers, preferences, prices, cook records, nightly reports or their changelog.
export const GUEST_SYNCED = ["recipes", "members", "recipe_ratings"];
const GUEST_MEMBER_FIELDS = ["id", "name", "removed_at"];

// The deleted_at of a hidden row's bare tombstone: no real time, nothing to read from it.
const HIDDEN_AT = "1970-01-01T00:00:00.000Z";

const OP_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function fromRow(kind, row) {
  const out = { ...row };
  delete out.household_id;
  for (const f of JSON_FIELDS[kind]) {
    if (out[f] === null || out[f] === undefined) continue;
    try {
      out[f] = JSON.parse(out[f]);
    } catch {
      out[f] = null;
    }
  }
  if (kind === "members") {
    out.is_admin = Boolean(out.is_admin);
    out.recipes_only = Boolean(out.recipes_only);
  }
  return out;
}

function toValue(kind, field, value) {
  if (JSON_FIELDS[kind].includes(field)) return value === null || value === undefined ? null : JSON.stringify(value);
  return value === undefined ? null : value;
}

async function loadInto(db, hh, state, kind, where, ...binds) {
  const { results } = await db
    .prepare(`SELECT * FROM ${TABLE[kind]} WHERE household_id = ? AND ${where}`)
    .bind(hh, ...binds)
    .all();
  for (const row of results) state[kind][row.id] = fromRow(kind, row);
}

/**
 * Items by a condition, plus the live items merged ones went into: a name
 * merged away (item.merge) is a tombstone with merged_into, and the engine's
 * findItem follows that chain, so the loader fetches it too (a hop or two).
 */
async function loadItems(db, hh, s, where, ...binds) {
  await loadInto(db, hh, s, "items", where, ...binds);
  for (let hops = 0; hops < 20; hops++) {
    const missing = Object.values(s.items).filter((i) => i.deleted_at && i.merged_into && !s.items[i.merged_into]).map((i) => i.merged_into);
    if (!missing.length) return;
    await loadIds(db, hh, s, "items", missing);
  }
}

// The space-free key, exactly as indexed in migrations/0022_item_aliases.sql
// (an expression index is used only for the same expression); its JS twin is
// compactKey in public/shared/item-names.js.
const COMPACT = "REPLACE(name_key, ' ', '') = ?";
// The same for English names (0029, items_en_compact): findItem treats them like aliases.
const COMPACT_EN = "REPLACE(name_en_key, ' ', '') = ?";

/**
 * Every item and alias row a typed name could mean (findItem): the items
 * and alias rows whose key is the same without spaces, tombstones included
 * (a merged name, a name to revive), and the items those aliases point at.
 */
async function loadByName(db, hh, s, title) {
  const compact = nameKey(title).replace(/ /g, "");
  if (!compact) return;
  await loadItems(db, hh, s, COMPACT, compact);
  await loadItems(db, hh, s, COMPACT_EN, compact);
  await loadInto(db, hh, s, "aliases", COMPACT, compact);
  await loadAliasItems(db, hh, s);
}

/** The items the loaded alias rows point at (and where those went). */
async function loadAliasItems(db, hh, s) {
  const ids = Object.values(s.aliases).map((a) => a.item_id).filter((x) => !s.items[x]);
  if (ids.length) await loadItems(db, hh, s, `id IN (${ids.slice(0, 90).map(() => "?").join(",")})`, ...ids.slice(0, 90));
}

/** A product by id, plus whichever product already has the key it would get. */
async function loadProduct(db, hh, s, productId, patch) {
  if (typeof productId === "string") await loadInto(db, hh, s, "products", "id = ?", productId);
  if (!patch || typeof patch !== "object") return;
  const draft = { ...(s.products[productId] ?? {}) };
  for (const f of ["name", "brand", "size"]) if (typeof patch[f] === "string") draft[f] = patch[f].trim();
  await loadInto(db, hh, s, "products", "product_key = ?", productKey(draft));
}

/** Every preference row (live or not) of the items loaded so far: a handful per item. */
async function loadPreferences(db, hh, s, ...extra) {
  const ids = new Set([...Object.keys(s.items), ...extra.filter((x) => typeof x === "string")]);
  for (const itemId of ids) await loadInto(db, hh, s, "preferences", "item_id = ?", itemId);
}

/** Rows of `kind` by a list of ids (at most a few dozen), in chunks SQLite takes. */
async function loadIds(db, hh, s, kind, ids) {
  const list = [...new Set(ids.filter((x) => typeof x === "string"))].slice(0, 100);
  for (let i = 0; i < list.length; i += 90) {
    const chunk = list.slice(i, i + 90);
    await loadInto(db, hh, s, kind, `id IN (${chunk.map(() => "?").join(",")})`, ...chunk);
  }
}

/**
 * The pantry rows a receipt purchase may fill in: the rows of its item
 * without a purchase, put in within MATCH_DAYS of the day bought (a
 * handful), and its own row in case of a replay.
 */
async function loadPantryForPurchase(db, hh, s, op) {
  await loadIds(db, hh, s, "pantry", [typeof op.pantry_id === "string" ? op.pantry_id : purchasePantryId(String(op.id))]);
  if (typeof op.bought_on !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(op.bought_on)) return;
  for (const itemId of Object.keys(s.items)) {
    await loadInto(db, hh, s, "pantry", "item_id = ? AND source_purchase_id IS NULL AND added_on >= ? AND added_on <= ?",
      itemId, addDays(op.bought_on, -MATCH_DAYS), addDays(op.bought_on, MATCH_DAYS));
  }
  // Cooked before this receipt came in: the open pending takes of those days
  // (a handful; the engine keeps the ones of this thing, pendingFits).
  await loadInto(db, hh, s, "pending_takes", "status = 'pending' AND deleted_at IS NULL AND cooked_on >= ? AND cooked_on <= ?",
    addDays(op.bought_on, -(PENDING_DAYS + MATCH_DAYS)), addDays(op.bought_on, 2 * MATCH_DAYS));
}

/** The products of the loaded pantry rows: their own shelf life comes first. */
async function loadRowProducts(db, hh, s) {
  await loadIds(db, hh, s, "products", Object.values(s.pantry).map((r) => r.product_id));
}

/** The "… gekookt?" rows of the loaded lines' recipes around `day` (a few). */
async function loadPrompts(db, hh, s, day, entries) {
  const recipes = new Set();
  for (const e of entries) for (const src of e?.sources ?? []) if (typeof src?.recipe_id === "string") recipes.add(src.recipe_id);
  for (const recipeId of recipes) {
    await loadInto(db, hh, s, "cook_prompts", "recipe_id = ? AND shopped_on >= ?", recipeId, addDays(day, -14));
  }
}

const opDay = (op) => (typeof op.on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(op.on) ? op.on : new Date().toISOString().slice(0, 10));

/**
 * The live rows of the loaded items that are counted down (public/shared/
 * pantry.js, rowRate): settling one row settles them all (oldest first), so
 * the op needs every one. Items that are not counted down load nothing more.
 */
async function loadCountedDown(db, hh, s) {
  const itemIds = new Set();
  for (const r of Object.values(s.pantry)) if (rowRate(r, s.items[r.item_id])) itemIds.add(r.item_id);
  for (const itemId of itemIds) await loadInto(db, hh, s, "pantry", "item_id = ? AND deleted_at IS NULL", itemId);
}

/** Rows of `kind` by a list of ids of any length (a merge's record), in chunks SQLite takes. */
async function loadAllIds(db, hh, s, kind, ids) {
  const list = [...new Set((ids ?? []).filter((x) => typeof x === "string"))];
  for (let i = 0; i < list.length; i += 90) {
    const chunk = list.slice(i, i + 90);
    await loadInto(db, hh, s, kind, `id IN (${chunk.map(() => "?").join(",")})`, ...chunk);
  }
}

/** The decision rows an op may write (public/shared/ops.js putDecision): by their deterministic ids. */
async function loadDecisions(db, hh, s, pairs) {
  await loadIds(db, hh, s, "decisions", pairs.map(([kind, a, b]) => {
    const [x, y] = kind === "apart" ? apartPair(a, b) : [String(a ?? ""), String(b ?? "")];
    return decisionId(kind, x, y);
  }));
}

/**
 * item.unmerge: the merged-away item, the item it went into (and where that
 * went), every row its record (undo_rows) names, the lines it was folded
 * into, the scoped rows on into it revived, its aliases, and the live
 * pantry rows of into (settled first).
 */
async function loadUnmerge(db, hh, s, fromId) {
  await loadItems(db, hh, s, "id = ?", fromId);
  const from = s.items[fromId];
  if (!from?.deleted_at || !from.merged_into) return;
  const rec = from.undo_rows?.kind === "merge" ? from.undo_rows : null;
  await loadItems(db, hh, s, "id = ?", rec?.into ?? from.merged_into);
  const holder = aliasTarget(s.items, s.items[rec?.into ?? from.merged_into]);
  for (const [kind, ids] of Object.entries(rec?.rows ?? {})) if (TABLE[kind]) await loadAllIds(db, hh, s, kind, ids);
  await loadAllIds(db, hh, s, "entries", (rec?.folded ?? []).flatMap((f) => [f.id, f.into_id]));
  for (const kind of ["preferences", "deal_rules"]) {
    const sc = (rec?.scoped ?? []).filter((x) => x.kind === kind);
    await loadAllIds(db, hh, s, kind, sc.flatMap((x) => [x.id, x.into_id]));
  }
  await loadAllIds(db, hh, s, "aliases", [...(rec?.aliases ?? []), rec?.alias?.id, `ma-${fromId}`]);
  await loadInto(db, hh, s, "aliases", "name_key = ?", from.name_key);
  if (holder) {
    await loadInto(db, hh, s, "pantry", "item_id = ? AND deleted_at IS NULL", holder.id);
    await loadDecisions(db, hh, s, [["apart", from.name, holder.name]]);
  }
}

/** item.unremove: the item, every row its record names, its open list line by now. */
async function loadUnremove(db, hh, s, itemId) {
  await loadInto(db, hh, s, "items", "id = ?", itemId);
  const item = s.items[itemId];
  if (!item) return;
  for (const [kind, ids] of Object.entries(item.undo_rows?.kind === "remove" ? item.undo_rows.rows ?? {} : {})) {
    if (TABLE[kind]) await loadAllIds(db, hh, s, kind, ids);
  }
  await loadInto(db, hh, s, "entries", "item_id = ? AND checked_at IS NULL AND deleted_at IS NULL", itemId);
  await loadDecisions(db, hh, s, [["keep", itemId, ""]]);
}

/** Rows of another load into this one (change.undo runs another op's handler). */
function addState(s, other) {
  for (const kind of Object.keys(other)) Object.assign(s[kind] ??= {}, other[kind]);
}

/** Exactly the rows this op can read or change, nothing more. */
async function load(db, hh, op, memberId) {
  const s = emptyState();
  switch (op.type) {
    case "item.unmerge":
      await loadUnmerge(db, hh, s, String(op.item_id));
      break;
    case "item.remove": {
      const itemId = String(op.item_id);
      await loadInto(db, hh, s, "items", "id = ?", itemId);
      // Every live row it buries (a junk name: a handful), and one product is enough to refuse.
      for (const kind of ["entries", "aliases", "pantry", "purchases", "preferences", "deal_rules", "pending_takes"]) {
        await loadInto(db, hh, s, kind, "item_id = ? AND deleted_at IS NULL", itemId);
      }
      await loadInto(db, hh, s, "products", "item_id = ? AND deleted_at IS NULL LIMIT 1", itemId);
      break;
    }
    case "item.unremove":
      await loadUnremove(db, hh, s, String(op.item_id));
      break;
    case "item.apart": {
      const names = Array.isArray(op.names) ? op.names.slice(0, 12).map((n) => String(n ?? "")) : [];
      const pairs = [];
      for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) pairs.push(["apart", names[i], names[j]]);
      await loadDecisions(db, hh, s, pairs);
      break;
    }
    case "recipe.link_fix":
      await loadInto(db, hh, s, "recipes", "id = ?", String(op.recipe_id));
      await loadItems(db, hh, s, "id = ?", String(op.item_id));
      break;
    case "change.undo": {
      await loadInto(db, hh, s, "auto_changes", "id = ?", String(op.change_id));
      const c = s.auto_changes[op.change_id];
      if (!c || c.deleted_at || c.undone_at) break;
      const u = c.undo ?? {};
      const on = opDay(op);
      if (c.what === "merge") {
        let fromId = u.from_item_id;
        if (!fromId) {
          // A line from before 30-10-2026: the merged name's tombstone.
          await loadItems(db, hh, s, "name_key = ? AND deleted_at IS NOT NULL AND merged_into IS NOT NULL", nameKey(c.name));
          fromId = Object.values(s.items).find((i) => i.deleted_at && i.merged_into && i.name_key === nameKey(c.name))?.id;
        }
        if (fromId) addState(s, await load(db, hh, { type: "item.unmerge", item_id: fromId, on }, memberId));
      } else if (c.what === "move" && u.from_item_id && c.product_id) {
        addState(s, await load(db, hh, { type: "product.move", product_id: c.product_id, item_id: u.from_item_id, on }, memberId));
        await loadDecisions(db, hh, s, [["no_move", c.product_id, c.item_id ?? ""]]);
      } else if (c.what === "alias") {
        addState(s, await load(db, hh, { type: "item.alias", item_id: String(c.item_id), name: c.name, remove: true }, memberId));
        await loadDecisions(db, hh, s, [["no_alias", nameKey(c.name), c.item_id ?? ""]]);
      } else if (c.what === "rename") {
        await loadInto(db, hh, s, "items", "id = ?", String(c.item_id));
        await loadDecisions(db, hh, s, [["no_rename", c.item_id ?? "", ""]]);
      } else if (c.what === "remove") {
        await loadUnremove(db, hh, s, String(u.item_id ?? c.item_id));
      } else if (c.what === "translate") {
        await loadInto(db, hh, s, "items", "id = ?", String(c.item_id));
        await loadDecisions(db, hh, s, [["no_translate", c.item_id ?? "", nameKey(c.target ?? "")]]);
      }
      break;
    }
    case "product.put":
      await loadProduct(db, hh, s, op.id, op.product);
      if (typeof op.product?.item_id === "string") await loadInto(db, hh, s, "items", "id = ?", op.product.item_id);
      break;
    case "item.rate":
      if (typeof op.item_id === "string") await loadInto(db, hh, s, "items", "id = ?", op.item_id);
      if (typeof op.title === "string") await loadByName(db, hh, s, op.title);
      // Its live rows are settled at the old rate first: a handful.
      for (const itemId of Object.keys(s.items)) await loadInto(db, hh, s, "pantry", "item_id = ? AND deleted_at IS NULL", itemId);
      break;
    case "item.private": {
      // The item and every live row about it: they are written again so the
      // other members' phones hear it is gone (or back). A handful, once.
      const itemId = String(op.item_id);
      await loadInto(db, hh, s, "items", "id = ?", itemId);
      const item = s.items[itemId];
      if (!item) break;
      for (const kind of ["entries", "purchases", "products", "pantry", "pantry_events", "preferences", "deal_rules", "pending_takes", "aliases", "auto_changes"]) {
        await loadInto(db, hh, s, kind, "item_id = ? AND deleted_at IS NULL", itemId);
      }
      const pids = Object.keys(s.products);
      for (let i = 0; i < pids.length; i += 90) {
        const chunk = pids.slice(i, i + 90);
        const inList = `product_id IN (${chunk.map(() => "?").join(",")}) AND deleted_at IS NULL`;
        for (const kind of ["ratings", "store_prices", "auto_changes"]) await loadInto(db, hh, s, kind, inList, ...chunk);
      }
      await loadIds(db, hh, s, "receipts", Object.values(s.purchases).map((p) => p.receipt_id));
      // Reports that name it, recipes linked to it (text and JSON, by a LIKE).
      const like = `%${item.name.replace(/[%_]/g, "")}%`;
      await loadInto(db, hh, s, "reviews", "deleted_at IS NULL AND (fixed LIKE ? OR decide LIKE ? OR errors LIKE ?)", like, like, like);
      await loadInto(db, hh, s, "recipes", "deleted_at IS NULL AND ingredient_links LIKE ?", `%"${itemId}"%`);
      break;
    }
    case "item.again":
    case "item.rename":
    case "item.low":
    case "item.not_yet":
      await loadInto(db, hh, s, "items", "id = ?", String(op.item_id));
      break;
    case "item.shelf":
      await loadInto(db, hh, s, "items", "id = ?", String(op.item_id));
      // Its live rows with an estimated date get the new estimate: a handful.
      await loadInto(db, hh, s, "pantry", "item_id = ? AND deleted_at IS NULL AND use_by_source = 'estimate'", String(op.item_id));
      // A row whose product has its own shelf life follows the product.
      await loadRowProducts(db, hh, s);
      break;
    case "product.shelf": {
      const list = Array.isArray(op.products) ? op.products.slice(0, 100) : [op];
      const ids = list.map((x) => x?.product_id).filter((x) => typeof x === "string");
      await loadIds(db, hh, s, "products", ids);
      // Their live rows with an estimated date get the new estimate.
      const live = Object.keys(s.products);
      for (let i = 0; i < live.length; i += 90) {
        const chunk = live.slice(i, i + 90);
        await loadInto(db, hh, s, "pantry", `product_id IN (${chunk.map(() => "?").join(",")}) AND deleted_at IS NULL AND use_by_source = 'estimate'`, ...chunk);
      }
      break;
    }
    case "item.prefer":
      await loadInto(db, hh, s, "items", "id = ?", String(op.item_id));
      if (typeof op.product_id === "string") await loadInto(db, hh, s, "products", "id = ?", op.product_id);
      await loadPreferences(db, hh, s);
      break;
    case "preference.set":
      if (typeof op.item_id === "string") await loadInto(db, hh, s, "items", "id = ?", op.item_id);
      if (typeof op.title === "string") await loadByName(db, hh, s, op.title);
      if (typeof op.product_id === "string") await loadInto(db, hh, s, "products", "id = ?", op.product_id);
      if (typeof op.recipe_id === "string" && op.recipe_id) await loadInto(db, hh, s, "recipes", "id = ?", op.recipe_id);
      await loadPreferences(db, hh, s);
      break;
    case "preference.clear":
      await loadPreferences(db, hh, s, op.item_id);
      break;
    case "deal_rule.set":
    case "deal_rule.clear":
      if (typeof op.item_id === "string") await loadInto(db, hh, s, "items", "id = ?", op.item_id);
      if (typeof op.title === "string") await loadByName(db, hh, s, op.title);
      if (typeof op.product_id === "string" && op.product_id) await loadInto(db, hh, s, "products", "id = ?", op.product_id);
      // The row that has this id, whatever item it is for: a new rule may not take it.
      if (typeof op.id === "string") await loadInto(db, hh, s, "deal_rules", "id = ?", op.id);
      // Every rule row of the item, live or not: one per product at most, a handful.
      for (const itemId of new Set([...Object.keys(s.items), ...(typeof op.item_id === "string" ? [op.item_id] : [])])) {
        await loadInto(db, hh, s, "deal_rules", "item_id = ?", itemId);
      }
      break;
    case "item.merge": {
      const fromId = String(op.from_item_id);
      const titled = typeof op.into_title === "string" && op.into_title.trim();
      await loadItems(db, hh, s, "id = ?", fromId);
      if (typeof op.into_item_id === "string") await loadItems(db, hh, s, "id = ?", op.into_item_id);
      if (titled) await loadByName(db, hh, s, op.into_title);
      const from = s.items[fromId];
      // Unknown, or merged before (a replay): the engine answers from the items alone.
      if (!from || from.deleted_at) break;
      const into = titled ? findItem(s, nameKey(op.into_title)) : aliasTarget(s.items, s.items[op.into_item_id]);
      // Every live row of the from-item moves; both items' live pantry rows
      // are settled first; a scope's row of into wins (any row, live or not).
      for (const kind of ["purchases", "products", "pantry_events", "pending_takes", "entries"]) {
        await loadInto(db, hh, s, kind, "item_id = ? AND deleted_at IS NULL", fromId);
      }
      for (const itemId of [fromId, ...(into && into.id !== fromId ? [into.id] : [])]) {
        await loadInto(db, hh, s, "pantry", "item_id = ? AND deleted_at IS NULL", itemId);
        await loadInto(db, hh, s, "preferences", "item_id = ?", itemId);
        await loadInto(db, hh, s, "deal_rules", "item_id = ?", itemId);
      }
      // An open line of the from-item merges into into's open line.
      if (into) await loadInto(db, hh, s, "entries", "item_id = ? AND checked_at IS NULL AND deleted_at IS NULL", into.id);
      // Its other names go along; its own name becomes an alias row.
      await loadInto(db, hh, s, "aliases", "item_id = ? AND deleted_at IS NULL", fromId);
      await loadInto(db, hh, s, "aliases", "name_key = ?", from.name_key);
      await loadIds(db, hh, s, "aliases", [`ma-${fromId}`]);
      break;
    }
    case "product.move": {
      const pid = String(op.product_id);
      await loadInto(db, hh, s, "products", "id = ?", pid);
      if (typeof op.item_id === "string") await loadItems(db, hh, s, "id = ?", op.item_id);
      const titled = typeof op.title === "string" && op.title.trim();
      if (titled) await loadByName(db, hh, s, op.title);
      // What was bought of it, its pantry rows and events, and the
      // preferences and deal rules that name it.
      for (const kind of ["purchases", "pantry", "pantry_events"]) {
        await loadInto(db, hh, s, kind, "product_id = ? AND deleted_at IS NULL", pid);
      }
      await loadInto(db, hh, s, "preferences", "product_id = ?", pid);
      await loadInto(db, hh, s, "deal_rules", "product_id = ?", pid);
      const target = titled ? findItem(s, nameKey(op.title)) : aliasTarget(s.items, s.items[op.item_id]);
      // The items its rows are on now and the target: settled first, so all their live rows.
      const itemIds = [...new Set([s.products[pid]?.item_id, ...Object.values(s.purchases).map((r) => r.item_id),
        ...Object.values(s.pantry).map((r) => r.item_id), target?.id].filter((x) => typeof x === "string"))];
      await loadIds(db, hh, s, "items", itemIds);
      for (const itemId of itemIds) await loadInto(db, hh, s, "pantry", "item_id = ? AND deleted_at IS NULL", itemId);
      if (target) {
        await loadInto(db, hh, s, "preferences", "item_id = ?", target.id);
        await loadInto(db, hh, s, "deal_rules", "item_id = ?", target.id);
      }
      break;
    }
    case "item.translate":
      await loadItems(db, hh, s, "id = ?", String(op.item_id));
      break;
    case "recipe.translate":
      await loadInto(db, hh, s, "recipes", "id = ?", String(op.id));
      break;
    case "item.alias":
      await loadItems(db, hh, s, "id = ?", String(op.item_id));
      if (typeof op.name === "string") await loadByName(db, hh, s, op.name);
      if (typeof op.id === "string") await loadIds(db, hh, s, "aliases", [op.id]);
      break;
    case "rating.set":
      await loadInto(db, hh, s, "products", "id = ?", String(op.product_id));
      await loadInto(db, hh, s, "ratings", "member_id = ? AND product_id = ?", String(memberId), String(op.product_id));
      break;
    case "receipt.save":
      await loadInto(db, hh, s, "receipts", "id = ?", String(op.id));
      break;
    case "purchase.add":
      await loadInto(db, hh, s, "purchases", "id = ?", String(op.id));
      if (s.purchases[op.id]) break;
      if (typeof op.title === "string") await loadByName(db, hh, s, op.title);
      if (typeof op.receipt_id === "string") await loadInto(db, hh, s, "receipts", "id = ?", op.receipt_id);
      if (op.product && typeof op.product === "object") await loadProduct(db, hh, s, op.product.id, op.product);
      if (typeof op.entry_id === "string") await loadInto(db, hh, s, "entries", "id = ?", op.entry_id);
      // Bought for a recipe: its open lines of this item name the recipes ("… gekookt?").
      if (op.pantry === true && op.entry_id === undefined) {
        for (const itemId of Object.keys(s.items)) {
          await loadInto(db, hh, s, "entries", "item_id = ? AND checked_at IS NULL AND deleted_at IS NULL", itemId);
        }
      }
      if (typeof op.bought_on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(op.bought_on)) {
        // The basket lines a receipt may clear (clearBasketFor): ticked around
        // the shopping day; few, so all of them. A line's title is its item's
        // name (entry.add, entry.update), so the canonical name needs no items.
        if (op.source === "receipt") {
          await loadInto(db, hh, s, "entries", "checked_at IS NOT NULL AND deleted_at IS NULL AND checked_at >= ? AND checked_at < ?",
            addDays(op.bought_on, -BASKET_BEFORE_DAYS), addDays(op.bought_on, BASKET_AFTER_DAYS + 1));
        }
        await loadPrompts(db, hh, s, op.bought_on, Object.values(s.entries));
      }
      if (op.prefer || op.prefer_recipe_id) {
        if (typeof op.prefer_recipe_id === "string") await loadInto(db, hh, s, "recipes", "id = ?", op.prefer_recipe_id);
        await loadPreferences(db, hh, s);
      }
      if (op.pantry === true) await loadPantryForPurchase(db, hh, s, op);
      // A rebuy may teach the rate (public/shared/rate-learning.js): the item's
      // live rows, and its last priced purchases for "was it on offer?".
      if (op.pantry === true && op.source === "receipt" && typeof op.bought_on === "string") {
        for (const itemId of Object.keys(s.items)) {
          await loadInto(db, hh, s, "pantry", "item_id = ? AND deleted_at IS NULL", itemId);
          await loadInto(db, hh, s, "purchases",
            `item_id = ? AND deleted_at IS NULL AND bought_on < ? AND price_cents IS NOT NULL AND id <> ? ORDER BY bought_on DESC, id DESC LIMIT ${OFFER_HISTORY}`,
            itemId, op.bought_on, String(op.id));
        }
      }
      break;
    case "pantry.add":
      await loadInto(db, hh, s, "pantry", "id = ?", String(op.id));
      if (typeof op.title === "string") await loadByName(db, hh, s, op.title);
      break;
    case "pantry.update":
    case "pantry.remove":
      await loadInto(db, hh, s, "pantry", "id = ?", String(op.id));
      // The row's item and product: their open shelf life applies when a fraction is left.
      for (const r of Object.values(s.pantry)) await loadInto(db, hh, s, "items", "id = ?", r.item_id);
      await loadRowProducts(db, hh, s);
      // A corrected amount settles a counted-down item's other rows.
      if (op.type === "pantry.update" && ("amount" in op || "add_days" in op)) await loadCountedDown(db, hh, s);
      break;
    case "pantry.use": {
      const takes = Array.isArray(op.takes) ? op.takes.slice(0, 40) : [];
      await loadIds(db, hh, s, "pantry_events", takes.map((t) => t?.event_id));
      await loadIds(db, hh, s, "pantry", takes.map((t) => t?.pantry_id));
      // An opened pack's date comes from its product's or item's opened_days.
      await loadIds(db, hh, s, "items", Object.values(s.pantry).map((r) => r.item_id));
      await loadRowProducts(db, hh, s);
      // A counted-down item is settled before the take: all its rows.
      await loadCountedDown(db, hh, s);
      break;
    }
    case "pantry.unuse":
      await loadIds(db, hh, s, "pantry_events", Array.isArray(op.event_ids) ? op.event_ids.slice(0, 40) : []);
      await loadIds(db, hh, s, "pantry", Object.values(s.pantry_events).map((e) => e.pantry_id));
      // An "op" that taught a rate: its item, to undo the lesson too.
      await loadIds(db, hh, s, "items", Object.values(s.pantry_events).filter((e) => e.rate_before).map((e) => e.item_id));
      break;
    case "purchase.delete":
      await loadInto(db, hh, s, "purchases", "id = ?", String(op.id));
      break;
    case "pantry.pend":
      await loadIds(db, hh, s, "pending_takes", Array.isArray(op.pending) ? op.pending.slice(0, 40).map((p) => p?.id) : []);
      break;
    case "pantry.unpend": {
      const ids = Array.isArray(op.ids) ? op.ids.slice(0, 40) : [];
      await loadIds(db, hh, s, "pending_takes", ids);
      await loadIds(db, hh, s, "pantry_events", Object.values(s.pending_takes).map((p) => p.event_id ?? pendingEventId(p.id)));
      await loadIds(db, hh, s, "pantry", Object.values(s.pantry_events).map((e) => e.pantry_id));
      break;
    }
    case "recipe.cook_prompt":
      if (typeof op.recipe_id === "string" && typeof op.shopped_on === "string") {
        await loadInto(db, hh, s, "cook_prompts", "id = ?", cookPromptId(op.recipe_id, op.shopped_on));
      }
      break;
    case "recipe.rate":
      await loadInto(db, hh, s, "recipes", "id = ?", String(op.recipe_id));
      await loadInto(db, hh, s, "recipe_ratings", "member_id = ? AND recipe_id = ?", String(memberId), String(op.recipe_id));
      break;
    case "recipe.cooked":
      await loadInto(db, hh, s, "cooks", "id = ?", String(op.id));
      if (s.cooks[op.id]) break;
      await loadInto(db, hh, s, "recipes", "id = ?", String(op.recipe_id));
      await loadInto(db, hh, s, "cooks", "recipe_id = ? AND cooked_on = ? AND deleted_at IS NULL", String(op.recipe_id), String(op.cooked_on));
      break;
    case "recipe.uncooked":
      await loadInto(db, hh, s, "cooks", "id = ?", String(op.id));
      break;
    case "recipe.put":
    case "recipe.delete":
    case "recipe.links":
      await loadInto(db, hh, s, "recipes", "id = ?", String(op.type === "recipe.links" ? op.recipe_id : op.id));
      break;
    case "entry.add":
    case "entry.update":
    case "entry.check":
    case "entry.delete": {
      await loadInto(db, hh, s, "entries", "id = ?", String(op.id));
      if (typeof op.title === "string") await loadByName(db, hh, s, op.title);
      // A tapped suggestion names its item by id ("Koppel aan…").
      if (typeof op.item_id === "string" && (op.type === "entry.add" || op.type === "entry.update")) {
        await loadItems(db, hh, s, "id = ?", op.item_id);
      }
      // A line that made its own item and is linked elsewhere drops that item
      // when nothing else points at it: every live row of it (a new item: none or few).
      const line = s.entries[op.id];
      if (op.type === "entry.update" && typeof op.title === "string" && line?.new_item && line.item_id) {
        await loadInto(db, hh, s, "items", "id = ?", line.item_id);
        await loadInto(db, hh, s, "entries", "item_id = ? AND deleted_at IS NULL AND id <> ? LIMIT 1", line.item_id, line.id);
        for (const kind of ["purchases", "products", "pantry", "pantry_events", "preferences", "deal_rules", "pending_takes", "aliases"]) {
          await loadInto(db, hh, s, kind, "item_id = ? AND deleted_at IS NULL LIMIT 1", line.item_id);
        }
      }
      const itemIds = new Set(Object.keys(s.items));
      for (const e of Object.values(s.entries)) if (e.item_id) itemIds.add(e.item_id);
      for (const itemId of itemIds) {
        await loadInto(db, hh, s, "entries", "item_id = ? AND checked_at IS NULL AND deleted_at IS NULL", itemId);
      }
      // Put on the list may teach a counted-down item's rate: its live rows (a handful).
      if (op.type === "entry.add" && !op.source) {
        for (const itemId of Object.keys(s.items)) await loadInto(db, hh, s, "pantry", "item_id = ? AND deleted_at IS NULL", itemId);
      }
      // Ticking puts the line in the pantry, unticking takes it out: its one row.
      // Its date comes from the item's own shelf life when it has one.
      if (op.type === "entry.check") {
        await loadInto(db, hh, s, "pantry", "id = ?", entryPantryId(String(op.id)));
        const e = s.entries[op.id];
        if (e?.item_id && !s.items[e.item_id]) await loadInto(db, hh, s, "items", "id = ?", e.item_id);
        // A line for a recipe: that recipe's "… gekookt?" rows.
        if (e?.sources?.length) await loadPrompts(db, hh, s, opDay(op), [e]);
      }
      break;
    }
    case "entry.clear_checked": {
      const ids = Array.isArray(op.ids) ? op.ids.map(String).slice(0, 500) : [];
      for (let i = 0; i < ids.length; i += 90) {
        const chunk = ids.slice(i, i + 90);
        await loadInto(db, hh, s, "entries", `id IN (${chunk.map(() => "?").join(",")})`, ...chunk);
      }
      break;
    }
    case "member.update":
      await loadInto(db, hh, s, "members", "id = ?", String(op.id));
      break;
    case "prices.sync":
      // Every live product is a candidate (a few hundred), the live items for
      // their names, and this store's price rows, tombstones too (a returning price revives its row).
      await loadInto(db, hh, s, "products", "deleted_at IS NULL");
      await loadInto(db, hh, s, "items", "deleted_at IS NULL");
      // For the comparables (public/shared/comparable-prices.js): the open
      // list lines (their items) and the preferences (the product to compare with).
      await loadInto(db, hh, s, "entries", "deleted_at IS NULL AND checked_at IS NULL");
      await loadInto(db, hh, s, "preferences", "deleted_at IS NULL");
      await loadInto(db, hh, s, "store_prices", "store = ?", canonicalStore(String(op.store ?? "")));
      break;
    case "review.save":
      // The day's own row, tombstone too (a second run that day replaces it).
      await loadInto(db, hh, s, "reviews", "id = ?", `review-${String(op.day ?? "")}`);
      // The changelog rows past AUTO_CHANGES_DAYS, to tombstone.
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(op.day ?? ""))) {
        await loadInto(db, hh, s, "auto_changes", "deleted_at IS NULL AND day < ?", addDays(String(op.day), -AUTO_CHANGES_DAYS));
      }
      break;
    default:
      break;
  }
  return s;
}

function writeStatements(db, hh, state, changed) {
  const stmts = [db.prepare("UPDATE households SET rev = rev + 1 WHERE id = ?").bind(hh)];
  const rev = "(SELECT rev FROM households WHERE id = ?)";
  for (const [kind, rowId] of changed) {
    const row = state[kind][rowId];
    if (kind === "members") {
      stmts.push(db.prepare(`UPDATE members SET name = ?, locale = ?, rev = ${rev} WHERE id = ? AND household_id = ?`)
        .bind(row.name, row.locale, hh, row.id, hh));
      continue;
    }
    const cols = COLUMNS[kind];
    const table = TABLE[kind];
    const updates = cols.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`).join(", ");
    // The WHERE keeps an id from one household from ever overwriting a row of another.
    stmts.push(db.prepare(
      `INSERT INTO ${table} (household_id, ${cols.join(", ")}, rev) VALUES (?, ${cols.map(() => "?").join(", ")}, ${rev}) ` +
      `ON CONFLICT(id) DO UPDATE SET ${updates}, rev = excluded.rev WHERE ${table}.household_id = excluded.household_id`,
    ).bind(hh, ...cols.map((c) => toValue(kind, c, row[c])), hh));
  }
  return stmts;
}

/**
 * The items this op put in the pantry or bought that have no shelf life yet
 * (no shelf_source): worker/shelf.js looks them up after the batch.
 */
function unknownShelfItems(state, changed) {
  const out = [];
  for (const [kind, rowId] of changed) {
    if (kind !== "pantry" && kind !== "purchases") continue;
    const row = state[kind][rowId];
    if (!row || row.deleted_at || !row.item_id) continue;
    if (kind === "purchases" && row.source !== "receipt") continue;   // the old history is no shopping
    const item = state.items[row.item_id];
    if (item && !item.deleted_at && !item.shelf_source) out.push(item.id);
  }
  return out;
}

/** The products this op bought on a receipt that have no shelf life of their own yet. */
function unknownShelfProducts(state, changed) {
  const out = [];
  for (const [kind, rowId] of changed) {
    if (kind !== "purchases") continue;
    const row = state.purchases[rowId];
    if (!row || row.deleted_at || row.source !== "receipt" || !row.product_id) continue;
    const p = state.products[row.product_id];
    if (p && !p.deleted_at && !p.shelf_source) out.push(p.id);
  }
  return out;
}

/**
 * The items this op made (or brought back) without an English name: the
 * worker asks Claude Haiku for one in the background (worker/kinds.js, in the
 * same request as the products' kinds). Older items are filled by the
 * one-off tool (tools/fill_translations.mjs), never here.
 */
function newItemsWithoutEnglish(state, changed, now) {
  const out = [];
  for (const [kind, rowId] of changed) {
    const item = kind === "items" ? state.items[rowId] : null;
    if (item && !item.deleted_at && !item.name_en && item.created_at === now) out.push(item.id);
  }
  return out;
}

/**
 * Apply a phone's ops in order. Each op is atomic on its own; one bad op does
 * not stop the ones after it.
 * ctx: { householdId, memberId, isAdmin, role }
 * hooks.unknownShelf: a Set that gets the ids of items bought or put in the
 * pantry without a shelf life (worker/shelf.js); hooks.unknownShelfProducts
 * the ids of products bought on a receipt without one. hooks.unknownKind: a Set
 * that gets the ids of products written without a kind (worker/kinds.js).
 * hooks.untranslatedItems: the ids of items made without an English name
 * (worker/kinds.js); hooks.untranslatedRecipes: recipes whose text an edit
 * changed while their translation is missing or stale (worker/translate.js).
 * A new recipe without labels is not one: the labeller's call
 * (worker/labels.js) brings its translation; an import's draft brings its own
 * (worker/recipe-import.js, sent as recipe.translate in the same batch).
 */
export async function applyOps(db, ctx, ops, hooks = {}) {
  const hh = ctx.householdId;
  const results = [];
  // What this member may not see (items private to someone else): read once
  // per batch, and only when there are ops. Nothing private: one empty read.
  const hidden = ops.length ? await loadHidden(db, hh, ctx.memberId) : null;
  for (const op of ops) {
    const opId = op?.op_id;
    if (typeof opId !== "string" || !OP_ID_RE.test(opId)) {
      results.push({ op_id: opId ?? null, ok: false, error: "bad_op_id" });
      continue;
    }
    const done = await db.prepare("SELECT result FROM applied_ops WHERE op_id = ? AND household_id = ?").bind(opId, hh).first();
    if (done) {
      results.push({ op_id: opId, ok: true, result: JSON.parse(done.result) });
      continue;
    }
    for (let attempt = 0; ; attempt++) {
      const state = await load(db, hh, op, ctx.memberId);
      // Another member's private item does not exist for this op: naming it
      // is not_found, and its rows are out of the state the engine sees.
      const dropped = guardOp(state, op, hidden, findItem);
      if (dropped === "not_found") {
        results.push({ op_id: opId, ok: false, error: "not_found" });
        break;
      }
      const now = new Date().toISOString();
      // The text a translation is made of, before this op (an edit that changes it makes it stale).
      const printBefore = op.type === "recipe.put" && state.recipes[op.id] && !state.recipes[op.id].deleted_at ? recipeFingerprint(state.recipes[op.id]) : null;
      let outcome;
      try {
        // The reviewer device's (the nightly check's) changes go into its changelog (auto_changes).
        outcome = applyOp(state, op, { memberId: ctx.memberId, isAdmin: ctx.isAdmin, now, autoLog: ctx.role === "reviewer" });
      } catch (e) {
        if (!(e instanceof OpError)) throw e;
        results.push({ op_id: opId, ok: false, error: e.code });
        break;
      }
      if (touchesHidden(state, outcome.changed, dropped, hidden)) {
        results.push({ op_id: opId, ok: false, error: "not_found" });
        break;
      }
      const stmts = outcome.changed.length ? writeStatements(db, hh, state, outcome.changed) : [];
      stmts.push(db.prepare("INSERT INTO applied_ops (op_id, household_id, result, applied_at) VALUES (?, ?, ?, ?)")
        .bind(opId, hh, JSON.stringify(outcome.result ?? {}), new Date().toISOString()));
      try {
        await db.batch(stmts);
        results.push({ op_id: opId, ok: true, result: outcome.result ?? {} });
        if (hooks.unknownShelf) for (const itemId of unknownShelfItems(state, outcome.changed)) hooks.unknownShelf.add(itemId);
        if (hooks.unknownShelfProducts) for (const pid of unknownShelfProducts(state, outcome.changed)) hooks.unknownShelfProducts.add(pid);
        if (hooks.unknownKind) for (const [kind, rowId] of outcome.changed) {
          const p = kind === "products" ? state.products[rowId] : null;
          if (p && !p.deleted_at && !p.kind) hooks.unknownKind.add(p.id);
        }
        if (hooks.untranslatedItems) for (const itemId of newItemsWithoutEnglish(state, outcome.changed, now)) hooks.untranslatedItems.add(itemId);
        if (hooks.untranslatedRecipes && op.type === "recipe.put") {
          const r = state.recipes[op.id];
          // An edit that changed the text; a new recipe only when the labeller
          // will not run for it (labels already set), since its call translates.
          const changedText = printBefore ? r && recipeFingerprint(r) !== printBefore : r && r.labels_by;
          if (changedText && needsTranslation(r)) hooks.untranslatedRecipes.add(r.id);
        }
        break;
      } catch (e) {
        // Another phone added the same item a moment earlier: reload, and the
        // engine merges into that line this time.
        if (attempt === 0 && /UNIQUE/i.test(String(e?.message))) continue;
        throw e;
      }
    }
  }
  return results;
}

/**
 * Everything that changed after `since`. since = 0 is a full load without
 * tombstones. `guest`: only GUEST_SYNCED, members as their names.
 */
export async function pull(db, hh, since, { guest = false, memberId = null } = {}) {
  const kinds = guest ? GUEST_SYNCED : SYNCED;
  const head = await db.prepare("SELECT rev FROM households WHERE id = ?").bind(hh).first();
  const rev = head?.rev ?? 0;
  const full = since <= 0;
  // Nothing changed since this phone last asked: answer from the counter
  // alone. Most polls end here, at one row read.
  if (!full && rev <= since) return { rev, full: false, ...Object.fromEntries(kinds.map((k) => [k, []])) };
  const live = full ? " AND deleted_at IS NULL" : "";
  const q = (table, extra = live) =>
    db.prepare(`SELECT * FROM ${table} WHERE household_id = ? AND rev > ?${extra}`).bind(hh, full ? -1 : since);
  // Items private to another member (worker/privacy.js), read in the same batch.
  const results = await db.batch([...kinds.map((kind) =>
    kind === "members" ? q("members", full ? " AND removed_at IS NULL" : "") : q(TABLE[kind])),
  ...(guest ? [] : [hiddenStatement(db, hh, memberId)])]);
  const hidden = guest ? null : hiddenOf(results[kinds.length].results);
  const out = { rev, full };
  kinds.forEach((kind, i) => { out[kind] = results[i].results.map((r) => fromRow(kind, r)); });
  if (hidden && !hidden.empty) {
    // A hidden row is left out of a full load; in a delta it goes as a bare
    // tombstone (its id only), so a phone that had it (before it was made
    // private) drops it. Nothing of its content leaves the server.
    for (const kind of kinds) {
      if (kind === "members") continue;
      out[kind] = out[kind].flatMap((row) => {
        if (!rowHidden(kind, row, hidden)) return [rowFor(kind, row, hidden)];
        return full ? [] : [{ id: row.id, deleted_at: row.deleted_at ?? HIDDEN_AT, rev: row.rev }];
      });
    }
  }
  // A merge's or removal's record stays on the server: no phone needs it.
  if (out.items) out.items = out.items.map(({ undo_rows, ...i }) => i);
  if (guest) out.members = out.members.map((m) => Object.fromEntries(GUEST_MEMBER_FIELDS.map((f) => [f, m[f] ?? null])));
  // Which item each recipe line means is the household's (30-10-2026): never a guest's.
  if (guest) out.recipes = out.recipes.map(({ ingredient_links, ...r }) => r);
  return out;
}
