-- "Bijna op" per item (28-10-2026): low_at is the threshold as typed
-- ("300 g", "1,5 kg", "2 st", or a number of packs like "0,5"); NULL means the
-- default rule (under a quarter pack, or too little for a recipe that uses it,
-- public/shared/low-stock.js). low_off = 1 never warns about the item.
-- Set through item.low; no data to move, nothing gets a new rev.

ALTER TABLE items ADD COLUMN low_at TEXT;
ALTER TABLE items ADD COLUMN low_off INTEGER;
