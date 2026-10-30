-- Phase 3, deals (28-10-2026): the AH bonus and other stores' folder
-- offers, fetched once a day on the home server and sent to
-- /api/offers/sync, which writes only what changed.
--
-- Same rules as before: every row a phone sees carries `rev`; an offer that
-- expired or left the folder gets deleted_at (a tombstone), so the phones
-- hear about it.

-- A device's role. NULL is a person's phone or tool; 'fetcher' is the home
-- server, which may call /api/offers/sync and nothing else.
ALTER TABLE devices ADD COLUMN role TEXT;
-- The role a code gives the device that uses it (an admin asks for it).
ALTER TABLE pairing_codes ADD COLUMN device_role TEXT;

CREATE TABLE offers (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  store TEXT NOT NULL,
  name TEXT NOT NULL,
  brand TEXT,
  size TEXT,
  deal TEXT,
  price_cents INTEGER,
  valid_from TEXT,
  valid_until TEXT NOT NULL,
  category TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  rev INTEGER NOT NULL
);
CREATE INDEX offers_rev ON offers(household_id, rev);
CREATE INDEX offers_live ON offers(household_id, deleted_at);
