// Labelling one recipe with Claude for the "what shall I eat" wizard: cuisine,
// main ingredient, how long it takes and which meals it is for, from the fixed vocabulary in
// public/shared/labels.js. The answer is written as an ordinary recipe.put op
// (labels_by: "claude"), so the phones get it through the delta sync and the
// op engine's rule holds: labels a person set are never overwritten.
//
// Called by the app after a new recipe is saved, and once for every recipe by
// tools/label_recipes.mjs. Each call is a paid call (about a cent).
import { CUISINES, MAIN_INGREDIENTS, TIME_CLASSES, MEALS, timeClassOf, sortMeals } from "../public/shared/labels.js";
import { fromRow, applyOps } from "./ops-store.js";
import { askClaude, takeOne } from "./claude.js";
import { needsTranslation, recipeLang, otherLang, recipeFingerprint, TRANSLATION_SCHEMA, translateInstruction } from "../public/shared/bilingual.js";

export const LABEL_DAILY_LIMIT = 100;   // labellings per household per day; the one-time pass is ~60
export const GUEST_LABEL_DAILY_LIMIT = 20;    // per recipes-only person per day

const MEALS_PROPERTY = {
  type: "array",
  items: { type: "string", enum: MEALS },
  description: "Which meals this dish is eaten at, one or more: breakfast, lunch, dinner, snack, dessert. A hot main course is dinner; pancakes can be breakfast and lunch; something small between meals (nachos, a sausage roll) is a snack; something sweet after dinner is dessert",
};

export const LABEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["cuisine", "main_ingredient", "time_class", "time_minutes", "meals"],
  properties: {
    cuisine: { type: "string", enum: CUISINES, description: "The kitchen this dish comes from; \"other\" when none fits" },
    main_ingredient: { type: "string", enum: MAIN_INGREDIENTS,
      description: "What the dish is built around: the protein, or pasta/rice/noodles/potato when that is the base of a dish without meat or fish; \"vegetarian\" for a vegetable dish" },
    time_class: { type: "string", enum: TIME_CLASSES, description: "fast: under 30 minutes in total; normal: 30 to 75 minutes; elaborate: longer, or a lot of work" },
    time_minutes: { type: "integer", description: "Your estimate of the total time in minutes, from start to the table" },
    meals: MEALS_PROPERTY,
  },
};

/** For `only: "meals"`: the recipes labelled before meals existed. */
export const MEALS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["meals"],
  properties: { meals: MEALS_PROPERTY },
};

const PROMPT = [
  "Label this home recipe for a \"what shall I eat\" picker. Recipes are mostly Dutch.",
  "Pick each label from the allowed values only. When the recipe is only a title, label it from the title.",
  "Count oven or simmering time in time_minutes.",
].join("\n");

function recipeText(r, { notes = false } = {}) {
  const ings = (r.ingredients ?? []).map((i) => (i.heading ? `${i.name}:` : i.raw || i.name)).slice(0, 80);
  const steps = (r.steps ?? []).slice(0, 40).map((s, i) => `${i + 1}. ${s}`);
  return [
    `Title: ${r.title}`,
    r.servings ? `Servings: ${r.servings}` : null,
    ings.length ? `Ingredients:\n${ings.join("\n")}` : "Ingredients: (none written down)",
    steps.length ? `Steps:\n${steps.join("\n")}` : "Steps: (none written down)",
    notes && r.notes ? `Notes:\n${r.notes}` : null,
  ].filter(Boolean).join("\n\n").slice(0, notes ? 16000 : 12000);
}

/**
 * The labels and, in the same call, the recipe's translation (0029: a new
 * recipe's one Sonnet call brings both; Thomas, 30-10-2026: never a second
 * call where one already happens).
 */
export const LABEL_TRANSLATE_SCHEMA = {
  ...LABEL_SCHEMA,
  required: [...LABEL_SCHEMA.required, "translation"],
  properties: { ...LABEL_SCHEMA.properties, translation: TRANSLATION_SCHEMA },
};

/** Claude's meals, checked against the vocabulary: the fixed order, or null. */
export function mealsOf(answer) {
  return Array.isArray(answer?.meals) ? sortMeals(answer.meals.filter((m) => MEALS.includes(m))) : null;
}

/** Claude's answer for `only: "meals"`, as a recipe.put patch, or null. */
export function mealsPatch(answer) {
  const meals = mealsOf(answer);
  return meals ? { meals, labels_by: "claude" } : null;
}

