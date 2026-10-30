// Stars for recipes (30-10-2026): 1-10 per person in steps of a half (10
// since the same day: "ik wil 10 sterren ipv 5"), the household's
// average shown with them. Not right after cooking ("dan moet je nog gaan
// eten"): the day after a cook each person is asked "Hoe was <recipe>
// gisteren?", once per cook, and can skip it. The rows are the op
// recipe.rate's (public/shared/ops.js, table recipe_ratings). Pure: no screen,
// no store; the phone, the wizard and the MCP server read the same numbers.
import { daysBetween } from "./intervals.js";

/** The most stars a person can give, for a recipe and for a product (migrations/0026_ten_stars.sql doubled the old 1-5). */
export const STARS_MAX = 10;

/** True for a stars value a person can give: 0.5 to 10 in steps of 0.5 (half stars since 30-10-2026). */
export function isStarValue(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0.5 && n <= STARS_MAX && Number.isInteger(n * 2);
}

/**
 * The tap cycle of a star (30-10-2026): tapping star n gives n whole;
 * tapping it again gives the half below it (7 -> 6.5); a third tap on that
 * same star takes the stars away (null). Any other star starts over with its
 * own whole number. current: the stars now, or null/0 for none.
 */
export function nextTap(current, n) {
  if (current === n) return n - 0.5;
  if (current === n - 0.5) return null;
  return n;
}

/** How star n (1..10) is drawn for these stars: "full", "half" or "empty". */
export function starFill(current, n) {
  if (!isStarValue(current)) return "empty";
  if (n <= current) return "full";
  return n - 0.5 === current ? "half" : "empty";
}

/** "★6,5" (nl, the Dutch comma) or "★6.5" (en); a whole number has no decimals. */
export function starsLabel(n, locale = "nl") {
  return `★${Number(n).toLocaleString(locale === "en" ? "en-GB" : "nl-NL", { maximumFractionDigits: 1 })}`;
}

/** The stars that neither pull nor push: 6 (the old 3). */
export const STARS_NEUTRAL = 6;

/** Asked on the day after the cook only. */
export const ASK_AFTER_DAYS = 1;

const live = (rows) => Object.values(rows ?? {}).filter((r) => r && !r.deleted_at);

/**
 * Every recipe's stars: Map recipe_id -> { average, count, byMember: { member_id: stars } }.
 * Only rows with stars count; a cleared row (stars null) does not.
 */
export function starsByRecipe(rows) {
  const out = new Map();
  for (const r of live(rows)) {
    if (!isStarValue(r.stars)) continue;
    const cur = out.get(r.recipe_id) ?? { sum: 0, count: 0, byMember: {} };
    cur.sum += r.stars;
    cur.count += 1;
    cur.byMember[r.member_id] = r.stars;
    out.set(r.recipe_id, cur);
  }
  for (const [k, v] of out) out.set(k, { average: Math.round((v.sum / v.count) * 10) / 10, count: v.count, byMember: v.byMember });
  return out;
}

/** One recipe's stars: { average, count, byMember }, or null when nobody gave any. */
export function recipeStars(rows, recipeId) {
  return starsByRecipe(rows).get(recipeId) ?? null;
}

/** This person's row of a recipe (live), or null. */
export function myRecipeRating(rows, memberId, recipeId) {
  return live(rows).find((r) => r.member_id === memberId && r.recipe_id === recipeId) ?? null;
}

/**
 * How the stars move a recipe in a ranking: -1 (two stars) .. +1 (ten
 * stars), 0 for six stars or none at all (the old 1-5 doubled).
 */
export function starsPart(average) {
  if (average === null || average === undefined || !Number.isFinite(average)) return 0;
  return Math.max(-1, Math.min(1, (average - STARS_NEUTRAL) / (STARS_MAX - STARS_NEUTRAL)));
}

/**
 * "Hoe was <recipe> gisteren?" for this person today: [{ recipe_id, title,
 * cooked_on, stars }] (stars: the person's current ones, or null). A cook of
 * a live recipe on the day before today, not yet answered or skipped by this
 * person on or after the day it was cooked (asked_on). One per recipe.
 * view: { cooks, recipes, recipe_ratings }.
 */
