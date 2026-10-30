-- The "what shall I eat" wizard (28-10-2026): labels on every recipe,
-- and when the household last cooked it.
--
-- Same rules as 0001 and 0002: every row a phone sees carries `rev`, deleting
-- sets deleted_at.

-- Labels from a fixed vocabulary (public/shared/labels.js). Claude fills them
-- once per recipe; a person can correct them in the editor, and then
-- labels_by = 'person' keeps Claude from ever overwriting them.
ALTER TABLE recipes ADD COLUMN cuisine TEXT;
ALTER TABLE recipes ADD COLUMN main_ingredient TEXT;
ALTER TABLE recipes ADD COLUMN time_class TEXT;
ALTER TABLE recipes ADD COLUMN time_minutes INTEGER;
ALTER TABLE recipes ADD COLUMN labels_by TEXT;

-- One row per time a recipe was cooked (cook mode reached the end, or the
-- "eaten" button). The wizard reads the newest day per recipe.
CREATE TABLE cooks (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  recipe_id TEXT NOT NULL REFERENCES recipes(id),
  member_id TEXT,
  cooked_on TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  rev INTEGER NOT NULL
);
CREATE INDEX cooks_rev ON cooks(household_id, rev);
CREATE INDEX cooks_recipe ON cooks(household_id, recipe_id, cooked_on);
