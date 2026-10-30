-- "Weer nodig" scope per item (28-10-2026). NULL: the rule decides
-- (recipe ingredients that are no cooking basic are left out,
-- public/shared/again-scope.js); 'show' always lists the item; 'hide' never
-- does. Set through item.again; no data to move.

ALTER TABLE items ADD COLUMN again TEXT;
