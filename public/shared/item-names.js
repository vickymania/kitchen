// View-side clean-up of the purchase history for "need it again". The stored
// rows are never changed: these lists only decide what the tab shows and how
// purchases are counted. Keys are nameKey() of the name (public/shared/ingredients.js).
import { nameKey } from "./ingredients.js";

// Lines of the old To Do lists that are no product (a meal, a catch-all, a note), so they never get a timer.
export const GENERIC = new Set([
  "eten", "drinken", "drankje", "ontbijt", "lunch", "diner", "avondeten", "avond eten",
  "boodschappen", "fruit", "vlees", "beleg", "snack", "snacks", "i love you",
]);

// Names of one and the same product, mapped to the one name it is shown and counted under.
export const SAME = {
  ei: "Eieren",
  eieren: "Eieren",
  boter: "Roomboter",
  roomboter: "Roomboter",
  kattengrind: "Kattenbakvulling",
  kattenbakvulling: "Kattenbakvulling",
  nrg: "Energy drink",
  energy: "Energy drink",
  "energy drink": "Energy drink",
  banaan: "Bananen",
  bananen: "Bananen",
  tomaat: "Tomaten",
  tomaten: "Tomaten",
  ui: "Uien",
  uien: "Uien",
  groentebouillon: "Groentebouillon",
  groentenbouillon: "Groentebouillon",
  "vochtig tp": "Vochtig toiletpapier",
  "vochtig toiletpapier": "Vochtig toiletpapier",
  "minoes eten": "Minoes eten",
  "eten minoes": "Minoes eten",
  bosui: "Bosui",
  "lente ui": "Bosui",
  lenteui: "Bosui",
  "bos lente ui": "Bosui",
  bosuien: "Bosui",
  "lente uien": "Bosui",
  lenteuien: "Bosui",
  bollen: "Bollen",
  bolletjes: "Bollen",
  bolletje: "Bollen",
  brokken: "Minoes brokken",
  brokkenjongen: "Minoes brokken",
  "brokken jongen": "Minoes brokken",
  "brok voor jongen": "Minoes brokken",
  "minoes brokken": "Minoes brokken",
  pluizebolbrokkenman: "Minoes brokken",
  kattenbrokjes: "Minoes brokken",
  "kattenbrokjes soon": "Minoes brokken",
  sap: "Sapje",
  sapje: "Sapje",
  // Every tin of tuna is for Minoes, the cat (28-10-2026).
  minoestuna: "Minoestuna",
  tonijn: "Minoestuna",
  tuna: "Minoestuna",
  "tonijn in olie": "Minoestuna",
  "tuna olijfolie": "Minoestuna",
};

/** True for a line that is no product. */
export const isGeneric = (name) => GENERIC.has(nameKey(name));

/**
 * { key, name } an item is counted and shown under: the canonical product for
 * an alias, else its own key and its name without a trailing "?" or "!".
 */
export function canonicalName(name) {
  const key = nameKey(name);
  const same = SAME[key];
  if (same) return { key: nameKey(same), name: same };
  return { key, name: String(name ?? "").replace(/[\s?!]+$/, "") || String(name ?? "") };
}

/**
 * The key without spaces: "Minoes brokken", "minoesbrokken" and
 * "minoes-brokken" are one name (30-10-2026). nameKey already folds
 * case, accents and hyphens; this drops the spaces too. The SQL twin is
 * REPLACE(name_key, ' ', '') (migrations/0022_item_aliases.sql indexes it):
 * change one, change both.
 */
export const compactKey = (name) => nameKey(name).replace(/ /g, "");
