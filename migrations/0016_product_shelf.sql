-- Shelf life per PRODUCT (28-10-2026: "Melk 7 dagen? weet je wel hoe
-- lang houdbare melk goed is?"). The same three columns as items got in 0013,
-- with the same meaning; a product's own values win over its item's
-- (public/shared/shelf-life.js, estimateUseBy). Set through product.shelf.
ALTER TABLE products ADD COLUMN shelf_days INTEGER;
ALTER TABLE products ADD COLUMN opened_days INTEGER;
ALTER TABLE products ADD COLUMN shelf_source TEXT;

-- Cooking before the receipt is in (28-10-2026): he shops, cooks the
-- same evening, and the receipt arrives the next morning. What a cook needed
-- but the pantry did not have is kept here, in the ingredient's own terms
-- (qty + unit of the scaled ingredient), and taken off the row a receipt
-- purchase for it makes within PENDING_DAYS (public/shared/pantry.js).
-- status: 'pending' or 'done'; a done row names the pantry row and the event
-- it became. Undoing the cook tombstones it (and gives back what it took).
CREATE TABLE pending_takes (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  cook_id TEXT,
  recipe_id TEXT,
  item_id TEXT,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  qty REAL NOT NULL,
  unit TEXT,
  default_portion INTEGER NOT NULL DEFAULT 0,
  cooked_on TEXT NOT NULL,
  status TEXT NOT NULL,
  pantry_id TEXT,
  event_id TEXT,
  member_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  rev INTEGER NOT NULL
);
CREATE INDEX pending_takes_rev ON pending_takes(household_id, rev);
CREATE INDEX pending_takes_open ON pending_takes(household_id, status, cooked_on);

-- "… gekookt?" (28-10-2026): a recipe whose list lines were ticked or
-- bought on shopped_on. One row per recipe per shopping day, written by the op
-- engine on the tick or the receipt purchase (so it survives clearing the
-- cart); entry_ids are the lines that made it (an untick of the last one
-- tombstones it). snoozed_on: "nog niet" on that day; dismissed_at: never
-- again. The prompt itself is public/shared/cook-prompts.js.
CREATE TABLE cook_prompts (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  recipe_id TEXT NOT NULL,
  listed_on TEXT NOT NULL,
  shopped_on TEXT NOT NULL,
  entry_ids TEXT,
  snoozed_on TEXT,
  dismissed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  rev INTEGER NOT NULL
);
CREATE INDEX cook_prompts_rev ON cook_prompts(household_id, rev);
CREATE INDEX cook_prompts_recipe ON cook_prompts(household_id, recipe_id, shopped_on);
