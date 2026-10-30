-- What kind of thing a product is (28-10-2026): a snack, a cup or a
-- ready meal is never the product for an ingredient item. The AH import had
-- made "Knorr Goodpasta" (a snack cup) the AH product for "Pasta".
--
-- products.category: AH's own category, "Main > Sub" (e.g. "Pasta, rijst,
-- wereldkeuken > Farfalle"); '' or NULL for a product from elsewhere.
-- products.kind: one of ingredient, ready_meal, snack, drink, household,
-- personal_care, pet, other (public/shared/product-kinds.js, KINDS); NULL is
-- unknown. Set by product.put (the AH import sends both), else derived by the
-- op engine from the category or the name rules, else asked of Claude Haiku
-- after the batch (worker/kinds.js).
--
-- No data to move: existing rows get their kind on their next product.put,
-- from tools/audit_items.mjs --push, or are read through the same rules
-- (productKind) wherever a kind is needed.

ALTER TABLE products ADD COLUMN category TEXT;
ALTER TABLE products ADD COLUMN kind TEXT;
