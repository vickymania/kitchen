// GET /api/widget: the Android widget's list, ready to show (Thomas,
// 28-10-2026: "geen details", "per winkel"). The open lines grouped by store,
// each with its note, recipes, the product to buy (public/shared/preferences.js)
// and the best current offer. One batch of reads, only the rows those lines
// need. With ?since=<rev> and nothing changed it answers from the household
// counter alone (one row), like an idle /api/sync poll.
import { fromRow } from "./ops-store.js";
import { resolveProduct, lastPrice, purchasesByProduct } from "../public/shared/preferences.js";
import { currentOffers, lineOffers, isExcludedOffer, isCoupon, brandedName } from "../public/shared/offers.js";
import { isRegularStore } from "../public/shared/deals.js";
import { isExcluded } from "../public/shared/excluded.js";
import { groupByStore, lineStore } from "../public/shared/list-groups.js";
import { neededSoon, notYetOp, tickEntry } from "../public/shared/needed-soon.js";
import { amsterdamDay } from "./offers.js";
import { isDealNote } from "../public/shared/store-prices.js";
import { purchaseScores } from "../public/shared/suggest.js";

const OPEN = "household_id = ? AND checked_at IS NULL AND deleted_at IS NULL";
const OPEN_ITEMS = `SELECT item_id FROM list_entries WHERE ${OPEN} AND item_id IS NOT NULL`;
const LIVE_PREFS = `household_id = ? AND deleted_at IS NULL AND item_id IN (${OPEN_ITEMS})`;
// "Al nodig?" (public/shared/needed-soon.js): the pantry rows with something
// left, the pantry events, the lines in the basket (on the list too, so not a
// hint), the items those and the open lines name, and the live recipes'
// ingredients ("too little for a recipe", recipe-only).
const STOCK = "household_id = ? AND deleted_at IS NULL AND amount > 0";
const EVENTS = "household_id = ? AND deleted_at IS NULL";
const BASKET = "household_id = ? AND checked_at IS NOT NULL AND deleted_at IS NULL";
const LIVE_ITEMS = "SELECT item_id FROM list_entries WHERE household_id = ? AND deleted_at IS NULL AND item_id IS NOT NULL";
const SOON_ITEMS = `household_id = ? AND deleted_at IS NULL AND (id IN (SELECT item_id FROM pantry WHERE ${STOCK})
  OR id IN (SELECT item_id FROM pantry_events WHERE ${EVENTS}) OR id IN (${LIVE_ITEMS}))`;

const byId = (rows, kind) => Object.fromEntries(rows.map((r) => [r.id, fromRow(kind, r)]));

/**
 * The widget's payload for one household, or { rev, unchanged: true } when
 * nothing changed after `since`. today = the Dutch day the offers go by.
 */
