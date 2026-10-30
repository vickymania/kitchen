// The labels a recipe can carry, for the "what shall I eat" wizard. A fixed,
// short vocabulary: Claude picks from it (worker/labels.js sends these lists
// as the enum of its answer), the editor offers it, the wizard asks it. The
// words people read are in the i18n files under "labels.*".

export const CUISINES = [
  "dutch", "italian", "french", "spanish", "greek", "middle_eastern", "indian",
  "thai", "chinese", "japanese", "korean", "indonesian", "mexican", "american", "other",
];

export const MAIN_INGREDIENTS = [
  "chicken", "beef", "mince", "pork", "fish", "seafood", "vegetarian",
  "pasta", "rice", "noodles", "potato", "bread", "eggs", "other",
];

export const TIME_CLASSES = ["fast", "normal", "elaborate"];

/**
 * Which meals a recipe is for (28-10-2026). A set: pancakes can be
 * breakfast and lunch. Stored as a JSON array in this order; empty is null,
 * "not labelled".
 */
export const MEALS = ["breakfast", "lunch", "dinner", "snack", "dessert"];

/** The meals in their fixed order, without doubles; null when there are none. */
export function sortMeals(list) {
  const out = MEALS.filter((m) => list.includes(m));
  return out.length ? out : null;
}

/** Who set the labels. A person's labels are never overwritten by Claude. */
export const LABELS_BY = ["claude", "person"];

/** Up to this many minutes of work a recipe counts as fast. */
export const FAST_MINUTES = 30;
/** Past this many minutes it counts as elaborate. */
export const ELABORATE_MINUTES = 75;

export function timeClassOf(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes < FAST_MINUTES) return "fast";
  return minutes > ELABORATE_MINUTES ? "elaborate" : "normal";
}

/** The label fields of a recipe, as recipe.put takes them. */
export const LABEL_FIELDS = ["cuisine", "main_ingredient", "time_class", "time_minutes", "meals"];
