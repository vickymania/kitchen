// The daily deals from the home server (fetcher/): the full current set comes
// in, only offers that an item or recipe ingredient of the household could
// match are kept, and only the difference is written. A new or changed offer
// is one upsert, an offer that expired or left the folders is one tombstone,
// an unchanged one is nothing. Each chunk of writes gets its own rev bump, so a
// phone that polls halfway still gets the rest next time.
import { cleanOffer, offerKey, relevanceTest, productOfferName, OFFER_FIELDS, OFFER_SOURCES } from "../public/shared/offers.js";
import { sha256 } from "./auth.js";
import { takeOne } from "./claude.js";

export const MAX_OFFERS = 5000;
/** Syncs per household per day: one a day is the plan, the rest is for a retry. */
export const SYNC_DAILY_LIMIT = 4;
const CHUNK = 50;

/** Today in Dutch time, the day the folders and the phones go by. */
export const amsterdamDay = (date = new Date()) => date.toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" });

// A folder offer's id is as it always was; another source's has its source in
// the hash, so a coupon and a folder offer on one product are two rows.
const offerId = async (o) => `of-${(await sha256(o.source ? `offer:${o.source}:${offerKey(o)}` : `offer:${offerKey(o)}`)).slice(0, 32)}`;

/**
 * Every item name, recipe ingredient name and preferred product (brand and
 * name) of the household: what an offer may be about. The preferred products
 * keep "Doritos Nacho Cheese" in the folder for a line called "Tortilla chips".
 * A deal rule's product counts too, and its brand with the item's name
 * ("Edet vochtig toiletpapier"), as public/shared/deals.js matches it, and
 * every rule's match_words ("felix", "pouches" for cat food). The
 * store does not matter here, so "omweg waard" stores are kept as well.
 */
async function householdNames(db, hh) {
  const [items, recipes, preferred, ruled, worded] = await db.batch([
    db.prepare("SELECT name FROM items WHERE household_id = ? AND deleted_at IS NULL").bind(hh),
    db.prepare("SELECT ingredients FROM recipes WHERE household_id = ? AND deleted_at IS NULL").bind(hh),
    db.prepare(`SELECT DISTINCT p.brand, p.name FROM preferences f JOIN products p ON p.id = f.product_id AND p.household_id = f.household_id
      WHERE f.household_id = ? AND f.deleted_at IS NULL AND p.deleted_at IS NULL`).bind(hh),
    db.prepare(`SELECT p.brand, p.name, i.name AS item FROM deal_rules r
      JOIN products p ON p.id = r.product_id AND p.household_id = r.household_id
      JOIN items i ON i.id = r.item_id AND i.household_id = r.household_id
      WHERE r.household_id = ? AND r.deleted_at IS NULL AND p.deleted_at IS NULL`).bind(hh),
    db.prepare("SELECT match_words FROM deal_rules WHERE household_id = ? AND deleted_at IS NULL AND match_words IS NOT NULL").bind(hh),
  ]);
  const names = items.results.map((r) => r.name);
  for (const p of preferred.results) names.push(productOfferName(p));
  for (const r of ruled.results) {
    names.push(productOfferName(r));
    if (r.brand) names.push(`${r.brand} ${r.item}`);
  }
  for (const r of worded.results) {
    try {
      for (const w of JSON.parse(r.match_words) ?? []) if (typeof w === "string") names.push(w);
    } catch {
      // Unreadable words add nothing.
    }
  }
  for (const r of recipes.results) {
    try {
      for (const i of JSON.parse(r.ingredients ?? "[]")) if (!i.heading && i.name) names.push(i.name);
    } catch {
      // A recipe without readable ingredients adds nothing.
    }
  }
  return names;
}

const same = (a, b) => OFFER_FIELDS.every((f) => (a[f] ?? null) === (b[f] ?? null));

