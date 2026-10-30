-- Things used at a steady rate, not by recipes (28-10-2026: the cat's
-- pouches, 6 a week; a tin of tuna a week; a fountain filter a month;
-- toothpaste, deo, toilet blocks). The pantry counts them down by itself,
-- computed when it is read (public/shared/pantry.js, withUsage), never written
-- daily.
--
-- items.use_per_day: packs or pieces (the pantry row's amount unit) used per
-- day, e.g. 6/7 for the cat food; 0 means "no countdown" (also no default
-- rate); NULL means unknown: the household-goods table in
-- public/shared/usage-rates.js may apply. items.rate_source: 'person' or
-- 'claude' (a person's value is never replaced by Claude's). Set through
-- item.rate.
--
-- pantry.amount_on: the day `amount` was last true (set by a correction, an
-- "op", cooking, or a rate change). NULL: added_on. The countdown runs from
-- there. No data to move, nothing gets a new rev.

ALTER TABLE items ADD COLUMN use_per_day REAL;
ALTER TABLE items ADD COLUMN rate_source TEXT;
ALTER TABLE pantry ADD COLUMN amount_on TEXT;
