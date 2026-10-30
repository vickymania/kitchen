// Which item a name means: the item itself, an alias (item.alias) or a name
// merged away (item.merge), else the one item equal without spaces. Never
// fuzzy. Pure and import-free so the op engine (public/shared/ops.js, which
// re-exports these), the ingredient resolver (public/shared/ingredient-match.js)
// and the pantry share one lookup.

/**
 * The live item a merged item went into (item.merge sets merged_into on the
 * from-item's tombstone), following the chain: "Wc blok" -> "Toiletblok". A
 * live item is itself; a tombstone without merged_into, or a broken chain, is null.
 */
export function aliasTarget(items, item) {
  let cur = item;
  for (let hops = 0; cur && hops < 20; hops++) {
    if (!cur.deleted_at) return cur;
    if (!cur.merged_into) return null;
    cur = items[cur.merged_into];
  }
  return null;
}

/**
 * Every item a name could mean, in the order findItem trusts them:
 *   exact    the live item with that key, a live alias row (item.alias) or a
 *            merged-away item's tombstone with that key
 *   compact  the same without spaces ("minoesbrokken" is "Minoes brokken")
 * Each answer is the live item at the end of the chain (aliasTarget). Never
 * fuzzy: a typo must not land an import on the wrong item.
 */
export function itemsNamed(state, key) {
  const compact = key.replace(/ /g, "");
  const exact = new Map();
  const loose = new Map();
  const add = (map, item) => { if (item) map.set(item.id, item); };
  for (const i of Object.values(state.items)) {
    const hit = i.name_key === key ? exact : i.name_key.replace(/ /g, "") === compact ? loose : null;
    if (!hit) continue;
    if (!i.deleted_at) add(hit, i);
    else if (i.merged_into) add(hit, aliasTarget(state.items, i));
  }
  for (const a of Object.values(state.aliases ?? {})) {
    if (a.deleted_at) continue;
    const hit = a.name_key === key ? exact : a.name_key.replace(/ /g, "") === compact ? loose : null;
    if (hit) add(hit, aliasTarget(state.items, state.items[a.item_id]));
  }
  return { exact: [...exact.values()], compact: [...loose.values()] };
}

/**
 * The item a name means: the live item with that key, else an alias of that
 * name (an explicit one, item.alias, or a name merged away, item.merge), else
 * the one item whose name or alias is the same without spaces. Two different
 * items that differ only in spaces are ambiguous: null, never a guess. Every
 * op that takes a title (a receipt's purchase.add, entry.add, entry.update,
 * preference.set, deal_rule.set, item.rate, pantry.add, item.merge,
 * product.move) finds its item here.
 */
export function findItem(state, key) {
  if (!key) return null;
  const live = Object.values(state.items).find((i) => !i.deleted_at && i.name_key === key);
  if (live) return live;
  const { exact, compact } = itemsNamed(state, key);
  if (exact.length) return exact[0];
  return compact.length === 1 ? compact[0] : null;
}

