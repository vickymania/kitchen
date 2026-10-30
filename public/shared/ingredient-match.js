// Which household item a recipe's ingredient line means (30-10-2026:
// a recipe imported by Claude barely touched the pantry: "wit patentbloem"
// was not Bloem, "half-om-halfgehakt" not Gehakt, "ei, losgeklopt" not
// Eieren). One resolver for the pantry's cooking (cookPlan, so cookTakes,
// cookPending and listCover), the "Op de lijst" sheet, the MCP
// kitchen_recipe_to_list and "product voor dit recept".
//
// Pure and deterministic. The candidate names of an ingredient, most specific
// first; the first one the household knows wins:
//   exact      the name with its preparation taken off ("melk, lauwwarm" is
//              "melk"), as an item, an alias or the same without spaces (findItem)
//   same       its canonical name (SAME in item-names.js: "ei" is "Eieren")
//   number     the last word singular or plural ("beschuiten" -> "beschuit")
//   plain      without words that do not change the product (FREE: "wit",
//              "gemalen", "instant", "verse", "grote"...)
//   compound   an explicit variety of a product (VARIETIES: "half-om-half-",
//              "runder-" and "varkensgehakt" are gehakt, "patentbloem" is bloem)
//   general    without a fat word (MODIFIERS: "volle melk" is "melk" when the
//              household has no "Volle melk")
// Never a typo-fuzzy match, never a word added ("melk" never becomes "Volle
// melk"), never a colour dropped ("rode ui" is not Uien, "rode peper" is no
// pepper). A name the household does not know resolves to null.
import { nameKey, splitPrep } from "./ingredients.js";
import { canonicalName, GENERIC } from "./item-names.js";
import { findItem } from "./item-find.js";

/** Words that never change which product is meant. "witte" is a colour (witte bonen) and stays; "wit" is flour or bread. */
export const FREE = new Set([
  "wit", "gemalen", "instant", "vers", "verse", "groot", "grote", "klein", "kleine", "middelgrote", "flinke",
  "biologisch", "biologische", "bio", "fijne", "grove", "extra", "vierge", "gedroogd", "gedroogde",
  "ongezouten", "zacht", "zachte", "koud", "koude", "warm", "warme", "lauwwarm", "lauwwarme", "hele", "heel",
  "rijpe", "rijp", "losse", "fresh", "ground", "large", "small", "medium",
]);

/** Words that do change the product, dropped only when the household has nothing more specific. */
export const MODIFIERS = new Set(["volle", "halfvolle", "magere"]);

/**
 * Compound names that are a variety of one product, as [prefix, product]
 * (no spaces, nameKey form). Explicit on purpose: "in the name" is not "the
 * same thing" (kokosmelk is no melk, pindakaas no kaas, sojasaus no saus).
 */
export const VARIETIES = [
  ["halfomhalf", "gehakt"], ["runder", "gehakt"], ["rund", "gehakt"], ["varkens", "gehakt"], ["kalfs", "gehakt"],
  ["patent", "bloem"], ["tarwe", "bloem"],
  ["zee", "zout"], ["keuken", "zout"], ["tafel", "zout"],
  ["kristal", "suiker"],
  ["scharrel", "eieren"], ["scharrel", "ei"],
];

const VOWELS = /[aeiou]/;

/** The last word singular and plural, Dutch and English: beschuiten -> beschuit, kip -> kippen, tomaat -> tomaten. */
export function numberForms(word) {
  const w = String(word ?? "");
  if (w.length < 2) return [];
  // Two letters only take a plural: "ui" -> "uien".
  if (w.length === 2) return VOWELS.test(w) ? [`${w}en`] : [];
  const out = [];
  if (w.endsWith("en") && w.length >= 5) {
    const stem = w.slice(0, -2);
    out.push(stem);
    if (/([^aeiou])\1$/.test(stem)) out.push(stem.slice(0, -1));             // kippen -> kip
    const m = stem.match(/^(.*[^aeiou])([aeiou])([^aeiou])$/);
    if (m) out.push(`${m[1]}${m[2]}${m[2]}${m[3]}`);                        // tomaten -> tomaat, bonen -> boon
  } else if (w.endsWith("s") && !w.endsWith("ss") && w.length >= 4) {
    out.push(w.slice(0, -1));                                                // champignons -> champignon
  } else {
    out.push(`${w}en`, `${w}s`);
    const doubled = w.match(/^(.*[^aeiou])([aeiou])([^aeiouwy])$/);
    if (doubled) out.push(`${w}${doubled[3]}en`);                            // kip -> kippen
    const long = w.match(/^(.*)([aeiou])\2([^aeiou])$/);
    if (long) out.push(`${long[1]}${long[2]}${long[3]}en`);                  // tomaat -> tomaten
  }
  return out.filter((x) => x.length >= 2 && VOWELS.test(x));
}

/** The name of an ingredient without how it is prepared, as a key: "melk, lauwwarm" -> "melk". */
export function ingredientKey(name) {
  return nameKey(splitPrep(name).name);
}

const dropWords = (key, set) => key.split(" ").filter((w) => !set.has(w)).join(" ");

