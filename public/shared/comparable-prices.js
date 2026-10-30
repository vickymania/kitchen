// Comparable products at other stores (30-10-2026: "als ik naar de
// verschillende winkels kijk ontbreekt bij bijna alles nog steeds de prijs per
// item"). Most of what he buys is an AH store brand ("AH Eieren"), which no
// other store sells, so an exact price (public/shared/store-prices.js) exists
// only at AH. For an ITEM he buys or has on the list, this finds the
// comparable product in one store's Checkjebon rows: the same kind of thing
// (the words of his product's name without its brand, the item's words, the
// same product kind) in a similar pack (within PACK_TOLERANCE, compared per
// kg, l or piece), the cheapest per unit of the close matches. The op
// prices.sync keeps one such row per item and store ("spc-<store>-<item>",
// comparable = 1) only where that store has no exact price of the item. The
// screens mark it "vergelijkbaar". Never an excluded thing; a private item's
// row carries its item_id, so worker/privacy.js hides it from the others.
//
// Tuned on his real rows (30-10-2026): every product of his of the item is
// compared (the reference first), then the item's own noun in his pack with
// the words that change the kind or price required (itemTarget).
//
// Unsure is nothing: a word in the row that is not his (beyond a brand of at
// most MAX_BRAND_WORDS words in front), a variant he does not buy (bio,
// lactosevrij, light...), another kind (chocolate eggs for eggs), a pack
// twice the size: no comparable.
import { isExcluded } from "./excluded.js";
import { nameKey } from "./ingredients.js";
import { canonicalStore } from "./stores.js";
import { keyWords, packSize, noise, holds, sameWord, DEFAULT_WORDS, matchStorePrices } from "./store-prices.js";
import { productKind, kindFromName, kindFits } from "./product-kinds.js";
import { preferenceAt } from "./preferences.js";
import { isGeneric } from "./item-names.js";

/** A comparable pack holds at most this many times more (or less) than his. */
export const PACK_TOLERANCE = 1.5;
/** Words in front of the matched ones that may be the row's brand ("Campina", "Dr. Oetker"). */
export const MAX_BRAND_WORDS = 2;
/** A store's own sub-brands: they say nothing about what the product is. */
export const SUB_BRANDS = new Set(["excellent", "basic", "basis", "terra", "gwoon", "beste", "huismerk", "premium", "selection", "kies", "smaakt", "jouw"]);
/** Variants that make another product: only comparable when his product is that variant too. */
export const VARIANTS = new Set(["bio", "biologisch", "biologische", "lactosevrij", "lactosevrije", "glutenvrij", "glutenvrije", "light", "lite",
  "zero", "vegan", "vegetarisch", "vegetarische", "plantaardig", "plantaardige", "halal", "kids", "mini", "minis", "suikervrij", "suikervrije",
  "ongezouten", "zoutarm", "proteine", "protein", "eiwit", "eiwitrijk", "decafe", "cafeinevrij"]);

/**
 * Pack and shape words: they say how it is packed or cut, not what it is
 * ("Jonge kaas plakken" is kaas). Allowed anywhere in a row, never required;
 * the pack check (PACK_TOLERANCE, per kg / l / piece) does the measuring.
 */
export const DESCRIPTIVE = new Set(["plakken", "plak", "stuk", "stukken", "blok", "voordeel", "voordeelverpakking", "voordeelpak",
  "grootverpakking", "familiepak", "multipack", "maat", "middel", "middelgroot", "groot", "grote", "klein", "kleine", "medium", "large",
  "los", "losse", "heel", "hele", "tros", "schaal", "rol", "rollen", "pack", "verpakking", "transparant", "tabletten", "hollandse", "hollands", "nederlandse", "nederlands"]);
/**
 * Words that make another kind of thing or another price class: a grade,
 * a fat level, a preparation, a flavour, a dish. In a row only when the
 * target has it too (also in front, where a brand may stand); the item-level
 * target requires the ones his product has.
 */
