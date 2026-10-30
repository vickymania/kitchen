// What "Weer nodig" is for (28-10-2026): things that have nothing to do
// with cooking a recipe (toilet paper, cat litter, drinks, snacks, breakfast).
// What he buys only when he cooks a recipe is left out, except the cooking
// basics he keeps in stock. A per-item override (items.again) beats the rule.
import { nameKey } from "./ingredients.js";
import { sameStuff } from "./pantry.js";

// Cooking basics, as nameKey words. A recipe ingredient that is one of these
// still shows. Short on purpose: add a line here, nothing else.
export const BASICS = new Set([
  "olie", "olijfolie", "zonnebloemolie", "arachideolie", "kokosolie", "boter", "roomboter", "margarine", "halvarine",
  "saus", "ketchup", "mayonaise", "mosterd", "sojasaus", "ketjap", "sambal", "sriracha", "tabasco", "pesto", "dressing",
  "bouillon", "azijn", "zout", "peper", "suiker", "bloem", "meel", "honing", "pindakaas", "tomatenpuree", "maizena", "bakpoeder",
]);
// Compounds of these count too: "pastasaus", "knoflookolie", "kruidenboter".
const BASIC_ENDINGS = ["olie", "saus", "boter", "bouillon", "azijn"];

/** Is this a cooking basic (oil, butter, a sauce, a condiment)? */
export function isBasic(name) {
  return nameKey(name).split(" ").some((w) => BASICS.has(w) || BASIC_ENDINGS.some((e) => w.endsWith(e)));
}

/** The distinct ingredient keys of the live recipes. */
export function recipeIngredientKeys(recipes) {
  const keys = new Set();
  for (const r of Object.values(recipes ?? {})) {
    if (!r || r.deleted_at) continue;
    for (const i of r.ingredients ?? []) if (!i.heading) { const k = nameKey(i.name); if (k) keys.add(k); }
  }
  return [...keys];
}

/** Does `key` (a canonical item key) match an ingredient of any live recipe? */
export const isRecipeIngredient = (key, ingredientKeys) => ingredientKeys.some((k) => sameStuff(k, key));

/**
 * Is the item hidden from "Weer nodig"? `again` is the override: 'hide' always
 * hides, 'show' always shows, null lets the rule decide (a recipe ingredient
 * that is no cooking basic is hidden).
 */
export function isHidden({ again, key, name, ingredientKeys }) {
  if (again === "hide") return true;
  if (again === "show") return false;
  return isRecipeIngredient(key, ingredientKeys) && !isBasic(name) && !isBasic(key);
}
