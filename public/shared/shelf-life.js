// How long something keeps once it is in the house: an estimate per kind of
// product, by the words of its name (Thomas, phase 4: "fresh meat ~3 days,
// milk ~7, cheese ~4 weeks, pasta none"). He can always type the real date;
// an estimate is shown as "geschat".
//
// Conservative on purpose: when in doubt the shorter time, because a date that
// comes too early costs a look in the fridge and one that comes too late costs
// a meal. Dry goods and tins have no date ("none"); a name nothing matches has
// no estimate at all.
//
// RULES is read top to bottom and the first match wins, so a specific rule
// ("kokosmelk") goes above a general one ("melk"). A pattern is tested
// against nameKey(name) (lowercase, no accents, single spaces). To add a kind:
// one line here and one case in tests/pantry.test.mjs.
import { nameKey } from "./ingredients.js";

export const NONE = "none";

/** [pattern on nameKey, days | NONE, kind]: the kind is only for the tests and reading. */
export const RULES = [
  // Kept in a tin, jar, bottle or bag first: "kokosmelk" is not milk.
  [/kokosmelk|kokosroom|\bblik|\bin blik|\bpassata|tomatenpuree|gepelde tomaten|tomatenblokjes|\bbonen in|kidneybonen|kikkererwten|linzen|mais\b/, NONE, "tin"],
  [/\bverse? pasta|\bgnocchi|\btortellini|\bravioli|\bverse noedels/, 5, "fresh pasta"],
  [/\bpasta|spaghetti|macaroni|penne|fusilli|tagliatelle|lasagne ?bladen|\brijst|noedels|mie\b|couscous|bulgur|quinoa|havermout|cornflakes|muesli|\bmeel|\bbloem\b|maizena|paneermeel|suiker|\bzout|peper\b|(?<!verse )kruiden|specerij|bouillon|\bolie|azijn|ketjap|sojasaus|\bsaus\b|ketchup|mayonaise|mosterd|\bpindakaas|\bjam\b|hagelslag|\bhoning|\bthee\b|koffie|chips|crackers|beschuit|\bnoten|pinda|rozijnen|wraps?\b|tortilla/, NONE, "dry"],
  // Fresh meat and fish: the shortest.
  [/gehakt|kipfilet|\bkip|kippen|\bvlees|biefstuk|rundvlees|varkens|speklap|\bspek|\bworst|\bbraadworst|shoarma|gyros|hamburger|\bvis\b|zalm|kabeljauw|tonijn(?!.*blik)|garnalen|\bmosselen|pangasius|tilapia|\bkalkoen|lamsvlees|\bschnitzel|\bsate\b|saucijs/, 2, "fresh meat and fish"],
  [/\bham\b|beenham|salami|cervelaat|\bfilet americain|\bvleeswaren|\bbacon|\bontbijtspek|\brookworst/, 5, "cold cuts"],
  [/geraspte kaas|\bmozzarella|\bburrata|\bricotta|\bfeta|\bhuttenkase|\bcottage cheese|\bmascarpone|roomkaas|\bphiladelphia/, 7, "soft and grated cheese"],
  [/kaas|parmezaan|parmigiano|pecorino|\bcheddar|\bgouda/, 28, "cheese"],
  [/slagroom|kookroom|zure room|creme fraiche|\broom\b|\bkwark|yoghurt|\bvla\b|\bskyr/, 7, "cream and yoghurt"],
  [/karnemelk|\bmelk|chocomel|\bdrinkyoghurt|\bmilk/, 7, "milk"],
  [/\beieren|\bei\b|\beggs?\b/, 21, "eggs"],
  [/roomboter|\bboter|margarine|halvarine/, 30, "butter"],
  [/\btofu|\btempeh|vegetarische|\bvega\b|\bhummus|\bpesto|\bsalsa\b|\bguacamole/, 5, "chilled spreads and vegetarian"],
  [/sap\b|sapje|jus d orange|\bsmoothie/, 5, "fresh juice"],
  [/\bbrood|\bbolletjes|\bbollen|stokbrood|croissant|\bpistolet|\bnaan|\bpita|\bbagel/, 3, "bread"],
  [/\bsla\b|\bijsbergsla|rucola|spinazie|\bandijvie|veldsla|\btaugé|\btauge|\bkiemen|\bbasilicum|koriander|peterselie|bieslook|\bmunt\b|\bverse kruiden|\bwokgroente|\bsnijbonen|\bsperziebonen|\bdoperwten vers|\bpaddenstoel|champignon|\bchampignons|\baardbei|framboz|bosbes|\bbramen|\bframbozen/, 3, "leafy, herbs, berries, mushrooms"],
  [/\bbanaan|bananen|\bavocado|\bperzik|nectarine|\bmango|\bkiwi|\bdruiven|\bpruimen|\bkomkommer|\bcourgette|\baubergine|\bbroccoli|bloemkool|\bprei|\bbosui|lente ?ui|\btomaat|tomaten|cherrytomaat|\bpaprika|\bspitskool|\bpaksoi|\bmaaltijdsalade|\bsalade/, 5, "soft fruit and vegetables"],
  [/\bwortel|\bwortelen|\bkool\b|rode kool|witte kool|\bknolselderij|\bselderij|\bbiet|\bbieten|\bpastinaak|\bappel|\bperen?\b|\bsinaasappel|\bmandarijn|\bcitroen|\blimoen|\bgember/, 14, "hard fruit and roots"],
  [/\baardappel|\bkriel|\bzoete aardappel|\bui\b|\buien|\bsjalot|\bknoflook|\bpompoen/, 21, "potatoes, onions, garlic"],
  [/diepvries|bevroren|\bfrozen|\bijs\b|\bfrites|patat/, NONE, "frozen"],
];