export const CHARACTER = new Set(["jong", "jonge", "jonkbelegen", "belegen", "oud", "oude", "overjarig", "pittig", "mild",
  "mager", "magere", "halfvol", "halfvolle", "vol", "volle", "houdbaar", "houdbare", "gerookt", "gerookte", "gekookt", "gekookte",
  "gebakken", "gegrild", "gegrilde", "gepaneerd", "gepaneerde", "gemarineerd", "gemarineerde", "gezouten", "gemalen", "gedroogd", "gedroogde",
  "aardbei", "aardbeien", "vanille", "chocolade", "choco", "cacao", "karamel", "caramel", "perzik", "mango", "citroen", "sinaasappel",
  "framboos", "frambozen", "banaan", "kers", "kersen", "honing", "kaneel", "paprika", "bosvruchten", "kokos", "appel", "ananas", "munt",
  "saus", "salade", "soep", "spread", "chips", "snack", "reep", "repen", "koek", "koeken", "koekjes", "poeder", "sap", "drink", "ijs",
  "taart", "cake", "wafel", "wafels", "pudding", "vla", "siroop", "cracker", "crackers", "pizza", "burger", "worst", "worstjes", "kroket",
  "smaak", "mix", "dip", "navulling", "spray", "capsules", "smoothie", "ragout", "cocktail", "cherry", "gekleurde", "cereal",
  "muesli", "granola", "thee", "yoghurt", "kwark", "melk", "room", "boter", "kaas",
  "rode", "rood", "gele", "geel", "witte", "wit", "groene", "groen", "zoete", "zoet", "bruine", "bruin", "volkoren", "meergranen", "spelt", "groenten", "roerbak"]);
/** Medicine and care: what is in it matters, so only his own products compare, never the item's noun alone. */
export const NO_ITEM_LEVEL = new Set(["neusspray", "paracetamol", "ibuprofen", "tabletten", "druppels", "oogdruppels", "zalf", "pleisters",
  "hoestdrank", "keelpastilles", "vitamine", "vitamines", "shampoo", "deodorant", "tandpasta"]);
/** Words that name the same kind of thing. Never sojasaus and ketjap: another sauce. */
export const SYNONYMS = [
  ["ei", "eieren"], ["ui", "uien"], ["tomaat", "tomaten"], ["banaan", "bananen"],
  ["kattenbakvulling", "kattengrind", "kattenbakkorrels"],
  ["vuilniszak", "vuilniszakken", "afvalzak", "afvalzakken", "pedaalemmerzak", "pedaalemmerzakken", "trekbandzak", "trekbandzakken"],
  ["broodje", "broodjes", "bolletje", "bolletjes", "bollen"],
  ["mayonaise", "mayonnaise", "mayo"],
  ["soy", "sojasaus", "soyasaus"],
  ["noedels", "noodles", "noedel", "noodle"],
];
/** Words in front of the matched ones that may be a brand when only the item's noun is compared ("Hoogvliet Champignons"). */
export const MAX_BRAND_WORDS_ITEM = 1;
/** A number that makes another product: fat ("10% vet", "48+"), a dose ("500mg") and layers ("3-laags"). Both sides must agree when the target has one. */
export function numberMarks(name) {
  const text = String(name ?? "").toLowerCase();
  const out = {};
  const pct = text.match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (pct) out.pct = pct[1].replace(",", ".");
  const plus = text.match(/\b(\d{2})\s*\+/);
  if (plus) out.plus = plus[1];
  const dose = text.match(/(\d+(?:[.,]\d+)?)\s*mg\b/);
  if (dose) out.mg = dose[1].replace(",", ".");
  const layers = text.match(/(\d)\s*-?\s*laags/);
  if (layers) out.layers = layers[1];
  return out;
}
/** Bags: their litres are a capacity, compared within PACK_TOLERANCE; unknown is nothing. */
export const BAG_WORDS = ["vuilniszak", "vuilniszakken", "afvalzak", "afvalzakken", "pedaalemmerzak", "pedaalemmerzakken", "trekbandzak", "trekbandzakken"];
const CAPACITY_RE = /(\d+(?:[.,]\d+)?)\s*(?:l|liter|ltr)\b/i;

const isVariant = (w) => [...VARIANTS].some((v) => w === v || (v.length >= 5 && sameWord(w, v)));
/** What a product is comes before what it is in or with: "kipfilet met eieren" is kipfilet. */
const headOf = (name) => String(name ?? "").split(/\s+(?:met|in|op|uit|voor|zonder)\s+/i)[0];
const contentWords = (words) => words.filter((w) => w.length > 1 && !noise(w));

// ------------------------------------------------------------- unit prices

