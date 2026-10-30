-- Which meals a recipe is for (28-10-2026): breakfast, lunch and/or
-- dinner, the wizard's first question. A JSON array from the fixed list in
-- public/shared/labels.js (MEALS); NULL is "not labelled yet". It is a label
-- like cuisine: labels_by says who set it.
ALTER TABLE recipes ADD COLUMN meals TEXT;
