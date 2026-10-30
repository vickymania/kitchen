-- Stars per person per recipe (30-10-2026). One row per member and
-- recipe, written by the op recipe.rate (public/shared/ops.js). stars is 1-5,
-- or NULL when the person cleared them (the row stays, so asked_on is kept).
-- asked_on: the day this person last answered or skipped "Hoe was <recipe>
-- gisteren?" (public/shared/recipe-ratings.js, rateAsks): a cook on or before
-- that day is not asked about again.
CREATE TABLE recipe_ratings (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  recipe_id TEXT NOT NULL,
  stars INTEGER,
  asked_on TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  rev INTEGER NOT NULL
);
CREATE UNIQUE INDEX recipe_ratings_member_recipe ON recipe_ratings(household_id, member_id, recipe_id);
CREATE INDEX recipe_ratings_rev ON recipe_ratings(household_id, rev);
