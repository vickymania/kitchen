-- Phase 2, product knowledge (28-10-2026): the product to buy for an
-- item per store and per recipe. Cheap store-brand tortilla chips for the
-- nachos lasagne, the brand for a bowl of chips; at Dirk another product than
-- at AH. Resolved per list line by public/shared/preferences.js.
--
-- Same rules as before: every row a phone sees carries `rev`; clearing a
-- preference sets deleted_at (a tombstone), and setting it again revives that
-- row, so a scope never has two rows.

CREATE TABLE preferences (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  -- The store's one name (public/shared/stores.js canonicalStore); '' = any store.
  store TEXT NOT NULL DEFAULT '',
  -- '' = any recipe.
  recipe_id TEXT NOT NULL DEFAULT '',
  product_id TEXT NOT NULL REFERENCES products(id),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  rev INTEGER NOT NULL
);
CREATE UNIQUE INDEX preferences_scope ON preferences(household_id, item_id, store, recipe_id);
CREATE INDEX preferences_rev ON preferences(household_id, rev);

-- The one preferred product per item of 0002 becomes a preference at the
-- store that product was last bought (any store when unknown). The column
-- stays readable; nothing writes it any more. The store names follow
-- canonicalStore for the two stores receipts have named so far.
INSERT INTO preferences (id, household_id, item_id, store, recipe_id, product_id, created_by, created_at, updated_at, deleted_at, rev)
SELECT
  'pf-' || i.id, i.household_id, i.id,
  CASE
    WHEN lower(trim(p.store)) IN ('ah', 'albert heijn', 'ah to go', 'albertheijn') THEN 'Albert Heijn'
    WHEN lower(trim(p.store)) IN ('dirk', 'dirk van den broek', 'dirk vd broek') THEN 'Dirk'
    ELSE trim(p.store)
  END,
  '', p.id, NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL,
  (SELECT h.rev + 1 FROM households h WHERE h.id = i.household_id)
FROM items i
JOIN products p ON p.id = i.preferred_product_id AND p.household_id = i.household_id AND p.deleted_at IS NULL
WHERE i.preferred_product_id IS NOT NULL AND i.deleted_at IS NULL;

-- The rows above carry rev + 1: the phones fetch them with their next delta.
UPDATE households SET rev = rev + 1 WHERE id IN (SELECT DISTINCT household_id FROM preferences);
