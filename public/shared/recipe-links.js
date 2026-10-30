// Which item each ingredient line of a recipe means, and why not when none
// (30-10-2026: "straks heeft ieder recept ieder ingrediënt gekoppeld
// … en anders vind ik terug waarom niet"). The nightly check
// (fetcher/review.mjs) runs it on every recipe whose stored result is
// missing, stale or different, and sends it as recipe.links; the recipe page
// marks an unlinked line with its reason, the changelog lists every line.
//
// Pure and deterministic: the resolver of public/shared/ingredient-match.js
// (resolveIngredient, listTargets), nothing fuzzy. Reasons, checked in order:
//   excluded  on the never-suggest list (public/shared/excluded.js)
//   tap       water from the tap: never bought
//   tool      a real tool, never in the pantry (ovenschaal, staafmixer, spuitzak...);
//             consumables such as bakpapier or aluminiumfolie link like ingredients
//   several   the line names several things that are not one item
//   never     the household has no item for it yet: never bought
import { nameKey, splitPrep } from "./ingredients.js";
import { isExcluded, isExcludedLookalike } from "./excluded.js";
import { alternativesOf, itemFinder, listTargets, resolveIngredient } from "./ingredient-match.js";

/** How a line found its item (matchKeys' `how`), and why a line found none. */
export const LINK_HOWS = ["exact", "same", "number", "plain", "compound", "general", "english", "parts", "person"];
export const LINK_REASONS = ["excluded", "tap", "tool", "several", "never"];

/** Water from the tap: never bought, never in the pantry. */
export const FROM_THE_TAP = new Set(["water", "kraanwater", "heet water", "kokend water", "kookwater", "lauw water", "lauwwarm water", "ijskoud water", "koud water", "warm water"]);

/**
 * Real tools named among the ingredients: never in the pantry (Thomas,
 * 30-10-2026). Consumables (aluminiumfolie, bakpapier, keukenpapier,
 * spiesjes, frituurolie) are used up, so they link like any ingredient and
 * are "never" when the household has no item for them yet.
 */
export const TOOL_WORDS = new Set([
  "ovenschaal", "pan", "koekenpan", "wokpan", "braadpan", "steelpan", "hapjespan", "grillpan", "pannetje",
  "keukenmachine", "foodprocessor", "staafmixer", "handmixer", "standmixer", "mixer", "blender",
  "spuitzak", "spuitmond", "schuimspaan", "bakvorm", "taartvorm", "springvorm", "cakevorm", "muffinvorm", "bakblik", "bakplaat",
  "rasp", "zeef", "vergiet", "garde", "deegroller", "kwast", "beslagkom", "kom", "mengkom", "snijplank", "pollepel", "spatel",
  "oven", "airfryer", "wok", "dutch oven", "blender", "whisk", "baking dish", "baking tray", "frying pan", "sieve",
]);

/** The stored result of one line: { name, item_id, item, how } or { name, item_id: null, reason }. */
export function linkLine(name, data, find = itemFinder(data)) {
  const text = String(name ?? "").trim();
  const key = nameKey(splitPrep(text).name);
  if (isExcluded(text) || isExcludedLookalike(text)) return { name: text, item_id: null, reason: "excluded" };
  if (FROM_THE_TAP.has(key)) return { name: text, item_id: null, reason: "tap" };
  if (TOOL_WORDS.has(key)) return { name: text, item_id: null, reason: "tool" };
  const hit = resolveIngredient(text, data, find);
  if (hit) return { name: text, item_id: hit.item.id, item: hit.item.name, how: hit.how };
  // "zout en peper": every part its own line on the list, each linked.
  const parts = listTargets(text, data, find);
  if (parts.length > 1 && parts.every((p) => p.item)) {
    return { name: text, item_id: parts[0].item.id, item: parts.map((p) => p.item.name).join(", "), how: "parts" };
  }
  if (alternativesOf(text) || parts.length > 1 || /\s(?:en|and|&)\s/i.test(splitPrep(text).name)) return { name: text, item_id: null, reason: "several" };
  return { name: text, item_id: null, reason: "never" };
}

/** Every ingredient line of a recipe (headings left out), in order. */
export function linkRecipe(recipe, data, find = itemFinder(data)) {
  return (recipe?.ingredients ?? []).filter((i) => i && !i.heading).map((i) => linkLine(i.name, data, find));
}

const sig = (lines) => JSON.stringify((lines ?? []).map((l) => [l.name, l.item_id ?? null, l.how ?? null, l.reason ?? null]));

/**
 * Does the recipe need (new) links: none stored, stored for an older
 * version of the recipe, or another answer today (a new item, an alias)?
 */
export function linksStale(recipe, lines) {
  const stored = recipe?.ingredient_links;
  return !stored || stored.at !== recipe.updated_at || sig(stored.lines) !== sig(lines);
}

/** The stored links of a recipe that still fit it (same version), or null. */
export function currentLinks(recipe) {
  const stored = recipe?.ingredient_links;
  return stored && stored.at === recipe.updated_at && Array.isArray(stored.lines) ? stored.lines : null;
}
