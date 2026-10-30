-- Phase 4, the pantry (28-10-2026): what is in the house, how much,
-- and until when it keeps. Filled by ticking the list and by receipts, taken
-- out by cooking and by "op" / "weggegooid". Rules in public/shared/pantry.js.
--
-- Same rules as before: every row a phone sees carries `rev`; a row that is
-- used up or removed gets deleted_at (a tombstone), so every phone hears it.

CREATE TABLE pantry (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  product_id TEXT REFERENCES products(id),
  -- The name it is shown under: the item's.
  title TEXT NOT NULL,
  -- Packs or pieces still in the house; may be a fraction (half a cheese).
  amount REAL NOT NULL,
  -- Packs taken out so far (used, thrown, cooked): a receipt that arrives
  -- after cooking fills in what was bought minus this.
  taken REAL NOT NULL DEFAULT 0,
  -- One pack, as the product or the list line says it: "400 g", "1 l", "10 st".
  pack_size TEXT NOT NULL DEFAULT '',
  added_on TEXT NOT NULL,
  use_by TEXT,
  -- 'estimate' (public/shared/shelf-life.js) or 'person' (typed in).
  use_by_source TEXT,
  -- Where it came from: the list line that was ticked, the purchase on a receipt.
  source_entry_id TEXT,
  source_purchase_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  rev INTEGER NOT NULL
);
CREATE INDEX pantry_rev ON pantry(household_id, rev);
CREATE INDEX pantry_item ON pantry(household_id, item_id, added_on);

-- What went out of the pantry and why: 'used' ("op"), 'thrown'
-- ("weggegooid"), 'cooked'. Thrown rows are the waste log, so the app can
-- later suggest buying less of that product. Undo tombstones the event and
-- puts the amount back.
CREATE TABLE pantry_events (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  pantry_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  product_id TEXT,
  reason TEXT NOT NULL,
  amount REAL NOT NULL,
  recipe_id TEXT,
  happened_on TEXT NOT NULL,
  member_id TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  rev INTEGER NOT NULL
);
CREATE INDEX pantry_events_rev ON pantry_events(household_id, rev);