/** Claude's answer, checked against the vocabulary, as a recipe.put patch. */
export function labelPatch(answer) {
  const pick = (list, v) => (list.includes(v) ? v : null);
  const minutes = Number.isFinite(Number(answer?.time_minutes)) && Number(answer.time_minutes) > 0
    ? Math.min(1440, Math.round(Number(answer.time_minutes))) : null;
  const patch = {
    cuisine: pick(CUISINES, answer?.cuisine),
    main_ingredient: pick(MAIN_INGREDIENTS, answer?.main_ingredient),
    time_class: pick(TIME_CLASSES, answer?.time_class) ?? timeClassOf(minutes),
    time_minutes: minutes,
    meals: mealsOf(answer),
    labels_by: "claude",
  };
  return patch.cuisine || patch.main_ingredient || patch.time_class || patch.meals ? patch : null;
}

/**
 * body: { id, again?: true, only?: "meals" }. A recipe that Claude labelled
 * before is not sent again unless `again` is set; one a person labelled never
 * is. With `only: "meals"` Claude fills just the meals, and only while they
 * are empty, also on a person's recipe; nothing else is touched.
 */
export async function labelRecipe(env, who, body) {
  if (!env.ANTHROPIC_API_KEY) return { status: 503, error: "labels_off" };
  const id = typeof body?.id === "string" ? body.id : "";
  const row = id && await env.DB.prepare("SELECT * FROM recipes WHERE id = ? AND household_id = ? AND deleted_at IS NULL")
    .bind(id, who.householdId).first();
  if (!row) return { status: 404, error: "not_found" };
  const recipe = fromRow("recipes", row);
  const onlyMeals = body?.only === "meals";
  if (body?.only !== undefined && !onlyMeals) return { status: 400, error: "bad_field" };
  if (onlyMeals) {
    if (recipe.meals?.length) return { labels: null, skipped: "labelled" };
  } else {
    if (recipe.labels_by === "person") return { status: 409, error: "labels_by_person" };
    if (recipe.labels_by === "claude" && !body.again) return { labels: null, skipped: "labelled" };
  }
  // A recipes-only person counts on his own, per member, never the household's.
  const took = who.recipesOnly
    ? await takeOne(env, "label_guest", who.memberId, GUEST_LABEL_DAILY_LIMIT)
    : await takeOne(env, "label", who.householdId, LABEL_DAILY_LIMIT);
  if (!took) return { status: 429, error: "too_many_labels" };

  // No translation yet (or one of another version): it comes in this call too.
  const translate = !onlyMeals && needsTranslation(recipe);
  const to = otherLang(recipeLang(recipe));
  const out = await askClaude(env, {
    what: "recipe label",
    schema: onlyMeals ? MEALS_SCHEMA : translate ? LABEL_TRANSLATE_SCHEMA : LABEL_SCHEMA,
    maxTokens: translate ? 8000 : 1000,
    content: [{ type: "text", text: translate
      ? `${PROMPT}\n${translateInstruction(to)}\n\n${recipeText(recipe, { notes: true })}`
      : `${PROMPT}\n\n${recipeText(recipe)}` }],
  });
  if (out.failed === "rate_limited") return { status: 429, error: "too_many_labels" };
  if (out.failed) return { status: 502, error: "label_failed" };
  const patch = onlyMeals ? mealsPatch(out.answer) : labelPatch(out.answer);
  if (!patch) return { status: 502, error: "label_failed" };

  // Through the op engine like any change: if a person set labels (or, for
  // meals only, the meals) in the meantime, it refuses (labels_by_person) and
  // nothing is written.
  const opId = `label-${crypto.randomUUID()}`;
  const tr = translate ? out.answer?.translation : null;
  // The translation of the version that was sent: an edit made meanwhile keeps it stale.
  const translation = tr && typeof tr === "object" && typeof tr.title === "string" && tr.title.trim()
    ? [{ type: "recipe.translate", op_id: `tr-${crypto.randomUUID()}`, id, translation: { ...tr, lang: to, of: recipeFingerprint(recipe), by: "claude" } }]
    : [];
  const [result, translated] = await applyOps(env.DB, who, [{ type: "recipe.put", op_id: opId, id, recipe: patch }, ...translation]);
  if (!result.ok) return { status: result.error === "labels_by_person" ? 409 : 400, error: result.error };
  return { labels: patch, translated: Boolean(translated?.ok) };
}
