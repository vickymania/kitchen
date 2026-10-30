-- "Alleen bij deze winkel" (28-10-2026): some products are sold at one
-- store only, such as the Lidl macaroni herbs for "Pastapotje HenkTorino". A
-- product with store_only = 1 is bought at its own `store` whatever store is
-- chosen on the list: the line says "haal bij <winkel>", sits under "Andere
-- winkel" when another store is chosen, never gets a cheaper-store hint and
-- only matches offers from that store.
--
-- Set through product.put (refused without a store); a receipt or the AH
-- import never clears it and never moves the product to another store.

ALTER TABLE products ADD COLUMN store_only INTEGER NOT NULL DEFAULT 0;
