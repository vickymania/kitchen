// An example of the reviewed Lidl mapping table (tools/import_lidl.mjs). The
// public repo ships this file as tools/lidl_items.mjs; a real household keeps
// its own table, built from its own receipts, in a private copy.
//
// Lidl's receipts give only a till name and an article number, so:
//   LIDL_BRANDS       Lidl's own brands, cut off the front of a till name.
//   LIDL_BRAND_ITEMS  a brand that says the item.
//   LIDL_ITEMS        per line, first match wins: { key: "art:<article>" or
//                     "name:<nameKey>", or re: a pattern on the nameKey },
//                     item: the item name, pin: an existing product the line IS.

export const LIDL_BRANDS = [
  "Alesto", "Baresa", "Bellarom", "Belbake", "Chef Select", "Combino", "Crownfield", "Deluxe",
  "Kania", "Milbona", "Snack Day", "Solevita", "Vitasia", "W5",
];

export const LIDL_BRAND_ITEMS = {};

/** A product sold at Lidl only, made by hand in the app (store_only). */
export const KANIA_MACARONI = { id: "product-kania-macaroni-lidl", name: "Kania kruidenmix pasta", brand: "Kania", size: "" };

/** A pack the pantry counts per piece, not per pack. */
export const ARIEL_PODS = { id: "lidl-product-0003926", name: "Huismerk waspods", brand: "", size: "50 stuks" };

export const LIDL_ITEMS = [
  // A seasoning mix is the item "macaroni kruidenmix", never the pasta "Macaroni".
  { re: /\bmac(aroni)?\b.*\b(spaghetti|kruid\w*|mix)\b/, item: "macaroni kruidenmix", pin: KANIA_MACARONI },
  { re: /\bmaaltijdmix macaroni\b/, item: "macaroni kruidenmix", pin: KANIA_MACARONI },
  { key: "art:0003926", item: "Wasmiddel", pin: ARIEL_PODS },
  { re: /\bkaars\b/, item: "Kaarsen" },
  { re: /\bcayenne peper\b/, item: "Cayennepeper" },
];

/** The table line for a receipt line ({ artId, key }), or null. */
export function lidlTableLine(line, table = LIDL_ITEMS) {
  for (const row of table) {
    if (row.key && (row.key === `art:${line.artId}` || row.key === `name:${line.key}`)) return row;
    if (row.re && row.re.test(line.key)) return row;
  }
  return null;
}
