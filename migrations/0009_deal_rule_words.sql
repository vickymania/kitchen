-- Words and a detour discount on a deal rule (28-10-2026). The words
-- are JSON arrays of nameKey words or phrases, NULL for none.
--
--   match_words:   any of them makes an offer a candidate, next to the item or
--                  product name: cat food "Minoes eten" is "Felix pouches" in
--                  the folder (felix, sheba, whiskas, kattenvoer, ...).
--   require_words: an offer must name all of them to be a full hit: only the
--                  pink Edet, "amandelmelk". An offer that names no variant at
--                  all is a "check" hit; one that names another variant is
--                  not shown (public/shared/deals.js).
--   exclude_words: an offer naming any of them is never a hit: tuna for the
--                  cat ("Minoestuna"), never "tonijnsalade" or tuna pizza.
--   detour_min_discount_pct: with "omweg waard", a store other than AH and
--                  Dirk counts only from this discount ("omweg waard vind ik
--                  pas vanaf 50%"); NULL: the same as at AH and Dirk.
--
-- Set through deal_rule.set like the other fields; no data to move.

ALTER TABLE deal_rules ADD COLUMN match_words TEXT;
ALTER TABLE deal_rules ADD COLUMN require_words TEXT;
ALTER TABLE deal_rules ADD COLUMN exclude_words TEXT;
ALTER TABLE deal_rules ADD COLUMN detour_min_discount_pct INTEGER;
