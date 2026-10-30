// Things the household never wants suggested, from any source: purchase
// history, receipts, bonus or folder offers. Every feature that proposes
// something to buy runs its candidates through this. The words are private
// household data (public/shared/excluded-words.js); tests bring their own
// with useExcludedWords.
import { nameKey } from "./ingredients.js";
import * as HOUSEHOLD from "./excluded-words.js";

let words, phrases, endings, lookalike;

/** Replace the word list (tests); without an argument the household's own again. */
export function useExcludedWords(list = HOUSEHOLD) {
  words = new Set(list.WORDS ?? []);
  phrases = [...(list.PHRASES ?? [])];
  endings = [...(list.ENDINGS ?? [])];
  lookalike = list.LOOKALIKE ? new RegExp(list.LOOKALIKE) : null;
}
useExcludedWords();

/** Does this product or list line name something the household never wants suggested? */
export function isExcluded(name) {
  const key = nameKey(name);
  if (!key) return false;
  if (phrases.some((p) => ` ${key} `.includes(` ${p} `))) return true;
  return key.split(" ").some((w) => words.has(w) || w.length > 5 && endings.some((e) => w.endsWith(e)));
}

/** A look-alike of an excluded thing (the list's own pattern): the importers leave it out too. */
export function isExcludedLookalike(name) {
  return Boolean(lookalike) && lookalike.test(String(name ?? ""));
}
