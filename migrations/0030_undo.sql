-- Nightly check v2 (30-10-2026: "Waarom heb ik niet direct een knop
-- 'terugdraaien'?", "Beslis jij — waarom geen knoppen?", "die generic dingen
-- horen niet eens in mijn database, weg ermee").
--
-- items.undo_rows: on the tombstone of an item that item.merge merged away
-- or item.remove removed, exactly what that op changed (JSON, written by
-- public/shared/ops.js): the ids of the rows it moved or buried per kind,
-- the scoped rows (preferences, deal rules) and how, the list lines it
-- folded into another line with that line's values before, the aliases that
-- went along, and the settings the into-item took over with their values
-- before. item.unmerge and item.unremove read it to put every row back.
-- Never sent to a phone (worker/ops-store.js pull leaves it out).
ALTER TABLE items ADD COLUMN undo_rows TEXT;

-- The changelog's undo: what change.undo needs (JSON: the merged item's id,
-- the item a product came from, the alias row, the recipe), and when the
-- household undid the line ("Teruggedraaid").
ALTER TABLE auto_changes ADD COLUMN undo TEXT;
ALTER TABLE auto_changes ADD COLUMN undone_at TEXT;

-- What the household decided about items, so the nightly check never asks or
-- does it again. One row per decision ever (deterministic id, tombstones
-- included). kind:
--   apart      a and b (name keys, sorted) are two things: never merged by
--              rule, never asked again ("Apart houden", an undone merge)
--   no_alias   name key a is not another name of item b (an undone alias)
--   no_rename  item a keeps its own spelling (an undone rename)
--   no_move    product a does not belong to item b (an undone product move)
--   keep       item a is no junk (an undone removal)
-- a_name and b_name: the names as shown, for the screens. Synced as the kind
-- decisions (never to a recipes-only person).
CREATE TABLE item_decisions (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  kind TEXT NOT NULL,
  a TEXT NOT NULL,
  b TEXT NOT NULL DEFAULT '',
  a_name TEXT,
  b_name TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  rev INTEGER NOT NULL
);
CREATE INDEX item_decisions_rev ON item_decisions(household_id, rev);
CREATE INDEX item_decisions_kind ON item_decisions(household_id, kind, a);
