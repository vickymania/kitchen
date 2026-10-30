-- The nightly check's changelog (30-10-2026: "Ik wil van die
-- nachtelijke autofixes ook een changelog ergens kunnen zien zodat ik weet
-- wat ie gedaan heeft en of ik onverhoopt iets moet fixen"). One row per
-- change the reviewer device made (the home server's nightly check): written
-- by the op engine itself (public/shared/ops.js logChange) when an
-- item.merge, product.move, item.alias, item.rename or recipe.links from
-- that device changed something, never by a person's op. what: 'merge' |
-- 'move' | 'alias' | 'rename' | 'recipe'; name: what changed (the merged
-- item, the product, the new name, the old spelling, the recipe's title);
-- target: where it went (the item, the new spelling; for a recipe "linked/
-- lines"); reason: why, in a few words (an alias the check proposed:
-- "spelling"); lines: a recipe's links (JSON, as recipes.ingredient_links). The app shows the last AUTO_CHANGES_DAYS (60) days; review.save
-- tombstones older rows. Synced as the kind auto_changes (never to a
-- recipes-only person).
CREATE TABLE auto_changes (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  day TEXT NOT NULL,
  what TEXT NOT NULL,
  name TEXT NOT NULL,
  target TEXT,
  item_id TEXT,
  product_id TEXT,
  reason TEXT,
  lines TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  rev INTEGER NOT NULL
);
CREATE INDEX auto_changes_rev ON auto_changes(household_id, rev);
CREATE INDEX auto_changes_day ON auto_changes(household_id, day);

-- Per ingredient line of a recipe, the item it means or why none
-- (public/shared/recipe-links.js), written by recipe.links from the nightly
-- check: JSON { at: the recipe's updated_at it was made for, lines: [{ name,
-- item_id, item, how } | { name, item_id: null, reason }] }. The recipe page
-- marks an unlinked line only while `at` is the recipe's updated_at.
ALTER TABLE recipes ADD COLUMN ingredient_links TEXT;
