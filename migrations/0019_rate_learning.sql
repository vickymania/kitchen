-- Usage rates that learn (30-10-2026: "zo min mogelijk zelf instellen
-- en een zo slim mogelijke app"). public/shared/rate-learning.js moves an
-- item's use_per_day toward what the household really does: "op", putting it
-- on the list, "Nog niet", a rebuy from a receipt.
--
-- items.rate_source gains 'learned' (no constraint to change: it is TEXT).
-- items.rate_samples: how many signals the learned rate rests on; 0 when a
-- person or Claude set the rate (item.rate restarts the learning from that
-- value), NULL when it never had a rate of its own.
-- pantry_events.rate_before: on the "op" event that taught a rate, the item's
-- rate before it (JSON { use_per_day, rate_source, rate_samples }), so the
-- toast's undo (pantry.unuse) also undoes the lesson. No data to move,
-- nothing gets a new rev.

ALTER TABLE items ADD COLUMN rate_samples INTEGER;
ALTER TABLE pantry_events ADD COLUMN rate_before TEXT;