function varietyOf(key) {
  const compact = key.replace(/ /g, "");
  for (const [prefix, product] of VARIETIES) {
    if (compact.startsWith(prefix) && compact.slice(prefix.length) === product) return product;
  }
  // The variety as the last word of a longer name: "biologisch rundergehakt".
  const words = key.split(" ");
  if (words.length > 1) {
    const last = varietyOf(words.at(-1));
    if (last) return [...words.slice(0, -1), last].join(" ");
  }
  return null;
}

/**
 * Every name an ingredient could mean, most specific first: [{ key, how }].
 * "X of Y" is each alternative in turn. Keys are nameKey form, without
 * duplicates and without GENERIC lines ("vlees" is no product).
 */
export function matchKeys(name) {
  const out = [];
  const seen = new Set();
  const push = (key, how) => {
    const k = String(key ?? "").replace(/\s+/g, " ").trim();
    if (!k || seen.has(k) || GENERIC.has(k)) return;
    seen.add(k);
    out.push({ key: k, how });
    const same = canonicalName(k).key;
    if (same !== k && !seen.has(same)) {
      seen.add(same);
      out.push({ key: same, how: how === "exact" ? "same" : how });
    }
  };
  const withNumber = (key, how) => {
    push(key, how);
    const words = key.split(" ");
    // "mango's" is "mango s" as a key.
    if (words.length > 1 && words.at(-1) === "s") push(words.slice(0, -1).join(" "), "number");
    for (const form of numberForms(words.at(-1))) push([...words.slice(0, -1), form].join(" "), how === "exact" ? "number" : how);
  };
  const base = ingredientKey(name);
  const alternatives = base.includes(" of ") ? base.split(" of ").map((x) => x.trim()).filter(Boolean) : [base];
  for (const alt of alternatives) {
    withNumber(alt, "exact");
    const plain = dropWords(alt, FREE);
    if (plain && plain !== alt) withNumber(plain, "plain");
    for (const k of [alt, plain]) {
      const v = k && varietyOf(k);
      if (v) withNumber(v, "compound");
    }
    const general = plain && dropWords(plain, MODIFIERS);
    if (general && general !== plain) {
      withNumber(general, "general");
      const v = varietyOf(general);
      if (v) withNumber(v, "compound");
    }
  }
  return out;
}

/**
 * The first candidate of `name` that `find(key)` knows: { target, key, how }
 * or null. `find` is a function key -> anything truthy (an item, a group of
 * pantry rows).
 */
export function resolveName(name, find) {
  for (const { key, how } of matchKeys(name)) {
    const target = find(key);
    if (target) return { target, key, how };
  }
  return null;
}

/** key -> the household's live item for it (findItem: name, alias, merged name, without spaces), memoised for one pass. */
export function itemFinder(data) {
  // A view without keys (a hand-made one) gets them from the names.
  const raw = data?.items ?? {};
  const keyed = Object.values(raw).every((i) => !i || typeof i.name_key === "string");
  const items = keyed ? raw : Object.fromEntries(Object.entries(raw).filter(([, i]) => i)
    .map(([id, i]) => [id, typeof i.name_key === "string" ? i : { ...i, name_key: nameKey(i.name) }]));
  const aliases = Object.fromEntries(Object.entries(data?.aliases ?? {}).filter(([, a]) => a && typeof a.name_key === "string"));
  const state = { items, aliases };
  const memo = new Map();
  return (key) => {
    if (!memo.has(key)) memo.set(key, findItem(state, key));
    return memo.get(key);
  };
}

/** The item an ingredient means in `data` ({ items, aliases }), or null. */
export function resolveIngredient(name, data, find = itemFinder(data)) {
  const hit = resolveName(name, find);
  return hit ? { item: hit.target, key: hit.key, how: hit.how } : null;
}

// Salt and pepper and the like: a line of only these is split, never one item "zout en peper".
const BASIC_PARTS = /^(?:(?:grof |fijn |zee|keuken)?zout|(?:zwarte |witte |verse )?peper(?: uit de molen)?|olie|olijfolie|suiker)$/;

/**
 * What an ingredient line puts on the list: [{ item, title }] with the
 * household's item when it has one (title its name) and else the name
 * without its preparation. "zout en peper" and "olie, peper en zout" are one
 * line per thing when every part is an item or a cooking basic; anything
 * else is one line.
 */
export function listTargets(name, data, find = itemFinder(data)) {
  const one = (text) => {
    const r = resolveIngredient(text, data, find);
    return r ? { item: r.item, title: r.item.name } : { item: null, title: splitPrep(text).name || String(text ?? "") };
  };
  const whole = resolveIngredient(name, data, find);
  if (whole) return [{ item: whole.item, title: whole.item.name }];
  const parts = splitPrep(name).name.split(/\s*,\s*|\s+(?:en|and|&)\s+/i).map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1 && parts.every((p) => resolveIngredient(p, data, find) || BASIC_PARTS.test(ingredientKey(p)))) {
    const out = [];
    for (const t of parts.map(one)) if (!out.some((x) => (x.item && x.item === t.item) || nameKey(x.title) === nameKey(t.title))) out.push(t);
    return out;
  }
  return [one(name)];
}
