// Usage rates that learn (30-10-2026: "zo min mogelijk zelf instellen
// en een zo slim mogelijke app"). Every counted-down item (public/shared/
// pantry.js, rowRate: a person's rate, Claude's estimate or the default table)
// moves its rate toward what the household really does. A person's rate
// learns too (he said so); setting one by hand restarts the learning from that
// value (item.rate, rate_samples 0).
//
// A signal compares how long the stock was predicted to last with how long it
// really lasted, and gives an implied rate. The new rate is the old one moved
// toward it by the signal's weight, never more than MAX_STEP in one signal:
//   strong  "op" (pantry.use "used" that leaves nothing of the item): the real
//           time from the stock's start to empty. implied = stored / days
//   middle  the item put on the list (entry.add, also the "Al nodig?" tick)
//           while the pantry predicted lots left or ran out long ago: it is
//           nearly empty now (LIST_LEAD_DAYS left)
//   middle  "Nog niet" (pantry.update with why "not_yet"): it lasts at least
//           NOT_YET_DAYS longer than predicted
//   light   a receipt rebuy without the item on the list: maybe nearly empty,
//           maybe stocking up. Ignored on offer, for several at once, and when
//           more than REBUY_HIGH_DAYS were predicted left
// "Weggegooid" is waste, not use: it never teaches a rate (eating it was not
// what emptied the stock; counting it would make the rate too fast). Cooking
// is a recipe's use, not the steady one: also never a signal.
//
// Pure functions: the op engine (public/shared/ops.js) calls them with the
// op's own day and the state's rows, so the phone and the worker learn the
// same thing. Nothing here reads the clock.
import { drainRows, RATE_MIN, RATE_MAX } from "./pantry.js";
import { isExcluded } from "./excluded.js";

/** Which strength each signal has. */
export const SIGNALS = { op: "strong", list: "middle", not_yet: "middle", rebuy: "light" };
/** How far one signal moves the rate toward what it implies (exponential smoothing). */
export const WEIGHTS = { strong: 0.5, middle: 0.3, light: 0.15 };
/** One signal never changes a rate by more than this: at most x1.25, at least /1.25. */
export const MAX_STEP = 0.25;
/** A stock younger than this teaches nothing (a mistap, a same-day correction). */
export const MIN_SIGNAL_DAYS = 3;
/** Put on the list: about this many days of stock are assumed left. */
export const LIST_LEAD_DAYS = 3;
/** Put on the list within this many days of the predicted end (before or after): the prediction was right, no signal. */
export const LIST_SLACK_DAYS = 7;
/** A rebuy while more than this many days were predicted left is stocking up: no signal. */
export const REBUY_HIGH_DAYS = 14;
/** "Nog niet": the days of use it adds (public/shared/needed-soon.js notYetOp). */
export const NOT_YET_DAYS = 3;
/** A unit price this much under the usual one is an offer: a rebuy on offer teaches nothing. */
export const OFFER_DROP = 0.15;
/** The usual price: the median unit price of the item's last this many priced purchases. */
export const OFFER_HISTORY = 10;
/** At least this many earlier priced purchases before a price can say "on offer". */
export const OFFER_MIN_HISTORY = 2;

const DAY_MS = 86_400_000;
const dayNumber = (day) => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
const live = (r) => r && !r.deleted_at;

/**
 * One item's stock on `day` as the countdown sees it, or null when it is not
 * counted down (or a row's amount was set after `day`):
 * { day, per_day, source, start, days, stored, left, days_left, empty_on, lasts }
 *   start / days   the oldest row's anchor and the days since
 *   stored         what the rows held at their anchors (used up by now if left is 0)
 *   left           what is predicted left today; days_left how long that lasts
 *   empty_on       the day the last row was predicted to run out (left 0)
 *   lasts          predicted days from start to empty
 * rows: the item's rows (live ones are used).
 */
export function stockSnapshot(rows, item, day) {
  if (!item) return null;                     // rowRate below: 0 ("niet aftellen") and excluded things are never counted down
  const list = rows.filter((r) => live(r) && r.added_on);
  const drained = drainRows(list, item, day);
  const rated = list.filter((r) => drained.get(r.id));
  if (!rated.length) return null;
  const today = dayNumber(day);
  const anchors = rated.map((r) => dayNumber(r.amount_on || r.added_on));
  if (anchors.some((a) => a > today)) return null;
  const oldest = [...rated].sort((a, b) => a.added_on.localeCompare(b.added_on) || a.id.localeCompare(b.id))[0];
  const start = Math.min(...anchors);
  let left = 0;
  let daysLeft = 0;
  let emptyOn = null;
  let stored = 0;
  for (const r of rated) {
    const cur = drained.get(r.id);
    stored += Math.max(0, Number(r.amount) || 0);
    left += cur.amount;
    if (cur.amount > 0) daysLeft = Math.max(daysLeft, cur.days_left);
    else if (!emptyOn || cur.empty_on > emptyOn) emptyOn = cur.empty_on;
  }
  const days = today - start;
  const lasts = left > 0 ? days + daysLeft : dayNumber(emptyOn) - start;
  return {
    day, per_day: drained.get(oldest.id).per_day, source: drained.get(oldest.id).source,
    start, days, stored, left, days_left: left > 0 ? daysLeft : 0, empty_on: left > 0 ? null : emptyOn, lasts,
  };
}

