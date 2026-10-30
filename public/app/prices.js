// Shelf prices of other stores on a screen (public/shared/store-prices.js):
// "AH €2,19 · Dirk €1,89 · Jumbo €2,05", the cheapest in bold, and the day of
// the prices when they are older than two days. Only for his own products that
// Checkjebon matched; with "Ik ben bij…" only that store's price.
import { h } from "./dom.js";
import { t, getLocale } from "./i18n.js";
import { money } from "./product.js";
import { localToday } from "../shared/intervals.js";
import { pricesOf, oldPricesDay, shortStore } from "../shared/store-prices.js";

/** The prices line of a product, or null when it has none. */
export function pricesLine(view, product, { store = null, today = localToday() } = {}) {
  const list = pricesOf(view.store_prices, product, today, { store });
  if (!list.length) return null;
  const old = oldPricesDay(list, today);
  const day = old ? new Date(`${old}T12:00:00`).toLocaleDateString(getLocale() === "nl" ? "nl-NL" : "en-GB", { day: "numeric", month: "short" }) : null;
  const parts = [];
  list.forEach((x, i) => {
    if (i) parts.push(" · ");
    const text = `${shortStore(x.store)} ${money(x.cents)}`;
    parts.push(x.cheapest ? h("b", { class: "cheapest" }, text) : text);
  });
  return h("span", { class: "store-prices mono" }, ...parts, day ? h("span", { class: "prices-day" }, ` · ${t("prices.of", { day })}`) : null);
}
