// Shelf prices of other stores on a screen (public/shared/store-prices.js,
// public/shared/line-prices.js): "AH €2,19 · Dirk ≈€1,89 · Jumbo €2,05", the
// cheapest in bold, "≈" for a comparable product (another product of the same
// kind and a similar pack, Prices v2) with "≈ vergelijkbaar" once at the end,
// and the day of the prices when they are older than two days. With "Ik ben
// bij…" only that store's price ("Dirk €2,19 · vergelijkbaar").
import { h } from "./dom.js";
import { t, getLocale } from "./i18n.js";
import { money } from "./product.js";
import { localToday } from "../shared/intervals.js";
import { oldPricesDay, shortStore } from "../shared/store-prices.js";
import { productPrices, linePrices } from "../shared/line-prices.js";
import { sameStore } from "../shared/stores.js";

/** The prices line of a list of store prices ({ store, cents, comparable, on }), or null. */
export function pricesText(list, { store = null, today = localToday() } = {}) {
  const shownList = store ? list.filter((x) => sameStore(x.store, store)) : list;
  if (!shownList.length) return null;
  const old = oldPricesDay(shownList, today);
  const day = old ? new Date(`${old}T12:00:00`).toLocaleDateString(getLocale() === "nl" ? "nl-NL" : "en-GB", { day: "numeric", month: "short" }) : null;
  // The cheapest is marked only when another store asks more.
  const low = shownList.length > 1 && shownList[0].cents < shownList.at(-1).cents ? shownList[0].cents : null;
  const parts = [];
  shownList.forEach((x, i) => {
    if (i) parts.push(" · ");
    const text = `${shortStore(x.store)} ${x.comparable && !store ? "≈" : ""}${money(x.cents)}`;
    parts.push(x.cents === low ? h("b", { class: "cheapest" }, text) : text);
  });
  const comparable = shownList.some((x) => x.comparable);
  // One store: "· vergelijkbaar: Dirk Scharreleieren" (what the comparable product is).
  const what = store && comparable ? ` · ${t("prices.comparable")}: ${shownList[0].name}${shownList[0].size ? ` ${shownList[0].size}` : ""}` : null;
  return h("span", { class: "store-prices mono" }, ...parts,
    what ?? (comparable ? h("span", { class: "prices-note" }, ` · ≈ ${t("prices.comparable")}`) : null),
    day ? h("span", { class: "prices-day" }, ` · ${t("prices.of", { day })}`) : null);
}

/** The prices line of a product (product screen, "Laatst gekocht"), or null when it has none. */
export function pricesLine(view, product, { store = null, today = localToday() } = {}) {
  return pricesText(productPrices(view, product, today), { store, today });
}

/** The prices line of a list line (its details), or null. */
export function linePricesLine(view, entry, { store = null, today = localToday(), list = null } = {}) {
  return pricesText(list ?? linePrices(view, entry, today), { store, today });
}
