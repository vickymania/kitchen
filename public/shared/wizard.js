// "What shall I eat": three recipes from the household's own book, picked from
// five answers (28-10-2026): which meal first, then the four others. A pure function, so the phone and the
// tests run exactly the same ranking.
//
// 1. Hard filters from the answers. An answer of null means "don't mind".
//    A recipe without that label passes only "don't mind"; carbs come from
//    the recipe's nutrition per serving, and unknown carbs pass only "don't
//    mind" too.
// 2. Scores: days since it was last cooked, the share of its main ingredients
//    that are probably in the house (bought in the last week, or on the list),
//    main ingredients in this week's bonus, and the household's stars.
// 3. A little chance on top, so the same three do not always come up.
//
// Ideas (only a title) may be proposed; they are marked as an idea. Nothing
// from the bonus is ever an excluded thing (public/shared/excluded.js).
import { nameKey } from "./ingredients.js";
import { isExcluded } from "./excluded.js";
import { daysBetween } from "./intervals.js";
import { MEALS } from "./labels.js";
import { sameThing, useUpSoon, liveRows, rowKey } from "./pantry.js";
import { starsByRecipe, starsPart } from "./recipe-ratings.js";

export const QUESTIONS = ["meal", "cuisine", "time", "main", "carbs"];

/** Before this hour breakfast fits best, before the next one lunch, after that dinner. */
export const MEAL_HOURS = { breakfast: 11, lunch: 16 };

/**
 * The meals in the order the wizard offers them: the one that fits the hour
 * (0-23) first, the others in their usual order. Nothing is preselected.
 */
export function mealsForHour(hour) {
  const now = hour < MEAL_HOURS.breakfast ? "breakfast" : hour < MEAL_HOURS.lunch ? "lunch" : "dinner";
  return [now, ...MEALS.filter((m) => m !== now)];
}

/** Grams of carbohydrate per serving, at most, for "light" and "normal". */
export const CARBS_MAX = { light: 40, normal: 75 };

/** How long ago a purchase still counts as "in the house". */
export const IN_HOUSE_DAYS = 7;

// use_up (phase 4): a main ingredient in the pantry that must be eaten within
// a few days pulls hardest after "not eaten for long", so what would go off
// is cooked first.
// stars (30-10-2026): the household's average stars of a recipe, ten pulls
// up, two push down, six or none is neutral (public/shared/recipe-ratings.js).
export const WEIGHTS = { days: 3, house: 3, bonus: 1.5, use_up: 4, variety: 1.2, stars: 2.5 };

/** From this average up the stars are a reason ("★9"). */
export const STARS_REASON_MIN = 8;

// The cooking time someone has: "fast" allows fast recipes, "normal" fast and
// normal ones, "elaborate" anything.
const TIME_ALLOWS = { fast: ["fast"], normal: ["fast", "normal"] };

// Always in the cupboard; they would make every recipe look "in the house".
const STAPLES = new Set([
  "zout", "peper", "olie", "olijfolie", "zonnebloemolie", "water", "suiker", "bloem", "boter", "azijn",
  "salt", "pepper", "oil", "sugar", "flour", "butter",
]);

export const isIdea = (r) => !(r.ingredients ?? []).some((i) => !i.heading) && !(r.steps ?? []).length;

const words = (key) => key.split(" ").filter(Boolean);

/** The ingredients that make the dish: no headings, nothing optional, no staples, no excluded things. */
export function mainIngredients(recipe) {
  return (recipe.ingredients ?? []).filter((i) => {
    if (i.heading || i.optional) return false;
    const key = nameKey(i.name);
    return key && !words(key).some((w) => STAPLES.has(w)) && !isExcluded(i.name);
  });
}

// sameThing (does an ingredient mean the thing bought?) lives in pantry.js,
// which matches recipes against the pantry the same way.
export { sameThing };

/** A bonus offer names this ingredient: every word of it is part of a word of the offer. */
function inOffer(ingredientKey, offerKey) {
  const ow = words(offerKey);
  const iw = words(ingredientKey).filter((w) => w.length >= 3);
  return iw.length > 0 && iw.every((w) => ow.some((o) => o.includes(w)));
}