/**
 * body: { offers: [...], source? }. Without a source the set is the folders'
 * (the AH bonus and allefolders); with one of OFFER_SOURCES ("lidl_plus") it
 * is that source's. Only rows of the same source are compared, updated and
 * tombstoned: the coupon run never removes a folder offer, nor the other way
 * round. Each source has its own daily limit.
 * Returns { result } or { error, status }.
 * result: { received, irrelevant, kept, added, changed, removed, skipped, rev }.
 */
export async function syncOffers(env, who, body, today = amsterdamDay()) {
  const list = body?.offers;
  if (!Array.isArray(list) || list.length > MAX_OFFERS) return { error: "bad_offers", status: 400 };
  const source = body?.source ?? null;
  if (source !== null && !OFFER_SOURCES.includes(source)) return { error: "bad_source", status: 400 };
  if (!(await takeOne(env, source ? `offers_${source}` : "offers", who.householdId, SYNC_DAILY_LIMIT))) return { error: "too_many_syncs", status: 429 };

  const hh = who.householdId;
  const relevant = relevanceTest(await householdNames(env.DB, hh));
  // The incoming set, cleaned the same way the fetcher did it, and only what holds today or later.
  const incoming = new Map();
  let skipped = 0;
  let irrelevant = 0;
  for (const raw of list) {
    const o = cleanOffer(raw);
    // The set's source decides, never the row's own field.
    if (o) o.source = source;
    if (!o || o.valid_until < today) {
      skipped++;
      continue;
    }
    if (!relevant(o)) {
      irrelevant++;
      continue;
    }
    const id = await offerId(o);
    if (incoming.has(id)) skipped++;
    else incoming.set(id, o);
  }

  const { results: live } = await env.DB.prepare(
    `SELECT id, ${OFFER_FIELDS.join(", ")} FROM offers WHERE household_id = ? AND deleted_at IS NULL AND source IS ?`,
  ).bind(hh, source).all();
  const stored = new Map(live.map((r) => [r.id, r]));

  const now = new Date().toISOString();
  const rev = "(SELECT rev FROM households WHERE id = ?)";
  const writes = [];
  let added = 0;
  let changed = 0;
  let removed = 0;
  for (const [id, o] of incoming) {
    const old = stored.get(id);
    if (old && same(old, o)) continue;
    if (old) changed++;
    else added++;
    // A returning offer revives its tombstone; the WHERE keeps another household's id untouched.
    writes.push(env.DB.prepare(
      `INSERT INTO offers (id, household_id, ${OFFER_FIELDS.join(", ")}, created_at, updated_at, deleted_at, rev)
       VALUES (?, ?, ${OFFER_FIELDS.map(() => "?").join(", ")}, ?, ?, NULL, ${rev})
       ON CONFLICT(id) DO UPDATE SET ${OFFER_FIELDS.map((f) => `${f} = excluded.${f}`).join(", ")},
         updated_at = excluded.updated_at, deleted_at = NULL, rev = excluded.rev
       WHERE offers.household_id = excluded.household_id`,
    ).bind(id, hh, ...OFFER_FIELDS.map((f) => o[f]), now, now, hh));
  }
  for (const id of stored.keys()) {
    if (incoming.has(id)) continue;
    removed++;
    writes.push(env.DB.prepare(
      `UPDATE offers SET deleted_at = ?, updated_at = ?, rev = ${rev} WHERE id = ? AND household_id = ?`,
    ).bind(now, now, hh, id, hh));
  }

  for (let i = 0; i < writes.length; i += CHUNK) {
    await env.DB.batch([
      env.DB.prepare("UPDATE households SET rev = rev + 1 WHERE id = ?").bind(hh),
      ...writes.slice(i, i + CHUNK),
    ]);
  }
  const head = await env.DB.prepare("SELECT rev FROM households WHERE id = ?").bind(hh).first();
  return {
    result: { received: list.length, irrelevant, kept: incoming.size - added - changed, added, changed, removed, skipped, rev: head?.rev ?? 0 },
  };
}
