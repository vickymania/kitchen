-- Phase 2: what was bought, as which product, and what people think of it.
--
-- Same rules as 0001: every row a phone sees carries `rev`, deleting sets
-- deleted_at. An excluded thing never gets a row here (public/shared/excluded.js, checked
-- by the op engine).

-- A product is a concrete thing on a shelf: "AH Halfvolle melk 1 l". An item
-- ("melk") can have many products; one of them can be the preferred one.
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  item_id TEXT REFERENCES items(id),
  name TEXT NOT NULL,
  brand TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL DEFAULT '',
  store TEXT NOT NULL DEFAULT '',
  last_price_cents INTEGER,
  -- name|brand|size through nameKey: the same product read from two receipts
  -- is one row.
  product_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  rev INTEGER NOT NULL
);
CREATE UNIQUE INDEX products_key ON products(household_id, product_key);
CREATE INDEX products_rev ON products(household_id, rev);

ALTER TABLE items ADD COLUMN preferred_product_id TEXT;

-- One rating per person per product: 1 to 5 stars and a short note.
CREATE TABLE ratings (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  stars INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  rev INTEGER NOT NULL
);
CREATE UNIQUE INDEX ratings_member_product ON ratings(household_id, member_id, product_id);
CREATE INDEX ratings_rev ON ratings(household_id, rev);

-- A read receipt after the review screen. `lines` is JSON and never holds an
-- excluded line.
CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  store TEXT NOT NULL DEFAULT '',
  bought_on TEXT NOT NULL,
  total_cents INTEGER,
  lines TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  rev INTEGER NOT NULL
);
CREATE INDEX receipts_rev ON receipts(household_id, rev);

-- One thing bought on one day: from a receipt, or from the old To Do history.
-- The "need it again" timers are computed from these (public/shared/intervals.js).
CREATE TABLE purchases (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  item_id TEXT REFERENCES items(id),
  product_id TEXT REFERENCES products(id),
  receipt_id TEXT REFERENCES receipts(id),
  title TEXT NOT NULL,
  bought_on TEXT NOT NULL,
  store TEXT NOT NULL DEFAULT '',
  qty REAL,
  price_cents INTEGER,
  source TEXT NOT NULL CHECK (source IN ('receipt', 'history')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  rev INTEGER NOT NULL
);
CREATE INDEX purchases_rev ON purchases(household_id, rev);
CREATE INDEX purchases_item ON purchases(household_id, item_id);

-- Counters for paid calls (receipt reading), per household per day.
CREATE TABLE usage_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);