export function rateAsks(view, memberId, today) {
  if (!memberId) return [];
  const out = new Map();
  for (const c of live(view?.cooks)) {
    if (daysBetween(c.cooked_on, today) !== ASK_AFTER_DAYS) continue;
    const recipe = view?.recipes?.[c.recipe_id];
    if (!recipe || recipe.deleted_at || out.has(recipe.id)) continue;
    const mine = myRecipeRating(view?.recipe_ratings, memberId, recipe.id);
    if (mine?.asked_on && mine.asked_on >= c.cooked_on) continue;
    out.set(recipe.id, { recipe_id: recipe.id, title: recipe.title, cooked_on: c.cooked_on, stars: isStarValue(mine?.stars) ? mine.stars : null });
  }
  return [...out.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * How often each recipe was cooked (30-10-2026), from the `cooks`
 * rows: Map recipe_id -> { total, last, byMember: { member_id: n } }.
 * Tombstones do not count; the same recipe on the same day counts once in
 * total and once per person. `last` is the newest day ("YYYY-MM-DD").
 */
export function cookStats(cooks) {
  const days = new Map();
  const memberDays = new Map();
  for (const c of live(cooks)) {
    if (!c.recipe_id || !c.cooked_on) continue;
    if (!days.has(c.recipe_id)) days.set(c.recipe_id, new Set());
    days.get(c.recipe_id).add(c.cooked_on);
    if (c.member_id) {
      const key = `${c.recipe_id}\u0000${c.member_id}`;
      if (!memberDays.has(key)) memberDays.set(key, new Set());
      memberDays.get(key).add(c.cooked_on);
    }
  }
  const out = new Map();
  for (const [recipeId, set] of days) {
    out.set(recipeId, { total: set.size, last: [...set].sort().at(-1), byMember: {} });
  }
  for (const [key, set] of memberDays) {
    const [recipeId, memberId] = key.split("\u0000");
    out.get(recipeId).byMember[memberId] = set.size;
  }
  return out;
}

/** One recipe's cook stats, or null when it was never cooked. */
export function recipeCooks(cooks, recipeId) {
  return cookStats(cooks).get(recipeId) ?? null;
}

/** A recipe without minutes sorts by its time class, as about this long. */
export const TIME_CLASS_MINUTES = { fast: 20, normal: 45, elaborate: 90 };

/** Minutes a recipe takes: its own, else its class's, else null. */
export function recipeMinutes(recipe) {
  if (Number.isFinite(recipe.time_minutes) && recipe.time_minutes > 0) return recipe.time_minutes;
  return TIME_CLASS_MINUTES[recipe.time_class] ?? null;
}

/** The orders of the recipe book; "title" (A-Z) is what the book always did. */
export const SORT_MODES = ["title", "stars_best", "stars_worst", "time_short", "time_long", "cooked_most", "cooked_recent", "cooked_oldest", "newest"];

/**
 * Recipes in the chosen order, as a new array. Recipes with no value for the
 * order (unrated, no time, never cooked) come last in both directions; ties
 * fall back to the title. `stars` is starsByRecipe(...), `cooks` is
 * cookStats(...); `compare` compares two titles.
 */
export function sortRecipes(recipes, mode, { stars = new Map(), cooks = new Map(), compare = (a, b) => a.localeCompare(b) } = {}) {
  const byTitle = (a, b) => compare(a.title, b.title);
  // [value or null, direction]: 1 = bigger first, -1 = smaller first.
  const keys = {
    stars_best: [(r) => stars.get(r.id)?.average ?? null, 1],
    stars_worst: [(r) => stars.get(r.id)?.average ?? null, -1],
    time_short: [recipeMinutes, -1],
    time_long: [recipeMinutes, 1],
    cooked_most: [(r) => cooks.get(r.id)?.total ?? null, 1],
    cooked_recent: [(r) => cooks.get(r.id)?.last ?? null, 1],
    cooked_oldest: [(r) => cooks.get(r.id)?.last ?? null, -1],
    newest: [(r) => r.created_at ?? null, 1],
  }[mode];
  if (!keys) return [...recipes].sort(byTitle);
  const [valueOf, dir] = keys;
  return [...recipes].sort((a, b) => {
    const x = valueOf(a);
    const y = valueOf(b);
    if (x === null && y === null) return byTitle(a, b);
    if (x === null) return 1;
    if (y === null) return -1;
    if (x === y) return byTitle(a, b);
    return (x < y ? 1 : -1) * dir;
  });
}