/** The newest day each recipe was cooked: { recipe_id: "YYYY-MM-DD" }. */
export function lastCookedDays(cooks) {
  const out = {};
  for (const c of Object.values(cooks ?? {})) {
    if (c.deleted_at) continue;
    if (!out[c.recipe_id] || c.cooked_on > out[c.recipe_id]) out[c.recipe_id] = c.cooked_on;
  }
  return out;
}

/**
 * What is probably in the house: [{ key, name, day, on_list }], newest first.
 * The pantry (phase 4) says it for sure; the recent purchases and ticked
 * lines still count, for what was bought before the pantry existed.
 */
export function inHouse({ purchases = {}, entries = {}, items = {}, pantry = {} }, today) {
  const out = [];
  const recent = (day) => day && day <= today && daysBetween(day, today) <= IN_HOUSE_DAYS;
  const keyOf = (itemId, title) => items[itemId]?.name_key ?? nameKey(title);
  for (const p of Object.values(purchases)) {
    if (p.deleted_at || !recent(p.bought_on)) continue;
    out.push({ key: keyOf(p.item_id, p.title), name: p.title, day: p.bought_on, on_list: false });
  }
  for (const e of Object.values(entries)) {
    if (e.deleted_at) continue;
    if (!e.checked_at) out.push({ key: keyOf(e.item_id, e.title), name: e.title, day: null, on_list: true });
    else if (recent(e.checked_at.slice(0, 10))) {
      out.push({ key: keyOf(e.item_id, e.title), name: e.title, day: e.checked_at.slice(0, 10), on_list: false });
    }
  }
  for (const r of liveRows(pantry)) out.push({ key: rowKey(r, items), name: r.title, day: r.added_on, on_list: false });
  // Bought beats "on the list"; the newest purchase is the one to mention.
  return out.sort((a, b) => (a.on_list - b.on_list) || String(b.day).localeCompare(String(a.day)));
}

/** This week's offers that may be mentioned: valid today, never an excluded thing. */
export function usableBonus(bonus, today) {
  return (bonus ?? []).filter((b) => b?.name && !isExcluded(b.name) && (!b.until || b.until >= today))
    .map((b) => ({ ...b, key: nameKey(b.name) }));
}

export function passes(recipe, answers) {
  const a = answers ?? {};
  if (a.meal && !(recipe.meals ?? []).includes(a.meal)) return false;
  if (a.cuisine && recipe.cuisine !== a.cuisine) return false;
  if (a.main && recipe.main_ingredient !== a.main) return false;
  if (a.time && TIME_ALLOWS[a.time] && !TIME_ALLOWS[a.time].includes(recipe.time_class)) return false;
  if (a.carbs && CARBS_MAX[a.carbs] !== undefined) {
    const carbs = recipe.nutrition?.carbs_g;
    if (carbs === null || carbs === undefined || carbs > CARBS_MAX[a.carbs]) return false;
  }
  return true;
}

/**
 * How many live recipes each value of question `key` leaves, given the
 * answers to the questions before it. The screen shows only values above 0,
 * so every path of answers ends in at least one recipe (28-10-2026).
 * Returns { value: count }.
 */
export function optionCounts(recipes, answers, key, values) {
  const before = {};
  for (const q of QUESTIONS.slice(0, QUESTIONS.indexOf(key))) before[q] = answers?.[q] ?? null;
  const live = Object.values(recipes ?? {}).filter((r) => !r.deleted_at && passes(r, before));
  return Object.fromEntries(values.map((v) => [v, live.filter((r) => passes(r, { ...before, [key]: v })).length]));
}

/**
 * Score one recipe. Returns { score, reasons } where reasons are
 * { key, vars, weight }, the strongest first; key is an i18n key under
 * "wizard.reason".
 */
