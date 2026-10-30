// "Ik ben bij..." (28-10-2026): the store this phone is shopping in,
// so each list line shows the product, price and offer of that store. A
// per-device choice, like the theme, kept in localStorage; it expires after
// one trip (public/shared/stores.js storeChoice).
import { storeChoice, knownStores } from "../shared/stores.js";

const KEY = "kitchen.store";

/** The chosen store's name, or null for none. */
export function getStore() {
  try {
    return storeChoice(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return null;
  }
}

export function setStore(store) {
  try {
    if (store) localStorage.setItem(KEY, JSON.stringify({ store, at: Date.now() }));
    else localStorage.removeItem(KEY);
  } catch {
    // Private mode or blocked storage: no store is remembered.
  }
}

/** The stores to choose from: those of his products, preferences, purchases, current offers and shelf prices. */
export function storesOf(view, current) {
  const purchases = Object.values(view.purchases ?? {}).filter((x) => x.product_id).map((x) => x.store);
  return knownStores(
    Object.values(view.products ?? {}).map((p) => p.store),
    Object.values(view.preferences ?? {}).map((p) => p.store),
    purchases,
    current.map((o) => o.store),
    // A store with a shelf price of one of his products (Checkjebon) can be chosen too.
    Object.values(view.store_prices ?? {}).map((r) => r.store),
  );
}