export async function widgetList(db, hh, since = 0, today = amsterdamDay()) {
  // The rev first, like pull(): a change in between shows up next time instead of being skipped.
  const head = await db.prepare("SELECT rev FROM households WHERE id = ?").bind(hh).first();
  if (since > 0 && (head?.rev ?? 0) <= since) return { rev: head?.rev ?? 0, unchanged: true };
  const [entries, preferences, products, purchases, offers, pantry, events, items, recipes, basket] = await db.batch([
    db.prepare(`SELECT * FROM list_entries WHERE ${OPEN}`).bind(hh),
    db.prepare(`SELECT * FROM preferences WHERE ${LIVE_PREFS}`).bind(hh, hh),
    db.prepare(`SELECT * FROM products WHERE household_id = ? AND deleted_at IS NULL
      AND id IN (SELECT product_id FROM preferences WHERE ${LIVE_PREFS})`).bind(hh, hh, hh),
    // The newest price per product and store is all lastPrice() looks at.
    db.prepare(`SELECT id, product_id, store, qty, price_cents, MAX(bought_on) AS bought_on FROM purchases
      WHERE household_id = ? AND deleted_at IS NULL AND price_cents IS NOT NULL AND item_id IN (${OPEN_ITEMS})
      GROUP BY product_id, store`).bind(hh, hh),
    db.prepare("SELECT * FROM offers WHERE household_id = ? AND deleted_at IS NULL AND valid_until >= ?").bind(hh, today),
    db.prepare(`SELECT * FROM pantry WHERE ${STOCK}`).bind(hh),
    db.prepare(`SELECT * FROM pantry_events WHERE ${EVENTS}`).bind(hh),
    db.prepare(`SELECT * FROM items WHERE ${SOON_ITEMS}`).bind(hh, hh, hh, hh),
    db.prepare("SELECT id, title, servings, ingredients FROM recipes WHERE household_id = ? AND deleted_at IS NULL").bind(hh),
    db.prepare(`SELECT id, item_id, title, checked_at FROM list_entries WHERE ${BASKET}`).bind(hh),
  ]);
  const data = {
    preferences: byId(preferences.results, "preferences"),
    products: byId(products.results, "products"),
  };
  const byProduct = purchasesByProduct(byId(purchases.results, "purchases"));
  const current = currentOffers(byId(offers.results, "offers"), today);
  const open = entries.results.map((r) => fromRow("entries", r)).sort((a, b) => b.created_at.localeCompare(a.created_at));

  const lines = open.map((e) => {
    const resolved = resolveProduct(data, e, null);
    // Never show or promote an excluded thing: such a product is not shown as "buy this".
    const product = resolved && !isExcluded(`${resolved.product.brand ?? ""} ${resolved.product.name}`) ? resolved.product : null;
    const store = lineStore(product ? resolved : null);
    const { mine, named } = lineOffers(e.title, product, current, null);
    // His own product on offer anywhere; else something with the line's name at AH or Dirk.
    const offer = mine[0] ?? named.find((o) => isRegularStore(o.store)) ?? null;
    return {
      store,
      line: {
        id: e.id,
        title: e.title,
        amounts: e.amounts ?? [],
        // An offer Deals once wrote into the note is old text: the widget shows the current offer itself.
        note: isDealNote(e.note) ? "" : e.note ?? "",
        recipes: (e.sources ?? []).map((s) => s?.title).filter(Boolean),
        product: product && {
          name: product.name,
          brand: product.brand ?? "",
          size: product.size ?? "",
          store: product.store ?? "",
          store_only: Boolean(product.store_only),
          last_price_cents: lastPrice(product, store, byProduct),
          for_recipe: resolved.why?.recipe ?? null,
        },
        only_at: product ? resolved.onlyAt : null,
        offer: offer && !isExcludedOffer(offer) ? {
          store: offer.store,
          name: [offer.brand, offer.name].filter(Boolean).join(" "),
          // A Lidl Plus coupon says so in the deal text: the widget's payload keeps its shape.
          deal: [isCoupon(offer) ? "Lidl Plus-coupon" : null, offer.deal].filter(Boolean).join(" · "),
          price_cents: offer.price_cents ?? null,
          until: offer.valid_until,
          mine: mine.includes(offer),
        } : null,
      },
    };
  });

  // A countdown moves with the day, not the rev: `day` lets the phone ask
  // for the whole payload again on a new day (ListState.refresh).
  const stock = {
    entries: Object.fromEntries([...open, ...basket.results.map((r) => fromRow("entries", r))].map((e) => [e.id, e])),
    pantry: byId(pantry.results, "pantry"),
    pantry_events: byId(events.results, "pantry_events"),
    items: byId(items.results, "items"),
    recipes: byId(recipes.results, "recipes"),
  };
  const soon = neededSoon(stock, today);

  return {
    rev: head?.rev ?? 0,
    day: today,
    count: lines.length,
    groups: groupByStore(lines, (l) => l.store).map(([store, group]) => ({ store, lines: group.map((l) => l.line) })),
    // "Al nodig?" with its "Nog niet" ready to send to /api/ops as it is
    // (notYetOp; the widget adds only the op_id). A new row's id is one per
    // item and day, so a second tap or a retry never adds twice. `tick` is the
    // list line the row's box makes (tickEntry); the widget sends it as
    // tickOps does: entry.add + entry.check of one new line, its own ids.
    needed_soon: soon.map((n) => ({
      key: n.key, name: n.name, code: n.code, amount: n.amount,
      days_left: n.days_left === null ? null : Math.floor(n.days_left), on: n.on,
      not_yet: notYetOp(stock, today, n, () => `pn-${today}-${n.item_id}`.slice(0, 64)),
      tick: tickEntry(n),
    })),
  };
}

// The widget's add dialog suggests names while typing, offline too (1.6,
// Thomas 30-10-2026), with the same tiers as the add box (public/shared/
// suggest.js; the Kotlin twin is Suggest.kt). It cannot ask per keystroke
// (no signal in the shop, and every request costs), so it keeps this list:
// the live items bought most often and recently, each with its other names
// and its any-store product. Never an excluded thing (the widget suggests,
// so it gets none at all; an exact excluded name still links on the server).
// Fetched at most once a day (the `day` it was made for) and after linking.
export const NAMES_MAX = 600;

export async function widgetNames(db, hh, today = amsterdamDay()) {
  const [items, aliases, purchases, preferred] = await db.batch([
    db.prepare("SELECT id, name FROM items WHERE household_id = ? AND deleted_at IS NULL").bind(hh),
    db.prepare("SELECT item_id, name FROM item_aliases WHERE household_id = ? AND deleted_at IS NULL").bind(hh),
    db.prepare("SELECT item_id, bought_on FROM purchases WHERE household_id = ? AND deleted_at IS NULL AND item_id IS NOT NULL").bind(hh),
    db.prepare(`SELECT pr.item_id, p.name, p.brand, p.size FROM preferences pr
      JOIN products p ON p.id = pr.product_id AND p.household_id = pr.household_id AND p.deleted_at IS NULL
      WHERE pr.household_id = ? AND pr.deleted_at IS NULL AND pr.store = '' AND pr.recipe_id = ''`).bind(hh),
  ]);
  const scores = purchaseScores(purchases.results, today);
  const other = new Map();
  for (const a of aliases.results) {
    if (isExcluded(a.name)) continue;
    other.set(a.item_id, [...(other.get(a.item_id) ?? []), a.name]);
  }
  const product = new Map(preferred.results.filter((p) => !isExcluded(`${p.brand ?? ""} ${p.name}`))
    .map((p) => [p.item_id, [brandedName(p), p.size].filter(Boolean).join(" · ")]));
  const names = items.results
    .filter((i) => !isExcluded(i.name))
    .map((i) => ({ id: i.id, name: i.name, score: scores.get(i.id) ?? 0 }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "nl"))
    .slice(0, NAMES_MAX)
    .map(({ id, name, score }) => ({
      i: id, n: name, s: Math.round(score * 100) / 100,
      ...(other.has(id) ? { a: other.get(id).sort() } : {}),
      ...(product.has(id) ? { p: product.get(id) } : {}),
    }));
  return { day: today, names };
}
