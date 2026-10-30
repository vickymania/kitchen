-- Shelf life per item (28-10-2026: "elk product een gemiddelde
-- houdbaarheid, zodat een aankoop vanzelf de datum krijgt"). shelf_days is how
-- long it keeps unopened, -1 for years (no date); opened_days how long once
-- opened, NULL when unknown; shelf_source says who set them: 'claude' (the
-- worker's lookup, worker/shelf.js), 'person' (typed in the app, never
-- overwritten) or 'rule'. NULL everywhere: unknown, the regex table in
-- public/shared/shelf-life.js decides. Set through item.shelf; no data to move.

ALTER TABLE items ADD COLUMN shelf_days INTEGER;
ALTER TABLE items ADD COLUMN opened_days INTEGER;
ALTER TABLE items ADD COLUMN shelf_source TEXT;
