// What kind of thing a product is (28-10-2026): a snack, a cup or a
// ready meal can never be the product for an ingredient item. The AH import
// had mapped "Knorr Goodpasta" (a snack cup) to "Pasta" because its name
// holds "pasta", and it became the AH preference behind "500 g pasta".
//
// A product's kind comes from, in order: its stored `kind`, AH's own category
// (`products.category`, "Main > Sub"), the name rules below. An item's
// expected kind: "ingredient" when a live recipe uses it or it is a cooking
// basic, else the kind most of its purchases have. Pure, for the phone, the
// worker, the AH import and the audit tool.
import { nameKey } from "./ingredients.js";
import { isBasic, recipeIngredientKeys } from "./again-scope.js";
import { sameThing } from "./pantry.js";
import { canonicalName } from "./item-names.js";
import { CATEGORY_KINDS as EXCLUDED_CATEGORY_KINDS } from "./excluded-words.js";

export const KINDS = ["ingredient", "ready_meal", "snack", "drink", "household", "personal_care", "pet", "other"];

/** Kinds that are never the product for an ingredient item. */
export const NOT_FOR_INGREDIENTS = new Set(["ready_meal", "snack", "drink", "household", "personal_care", "pet"]);

export const isKind = (k) => KINDS.includes(k);

/** AH's category as stored on a product: "Pasta, rijst, wereldkeuken > Farfalle". */
export function categoryText(main, sub) {
  return [main, sub].map((s) => String(s ?? "").trim()).filter(Boolean).join(" > ").slice(0, 120);
}

// AH sub categories whose kind differs from their main category's. First
// match wins; tested on the sub in lower case, accents and signs as spaces
// (brackets kept as words: "Cake (vers)" is "cake vers").
const SUB_KINDS = [
  // Odd ones AH files under snacks or ready meals, used in cooking.
  [/^(droge worst salami|suiker|schenkstroop|lange vingers|pijnboompitten|cashewnoten|pinda s|chorizo worst|tortilla chips|friet|zoetstof|diepvries loempiavellen|kokosmelk|guacamoledip)/, "ingredient"],
  // Drinks among the dairy, the fruit and the world food.
  [/(chocolademelk|drinkyoghurt|ontbijtdranken|protein drinks|multivruchtensap|sap vers|antiliaans fris|ijskoffie)/, "drink"],
  // Snacks among the dairy, bakery and frozen food.
  [/(pudding|mousse|tussendoortjes|fruitvla)/, "snack"],
  [/(saucijzenbroodjes|worstenbroodjes|frikandelbroodjes|kaasstengels|kaasbroodjes|donuts|muffins|taart|\bgebak\b|cake vers|verse koeken|patisserie|borek|hartige snacks)/, "snack"],
  [/(roomijs|handijs|ijs bitesizes|kipnuggets|kaassouffle|kroket|frikandel|loempia|gehaktstaaf|borrelmix|hapjes|kipsnacks)/, "snack"],
  [/^ijsblokjes/, "other"],
  // Ready meals among the soups, the frozen food and the bakery.
  [/(noedelsoep|kopsoep|soep in zak|verse soepen|pizza|diepvries maaltijd|maaltijden|maaltijdsalades|salades|belegde broodjes|quiches|stoommaaltijden|bapao|pannenkoeken|poffertjes|pasta snack|noedelsnack|kipsalades)/, "ready_meal"],
];

// AH main categories (nameKey) -> kind.
const MAIN_KINDS = {
  "fruit verse sappen": "ingredient",
  "kaas": "ingredient",
  "groente aardappelen": "ingredient",
  "pasta rijst wereldkeuken": "ingredient",
  "soepen sauzen kruiden olie": "ingredient",
  "bakkerij": "ingredient",
  "zuivel eieren": "ingredient",
  "vleeswaren": "ingredient",
  "vlees": "ingredient",
  "vis": "ingredient",
  "vegetarisch vegan en plantaardig": "ingredient",
  "ontbijtgranen beleg": "ingredient",
  "koek snoep chocolade": "snack",
  "tussendoortjes": "snack",
  "borrel chips snacks": "snack",
  "maaltijden salades": "ready_meal",
  "diepvries": "ready_meal",
  "frisdrank sappen water": "drink",
  "koffie thee": "drink",
  "drogisterij": "personal_care",
  "gezondheid en sport": "personal_care",
  "baby en kind": "personal_care",
  "huishouden": "household",
  "koken tafelen vrije tijd": "household",
  "huisdier": "pet",
  // AH categories that only hold the household's excluded things (private word list).
  ...EXCLUDED_CATEGORY_KINDS,
};

