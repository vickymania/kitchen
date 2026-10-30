-- Private items (30-10-2026: "Condooms wil ik wel een herinnering
-- voor, maar alleen ik. Niemand anders in mijn huishouden mag dat item
-- überhaupt op mijn lijstje zien staan."). private_to is the member the item
-- belongs to; NULL (the default, every existing row) is the household's.
-- For every other member the item and everything about it does not exist:
-- worker/ops-store.js filters /api/sync per member and refuses their ops on
-- it as not_found, worker/widget.js filters the widget. Set and cleared only
-- by the op item.private, and only by that member.
ALTER TABLE items ADD COLUMN private_to TEXT;
-- The few private items of a household, read on every pull that has changes
-- and once per ops batch.
CREATE INDEX items_private ON items(household_id, private_to) WHERE private_to IS NOT NULL;
