-- Two items of one thing become one (30-10-2026: the AH receipts put
-- the cat's tuna under "Tonijn" while its rate sits on "Minoestuna", so the
-- pantry and the learning saw nothing). item.merge moves every live row of
-- the from-item to the into-item and tombstones the from-item with
-- merged_into = the into-item's id.
--
-- That tombstone is the alias: it keeps its name_key (items_name is unique per
-- household, tombstones included, so no new item can take the name), and the
-- op engine's findItem follows merged_into from a name that has no live item
-- to the item it went into. So an AH or Lidl receipt, a list line or an MCP
-- tool that still says "Tonijn" lands on "Minoestuna". No data to move,
-- nothing gets a new rev.

ALTER TABLE items ADD COLUMN merged_into TEXT;
