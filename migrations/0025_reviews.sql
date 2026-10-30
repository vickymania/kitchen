-- The nightly check on the home server (30-10-2026): after the daily
-- run a headless Claude reads the run log and the new receipts, fixes the
-- clear-cut product-to-item links itself and writes a short report. Written
-- only by the op review.save from the device with the role 'reviewer'
-- (fetcher/review.mjs); one row per day (id "review-<day>"), a second run on
-- the same day replaces it. fixed: JSON list of {text, undo}; decide and
-- errors: JSON lists of short Dutch lines. Synced to the phones as the kind
-- reviews (never to a recipes-only person).
CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  day TEXT NOT NULL,
  run_ok INTEGER NOT NULL DEFAULT 1,
  fixed TEXT,
  decide TEXT,
  errors TEXT,
  turns INTEGER,
  cost_cents INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  rev INTEGER NOT NULL
);
CREATE INDEX reviews_rev ON reviews(household_id, rev);
