// Default portions and default pack sizes for the pantry (28-10-2026:
// "ook de dingen 'met rust' moeten automatisch gaan, wat is anders het doel
// van voorraadbeheer?"). Pure data plus two lookups, no imports. Keys are
// nameKey() of an ingredient or pantry name (public/shared/ingredients.js).
//
// Two tables:
//   - PORTIONS: what one cook takes of a thing written without an amount
//     ("Ketchup", "Italiaanse kruiden", "olie naar smaak"), per category, and
//     how much a teaspoon of it is. Conservative on purpose: a recipe takes
//     a little, never a whole bottle. Salt and pepper are a pinch: ignored.
//   - PACK_DEFAULTS: the size of one pack when neither the pantry row nor the
//     household's own products say it (a pasta row without a pack size is a
//     500 g bag, not "the whole thing").
// cookTakes (public/shared/pantry.js) reads both. Everything taken through a
// default here is an estimate and the cook toast says "(schatting)".

const has = (key, words) => key.split(" ").some((w) => words.includes(w));
const ends = (key, tails) => key.split(" ").some((w) => tails.some((t) => w.endsWith(t)));

/**
 * The categories, first match wins. Each one:
 *   id       the category's name
 *   test     (key) -> boolean
 *   ignore   true: never taken off (salt and pepper are a pinch)
 *   portion  { qty, unit } one cook takes when the recipe gives no amount
 *            (scaled by servings cooked vs the recipe's servings)
 *   tsp      [qty, base] one teaspoon of it ("g" or "ml"); a tablespoon is three
 *   packs    [[test, "size"], ...] the default pack by kind, the last one the fallback
 */
export const PORTIONS = [
  {
    id: "salt_pepper",
    // "1 rode peper" is a fresh chili, not pepper from the mill.
    test: (k) => /^(?:(?:grof |fijn |zee|keuken)?zout|(?:zwarte |witte |verse )?peper(?: uit de molen)?|(?:peper en zout|zout en peper|peper zout))$/.test(k),
    ignore: true,
  },
  {
    id: "oil",
    test: (k) => ends(k, ["olie"]) && !has(k, ["olijven"]),
    portion: { qty: 2, unit: "tbsp" },
    tsp: [5, "ml"],
    packs: [[() => true, "1 l"]],
  },
  {
    id: "butter",
    test: (k) => has(k, ["boter", "roomboter", "margarine", "halvarine", "bakboter"]) || k.includes("bak en braad"),
    portion: { qty: 15, unit: "g" },
    tsp: [5, "g"],
    packs: [[() => true, "250 g"]],
  },
  {
    id: "condiment",
    test: (k) => has(k, ["ketchup", "mayo", "mayonaise", "mayonnaise", "sojasaus", "ketjap", "sambal", "mosterd", "sriracha",
      "tabasco", "worcestershire", "hoisin", "frietsaus", "curry ketchup"]) || ends(k, ["saus", "ketchup", "mayonaise"]) || k.startsWith("sambal"),
    portion: { qty: 2, unit: "tbsp" },
    tsp: [5, "ml"],
    packs: [
      [(k) => has(k, ["ketchup"]) || ends(k, ["ketchup"]), "500 ml"],
      [(k) => has(k, ["mayo", "mayonaise", "mayonnaise", "frietsaus"]) || ends(k, ["mayonaise"]), "500 ml"],
      [() => true, "250 ml"],
    ],
  },
  {
    id: "dried_herbs",
    // Fresh herbs ("verse peterselie", a bunch) are no jar: left alone.
    test: (k) => !has(k, ["vers", "verse", "fresh"]) && (ends(k, ["kruiden"]) || has(k, ["oregano", "tijm", "basilicum",
      "rozemarijn", "peterselie", "dille", "bieslook", "laurier", "laurierblad", "laurierblaadjes", "majoraan", "marjolein",
      "salie", "dragon", "herbes", "herbs"])),
    portion: { qty: 1, unit: "tsp" },
    tsp: [1, "g"],
    packs: [[() => true, "15 g"]],
  },
  {
    id: "spices",
    test: (k) => !has(k, ["vers", "verse"]) && (has(k, ["kerrie", "curry", "komijn", "komijnzaad", "kurkuma", "kaneel",
      "nootmuskaat", "chilivlokken", "chilipoeder", "cayennepeper", "cayenne", "venkelzaad", "korianderzaad", "kardemom",
      "kruidnagel", "piment", "steranijs", "paprikapoeder", "gemberpoeder", "knoflookpoeder", "uienpoeder", "garam",
      "ras", "madras", "gemalen", "spices"]) || (ends(k, ["poeder"]) && !has(k, ["bakpoeder", "cacaopoeder", "puddingpoeder"]))),
    portion: { qty: 1, unit: "tsp" },
    tsp: [2.5, "g"],
    packs: [[() => true, "30 g"]],
  },
];

/**
 * The size of one pack of a staple when nothing else says it, for weighed
 * ingredients ("500 g pasta" against a pasta row without a pack size).
 * [test, size]; first match wins.
 */
export const PACK_DEFAULTS = [
  [(k) => /\b(pasta|spaghetti|macaroni|penne|fusilli|tagliatelle|farfalle|lasagne|lasagnebladen)\b/.test(k) && !/\bvers(e)?\b/.test(k), "500 g"],
  [(k) => /\b(rijst|basmati|basmatirijst|zilvervliesrijst|pandanrijst|risottorijst|jasmijnrijst)\b/.test(k), "1 kg"],
  [(k) => /\b(bloem|tarwebloem|zelfrijzend bakmeel|patentbloem)\b/.test(k), "1 kg"],
  [(k) => /\b(suiker|kristalsuiker|basterdsuiker|rietsuiker|griesmeelsuiker)\b/.test(k) && !/\b(poedersuiker|vanillesuiker|kaneelsuiker)\b/.test(k), "1 kg"],
];

/** The portion category of a key, or null. */
export function portionCategory(key) {
  if (!key) return null;
  return PORTIONS.find((c) => c.test(key)) ?? null;
}

/** The default pack size text of a category for this key ("500 ml"), or null. */
export function categoryPack(category, key) {
  return category?.packs?.find(([test]) => test(key))?.[1] ?? null;
}

/** The default pack size text of a staple ("500 g" for pasta), or null. */
export function stapleDefault(key) {
  if (!key) return null;
  return PACK_DEFAULTS.find(([test]) => test(key))?.[1] ?? null;
}
