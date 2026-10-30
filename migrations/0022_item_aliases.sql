-- Other names of an item (30-10-2026: "Als ik iets op mijn lijstje
-- zet moet hij het echt aan het juiste product koppelen"). An alias is a name
-- that means an item: "Pluizenbolbrokkenman" is "Minoes brokken". The op
-- engine's findItem resolves it, so the add box, the widget, a receipt import
-- and Claude land on the item by that name.
--
-- One row per name per household ever (item_aliases_name, tombstones
-- included): removing an alias sets deleted_at, adding the name again revives
-- that row. An alias never has the name of a live item (item.alias refuses it).
--
-- The space-free key REPLACE(name_key, ' ', '') makes "minoesbrokken" and
-- "Minoes brokken" one name; both tables get an index on exactly that
-- expression, so the loaders' lookups by it stay one index read.
--
-- A merged-away item (0020) is an alias too: every merged tombstone gets a
-- row here, so the phones (which never keep tombstones) see the old name.

CREATE TABLE item_aliases (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  rev INTEGER NOT NULL
);
CREATE UNIQUE INDEX item_aliases_name ON item_aliases(household_id, name_key);
CREATE INDEX item_aliases_compact ON item_aliases(household_id, REPLACE(name_key, ' ', ''));
CREATE INDEX item_aliases_item ON item_aliases(household_id, item_id);
CREATE INDEX item_aliases_rev ON item_aliases(household_id, rev);

CREATE INDEX items_compact ON items(household_id, REPLACE(name_key, ' ', ''));

-- What was typed when it was not the item's own name, and whether the line
-- made its item ("Nieuw" on the list until it is linked to a known item).
ALTER TABLE list_entries ADD COLUMN typed TEXT;
ALTER TABLE list_entries ADD COLUMN new_item INTEGER NOT NULL DEFAULT 0;

-- The merges done before this file: their old names as alias rows, with a
-- new rev so the phones fetch them.
UPDATE households SET rev = rev + 1
  WHERE id IN (SELECT household_id FROM items WHERE merged_into IS NOT NULL AND deleted_at IS NOT NULL);
INSERT OR IGNORE INTO item_aliases (id, household_id, item_id, name, name_key, created_by, created_at, updated_at, deleted_at, rev)
  SELECT 'ma-' || i.id, i.household_id, i.merged_into, i.name, i.name_key, NULL, i.deleted_at, i.deleted_at, NULL,
    (SELECT rev FROM households h WHERE h.id = i.household_id)
  FROM items i WHERE i.merged_into IS NOT NULL AND i.deleted_at IS NOT NULL;
-- A merge of a merged item: point at the live end of the chain (three hops
-- are more than any real chain).
UPDATE item_aliases SET item_id = (SELECT merged_into FROM items WHERE items.id = item_aliases.item_id)
  WHERE item_id IN (SELECT id FROM items WHERE merged_into IS NOT NULL AND deleted_at IS NOT NULL);
UPDATE item_aliases SET item_id = (SELECT merged_into FROM items WHERE items.id = item_aliases.item_id)
  WHERE item_id IN (SELECT id FROM items WHERE merged_into IS NOT NULL AND deleted_at IS NOT NULL);
UPDATE item_aliases SET item_id = (SELECT merged_into FROM items WHERE items.id = item_aliases.item_id)
  WHERE item_id IN (SELECT id FROM items WHERE merged_into IS NOT NULL AND deleted_at IS NOT NULL);
