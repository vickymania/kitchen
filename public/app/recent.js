// The "Laatst gekocht" tab of groceries (#/recent, 30-10-2026): every
// purchase newest first, per shopping trip, each line the exact product with
// what was paid and your stars for it (rating.set) in place. A store filter on
// top, and "Beste koop" per item: the most stars per euro. The grouping and
// the pick are public/shared/recent-purchases.js; never an excluded thing.
import { h, title, toast, newId, fill } from "./dom.js";
import { t, getLocale, formatNumber } from "./i18n.js";
import { OpError } from "../shared/ops.js";
import * as store from "./store.js";
import { syncLine } from "./status.js";
import { groceryTabs } from "./groceries.js";
import { productLabel, money, ratingsOf } from "./product.js";
import { miniStars } from "./stars.js";
import { pricesLine } from "./prices.js";
import { brandedName } from "../shared/offers.js";
import { recentTrips, tripStores, bestBuys, TRIPS_PAGE } from "../shared/recent-purchases.js";

// The store chosen and how many trips are open, while the app is open.
let chosenStore = null;
let shown = TRIPS_PAGE;

const refused = (err) => toast(err instanceof OpError ? t(`errors.${err.code}`) : t("errors.refused"), { error: true });

/** "do 29 okt" */
function dayText(day) {
  return new Date(`${day}T12:00:00`).toLocaleDateString(getLocale() === "nl" ? "nl-NL" : "en-GB", { weekday: "short", day: "numeric", month: "short" });
}

/** "€1,09/l": a best buy's price per kg, l, piece or pack. */
const perText = (b) => `${money(b.cents)}${t(`recent.per.${b.measure}`)}`;

/** Your stars for a product, in place; a tap on the same stars takes them away. */
function productStarsFor(view, product, me) {
  const mine = ratingsOf(view, product.id).find((r) => r.member_id === me?.member.id);
  return miniStars(mine?.stars ?? null, (n) => store.dispatch(n === null
    ? { type: "rating.set", product_id: product.id, stars: null }
    : { type: "rating.set", id: mine?.id ?? newId(), product_id: product.id, stars: n, note: mine?.note ?? "" }).catch(refused),
  { label: productLabel(product) });
}

function lineRow(view, line, me, best) {
  const { purchase: p, product, item, unit_cents: unit } = line;
  const name = product ? brandedName(product) : p.title;
  const each = p.qty > 1 && unit !== null ? t("recent.each", { n: formatNumber(p.qty), price: money(unit) }) : null;
  const pick = item ? best.get(item.id) : null;
  const isBest = pick && product && pick.product.id === product.id;
  return h("li", { class: "row static recent-line" },
    product ? h("a", { class: "ttl", href: `#/product/${product.id}` }, name) : h("span", { class: "ttl" }, name),
    h("span", { class: "st mono" }, money(p.price_cents)),
    h("span", { class: "meta" }, [product?.size, each].filter(Boolean).join(" · ") || null,
      isBest ? h("span", { class: "best-tag mono" }, ` ${t("recent.is_best")}`) : null),
    product ? productStarsFor(view, product, me) : null,
    product ? pricesLine(view, product) : null,
    pick && !isBest ? h("span", { class: "best mono" }, t("recent.best_line", { product: productLabel(pick.product), stars: formatNumber(pick.stars), price: perText(pick) })) : null);
}

export function mountRecent(root) {
  const eyebrow = h("div", { class: "eyebrow mono" });
  const filter = h("div", { class: "filters recent-stores" });
  const bestBox = h("div", {});
  const body = h("div", {});
  root.append(
    h("section", { class: "hero wrap" }, eyebrow, title(t("recent.title"), { long: t("recent.title").length > 9 })),
    groceryTabs("recent"),
    h("div", { class: "wrap" }, filter, bestBox, body),
  );
  // The last tab: under 520 px the strip scrolls, so bring this one into view.
  setTimeout(() => root.querySelector(".tab[aria-current]")?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  let last = null;
  const render = () => {
    if (!last) return;
    const { view, status } = last;
    const me = store.getMe();
    const all = recentTrips(view);
    const stores = tripStores(all);
    if (chosenStore && !stores.includes(chosenStore)) chosenStore = null;
    const trips = chosenStore ? recentTrips(view, { store: chosenStore }) : all;
    const best = bestBuys(view);
    const chip = (label, value) => h("button", {
      type: "button", class: "chip", "aria-pressed": String(chosenStore === value),
      onclick: () => { chosenStore = value; shown = TRIPS_PAGE; render(); },
    }, label);

    fill(eyebrow,
      h("span", {}, h("b", {}, t("recent.trips", { n: trips.length }))),
      syncLine(status));
    fill(filter, stores.length > 1 ? [chip(t("recent.all"), null), stores.map((s) => chip(s, s))] : null);
    const bestList = [...best.values()].sort((a, b) => a.item.name.localeCompare(b.item.name, "nl"));
    fill(bestBox, bestList.length ? h("details", { class: "best-buys" },
      h("summary", {}, h("h2", {}, t("recent.best")), h("span", { class: "note mono mute" }, String(bestList.length))),
      h("ul", { class: "rows" }, bestList.map((b) => h("li", { class: "row static rating" },
        h("span", { class: "ttl" }, b.item.name),
        h("span", { class: "meta" }, `${productLabel(b.product)} · ★${formatNumber(b.stars)} · ${perText(b)}`))))) : null);
    fill(body,
      trips.length ? null : h("p", { class: "empty" }, t("recent.empty")),
      trips.slice(0, shown).map((trip) => h("section", { class: "trip" },
        h("div", { class: "section-head" },
          h("h2", {}, trip.store || t("recent.no_store")),
          h("span", { class: "note mono" }, [dayText(trip.day), t("recent.lines", { n: trip.lines.length }), trip.total_cents ? money(trip.total_cents) : null].filter(Boolean).join(" · "))),
        h("ul", { class: "rows" }, trip.lines.map((line) => lineRow(view, line, me, best))))),
      trips.length > shown ? h("div", { class: "actions" },
        h("button", { type: "button", class: "btn", onclick: () => { shown += TRIPS_PAGE; render(); } }, t("recent.more"))) : null);
  };
  return store.subscribe((view, status) => { last = { view, status }; render(); });
}
