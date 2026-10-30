-- "Al nodig?" per item (29-10-2026): "Nog niet" on a thing that is
-- low without a countdown hides it from that section until not_yet_until
-- (a day, YYYY-MM-DD; shown again on that day). It never hides anything from
-- "Bijna op". Set through item.not_yet (public/shared/needed-soon.js
-- notYetOp); no data to move, nothing gets a new rev.

ALTER TABLE items ADD COLUMN not_yet_until TEXT;