/** The price per kg, l or piece of a pack ({ count, grams, ml }): { per, cents } or null. */
export function unitPrice(cents, size) {
  if (!size || !(cents > 0)) return null;
  if (size.grams > 0) return { per: "kg", cents: Math.round((cents * 1000) / size.grams) };
  if (size.ml > 0) return { per: "l", cents: Math.round((cents * 1000) / size.ml) };
  if (size.count > 0) return { per: "piece", cents: Math.round(cents / size.count) };
  return null;
}

/** The measure two packs share ("grams", "ml" or "count"), weight first; null when none. */
export function sharedMeasure(a, b) {
  if (!a || !b) return null;
  for (const k of ["grams", "ml", "count"]) if (a[k] > 0 && b[k] > 0) return k;
  return null;
}

/** How many times bigger the bigger pack is (1 = the same); Infinity when they share no measure. */
export function packRatio(a, b) {
  const k = sharedMeasure(a, b);
  return k ? Math.max(a[k], b[k]) / Math.min(a[k], b[k]) : Infinity;
}

// --------------------------------------------------------- what to compare

const byItemCache = new WeakMap();
/** Live products per item, newest first (built once per products object). */
function productsByItem(products) {
  const key = products ?? {};
  let map = byItemCache.get(key);
  if (!map) {
    map = new Map();
    for (const p of Object.values(key)) {
      if (!p?.item_id || p.deleted_at) continue;
      if (!map.has(p.item_id)) map.set(p.item_id, []);
      map.get(p.item_id).push(p);
    }
    for (const list of map.values()) list.sort((a, b) => String(b.updated_at ?? b.created_at ?? "").localeCompare(String(a.updated_at ?? a.created_at ?? "")));
    if (products) byItemCache.set(products, map);
  }
  return map;
}

/** The live products of an item, newest first. */
export const productsOfItem = (data, itemId) => productsByItem(data.products).get(itemId) ?? [];

const countCache = new WeakMap();
/**
 * How often he bought each product: { product_id: n }. The server's loader
 * gives data.purchase_counts (one query); a phone counts data.purchases.
 */
export function purchaseCounts(data) {
  if (data?.purchase_counts) return data.purchase_counts;
  const src = data?.purchases;
  if (!src || typeof src !== "object") return {};
  if (!countCache.has(src)) {
    const n = {};
    for (const x of Array.isArray(src) ? src : Object.values(src)) if (x?.product_id && !x.deleted_at) n[x.product_id] = (n[x.product_id] ?? 0) + 1;
    countCache.set(src, n);
  }
  return countCache.get(src);
}

/** A product of a variant (bio, light, lactosevrij...), in its brand or name. */
export const isVariantProduct = (p) => [...keyWords(p?.brand), ...keyWords(p?.name)].some(isVariant);

/**
 * His products of an item in the order they are compared (Thomas's
 * coordinator, 30-10-2026): the one he bought most often first, then the
 * newest; a variant product (organic eggs) only when he has no plain one of
 * the item, so plain eggs are compared with plain eggs.
 */
export function productsByUse(data, itemId) {
  const list = productsOfItem(data, itemId);
  const plain = list.filter((p) => !isVariantProduct(p));
  const n = purchaseCounts(data);
  // A stable sort: equal counts keep newest first.
  return [...(plain.length ? plain : list)].sort((a, b) => (n[b.id] ?? 0) - (n[a.id] ?? 0));
}

/**
 * The product a comparable is compared with: the item's preference for any
 * store and recipe, else items.preferred_product_id (his own choices, also a
 * variant), else productsByUse's first; null when he has none (then the item
 * gets no comparable).
 */
export function referenceProduct(data, itemId) {
  const live = (id) => {
    const p = id ? data.products?.[id] : null;
    return p && !p.deleted_at ? p : null;
  };
  return live(preferenceAt(data.preferences ?? {}, itemId, "", "")?.product_id)
    ?? live(data.items?.[itemId]?.preferred_product_id)
    ?? productsByUse(data, itemId)[0]
    ?? null;
}