/** { days, kind } for a product name: days is a number, NONE, or null when nothing matches. */
export function shelfLife(name) {
  const key = nameKey(name);
  if (!key) return { days: null, kind: null };
  for (const [pattern, days, kind] of RULES) if (pattern.test(key)) return { days, kind };
  return { days: null, kind: null };
}

/** YYYY-MM-DD plus whole days. */
export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ------------------------------------------------- shelf life per item
//
// Thomas, 28-10-2026: every product gets an average shelf life, so a purchase
// gets its date by itself. Stored on the item (migrations/0013_item_shelf.sql,
// op item.shelf): shelf_days unopened (KEEPS: years, no date), opened_days once
// opened (null: unknown), shelf_source who said so. A person's value is never
// overwritten by Claude's or a rule's (SHELF_RANK).

export const KEEPS = -1;
export const SHELF_DAYS_MAX = 1825;
export const SHELF_SOURCES = ["rule", "claude", "person"];
/** Higher wins: a lower source never replaces a higher one. */
export const SHELF_RANK = { rule: 1, claude: 2, person: 3 };

/** The item's own days unopened (a number, KEEPS included) or null when unknown. */
export function itemShelfDays(item) {
  const d = item?.shelf_days;
  return Number.isInteger(d) && (d === KEEPS || (d >= 1 && d <= SHELF_DAYS_MAX)) ? d : null;
}

/** The item's days once opened, or null. */
export function itemOpenedDays(item) {
  const d = item?.opened_days;
  return Number.isInteger(d) && d >= 1 && d <= SHELF_DAYS_MAX ? d : null;
}

/**
 * The estimated use-by date of something put in the house on `day`, or null
 * when it keeps (dry, tinned, frozen, KEEPS) or nothing is known about it.
 * Each argument is a name or an item ({ name, shelf_days }):
 *   1. an item's own shelf_days decides first, wherever it stands;
 *   2. then the RULES table on the names in the order given (an item counts
 *      by its name there), so "AH Kipfilet" says more than the item "kip";
 *   3. else null.
 */
export function estimateUseBy(day, ...names) {
  for (const n of names) {
    if (!n || typeof n !== "object") continue;
    const days = itemShelfDays(n);
    if (days !== null) return days === KEEPS ? null : addDays(day, days);
  }
  for (const n of names) {
    const name = n && typeof n === "object" ? n.name : n;
    if (!name) continue;
    const { days } = shelfLife(name);
    if (days === null) continue;
    return days === NONE ? null : addDays(day, days);
  }
  return null;
}

/**
 * Opened on `day`: the use-by is min(current, day + opened_days). Null
 * current means "keeps", so an opened jar gets its first date. Returns the
 * current date when opened_days is unknown.
 */
export function openedUseBy(current, day, openedDays) {
  if (!Number.isInteger(openedDays) || openedDays < 1) return current ?? null;
  const opened = addDays(day, openedDays);
  return current && current < opened ? current : opened;
}

// ---------------------------------------------- shelf life per product
//
// Thomas, 28-10-2026: "Melk 7 dagen? weet je wel hoe lang houdbare melk goed
// is?" A product carries the same three fields as an item
// (migrations/0016_product_shelf.sql, op product.shelf) and its values win
// over its item's: pass the product before the item to estimateUseBy.

/** Days once opened: the product's own, else the item's, else null. */
export function openedDaysOf(product, item) {
  return itemOpenedDays(product) ?? itemOpenedDays(item);
}

/** Days unopened: the product's own, else the item's (KEEPS included), else null. */
export function shelfDaysOf(product, item) {
  return itemShelfDays(product) ?? itemShelfDays(item);
}
