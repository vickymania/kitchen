// Both languages in the data (30-10-2026): an item has a Dutch name
// and an English one (items.name_en); a recipe is written in one language
// (recipes.lang) and carries a translation into the other (recipes.translation).
// The screens, the widget and the MCP server pick by the member's language;
// matching, cooking and the pantry always read the Dutch item names and the
// recipe's original ingredients.
import { nameKey } from "./ingredients.js";
import { parseRecipeText } from "./recipe-text.js";

export const LANGS = ["nl", "en"];
export const otherLang = (lang) => (lang === "en" ? "nl" : "en");
export const NAME_EN_SOURCES = ["claude", "person"];
export const NAME_EN_RANK = { claude: 1, person: 2 };
export const TRANSLATION_BY = ["claude", "person"];

// ---------------------------------------------------------------- items

/** An item's name in `lang`: its English name in English when it has one, else its Dutch name. */
export function itemLabel(item, lang) {
  if (!item) return "";
  return lang === "en" && item.name_en ? item.name_en : item.name;
}

const NAMES = new WeakMap();

/** name_key -> English name of every live item that has one, per items object. */
function englishNames(items) {
  if (!items) return new Map();
  // Per items object (the phone's view is a new object on every change) and its row count.
  const hit = NAMES.get(items);
  const size = Object.keys(items).length;
  if (hit && hit.rows === size) return hit.names;
  const names = new Map();
  for (const i of Object.values(items)) if (!i.deleted_at && i.name_en) names.set(i.name_key, i.name_en);
  NAMES.set(items, { rows: size, names });
  return names;
}

/**
 * A Dutch item name as shown in `lang`: in English the English name of the
 * item with that key, else the name as it is. Works for any row that shows an
 * item's name (a list line's title, a pantry row, "Bijna op", "Weer nodig").
 */
export function localName(view, lang, name) {
  if (lang !== "en" || !name) return name;
  return englishNames(view?.items).get(nameKey(name)) ?? name;
}

// ---------------------------------------------------------------- recipes

const NL_WORDS = new Set(["de", "het", "een", "en", "met", "van", "voor", "op", "tot", "minuten", "snijd", "bak", "voeg", "toe", "doe", "laat", "eetlepel", "theelepel", "el", "tl", "ui", "uien", "knoflook", "zout", "peper", "boter", "pan", "oven", "gram", "teentjes", "teen", "ongeveer", "erin", "in", "aan", "dan", "ook", "nog", "goed", "warm", "roer", "kook", "over", "uit", "per"]);
const EN_WORDS = new Set(["the", "and", "with", "of", "for", "to", "until", "minutes", "cut", "chop", "add", "stir", "cook", "into", "tbsp", "tsp", "cup", "cups", "tablespoon", "teaspoon", "onion", "onions", "garlic", "salt", "pepper", "butter", "pan", "heat", "about", "then", "it", "a", "is", "on", "over", "until", "serve", "minced", "sliced", "chopped", "pound", "ounces", "oz", "lb", "large", "small"]);

/** 'nl' or 'en': which of the two the recipe's words are mostly in. Dutch on a tie (most of the book is Dutch). */
export function detectLang(r) {
  const text = [r?.title, ...(r?.ingredients ?? []).map((i) => i?.raw || i?.name), ...(r?.steps ?? []), r?.notes].filter(Boolean).join(" ");
  let nl = 0;
  let en = 0;
  for (const w of text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z]+/)) {
    if (NL_WORDS.has(w)) nl++;
    if (EN_WORDS.has(w)) en++;
  }
  return en > nl ? "en" : "nl";
}

/** The language a recipe is written in: its own `lang`, else detected from its text. */
export function recipeLang(r) {
  return LANGS.includes(r?.lang) ? r.lang : detectLang(r);
}

/** The ingredient lines as written: a heading as "Saus:", a line as its raw text. */
export function ingredientLines(r) {
  return (r?.ingredients ?? []).map((i) => (i.heading ? `${i.name}:` : i.raw || [i.name, i.note].filter(Boolean).join(", ")));
}

