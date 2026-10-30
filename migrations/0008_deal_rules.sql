-- Deal rules (28-10-2026): per item, optionally per product, when an
-- offer is worth it. A max price per piece ("2 voor 2,40" is €1,20 each), only
-- on offer (with an optional minimum discount), a max price per kg / l /
-- piece in the pack, and "omweg waard" (other stores than AH and Dirk count).
-- Checked against the synced offers by public/shared/deals.js.
--
-- Same rules as before: every row a phone sees carries `rev`; clearing a rule
-- sets deleted_at (a tombstone), and setting it again revives that row, so an
-- item and product never have two rows.

CREATE TABLE deal_rules (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  -- '' = any product of the item.
  product_id TEXT NOT NULL DEFAULT '',
  max_price_cents INTEGER,
  offer_only INTEGER NOT NULL DEFAULT 0,
  min_discount_pct INTEGER,
  max_unit_price_cents INTEGER,
  -- 'kg', 'l' or 'piece'; set together with max_unit_price_cents.
  unit TEXT,
  detour INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  rev INTEGER NOT NULL
);
CREATE UNIQUE INDEX deal_rules_scope ON deal_rules(household_id, item_id, product_id);
CREATE INDEX deal_rules_rev ON deal_rules(household_id, rev);
