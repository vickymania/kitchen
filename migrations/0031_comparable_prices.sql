-- Prices v2 (30-10-2026: "als ik naar de verschillende winkels kijk
-- ontbreekt bij bijna alles nog steeds de prijs per item"). Besides the exact
-- price of his own product, store_prices keeps per item and store the price
-- of the COMPARABLE product (public/shared/comparable-prices.js) where that
-- store does not sell any of his products of the item: id
-- "spc-<store>-<item_id>", comparable = 1, item_id the item, product_id the
-- product it was compared with ('' when the item has none). Exact rows keep
-- comparable 0 or NULL and item_id NULL. Written only by prices.sync; at most
-- one comparable row per item and store, for the items he has a product of or
-- on the list. item_id also hides a private item's row from the others
-- (worker/privacy.js rowHidden).
ALTER TABLE store_prices ADD COLUMN item_id TEXT;
ALTER TABLE store_prices ADD COLUMN comparable INTEGER;