/**
 * A short fingerprint of what a translation translates (title, ingredient
 * lines, steps, notes): a translation made of another version is stale.
 * FNV-1a, 32 bits, hex; the same on the phone, the worker and the tools.
 */
export function recipeFingerprint(r) {
  const s = JSON.stringify([String(r?.title ?? "").trim(), ingredientLines(r), r?.steps ?? [], String(r?.notes ?? "").trim()]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Does the recipe need a (new) translation: none, or one of another version or language. */
export function needsTranslation(r) {
  if (!r || r.deleted_at || !String(r.title ?? "").trim()) return false;
  const tr = r.translation;
  return !tr || tr.lang !== otherLang(recipeLang(r)) || tr.of !== recipeFingerprint(r);
}

/** The translation when it is of this version of the recipe, else null (stale or none). */
export function freshTranslation(r) {
  const tr = r?.translation;
  if (!tr || typeof tr !== "object" || tr.lang !== otherLang(recipeLang(r))) return null;
  return tr.of === recipeFingerprint(r) ? tr : null;
}

/**
 * The recipe as shown in `lang`: the translation when it is fresh and in
 * that language (`translated: true`), its ingredient lines parsed again for
 * display; else the original. `original: true` forces the original. Id,
 * servings, photo and labels stay the original's; cooking and the list read
 * the original object, never this one.
 */
export function shownRecipe(r, lang, { original = false } = {}) {
  if (!r) return { recipe: r, translated: false, stale: false, canToggle: false };
  const own = recipeLang(r);
  if (lang === own) return { recipe: r, translated: false, stale: false, canToggle: false };
  const tr = freshTranslation(r);
  const stale = Boolean(r.translation) && !tr;
  if (!tr) return { recipe: r, translated: false, stale, canToggle: false };
  if (original) return { recipe: r, translated: false, stale: false, canToggle: true };
  const parsed = parseRecipeText((tr.ingredients ?? []).join("\n")).ingredients;
  return {
    recipe: { ...r, title: tr.title || r.title, ingredients: parsed, steps: tr.steps?.length ? tr.steps : r.steps, notes: tr.notes ?? "" },
    translated: true, stale: false, canToggle: true,
  };
}

const str = (v, max) => (typeof v === "string" ? v.replace(/\r/g, "").trim().slice(0, max) : null);

/**
 * A translation as the op engine stores it, or null when it is not one:
 * { lang, title, ingredients: [lines], steps, notes, of, by }. `recipe` is the
 * original (its language and fingerprint).
 */
export function cleanTranslation(v, recipe) {
  if (!v || typeof v !== "object") return null;
  const lang = otherLang(recipeLang(recipe));
  if (v.lang !== undefined && v.lang !== lang) return null;
  const title = str(v.title, 200);
  if (!title) return null;
  const list = (x, max, n) => (Array.isArray(x) ? x.slice(0, n).map((s) => str(s, max)).filter(Boolean) : []);
  const of = typeof v.of === "string" && /^[0-9a-f]{8}$/.test(v.of) ? v.of : recipeFingerprint(recipe);
  return {
    lang, title,
    ingredients: list(v.ingredients, 300, 200),
    steps: list(v.steps, 2000, 200),
    notes: str(v.notes, 20000) ?? "",
    of,
    by: TRANSLATION_BY.includes(v.by) ? v.by : "person",
  };
}

/** The JSON schema of a translation inside a Claude answer (the import, the labeller, the worker). */
export const TRANSLATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "ingredients", "steps", "notes"],
  properties: {
    title: { type: "string" },
    ingredients: { type: "array", items: { type: "string" }, description: "Every ingredient line translated, in the same order; a heading keeps its colon; amounts and units as a cook in that language writes them" },
    steps: { type: "array", items: { type: "string" }, description: "Every step translated, the same number of steps in the same order" },
    notes: { type: "string", description: "The notes translated, empty when there are none" },
  },
};

/** One line for Claude: what to translate into. */
export const translateInstruction = (lang) =>
  `Also give "translation": the whole recipe (title, every ingredient line, every step, the notes) translated into ${lang === "en" ? "English" : "Dutch"}, natural kitchen ${lang === "en" ? "English" : "Dutch"}, nothing added or left out.`;
