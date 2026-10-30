// Store names. A receipt says "AH" or "DIRK VAN DEN BROEK", the folders say
// "Albert Heijn" and "Dirk": one name per store, so a preference "bij Dirk",
// a purchase at "DIRK" and an offer from "Dirk" are about the same shop.
// Also the pure part of the "Ik ben bij..." choice on the list (the device's
// copy lives in public/app/shop.js).
import { nameKey } from "./ingredients.js";

// nameKey of a way of writing it -> the one name (the folders' spelling).
const ALIASES = {
  "ah": "Albert Heijn", "albert heijn": "Albert Heijn", "ah to go": "Albert Heijn", "albertheijn": "Albert Heijn",
  "dirk": "Dirk", "dirk van den broek": "Dirk", "dirk vd broek": "Dirk",
  "jumbo": "Jumbo", "lidl": "Lidl", "aldi": "ALDI", "plus": "PLUS", "coop": "Coop", "vomar": "Vomar",
  "hoogvliet": "Hoogvliet", "dekamarkt": "DekaMarkt", "spar": "SPAR", "poiesz": "Poiesz", "nettorama": "Nettorama",
  "kruidvat": "Kruidvat", "etos": "Etos", "action": "Action",
};

/** The one name of a store, or "" for none. An unknown store keeps its own spelling. */
export function canonicalStore(name) {
  if (typeof name !== "string") return "";
  const clean = name.replace(/\s+/g, " ").trim().slice(0, 40);
  return Object.hasOwn(ALIASES, nameKey(clean)) ? ALIASES[nameKey(clean)] : clean;
}

/** A store's name, also as a brand: "AH Tortilla chips" is only sold at Albert Heijn. */
export const isStoreName = (name) => typeof name === "string" && Object.hasOwn(ALIASES, nameKey(name));

/** Two spellings of one store. Empty is no store, never the same as one. */
export function sameStore(a, b) {
  const x = nameKey(canonicalStore(a));
  return Boolean(x) && x === nameKey(canonicalStore(b));
}

/** The order of the "Ik ben bij..." choice: the two Thomas uses most, then A to Z. */
const FIRST = ["Albert Heijn", "Dirk"];

/** Every store named in these lists, once, AH and Dirk first. */
export function knownStores(...lists) {
  const seen = new Map();
  for (const list of lists) {
    for (const s of list) {
      const name = canonicalStore(s);
      if (name && !seen.has(nameKey(name))) seen.set(nameKey(name), name);
    }
  }
  for (const f of FIRST) if (!seen.has(nameKey(f))) seen.set(nameKey(f), f);
  return [...seen.values()].sort((a, b) => {
    const ia = FIRST.indexOf(a);
    const ib = FIRST.indexOf(b);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return a.localeCompare(b, "nl");
  });
}

/** The choice holds for one shopping trip: the next one starts without a store. */
export const STORE_CHOICE_HOURS = 12;

/**
 * The saved choice { store, at } (at: ms), or null once it is older than
 * STORE_CHOICE_HOURS, from the future (a clock that jumped), or malformed.
 */
export function storeChoice(saved, now = Date.now()) {
  if (!saved || typeof saved !== "object" || typeof saved.store !== "string" || !Number.isFinite(saved.at)) return null;
  if (saved.at > now + 60_000 || now - saved.at > STORE_CHOICE_HOURS * 3_600_000) return null;
  return canonicalStore(saved.store) || null;
}