/**
 * The rate a signal implies, or null when it says nothing:
 *   op       stored / days (the stock lasted `days`)
 *   list     per_day x lasts / (days + LIST_LEAD_DAYS), outside LIST_SLACK_DAYS of the predicted end
 *   rebuy    as list, and not with more than REBUY_HIGH_DAYS predicted left
 *   not_yet  per_day x lasts / (max(lasts, days) + NOT_YET_DAYS)
 */
export function impliedRate(signal, snap) {
  if (!snap || !(snap.per_day > 0)) return null;
  if (signal === "op") return snap.days >= MIN_SIGNAL_DAYS && snap.stored > 0 ? snap.stored / snap.days : null;
  if (signal === "list" || signal === "rebuy") {
    if (snap.days < MIN_SIGNAL_DAYS || !(snap.lasts > 0)) return null;
    if (snap.left > 0 && snap.days_left <= LIST_SLACK_DAYS) return null;
    if (snap.left <= 0 && snap.days - snap.lasts <= LIST_SLACK_DAYS) return null;
    if (signal === "rebuy" && snap.left > 0 && snap.days_left > REBUY_HIGH_DAYS) return null;
    return (snap.per_day * snap.lasts) / (snap.days + LIST_LEAD_DAYS);
  }
  if (signal === "not_yet") {
    if (!(snap.lasts > 0)) return null;
    return (snap.per_day * snap.lasts) / (Math.max(snap.lasts, snap.days) + NOT_YET_DAYS);
  }
  return null;
}

/** The current rate moved toward `implied` by `weight`, at most MAX_STEP either way, within RATE_MIN..RATE_MAX. */
export function blendRate(current, implied, weight) {
  const target = current + weight * (implied - current);
  const bounded = Math.min(current * (1 + MAX_STEP), Math.max(current / (1 + MAX_STEP), target));
  return Math.min(RATE_MAX, Math.max(RATE_MIN, bounded));
}

/**
 * What a signal teaches an item: { use_per_day, samples, implied, from } or
 * null. rows: the item's rows as they were before the op changed them.
 */
export function learnRate(signal, item, rows, day) {
  const strength = SIGNALS[signal];
  if (!strength || !item || isExcluded(item.name)) return null;
  const snap = stockSnapshot(rows, item, day);
  const implied = impliedRate(signal, snap);
  if (implied === null || !Number.isFinite(implied) || !(implied > 0)) return null;
  return {
    use_per_day: blendRate(snap.per_day, implied, WEIGHTS[strength]),
    samples: (Number(item.rate_samples) || 0) + 1,
    implied, from: snap.per_day, snapshot: snap,
  };
}

/**
 * Was this purchase on offer? Its unit price is OFFER_DROP or more under the
 * median unit price of the item's earlier priced purchases (the last
 * OFFER_HISTORY before `bought_on`; the same product's when it has at least
 * OFFER_MIN_HISTORY of them). Purchases carry no bonus marker: the AH import
 * folds a discount into the line's price. Unknown (too little history): false.
 */
export function onOffer(purchase, earlier, productId = null) {
  const unit = (p) => (p.price_cents !== null && p.price_cents !== undefined && Number(p.qty) > 0 ? p.price_cents / Number(p.qty) : null);
  const own = unit(purchase);
  if (own === null) return false;
  const priced = earlierPurchases(earlier, purchase).filter((p) => unit(p) !== null && unit(p) > 0);
  const same = productId ? priced.filter((p) => p.product_id === productId) : [];
  const pool = same.length >= OFFER_MIN_HISTORY ? same : priced;
  if (pool.length < OFFER_MIN_HISTORY) return false;
  const prices = pool.map(unit).sort((a, b) => a - b);
  const mid = prices.length >> 1;
  const usual = prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
  return own <= usual * (1 - OFFER_DROP);
}

/**
 * The item's earlier priced purchases the offer check reads: live, of the
 * same item, before the day bought, the last OFFER_HISTORY (newest first).
 * worker/ops-store.js loads exactly these.
 */
export function earlierPurchases(purchases, purchase) {
  return Object.values(purchases ?? {})
    .filter((p) => live(p) && p.id !== purchase.id && p.item_id === purchase.item_id && p.bought_on < purchase.bought_on && p.price_cents !== null && p.price_cents !== undefined)
    .sort((a, b) => b.bought_on.localeCompare(a.bought_on) || b.id.localeCompare(a.id))
    .slice(0, OFFER_HISTORY);
}
