-- Ten stars instead of five (30-10-2026: "ik wil 10 sterren ipv 5").
-- Neither stars column has a CHECK constraint (the ops refuse anything but
-- 1-10: rating.set and recipe.rate in public/shared/ops.js), so only the data
-- moves: every stars value is doubled once (1 -> 2 ... 5 -> 10), cleared and
-- deleted rows too, so a restored row is on the same scale. The rows carry
-- rev + 1 and the household's rev goes up once, so every phone pulls them.
-- This file runs once; run twice it would double again.

UPDATE ratings
SET stars = stars * 2,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    rev = (SELECT h.rev + 1 FROM households h WHERE h.id = ratings.household_id)
WHERE stars IS NOT NULL;

UPDATE recipe_ratings
SET stars = stars * 2,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    rev = (SELECT h.rev + 1 FROM households h WHERE h.id = recipe_ratings.household_id)
WHERE stars IS NOT NULL;

UPDATE households SET rev = rev + 1
WHERE id IN (SELECT household_id FROM ratings WHERE stars IS NOT NULL)
   OR id IN (SELECT household_id FROM recipe_ratings WHERE stars IS NOT NULL);