/** The kind AH's category says, or null. `category` is "Main > Sub" or { main, sub }. */
export function kindFromCategory(category) {
  if (!category) return null;
  const [main, sub] = typeof category === "string"
    ? [category.split(" > ")[0], category.split(" > ").slice(1).join(" > ")]
    : [category.main, category.sub];
  const subKey = String(sub ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
  if (subKey) for (const [re, kind] of SUB_KINDS) if (re.test(subKey)) return kind;
  return MAIN_KINDS[nameKey(main)] ?? null;
}

// Name rules for products without an AH category (typed in, a receipt photo)
// and for item names. Tested on nameKey("brand name"); first match wins, so
// an exception sits above the rule it overrides ("tandpasta" above "pasta",
// "pasta beker" above "pasta"). \b is a word edge; a compound needs its own
// alternative.
const NAME_RULES = [
  // Cooking mixes and seasonings are ingredients, whatever dish they name.
  [/\b(maaltijdmix|kruidenmix|mix|wereldgerechten|bouillon\w*|citroensap|limoensap|kokosmelk|kookroom|suiker|zoetstof|lange vingers|pijnboompitten|tortillachips|nachochips|paneermeel|loempiavellen|wraps?|tortilla s?)\b/, "ingredient"],
  [/\b(tandpasta|tandenborstel\w*|deo\w*|douchegel|shampoo|conditioner|zeep|handzeep|scheer\w*|maandverband|tampons?|flosdraad|mondwater|paracetamol|ibuprofen|pleisters?|zonnebrand\w*|vitamine\w*|neusspray|wattenstaafjes|condooms?|glijmiddel|bodylotion|dagcreme|nachtcreme|haarspray|gezichts\w*)\b/, "personal_care"],
  [/\b(katten\w*|kattenbak\w*|kattengrind|hondenvoer|honden\w*|whiskas|sheba|felix|minoes eten|kattenmelk|dierenvoer)\b/, "pet"],
  [/\b(toiletpapier|keukenpapier|tissues|afwasmiddel|afwasborstel|vaatwas\w*|wasmiddel|waspods|wasverzachter|vuilniszak\w*|pedaalemmerzak\w*|afvalzak\w*|allesreiniger|reiniger|schoonmaak\w*|sponzen|spons|bleek\w*|toiletblok\w*|luchtverfrisser\w*|batterij\w*|lucifers|aansteker\w*|theelicht\w*|kaars\w*|aluminiumfolie|vershoudfolie|bakpapier|diepvrieszak\w*|boterhamzak\w*|treksluitzak\w*|servetten|houtskool|aanmaakblokjes|vochtige doekjes|vochtig toiletpapier|vochtig tp|dweil\w*|vlekverwijderaar)\b/, "household"],
  // Cups and ready meals before the ingredients they are made of.
  [/\b(goodpasta|pasta ?beker\w*|pastapot\w*|noedelbeker\w*|noodle ?cup|cup a soup|kopsoep|noedelsoep|soep in zak|maaltijd\w*|kant en klaar|ovenschotel|magnetronmaaltijd|pizza\w*|lasagne bolognese|bapao|pannenkoeken|poffertjes|quiche|maaltijdsalade|belegd broodje|wrap kip|sandwich\w*|pot noodle|unox pasta|unox noodles|goodnoodles|good noodles|cup noodles|noodle bowl|noodle cup|soep in blik)\b/, "ready_meal"],
  [/\b\w+ beker\b/, "ready_meal"],
  [/\b(chips|crisps|paprikachips|popcorn|borrelnoten|nootjes|pinda s|koek\w*|koekjes|stroopwafel\w*|snoep\w*|drop|winegums?|chocolade\w*|chocoladereep|reep|repen|candybar\w*|snickers|mars|twix|kitkat|m ms|kauwgom|pepermunt|ijs|ijsjes|roomijs|magnum|kroket\w*|frikandel\w*|bitterbal\w*|nuggets|kipnuggets|loempia s?|saucijzenbroodje\w*|worstenbroodje\w*|kaasstengel\w*|donut\w*|muffin\w*|taart\w*|gebak|cake|tompouce|mueslireep\w*|haverreep\w*|pudding|mousse|liga|evergreen|snack\w*|dipsaus)\b/, "snack"],
  [/\b(cola|fanta|sprite|sinas|7up|frisdrank|energy\w*|energydrink\w*|monster|red bull|ice ?tea|limonade\w*|siroop|ranja|\w*sap|jus d orange|spa|mineraalwater|bronwater|water|koffie\w*|koffiebonen|koffiecups|nespresso|thee|chocomel|chocolademelk|drinkyoghurt|smoothie\w*|sportdrank\w*|kombucha)\b/, "drink"],
  // Things one cooks with.
  [/\b(pasta|spaghetti|macaroni|penne|farfalle|fusilli|tagliatelle|lasagnebladen|rijst|noedels|mie|couscous|bulgur|quinoa|gnocchi|tortellini|ravioli|aardappel\w*|krieltjes|ui|uien|knoflook|tomaat|tomaten|tomatenpuree|passata|paprika|courgette|aubergine|wortel\w*|peen|prei|broccoli|bloemkool|spinazie|sla|komkommer|champignons?|paddenstoel\w*|mais|bonen|kidneybonen|kikkererwten|linzen|erwten|doperwten|sperziebonen|kool|spruitjes|andijvie|avocado|limoen|citroen|gember|peper|pepers|chilipeper|kruiden|basilicum|peterselie|koriander|bieslook|tijm|rozemarijn|oregano|kerrie|komijn|paprikapoeder|kaneel|zout|olie|olijfolie|azijn|bloem|meel|maizena|bakpoeder|gist|ei|eieren|boter|roomboter|melk|room|slagroom|creme fraiche|zure room|yoghurt|kwark|kaas|geraspte kaas|parmezaan|mozzarella|feta|ricotta|mascarpone|kip|kipfilet|kipdij\w*|gehakt|rundergehakt|spek|spekjes|bacon|ham|worst|rookworst|chorizo|biefstuk|vlees|zalm|tonijn|garnalen|vis|tofu|tempeh|ketjap|sojasaus|sambal|pesto|tomatensaus|pastasaus|mosterd|mayonaise|ketchup|honing|brood|stokbrood|pita|naan|beschuit|havermout|muesli)\b/, "ingredient"],
];

/** The kind a name says ("brand name" or an item name), or null when the rules do not know. */
export function kindFromName(name, brand = "") {
  // What it is comes before what it is in or with: "tonijn in water" is no drink.
  const head = String(name ?? "").split(/\s+(?:met|in|op|uit|voor)\s+/i)[0];
  const key = nameKey(`${brand ?? ""} ${head}`);
  if (!key) return null;
  for (const [re, kind] of NAME_RULES) if (re.test(key)) return kind;
  return null;
}

/** A product's kind: its own, else its AH category's, else its name's; null when unknown. */
export function productKind(product) {
  if (!product) return null;
  if (isKind(product.kind)) return product.kind;
  return kindFromCategory(product.category) ?? kindFromName(product.name, product.brand);
}

/**
 * May a product of kind `productKindValue` be bought for an item of kind
 * `itemKindValue`? Unknown on either side fits. An ingredient item takes
 * no ready meal, snack, drink, household, care or pet product; any other
 * item takes its own kind, "other", or a plain ingredient (nuts are
 * "Nootjes", a piece of cheese can be a snack: no harm done there).
 */
export function kindFits(itemKindValue, productKindValue) {
  if (!itemKindValue || !productKindValue) return true;
  if (itemKindValue === "ingredient") return !NOT_FOR_INGREDIENTS.has(productKindValue);
  return productKindValue === itemKindValue || productKindValue === "other" || productKindValue === "ingredient" || itemKindValue === "other";
}

/**
 * Does a recipe use this item? Only in one direction: "500 g pasta" uses the
 * item "Pasta", and "geraspte kaas" the item "Kaas", but "pasta" does not
 * make the item "Pasta beker" an ingredient (the pantry's sameStuff would).
 */
export function usedByRecipe(itemKey, ingredientKeys) {
  return recipeUse(itemKey, ingredientKeys) !== null;
}

/**
 * "exact" when a recipe names this item as it is ("pasta" for "Pasta"),
 * "part" when a recipe names something the item's words are part of
 * ("tortilla chips" for "Chips", "ijsblokjes" for "IJs"), else null.
 */
export function recipeUse(itemKey, ingredientKeys) {
  if (!itemKey) return null;
  let part = false;
  for (const k of ingredientKeys) {
    for (const alt of k.split(" of ").map((a) => a.trim())) {
      if (alt === itemKey || canonicalName(alt).key === canonicalName(itemKey).key) return "exact";
      if (sameThing(alt, itemKey)) part = true;
    }
  }
  return part ? "part" : null;
}

/**
 * The expected kind of every live item: { kind, why, counts } by item id.
 * why: "recipe" (a live recipe uses it), "basic" (a cooking basic), "products"
 * (the kind most of its purchases have; a product linked by item_id without
 * a purchase counts once), or null when nothing is known. counts: purchases per
 * product kind. Built once per call; pass data = { items, recipes, products, purchases }.
 */
export function itemKinds(data) {
  const ingredientKeys = recipeIngredientKeys(data.recipes);
  const counts = new Map();
  const add = (itemId, kind, n = 1) => {
    if (!itemId || !kind) return;
    const c = counts.get(itemId) ?? {};
    c[kind] = (c[kind] ?? 0) + n;
    counts.set(itemId, c);
  };
  const bought = new Set();
  for (const x of Object.values(data.purchases ?? {})) {
    if (!x || x.deleted_at || !x.product_id) continue;
    const p = data.products?.[x.product_id];
    if (!p || p.deleted_at) continue;
    add(x.item_id, productKind(p), 1);
    bought.add(`${x.item_id}|${p.id}`);
  }
  for (const p of Object.values(data.products ?? {})) {
    if (!p || p.deleted_at || !p.item_id || bought.has(`${p.item_id}|${p.id}`)) continue;
    add(p.item_id, productKind(p), 1);
  }
  const out = new Map();
  for (const item of Object.values(data.items ?? {})) {
    if (!item || item.deleted_at) continue;
    const c = counts.get(item.id) ?? {};
    const key = canonicalName(item.name).key;
    let kind = null;
    let why = null;
    const use = recipeUse(key, ingredientKeys);
    const top = Object.entries(c).sort((a, b) => b[1] - a[1] || KINDS.indexOf(a[0]) - KINDS.indexOf(b[0]))[0];
    const total = Object.values(c).reduce((n, x) => n + x, 0);
    // A recipe that only names something bigger ("tortilla chips") does not
    // make "Chips" an ingredient when most of what is bought for it is a snack.
    const boughtAsOther = Boolean(top && NOT_FOR_INGREDIENTS.has(top[0]) && top[1] >= total * 0.6);
    if (use === "exact" || (use === "part" && !boughtAsOther)) { kind = "ingredient"; why = "recipe"; }
    else if (isBasic(item.name) && !boughtAsOther) { kind = "ingredient"; why = "basic"; }
    else if (top) { kind = top[0]; why = "products"; }
    else { kind = kindFromName(item.name); why = kind ? "name" : null; }
    out.set(item.id, { kind, why, counts: c });
  }
  return out;
}

// One itemKinds per data object: the phone's view is a new object on every
// recompute, so a screen asking for many items builds it once.
const cache = new WeakMap();

/** The expected kind of one item (see itemKinds), or null. */
export function itemKind(data, itemId) {
  if (!data || typeof data !== "object") return null;
  let kinds = cache.get(data);
  if (!kinds) { kinds = itemKinds(data); cache.set(data, kinds); }
  return kinds.get(itemId)?.kind ?? null;
}

/**
 * Products for an item's picker, the fitting ones first (in their own
 * order), then the ones of the wrong kind, each with `misfit` true.
 */
export function orderByFit(products, itemKindValue) {
  const fit = [];
  const misfit = [];
  for (const p of products) (kindFits(itemKindValue, productKind(p)) ? fit : misfit).push(p);
  return [...fit.map((p) => ({ product: p, misfit: false })), ...misfit.map((p) => ({ product: p, misfit: true }))];
}
