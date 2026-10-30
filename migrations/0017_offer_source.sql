-- Lidl Plus coupons (28-10-2026): his own coupons next to the folder
-- offers. NULL is the AH bonus and the allefolders folders (fetcher/fetch.mjs);
-- 'lidl_plus' is a Lidl Plus coupon (fetcher/lidl_import.mjs), which he must
-- activate in the Lidl Plus app. /api/offers/sync replaces one source's set
-- at a time, so the coupon run never tombstones the folder offers and the
-- folder run never tombstones the coupons.
ALTER TABLE offers ADD COLUMN source TEXT;
CREATE INDEX offers_source ON offers(household_id, source, deleted_at);