/** Do two words name the same thing: the same word, a plural or stem, or SYNONYMS. */
export function sameThing(a, b) {
  if (sameWord(a, b)) return true;
  const g = synonymGroup(a);
  return Boolean(g && g.some((x) => sameWord(x, b)));
}
const groupCache = new Map();
function synonymGroup(w) {
  if (!groupCache.has(w)) groupCache.set(w, SYNONYMS.find((g) => g.some((x) => sameWord(x, w))) ?? null);
  return groupCache.get(w);
}
/** A word with its synonyms. */
const withSynonyms = (w) => [w, ...(synonymGroup(w) ?? [])];
/** Does row word o hold target word w (the word, a synonym, or inside a compound)? */
const holdsThing = (o, w) => withSynonyms(w).some((x) => holds(o, x));
/** A word that changes the kind or price, also inside a compound ("vanillesmaak", "roerbakgroenten"). */
const characterCache = new Map();
function isCharacter(w) {
  if (!characterCache.has(w)) {
    characterCache.set(w, CHARACTER.has(w) || isVariant(w)
      || [...CHARACTER].some((c) => (c.length >= 5 && sameWord(w, c)) || (c.length >= 4 && w.length > c.length + 2 && (w.startsWith(c) || w.endsWith(c)))));
  }
  return characterCache.get(w);
}
const isBag = (w) => BAG_WORDS.some((b) => sameWord(w, b));

/**
 * Is row word o made only of the target's words? "scharreleieren" is
 * scharrel + eieren, "ijsbergslamelange" ijsbergsla + melange; "keukenpapier"
 * is not papier and "geitenkaas" not kaas: a part of its own is another kind.
 */
function covered(o, vocab, depth = 0) {
  if (!o) return true;
  if (vocab.some((w) => sameThing(o, w))) return true;
  // "Vrije uitloop eieren" against "uitloopeieren": a part of his own compound.
  if (depth === 0 && o.length >= 5 && vocab.some((w) => w.length > o.length + 2 && (w.startsWith(o) || w.endsWith(o)))) return true;
  if (depth > 3) return false;
  for (const w of vocab) {
    if (w.length < 3 || o.length <= w.length || !o.startsWith(w)) continue;
    const rest = o.slice(w.length);
    if (rest.length <= 1 && depth > 0) return true;
    for (const r of new Set([rest, rest.replace(/^(?:en|s|e|n)/, "")])) if (r.length >= 3 && covered(r, vocab, depth + 1)) return true;
  }
  return false;
}

/** A bag's capacity in litres from its name ("Vuilniszakken 60 liter"), or null. */
export function capacityOf(name) {
  const m = String(name ?? "").match(CAPACITY_RE);
  return m ? Number(m[1].replace(",", ".")) : null;
}
/** The pack of a row or product; a bag's litres are its capacity, not its contents. */
const packOf = (size, name, bag) => packSize(size, bag ? String(name ?? "").replace(CAPACITY_RE, " ") : name);

/** His product's words that say which one it is: its name without brand, sub-brands and default words. */
function productWords(product) {
  const brand = keyWords(product.brand);
  let name = keyWords(headOf(product.name));
  if (brand.length && brand.every((w, i) => name[i] === w)) name = [...brand.filter((w) => isCharacter(w)), ...name.slice(brand.length)];
  return [...new Set(contentWords(name).filter((w) => !DEFAULT_WORDS.has(w) && !SUB_BRANDS.has(w)))];
}

function finish(t) {
  t.vocab = [...new Set([...t.words, ...t.itemWords, ...(t.tail ?? [])])];
  t.variants = t.words.filter(isVariant);
  t.bag = t.vocab.some(isBag);
  t.capacity = t.bag ? t.capacity ?? null : null;
  return t;
}

/**
 * What a comparable must be for one item and one of his products (or the
 * item alone when product is null): { item_id, product_id, words, required,
 * itemWords, needItem, size, kind, variants, vocab, bag, capacity, rank },
 * or null when it can never have one (gone, merged, excluded, no words).
 */