export function scoreRecipe(recipe, { lastCooked, house, bonus, today, useUp = [], stars = new Map() }) {
  const reasons = [];
  let score = 0;

  const rated = stars.get(recipe.id);
  if (rated) {
    const part = starsPart(rated.average);
    score += WEIGHTS.stars * part;
    if (rated.average >= STARS_REASON_MIN) reasons.push({ key: "stars", vars: { stars: rated.average, n: rated.count }, weight: WEIGHTS.stars * part });
  }

  const last = lastCooked[recipe.id];
  if (last) {
    const days = Math.max(0, daysBetween(last, today));
    // Just eaten: pushed back hard. After two months it counts as long ago.
    const part = days < 3 ? -1 : Math.min(days, 60) / 60;
    score += WEIGHTS.days * part;
    if (days >= 14) reasons.push({ key: "not_eaten", vars: { n: days }, weight: WEIGHTS.days * part });
  } else {
    // Never cooked since tracking began: neither pushed nor pulled much.
    score += WEIGHTS.days * 0.5;
  }

  const mains = mainIngredients(recipe);
  if (mains.length) {
    const hits = mains.map((i) => ({ ing: i, got: house.find((h) => sameThing(nameKey(i.name), h.key)) })).filter((x) => x.got);
    if (hits.length) {
      const part = hits.length / mains.length;
      score += WEIGHTS.house * part;
      const best = hits.find((x) => !x.got.on_list) ?? hits[0];
      reasons.push(best.got.on_list
        ? { key: "on_list", vars: { name: best.ing.name }, weight: WEIGHTS.house * part }
        : { key: "in_house", vars: { name: best.ing.name, day: best.got.day }, weight: WEIGHTS.house * part });
    }
    // The pantry thing closest to its date decides: today or past counts
    // fully, three days away a half.
    const soon = mains.map((i) => ({ ing: i, row: useUp.find((u) => sameThing(nameKey(i.name), u.key) || sameThing(u.key, nameKey(i.name))) }))
      .filter((x) => x.row).sort((a, b) => a.row.days - b.row.days)[0];
    if (soon) {
      const part = soon.row.days <= 1 ? 1 : soon.row.days === 2 ? 0.75 : 0.5;
      score += WEIGHTS.use_up * part;
      reasons.push({ key: "use_up", vars: { name: soon.ing.name, days: soon.row.days }, weight: WEIGHTS.use_up * part });
      // "Kipfilet moet op" already says it is in the house: name another one, or none.
      const dup = reasons.findIndex((r) => r.key === "in_house" && r.vars.name === soon.ing.name);
      if (dup >= 0) {
        const other = hits.find((x) => x.ing !== soon.ing && !x.got.on_list);
        if (other) reasons[dup] = { ...reasons[dup], vars: { name: other.ing.name, day: other.got.day } };
        else reasons.splice(dup, 1);
      }
    }
    const offer = mains.find((i) => bonus.some((b) => inOffer(nameKey(i.name), b.key)));
    if (offer) {
      score += WEIGHTS.bonus;
      reasons.push({ key: "bonus", vars: { name: offer.name }, weight: WEIGHTS.bonus });
    }
  }
  reasons.sort((a, b) => b.weight - a.weight);
  return { score, reasons };
}

/**
 * The proposals. data: { recipes, cooks, purchases, entries, items, pantry, recipe_ratings } (the
 * synced view), answers: { meal, cuisine, time, main, carbs } (null = don't mind),
 * bonus: [{ name, category, until }] or [], today: "YYYY-MM-DD", random: a
 * function like Math.random, exclude: ids already shown.
 * Returns [{ recipe, score, reasons, idea }].
 */
export function propose({ data, answers = {}, bonus = [], today, random = Math.random, count = 3, exclude = [] }) {
  const ctx = {
    today,
    lastCooked: lastCookedDays(data.cooks),
    house: inHouse(data, today),
    bonus: usableBonus(bonus, today),
    useUp: useUpSoon(data.pantry, today, data.items),
    stars: starsByRecipe(data.recipe_ratings),
  };
  const skip = new Set(exclude);
  return Object.values(data.recipes ?? {})
    .filter((r) => !r.deleted_at && !skip.has(r.id) && passes(r, answers))
    .map((r) => {
      const { score, reasons } = scoreRecipe(r, ctx);
      return { recipe: r, score: score + WEIGHTS.variety * random(), reasons: reasons.slice(0, 2), idea: isIdea(r) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, count);
}
