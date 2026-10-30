// The open list per store (28-10-2026: "wordt mijn lijstje per winkel
// beschreven?"). Pure, for the Android widget's route and any screen that
// wants the same groups.
import { resolveProduct } from "./preferences.js";
import { canonicalStore, sameStore } from "./stores.js";

/** The two stores Thomas uses most come first, then the rest A to Z, "anywhere" last. */
const FIRST = ["Albert Heijn", "Dirk"];

/**
 * Where a line is bought. In this order: the store of a product sold at one
 * store only ("haal bij Lidl"), the store chosen with "Ik ben bij…", the
 * store of the line's preferred product (the preference's own store, else
 * where that product was last bought). null = anywhere ("Overal").
 * resolved: resolveProduct() for this line, so it is computed once.
 */
export function lineStore(resolved, chosen = null) {
  if (resolved?.onlyAt) return resolved.onlyAt;
  if (chosen) return canonicalStore(chosen) || null;
  return canonicalStore(resolved?.why?.store || resolved?.product?.store || "") || null;
}

/** Compare two group stores: AH, Dirk, the others A to Z, null (anywhere) last. */
export function compareStores(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const rank = (s) => {
    const i = FIRST.findIndex((f) => sameStore(f, s));
    return i < 0 ? FIRST.length : i;
  };
  return rank(a) - rank(b) || a.localeCompare(b, "nl");
}

/**
 * Lines grouped by store: [[store | null, lines]] in compareStores order;
 * inside a group the lines keep the order they came in. storeOf(line) gives
 * a line's store (lineStore for list entries).
 */
export function groupByStore(lines, storeOf) {
  const groups = new Map();
  for (const line of lines) {
    const raw = storeOf(line);
    const store = raw ? canonicalStore(raw) : null;
    const key = store ?? "";
    if (!groups.has(key)) groups.set(key, [store, []]);
    groups.get(key)[1].push(line);
  }
  return [...groups.values()].sort(([a], [b]) => compareStores(a, b));
}

/** The open entries of a view grouped by store, each with its resolved product. */
export function listByStore(data, entries, chosen = null) {
  const lines = entries.map((entry) => {
    const resolved = resolveProduct(data, entry, chosen);
    return { entry, resolved, store: lineStore(resolved, chosen) };
  });
  return groupByStore(lines, (l) => l.store);
}

/** The basket starts open up to this many ticked lines; longer, it starts folded. */
export const BASKET_OPEN_MAX = 5;

/** Whether the basket shows its lines: the person's own choice, else open while it is short. */
export function basketOpen(count, choice = null) {
  return choice === null || choice === undefined ? count <= BASKET_OPEN_MAX : Boolean(choice);
}

/**
 * Groups in the web list's order (28-10-2026: "net als de widget").
 * No store chosen: compareStores (AH, Dirk, the others, "Overal" last). With
 * "Ik ben bij…" set: that store's group first, then "Overal" (bought here
 * too), then the other stores in compareStores order. The groups' own order
 * of lines is kept.
 */
export function orderGroups(groups, chosen = null) {
  const shop = chosen ? canonicalStore(chosen) : "";
  if (!shop) return [...groups].sort(([a], [b]) => compareStores(a, b));
  const rank = (s) => (s !== null && sameStore(s, shop) ? 0 : s === null ? 1 : 2);
  return [...groups].sort(([a], [b]) => rank(a) - rank(b) || compareStores(a, b));
}

/**
 * The web list, top to bottom (28-10-2026): the basket (the ticked
 * lines, last ticked first) on top, then the open lines per store. A line
 * goes under the store of the product resolveProduct picks for the chosen
 * store (store_only first: "Haal bij Lidl"), else "Overal" (store null).
 * With a store chosen, every other store's group is `away` ("Andere winkel:
 * Lidl"), the same as storeGroups() in public/shared/preferences.js.
 * Returns [{ kind: "basket", lines } | { kind: "store", store, away, lines }],
 * lines as { entry, resolved }. open lines keep the order they came in.
 */
export function listLayout(data, entries, chosen = null) {
  const shop = chosen ? canonicalStore(chosen) : "";
  const done = entries.filter((e) => e.checked_at)
    .sort((a, b) => String(b.checked_at).localeCompare(String(a.checked_at)));
  const open = entries.filter((e) => !e.checked_at)
    .map((entry) => {
      const resolved = resolveProduct(data, entry, shop || null);
      return { entry, resolved, store: lineStore(resolved) };
    });
  const groups = orderGroups(groupByStore(open, (l) => l.store), shop || null);
  const out = [];
  if (done.length) out.push({ kind: "basket", lines: done.map((entry) => ({ entry, resolved: resolveProduct(data, entry, shop || null) })) });
  for (const [store, lines] of groups) {
    out.push({
      kind: "store",
      store,
      away: Boolean(shop && store !== null && !sameStore(store, shop)),
      lines: lines.map(({ entry, resolved }) => ({ entry, resolved })),
    });
  }
  return out;
}