export function comparableTarget(item, product, rank = 0) {
  if (!item?.id || item.deleted_at || item.merged_into || !item.name || isExcluded(item.name)) return null;
  if (product && (isExcluded(product.name ?? "") || isExcluded(`${product.brand ?? ""} ${product.name ?? ""}`))) return null;
  const itemWords = contentWords(keyWords(item.name));
  let words = [];
  let size = null;
  let capacity = null;
  let kind = kindFromName(item.name);
  let tail = null;
  let marks = {};
  if (product?.name && !product.deleted_at) {
    words = productWords(product);
    tail = contentWords(keyWords(product.name));
    marks = numberMarks(`${product.name} ${product.size ?? ""}`);
    const bag = [...words, ...itemWords].some(isBag);
    size = packOf(product.size, product.name, bag);
    capacity = bag ? capacityOf(product.name) : null;
    kind = productKind(product) ?? kind;
  }
  if (!words.length) {
    // Only for a direct call: itemTargets gives an item without a product of his nothing. Never a word that is no product ("Snack").
    if (isGeneric(item.name)) return null;
    words = itemWords;
    size = null;
  }
  if (!words.length) return null;
  // The item's words say what kind of thing it is; the rest of the name which one.
  // Pack words ("plakken", "voordeelverpakking") are never required: the pack check measures.
  let required = words.filter((w) => !itemWords.some((i) => sameThing(i, w)) && !DESCRIPTIVE.has(w));
  // "AH Scharrel eieren" or "AH Tex-mex geraspte kaas": the item's word must be in the row too.
  const needItem = required.length > 0 && words.some((w) => itemWords.some((i) => sameThing(i, w)));
  if (!required.length) required = words.filter((w) => !DESCRIPTIVE.has(w));
  if (!required.length) required = words;
  return finish({ item_id: item.id, product_id: product?.id ?? "", words, required, itemWords, needItem, size, capacity, kind, rank, tail, marks, level: product ? "product" : "name" });
}

/**
 * The item-level target: the item's own noun ("kaas", "eieren") as his
 * products name it, in the pack of `base` (one of his products), with the
 * words of base that change the kind or price (jong, mager, aardbei, bio...)
 * required and its other words allowed. Null when none of his products
 * names the item's noun (then only his products compare).
 */
export function itemTarget(item, base, products, rank) {
  const t0 = comparableTarget(item, base, rank);
  if (!t0 || !base) return null;
  if (isGeneric(item.name) || t0.kind === "personal_care" || t0.vocab.some((w) => NO_ITEM_LEVEL.has(w))) return null;
  const named = products.flatMap((p) => contentWords(keyWords(headOf(p.name))));
  const core = t0.itemWords.filter((w) => !DESCRIPTIVE.has(w) && named.some((o) => holdsThing(o, w) || sameThing(w, o)));
  if (!core.length) return null;
  const character = t0.words.filter((w) => isCharacter(w) && !core.some((c) => sameThing(c, w)));
  return finish({ ...t0, words: [...new Set([...t0.words, ...core])], required: [...core, ...character], needItem: false, level: "item" });
}

/** At most this many of his products of one item are compared, the reference first. */
export const MAX_PRODUCT_TARGETS = 6;

/**
 * Everything to compare for one item, best first (rank): his reference
 * product, his other products with a size (productsByUse: most bought, then
 * newest; no variant when he has a plain one), then the item's noun in the
 * reference's pack. A product without a size only when none of his products
 * of the item has one. An item without a product of his: nothing.
 */
export function itemTargets(state, itemId) {
  const item = state.items?.[itemId];
  if (!item) return [];
  const ref = referenceProduct(state, itemId);
  const live = productsByUse(state, itemId).filter((p) => p.name && !isExcluded(`${p.brand ?? ""} ${p.name}`));
  // No product of his: no comparable at all (a guess by the item's name gave
  // energy drinks for "Energy" and glucose tablets); the line stays unpriced.
  if (!ref && !live.length) return [];
  const sized = (p) => Boolean(packSize(p.size, p.name));
  const order = [...new Set([ref, ...live].filter(Boolean))];
  const anySized = order.some(sized);
  const picked = order.filter((p) => !anySized || sized(p)).slice(0, MAX_PRODUCT_TARGETS);
  const out = [];
  for (const p of picked) {
    const t = comparableTarget(item, p, out.length);
    if (t) out.push(t);
  }
  const base = picked[0];
  const it = base ? itemTarget(item, base, productsOfItem(state, itemId), out.length) : null;
  if (it) out.push(it);
  return out;
}

/**
 * The items that get comparables: every live item he has a product of (he
 * buys it) and every item on the list. Several targets per item (itemTargets).
 */
