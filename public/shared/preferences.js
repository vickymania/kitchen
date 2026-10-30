// Which product to buy for a list line (28-10-2026): cheap store-brand
// tortilla chips for the nachos lasagne (harder, crunchier), the brand for a
// bowl of chips; and at Dirk another product than at AH. A preference is one
// row per item, store ('' = any store) and recipe ('' = any recipe); this file
// picks the one that holds for a line, pure, for the phone and the MCP server.
import { canonicalStore, sameStore } from "./stores.js";
import { nameKey } from "./ingredients.js";

const scopeKey = (itemId, store, recipeId) => `${itemId}|${nameKey(canonicalStore(store ?? ""))}|${recipeId ?? ""}`;

const indexes = new WeakMap();

/** The live preferences by scope, built once per synced preferences object. */
function indexOf(preferences) {
  let idx = indexes.get(preferences);
  if (!idx) {
    idx = { byScope: new Map(), byItem: new Map() };
    for (const p of Object.values(preferences ?? {})) {
      if (!p || p.deleted_at || !p.product_id) continue;
      idx.byScope.set(scopeKey(p.item_id, p.store, p.recipe_id), p);
      if (!idx.byItem.has(p.item_id)) idx.byItem.set(p.item_id, []);
      idx.byItem.get(p.item_id).push(p);
    }
    indexes.set(preferences, idx);
  }
  return idx;
}

/** The live preference row of exactly this scope, or null. */
export function preferenceAt(preferences, itemId, store = "", recipeId = "") {
  return indexOf(preferences).byScope.get(scopeKey(itemId, store, recipeId)) ?? null;
}

/** Every live preference of an item. */
export function preferencesOf(preferences, itemId) {
  return indexOf(preferences).byItem.get(itemId) ?? [];
}

/**
 * The product for a list line at a store (null = no store chosen).
 * data: { preferences, products, recipes }; entry: { item_id, sources }.
 * With a store, in this order: the line's recipe at that store, the recipe at
 * any store, the item at that store, the item at any store. Without one: the
 * recipe at any store, the item at any store, and then what is known for one
 * store (recipe first, the newest), so a line still shows "AH Halfvolle melk ·
 * bij Albert Heijn". A preference whose product is gone does not count.
 *
 * Store_only (28-10-2026: the Lidl macaroni herbs for "Pastapotje
 * HenkTorino"): a product sold at one store only is bought there whatever
 * store is chosen, so its preference for its own store also holds at another
 * one. A recipe's store_only preference for another store comes right after
 * the recipe at any store and before the item at the chosen store (or, with
 * no store chosen, the item at any store), because the recipe asked for it (recipe + any = Lidl store_only
 * already beats item + AH by the order above); with a store chosen, an
 * item's store_only preference for another store comes last, only when
 * nothing else holds. The
 * line then says "haal bij <winkel>" (onlyAt).
 * Returns { product, preference, why: { recipe, store }, onlyAt } (recipe: its
 * title, store: the store's name; null when it holds for any; onlyAt: the
 * store of a store_only product, else null) or null.
 */
export function resolveProduct(data, entry, store = null) {
  if (!entry?.item_id) return null;
  const prefs = data.preferences ?? {};
  const recipes = (entry.sources ?? []).map((s) => s?.recipe_id).filter(Boolean);
  const shop = store ? canonicalStore(store) : "";
  const live = (p) => {
    const product = p && data.products?.[p.product_id];
    return product && !product.deleted_at ? product : null;
  };
  const answer = (p, product) => {
    const recipe = p.recipe_id ? (data.recipes?.[p.recipe_id]?.title ?? entry.sources.find((s) => s.recipe_id === p.recipe_id)?.title ?? "") : null;
    const onlyAt = product.store_only && product.store ? canonicalStore(product.store) : null;
    return { product, preference: p, why: { recipe, store: p.store ? canonicalStore(p.store) : null }, onlyAt };
  };
  // Store_only preferences for a store other than the chosen one, newest first.
  const away = (recipe) => preferencesOf(prefs, entry.item_id)
    .filter((p) => p.store && !sameStore(p.store, shop) && (recipe ? recipes.includes(p.recipe_id) : !p.recipe_id) && live(p)?.store_only)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0] ?? null;
  const steps = [];
  if (shop) for (const r of recipes) steps.push([shop, r]);
  for (const r of recipes) steps.push(["", r]);
  steps.push("away-recipe");
  if (shop) steps.push([shop, ""]);
  steps.push(["", ""]);
  if (shop) steps.push("away-item");
  for (const step of steps) {
    const p = step === "away-recipe" ? away(true) : step === "away-item" ? away(false) : preferenceAt(prefs, entry.item_id, step[0], step[1]);
    const product = live(p);
    if (product) return answer(p, product);
  }
  if (shop) return null;
  // No store chosen: what is known for one store still says what to buy.
  const elsewhere = preferencesOf(prefs, entry.item_id)
    .filter((p) => p.store && (!p.recipe_id || recipes.includes(p.recipe_id)) && live(p))
    .sort((a, b) => Number(Boolean(b.recipe_id)) - Number(Boolean(a.recipe_id)) || String(b.updated_at).localeCompare(String(a.updated_at)));
  return elsewhere.length ? answer(elsewhere[0], live(elsewhere[0])) : null;
}

/**
 * The open list lines split by where they are bought (28-10-2026):
 * with a store chosen, a line whose product is sold only at another store
 * goes to that store's group at the bottom ("Andere winkel: Lidl"), groups
 * sorted by store; the rest keep their order. Without a store chosen nothing
 * moves (the line still says "haal bij Lidl"). Returns { here, away: [[store,
 * lines]] }.
 */
export function storeGroups(data, entries, store = null) {
  const shop = store ? canonicalStore(store) : "";
  const here = [];
  const away = new Map();
  for (const e of entries) {
    const at = shop && !e.checked_at ? resolveProduct(data, e, shop)?.onlyAt : null;
    if (!at || sameStore(at, shop)) here.push(e);
    else away.set(at, [...(away.get(at) ?? []), e]);
  }
  return { here, away: [...away].sort(([a], [b]) => a.localeCompare(b, "nl")) };
}

/**
 * The last price of a product at a store: its newest purchase there, else the
 * product's own last price when it was last bought there (or no store is
 * chosen). byProduct: purchasesByProduct(), once per render.
 */
export function lastPrice(product, store, byProduct) {
  if (!product) return null;
  if (!store) return product.last_price_cents ?? null;
  const there = (byProduct?.get(product.id) ?? []).find((x) => x.price_cents !== null && sameStore(x.store, store));
  if (there) return there.qty ? Math.round(there.price_cents / there.qty) : there.price_cents;
  return sameStore(product.store, store) ? product.last_price_cents ?? null : null;
}

/** Live purchases per product, newest first. */
export function purchasesByProduct(purchases) {
  const out = new Map();
  for (const x of Object.values(purchases ?? {})) {
    if (!x?.product_id || x.deleted_at) continue;
    if (!out.has(x.product_id)) out.set(x.product_id, []);
    out.get(x.product_id).push(x);
  }
  for (const list of out.values()) list.sort((a, b) => b.bought_on.localeCompare(a.bought_on));
  return out;
}
