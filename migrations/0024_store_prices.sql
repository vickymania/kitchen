-- Shelf prices of other stores from Checkjebon (30-10-2026), written
-- only by the op prices.sync (public/shared/ops.js, sent by the home server's
-- fetcher/prices.mjs). Not the whole price list (~70,000 rows a day for the
-- stores near home): only the prices of the household's own products, one row
-- per product and store (id "sp-<store>-<product_id>"), so the table stays at
-- a few hundred rows. name and size are the store's own wording; price_on is
-- the day of the Checkjebon data. A product without a match any more gets a
-- tombstone. Synced to the phones as the kind store_prices.
CREATE TABLE store_prices (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  product_id TEXT NOT NULL,
  store TEXT NOT NULL,
  name TEXT NOT NULL,
  size TEXT,
  price_cents INTEGER NOT NULL,
  price_on TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  rev INTEGER NOT NULL
);
CREATE INDEX store_prices_rev ON store_prices(household_id, rev);
CREATE INDEX store_prices_store ON store_prices(household_id, store);