export function comparableTargets(state) {
  const wanted = new Set();
  for (const p of Object.values(state.products ?? {})) if (p?.item_id && !p.deleted_at) wanted.add(p.item_id);
  for (const e of Object.values(state.entries ?? {})) if (e?.item_id && !e.deleted_at && !e.checked_at) wanted.add(e.item_id);
  const out = [];
  for (const id of wanted) out.push(...itemTargets(state, id));
  return out;
}

// ------------------------------------------------------------- matching

/**
 * Why this row (its name) is not the same kind of thing as the target, or ""
 * when it is. Words of the row, in order: at most MAX_BRAND_WORDS unknown
 * ones in front (a brand), then only the target's words (also in a compound
 * made of them only), pack words and default words. A word that changes the
 * kind or price (CHARACTER, VARIANTS) only when the target has it too.
 */
export function comparableReason(t, name, parsed = parseRow(name)) {
  if (!t) return "no target";
  if (parsed.excluded) return "excluded";
  const { words, tailWords, marks } = parsed;
  const known = (o) => covered(o, t.vocab);
  const free = (o) => DESCRIPTIVE.has(o) || DEFAULT_WORDS.has(o) || SUB_BRANDS.has(o);
  const first = words.findIndex(known);
  if (first < 0) return "no word of his";
  const front = words.slice(0, first).filter((o) => !free(o));
  if (front.length > (t.level === "item" ? MAX_BRAND_WORDS_ITEM : MAX_BRAND_WORDS)) return `too many words in front: ${front.join(" ")}`;
  for (const o of words) {
    if (known(o)) continue;
    if (isCharacter(o)) return `another kind or variant: ${o}`;
  }
  for (const o of words.slice(first)) if (!known(o) && !free(o)) return `unknown word: ${o}`;
  // "Kip ketjap met mihoen goreng" is a meal, not his "Kip ketjap": what it comes with must be his too.
  if (t.tail) for (const o of tailWords) if (!known(o) && !free(o)) return `comes with: ${o}`;
  for (const k of Object.keys(t.marks ?? {})) if (marks[k] !== undefined && marks[k] !== t.marks[k]) return `${k} ${marks[k]} for ${t.marks[k]}`;
  const mine = words.filter(known);
  // "Tomaten blokjes" is "tomatenblokjes": two words written apart.
  const joined = mine.slice(1).map((o, i) => `${mine[i]}${o}`);
  const miss = t.required.find((w) => !mine.some((o) => holdsThing(o, w)) && !joined.some((o) => sameThing(o, w)));
  if (miss) return `missing: ${miss}`;
  if (t.needItem && !t.itemWords.some((w) => mine.some((o) => holdsThing(o, w)))) return "missing the item's word";
  for (const o of words) if (isVariant(o) && !t.variants.some((v) => holds(o, v) || holds(v, o))) return `variant: ${o}`;
  const kind = parsed.kind;
  if (!(kindFits(t.kind, kind) && kindFits(kind, t.kind))) return `kind ${kind} for ${t.kind}`;
  if (t.bag) {
    const cap = parsed.capacity;
    if (!t.capacity || !cap) return "bag size unknown";
    if (Math.max(cap, t.capacity) / Math.min(cap, t.capacity) > PACK_TOLERANCE) return `bag of ${cap} l for ${t.capacity} l`;
  }
  return "";
}

/** What matching needs of a row's name, worked out once per row. */
function parseRow(name) {
  const words = [...new Set(contentWords(keyWords(headOf(name))))];
  return {
    excluded: isExcluded(name), words, tailWords: contentWords(keyWords(name)).filter((o) => !words.includes(o)),
    marks: numberMarks(name), kind: kindFromName(headOf(name)), capacity: capacityOf(name),
  };
}

/** Is this row (its name) the same kind of thing as the target? */
export const rowComparable = (t, name) => comparableReason(t, name) === "";

/** Keys under which a target is found: its longest required word, also one or two letters shorter, and its synonyms. */
function anchorKeys(w) {
  const out = new Set();
  for (const x of withSynonyms(w)) {
    out.add(x);
    if (x.length >= 5) out.add(x.slice(0, -1));
    if (x.length >= 6) out.add(x.slice(0, -2));
  }
  return [...out];
}
/** Keys a row word looks under: itself, its starts (4+ letters) and ends (5+ letters, compounds). */
function lookupKeys(o) {
  const out = new Set([o]);
  for (let i = 3; i < o.length; i++) out.add(o.slice(0, i));
  for (let i = 1; i <= o.length - 5; i++) out.add(o.slice(i));
  return out;
}

