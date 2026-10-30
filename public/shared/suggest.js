// The add box's suggestions (30-10-2026: "Als ik iets op mijn lijstje
// zet moet hij het echt aan het juiste product koppelen"). "Mino" offers
// Minoes brokken and Minoes brood; "Pluiz" offers Minoes brokken, because
// "Pluizenbolbrokkenman" is another name of it; "mines brokkken" still finds
// it. The web app's add box and "Koppel aan…" use this; worker/widget.js
// sends the names the widget matches with its Kotlin twin (Suggest.kt).
//
// Match tiers, best first:
//   0 exact    the name or an alias, as nameKey has it (case, accents, hyphens)
//   1 compact  the same without spaces: "minoesbrokken" is "Minoes brokken"
//   2 prefix   the typed words start words of the name ("mino", "brokk"), or
//              the space-free text starts the space-free name
//   3 fuzzy    a typo: Damerau-Levenshtein within FUZZY_MAX of the length,
//              on the whole space-free text or word by word
// Inside a tier: bought often and recently first, then alphabetical.
//
// Only tiers 0 and 1 may link by themselves (Enter): that is findItem in
// public/shared/ops.js, which the server runs too. A fuzzy match is only ever
// offered ("Bedoel je …?"), never applied. An excluded thing is suggested only when the
// typed text names it exactly (tiers 0 and 1), never on its own.
import { nameKey } from "./ingredients.js";
import { isExcluded } from "./excluded.js";
import { aliasTarget, findItem } from "./ops.js";

export const SUGGEST_MAX = 6;
// Half-life of a purchase in the ranking, in days.
export const HALF_LIFE_DAYS = 180;

/** How many typos a text of this length may have: none up to 3 letters, 1 up to 5, else 2. */
export function fuzzyMax(length) {
  return length <= 3 ? 0 : length <= 5 ? 1 : 2;
}

/**
 * Damerau-Levenshtein (optimal string alignment) distance between a and b,
 * or max + 1 as soon as it is certainly more than max.
 */
export function editDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Within the typo budget of `typed` against the whole of `word`; with
 * `prefix`, also one typo against its start (still typing: "minor bro").
 */
function near(typed, word, prefix) {
  const max = fuzzyMax(typed.length);
  if (!max) return false;
  if (editDistance(typed, word, max) <= max) return true;
  if (!prefix || typed.length < 5) return false;
  for (let n = typed.length - 1; n <= typed.length + 1; n++) {
    if (n > 0 && n < word.length && editDistance(typed, word.slice(0, n), 1) <= 1) return true;
  }
  return false;
}

/** The parts of a typed text the tiers compare. */
export function typedParts(text) {
  const key = nameKey(text);
  return { key, compact: key.replace(/ /g, ""), words: key ? key.split(" ") : [] };
}

/** The tier of one name (its parts) for a typed text, or null. */
export function matchTier(t, n) {
  if (!t.compact || !n.compact) return null;
  if (n.key === t.key) return 0;
  if (n.compact === t.compact) return 1;
  if (n.compact.startsWith(t.compact)) return 2;
  if (t.words.every((w) => n.words.some((x) => x.startsWith(w)))) return 2;
  if (near(t.compact, n.compact, true)) return 3;
  // Word by word: each typed word starts a word of the name or is a typo of
  // one; a word of up to 3 letters must start one exactly ("ui" never finds "jus").
  if (t.words.length && t.words.every((w) => n.words.some((x) => x.startsWith(w) || near(w, x, true)))) return 3;
  return null;
}

const nameParts = (text) => {
  const key = nameKey(text);
  return { text, key, compact: key.replace(/ /g, ""), words: key.split(" ") };
};

/** Per item id: Σ 0.5^(age / HALF_LIFE_DAYS) over its purchases: often and recent count most. */
export function purchaseScores(purchases, today) {
  const now = Date.parse(`${today}T12:00:00Z`);
  const out = new Map();
  for (const p of Object.values(purchases ?? {})) {
    if (p.deleted_at || !p.item_id || !p.bought_on) continue;
    const age = Math.max(0, (now - Date.parse(`${p.bought_on}T12:00:00Z`)) / 864e5);
    out.set(p.item_id, (out.get(p.item_id) ?? 0) + 0.5 ** (age / HALF_LIFE_DAYS));
  }
  return out;
}

const CACHE = new WeakMap();

/**
 * The candidates of a view: every live item with its own name and its
 * aliases (live alias rows, merged names included), and its score. Cached
 * per view object (the phone builds a new view on every change) and the
 * number of rows, for a caller that changes its view in place.
 */
export function nameIndex(view, today) {
  const size = (rows) => Object.keys(rows ?? {}).length;
  const sig = `${today}|${size(view.items)}|${size(view.aliases)}|${size(view.purchases)}`;
  const hit = CACHE.get(view);
  if (hit && hit.sig === sig) return hit.list;
  const scores = purchaseScores(view.purchases, today);
  const byItem = new Map();
  for (const item of Object.values(view.items ?? {})) {
    if (item.deleted_at) continue;
    byItem.set(item.id, { item, score: scores.get(item.id) ?? 0, names: [nameParts(item.name)] });
  }
  for (const a of Object.values(view.aliases ?? {})) {
    if (a.deleted_at) continue;
    const to = aliasTarget(view.items ?? {}, view.items?.[a.item_id]);
    const c = to && byItem.get(to.id);
    if (c) c.names.push({ ...nameParts(a.name), alias: true });
  }
  const list = [...byItem.values()];
  CACHE.set(view, { sig, list });
  return list;
}

/**
 * Up to `limit` suggestions for a typed text: [{ item, tier, via, score }],
 * via = the alias it matched through (null for the item's own name).
 * `except`: an item id to leave out (the line's own item, for "Koppel aan…").
 */
export function suggest(view, text, { limit = SUGGEST_MAX, today = new Date().toISOString().slice(0, 10), except = null } = {}) {
  const t = typedParts(text);
  if (!t.compact) return [];
  const out = [];
  for (const c of nameIndex(view, today)) {
    if (c.item.id === except) continue;
    let best = null;
    for (const n of c.names) {
      const tier = matchTier(t, n);
      if (tier === null) continue;
      if (!best || tier < best.tier || (tier === best.tier && best.n.alias && !n.alias)) best = { tier, n };
    }
    if (!best) continue;
    // Never an excluded thing on its own: only when the text names it exactly.
    if (best.tier > 1 && (isExcluded(c.item.name) || isExcluded(best.n.text))) continue;
    out.push({ item: c.item, tier: best.tier, via: best.n.alias ? best.n.text : null, score: c.score });
  }
  const collator = new Intl.Collator("nl", { sensitivity: "base", numeric: true });
  out.sort((a, b) => a.tier - b.tier || b.score - a.score || collator.compare(a.item.name, b.item.name));
  return out.slice(0, limit);
}

/**
 * The item Enter links to by itself: the same answer as the server's
 * findItem (exact name or alias, else the one item equal without spaces).
 * Never a fuzzy one.
 */
export function exactItem(view, text) {
  const key = nameKey(text);
  return key ? findItem({ items: view.items ?? {}, aliases: view.aliases ?? {} }, key) : null;
}

/**
 * "Bedoel je Minoes brokken?" for a line that made a new item: the best
 * other item its typed text matches by prefix or typo, or null.
 */
export function didYouMean(view, text, itemId, opts = {}) {
  return suggest(view, text, { ...opts, limit: 1, except: itemId })[0] ?? null;
}
