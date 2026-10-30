-- A recipes-only person (30-10-2026: his father Henk sees the recipe
-- book and gives his own stars, never the groceries side). The flag sits on
-- the member, so every device of that person is held to it, also one he links
-- later with a code. An invite link (pairing_codes.kind 'invite') makes such a
-- member, or adds a device to one, and copies the flag from here.
ALTER TABLE members ADD COLUMN recipes_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pairing_codes ADD COLUMN recipes_only INTEGER NOT NULL DEFAULT 0;
