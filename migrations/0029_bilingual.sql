-- Both languages in the data (30-10-2026: the NL/EN switch must
-- switch the items and the recipes too, not only the buttons).
--
-- items.name_en: the item's English name, shown when the member's language is
-- English (else the Dutch name). Not a key: two items may share one English
-- name, so it lives here and never in item_aliases (whose names are unique).
-- findItem treats it like an alias for matching, after every Dutch name, and
-- an English name that two items share means neither (ambiguous, as aliases).
-- name_en_key is nameKey(name_en), indexed without spaces like name_key
-- (0022), so a typed English name loads in one index read.
-- name_en_source: 'claude' (the worker, the import, the fill tool) or
-- 'person'; Claude never replaces a person's (item.translate answers kept).
ALTER TABLE items ADD COLUMN name_en TEXT;
ALTER TABLE items ADD COLUMN name_en_key TEXT;
ALTER TABLE items ADD COLUMN name_en_source TEXT;
CREATE INDEX items_en_compact ON items(household_id, REPLACE(name_en_key, ' ', ''));

-- recipes.lang: the language the recipe is written in ('nl' | 'en'); NULL on
-- older rows until their next recipe.put (the app detects it from the text,
-- public/shared/bilingual.js detectLang). recipes.translation: JSON { lang,
-- title, ingredients: [lines as written], steps, notes, of, by } in the other
-- language; `of` is the fingerprint of the original it was made from
-- (recipeFingerprint), so an edit of the original makes it stale without a
-- write. Matching, cooking and the pantry always read the original.
ALTER TABLE recipes ADD COLUMN lang TEXT;
ALTER TABLE recipes ADD COLUMN translation TEXT;
