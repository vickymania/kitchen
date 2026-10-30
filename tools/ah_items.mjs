// An example of the reviewed AH mapping table (tools/import_ah.mjs). The
// public repo ships this file as tools/ah_items.mjs; a real household keeps
// its own table, built from its own receipts, in a private copy.
//
// AH_ITEMS: AH webshop id (or "pos:<till code>" for a line without a webshop
// product) -> the item name as the household writes it on its list.
// AH_BRAND_ITEMS: a brand (nameKey) whose products are one item, whatever
// their own name says ("Pringles Original" is chips).
// OTHER_PEOPLE_CITIES / OWNERS: a shared AH account. Receipts paid in these
// towns (nameKey) belong to someone else and are never imported; owners.json
// can override one receipt with OWNERS.own, one of OWNERS.others, or "skip".

export const OTHER_PEOPLE_CITIES = ["westerbroek", "oosthoek"];
export const OWNERS = { own: "sam", others: ["noor"] };

export const AH_ITEMS = {
  "467677": "Börek",
  "62025": "Pasta",
  "164101": "Maaltijdmix",
  "230786": "Brood",
  "32494": "Bollen",
};

export const AH_BRAND_ITEMS = {
  "pringles": "Chips",
  "doritos": "Tortillachips",
  "monster": "Energy drink",
  "red bull": "Energy drink",
  "magnum": "IJs",
  "whiskas": "Kattenvoer",
};
