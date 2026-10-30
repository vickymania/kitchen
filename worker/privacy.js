// Private items (items.private_to, migrations/0028_private_items.sql; Thomas,
// 30-10-2026: "Niemand anders in mijn huishouden mag dat item überhaupt op
// mijn lijstje zien staan"). For every member but the owner such an item and
// everything about it does not exist. This file says, per member, what is
// hidden and whether a row or a line of text is about it; worker/ops-store.js
// uses it for /api/sync and /api/ops, worker/widget.js for the widget.
import { nameKey } from "../public/shared/ingredients.js";
import { offerMatches, productOfferMatches } from "../public/shared/offers.js";

// Items private to someone else, their products, and their other names: one
// statement (a handful of rows; items_private is a partial index).
const HIDDEN_SQL = `
SELECT 'i' AS k, id, name, name_key AS a, NULL AS b, NULL AS c, NULL AS item_id FROM items
 WHERE household_id = ?1 AND private_to IS NOT NULL AND private_to <> ?2
UNION ALL
SELECT 'p', p.id, p.name, p.brand, p.size, p.product_key, p.item_id FROM products p JOIN items i ON i.id = p.item_id
 WHERE p.household_id = ?1 AND i.household_id = ?1 AND i.private_to IS NOT NULL AND i.private_to <> ?2
UNION ALL
SELECT 'a', a.id, a.name, a.name_key, NULL, NULL, a.item_id FROM item_aliases a JOIN items i ON i.id = a.item_id
 WHERE a.household_id = ?1 AND i.household_id = ?1 AND i.private_to IS NOT NULL AND i.private_to <> ?2`;

/** The statement that reads what `memberId` may not see (bind order fixed). */
export const hiddenStatement = (db, hh, memberId) => db.prepare(HIDDEN_SQL).bind(hh, String(memberId ?? ""));

/**
 * The answer of hiddenStatement as { items: Set, products: Map(id -> product),
 * names: [name keys of the items and their other names], empty }.
 */
export function hiddenOf(rows = []) {
  const items = new Set();
  const products = new Map();
  const names = new Set();
  for (const r of rows) {
    if (r.k === "i") {
      items.add(r.id);
      if (r.a) names.add(r.a);
    } else if (r.k === "p") {
      products.set(r.id, { id: r.id, name: r.name, brand: r.a, size: r.b, product_key: r.c, item_id: r.item_id });
    } else if (r.k === "a" && r.a) {
      names.add(r.a);
    }
  }
  return { items, products, names: [...names], empty: items.size === 0 };
}

/** What `memberId` may not see in household `hh`. */
export async function loadHidden(db, hh, memberId) {
  const { results } = await hiddenStatement(db, hh, memberId).all();
  return hiddenOf(results);
}

/** Does this text name a hidden item (every word of a name or other name, as offers match)? */
export function namesHidden(text, hidden) {
  if (hidden.empty || typeof text !== "string" || !text.trim()) return false;
  const probe = { name: text, brand: "" };
  return hidden.names.some((key) => offerMatches(key, probe));
}

/** Is this offer about a hidden item: its name, an other name, or one of its products? */
function offerHidden(offer, hidden) {
  if (namesHidden(`${offer.brand ?? ""} ${offer.name ?? ""}`, hidden)) return true;
  for (const p of hidden.products.values()) if (productOfferMatches(p, offer)) return true;
  return false;
}

/** A receipt line (name, brand, size) of a hidden product or naming a hidden item. */
function lineHidden(line, hidden) {
  if (!line) return false;
  const key = [line.name, line.brand, line.size].map((v) => nameKey(v ?? "")).join("|");
  for (const p of hidden.products.values()) if (p.product_key === key) return true;
  return namesHidden(`${line.brand ?? ""} ${line.name ?? ""}`, hidden);
}

const textOf = (line) => (typeof line === "string" ? line : line?.text ?? "");

/**
 * Is a whole row hidden from this member? Rows of an item (item_id), of a
 * product (product_id), the item and products themselves, offers about it,
 * changelog rows about it.
 */