/**
 * The comparable product of each item in one store's rows ([name, size,
 * cents, ref]): Map item_id -> { product_id, name, size, cents }. Per item
 * the best-ranked target that finds one (his reference product first, his
 * other products, then the item's noun); within it, with a pack size known,
 * only packs within PACK_TOLERANCE, the cheapest per kg / l / piece; without
 * one (none of his products of the item has a size), the cheapest pack.
 */
export function matchComparables(targets, rows) {
  const index = new Map();
  for (const t of targets) {
    const anchor = [...t.required].sort((a, b) => b.length - a.length)[0];
    for (const k of anchorKeys(anchor)) {
      if (!index.has(k)) index.set(k, []);
      index.get(k).push(t);
    }
  }
  const best = new Map(); // item_id -> { rank, score, cents, row, t }
  for (const row of rows ?? []) {
    const [name, size, cents] = row;
    const cands = new Set();
    const rw = keyWords(headOf(name));
    // Also two words written apart ("tomaten blokjes" for "tomatenblokjes").
    for (const o of rw) for (const k of lookupKeys(o)) for (const t of index.get(k) ?? []) cands.add(t);
    for (const j of rw.slice(1).map((x, i) => `${rw[i]}${x}`)) for (const k of [j, j.slice(0, -1), j.slice(0, -2)]) for (const t of index.get(k) ?? []) cands.add(t);
    if (!cands.size) continue;
    const parsed = parseRow(name);
    if (parsed.excluded) continue;
    for (const t of cands) {
      const had = best.get(t.item_id);
      if (had && had.rank < (t.rank ?? 0)) continue;
      if (comparableReason(t, name, parsed) !== "") continue;
      let score = cents;
      if (t.size) {
        // A loose piece ("Jumbo Komkommer", no size at all) against his one piece.
        const rowSize = packOf(size, name, t.bag) ?? (t.size.count === 1 && !t.size.grams && !t.size.ml && !String(size ?? "").trim() ? { count: 1, grams: null, ml: null } : null);
        const k = sharedMeasure(t.size, rowSize);
        if (!k || packRatio(t.size, rowSize) > PACK_TOLERANCE) continue;
        score = cents / rowSize[k];
      }
      const rank = t.rank ?? 0;
      if (!had || rank < had.rank || score < had.score || (score === had.score && cents < had.cents)) best.set(t.item_id, { rank, score, cents, row, t });
    }
  }
  const out = new Map();
  for (const [itemId, b] of best) out.set(itemId, { product_id: b.t.product_id, name: b.row[0], size: b.row[1] || "", cents: b.row[2] });
  return out;
}

/** The id of the row of one item's comparable product in one store. */
export const comparablePriceId = (store, itemId) => `spc-${nameKey(canonicalStore(store)).replace(/ /g, "-")}-${itemId}`;

/**
 * Everything one store's Checkjebon rows ([name, size, cents, ref]) say about
 * his products and items: the result rows of a prices.sync op (checked by
 * checkPriceResults in public/shared/store-prices.js). The exact price of each
 * product of his the store sells, and for an item without one there a
 * comparable product. Runs on the home server (fetcher/prices.mjs) with the
 * household's inputs (/api/prices/inputs), never in the worker: 17,000 rows
 * against every product and item is far more CPU than the free plan allows.
 * state: { products, items, preferences, entries, purchase_counts } by id.
 */
export function storePriceResults(state, rows, store) {
  const found = matchStorePrices(Object.values(state.products ?? {}), state.items ?? {}, rows, store);
  const out = [];
  const exactItems = new Set();
  for (const [productId, m] of found) {
    out.push({ product_id: productId, name: m.name, size: m.size, price_cents: m.cents });
    const itemId = state.products?.[productId]?.item_id;
    if (itemId) exactItems.add(itemId);
  }
  const comps = matchComparables(comparableTargets(state).filter((t) => !exactItems.has(t.item_id)), rows);
  for (const [itemId, m] of comps) {
    out.push({ item_id: itemId, comparable: 1, product_id: m.product_id || null, name: m.name, size: m.size, price_cents: m.cents });
  }
  return out;
}