export function rowHidden(kind, row, hidden) {
  if (hidden.empty || !row) return false;
  if (kind === "items") return hidden.items.has(row.id);
  if (kind === "products" && hidden.products.has(row.id)) return true;
  if (kind === "offers") return offerHidden(row, hidden);
  if (row.item_id && hidden.items.has(row.item_id)) return true;
  if (row.product_id && hidden.products.has(row.product_id)) return true;
  if (kind === "auto_changes") return namesHidden(row.name, hidden) || namesHidden(row.target, hidden);
  return false;
}

/**
 * The row as this member sees it: receipts without the hidden lines, nightly
 * reports without the lines that name a hidden item, a changelog row's and a
 * recipe's links without the lines of one. Other rows come back as they are.
 */
export function rowFor(kind, row, hidden) {
  if (hidden.empty || !row) return row;
  if (kind === "receipts" && Array.isArray(row.lines)) {
    return { ...row, lines: row.lines.filter((l) => !lineHidden(l, hidden)) };
  }
  if (kind === "reviews") {
    const out = { ...row };
    for (const f of ["fixed", "decide", "errors"]) {
      if (Array.isArray(out[f])) out[f] = out[f].filter((l) => !namesHidden(textOf(l), hidden) && !namesHidden(l?.undo, hidden));
    }
    return out;
  }
  if (kind === "auto_changes" && Array.isArray(row.lines)) {
    return { ...row, lines: row.lines.filter((l) => !(l?.item_id && hidden.items.has(l.item_id))) };
  }
  if (kind === "recipes" && Array.isArray(row.ingredient_links?.lines)) {
    return { ...row, ingredient_links: { ...row.ingredient_links, lines: row.ingredient_links.lines.filter((l) => !(l?.item_id && hidden.items.has(l.item_id))) } };
  }
  return row;
}

/** Every string in an op (a few levels deep): ids it names, in arrays and objects too. */
function* stringsOf(v, depth = 0) {
  if (typeof v === "string") yield v;
  else if (v && typeof v === "object" && depth < 4) for (const x of Object.values(v)) yield* stringsOf(x, depth + 1);
}

/**
 * Before an op of this member runs on the server: refuse it as not_found when
 * it names something hidden (an id of a hidden row it loaded, a hidden item
 * or product, or a typed name that means a hidden item), else drop every
 * hidden row from the loaded state so the engine never sees them.
 * find(state, key): the engine's findItem. Returns the ids it dropped, or
 * "not_found".
 */
export function guardOp(state, op, hidden, find) {
  if (hidden.empty) return new Set();
  const dropped = new Set([...hidden.items, ...hidden.products.keys()]);
  for (const [kind, rows] of Object.entries(state)) {
    for (const row of Object.values(rows ?? {})) if (rowHidden(kind, row, hidden)) dropped.add(row.id);
  }
  for (const s of stringsOf(op)) if (s !== op.op_id && dropped.has(s)) return "not_found";
  // A typed name that means a hidden item (its name, another name, without spaces).
  for (const f of ["title", "into_title", "name"]) {
    if (op.type === "member.update" || op.type?.startsWith("recipe.")) break;
    const v = op[f];
    if (typeof v !== "string" || !v.trim()) continue;
    const key = nameKey(v);
    const hit = find(state, key);
    if (hit && hidden.items.has(hit.id)) return "not_found";
    const compact = key.replace(/ /g, "");
    if (Object.values(state.items).some((i) => hidden.items.has(i.id) && i.name_key?.replace(/ /g, "") === compact)) return "not_found";
    if (Object.values(state.aliases ?? {}).some((a) => hidden.items.has(a.item_id) && a.name_key?.replace(/ /g, "") === compact)) return "not_found";
  }
  for (const [kind, rows] of Object.entries(state)) {
    for (const [rid, row] of Object.entries(rows ?? {})) if (rowHidden(kind, row, hidden)) delete rows[rid];
  }
  return dropped;
}

/** After the engine ran: did it write anything hidden after all? (A last net.) */
export function touchesHidden(state, changed, dropped, hidden) {
  if (hidden.empty) return false;
  return changed.some(([kind, rid]) => dropped.has(rid) || rowHidden(kind, state[kind]?.[rid], hidden));
}
