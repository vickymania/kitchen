// groceries.vexed.works: the shared list, per store like the widget. The box
// on the left puts a line in the basket (the other phones see it within
// seconds); a tap on the rest of the line opens its details. The basket sits
// on top until someone clears it, so a mistap can be undone.
import { h, title, toast, sheet, confirmSheet, newId, svg, CHECK_SVG, fill } from "./dom.js";
import { t, formatAmounts, getLocale } from "./i18n.js";
import { parseListInput, parseAmount } from "../shared/ingredients.js";
import { OpError } from "../shared/ops.js";
import * as store from "./store.js";
import { syncLine } from "./status.js";
import { productLabel, preferredSheet, money, whyText, privateBlock, privateMark } from "./product.js";
import { currentOffers, isCoupon } from "../shared/offers.js";
import { resolveProduct, lastPrice, purchasesByProduct } from "../shared/preferences.js";
import { listLayout, basketOpen } from "../shared/list-groups.js";
import { pickReceipt } from "./receipt.js";
import { getStore, setStore, storesOf } from "./shop.js";
import { useUpStrip, lowStrip, soonSection } from "./pantry.js";
import { localToday, daysBetween } from "../shared/intervals.js";
import { addDays } from "../shared/shelf-life.js";
import { cookPrompts } from "../shared/cook-prompts.js";
import { markCooked } from "./recipe.js";
import { dealRuleSheet, ruleLine } from "./deals.js";
import { rulesOf, cheaperElsewhere, liveLineOffers, dealsFor } from "../shared/deals.js";
import { isDealNote } from "../shared/store-prices.js";
import { pricesLine } from "./prices.js";
import { exactItem, didYouMean } from "../shared/suggest.js";
import { compactKey } from "../shared/item-names.js";
import { suggestBox, linkSheet, relink } from "./suggest-box.js";
import { rateAskStrip } from "./stars.js";
import { reviewStrip } from "./review.js";

/**
 * "… gekookt?" (public/shared/cook-prompts.js): from the day after shopping
 * for a recipe that nobody marked cooked. "Ja" runs markCooked on that day
 * (takes, pending takes, the toast with undo); "Nog niet" asks again tomorrow
 * on every phone (recipe.cook_prompt).
 */
function cookAskStrip(view, today) {
  const asks = cookPrompts(view, today);
  if (!asks.length) return null;
  const cooked = async (a, on) => {
    const recipe = store.getView().recipes?.[a.recipe_id];
    if (recipe) await markCooked(recipe, { on });
  };
  const later = (a) => store.dispatch({ type: "recipe.cook_prompt", recipe_id: a.recipe_id, shopped_on: a.shopped_on, action: "snooze", on: today })
    .catch((err) => toast(err instanceof OpError ? t(`errors.${err.code}`) : t("errors.refused"), { error: true }));
  return h("section", { class: "low-strip cook-ask", "aria-label": t("cookask.label") },
    h("h2", { class: "low-label mono" }, t("cookask.label")),
    h("ul", {}, asks.map((a) => h("li", { class: "low-row" },
      h("span", { class: "low-name" }, t("cookask.question", { title: a.title })),
      h("span", { class: "low-why mono" }, t("cookask.shopped", { n: daysBetween(a.shopped_on, today) })),
      h("span", { class: "low-acts cook-acts" },
        h("button", { type: "button", class: "btn ghost low-add", onclick: () => cooked(a, addDays(today, -1)) }, t("cookask.yes_yesterday")),
        h("button", { type: "button", class: "btn ghost low-add", onclick: () => cooked(a, today) }, t("cookask.yes_today")),
        h("button", { type: "button", class: "btn ghost low-later", onclick: () => later(a) }, t("cookask.not_yet")))))));
}

/** List | Again | Pantry | Deals | Recently bought, and the receipt button: the same strip on every tab. */
export function groceryTabs(current) {
  const tab = (key, href) => h("a", { href, class: "tab mono", "aria-current": current === key ? "page" : null }, t(`tabs.${key}`));
  return h("nav", { class: "tabs" }, h("div", { class: "wrap" },
    tab("list", "#/"), tab("again", "#/again"), tab("pantry", "#/pantry"), tab("deals", "#/deals"), tab("recent", "#/recent"),
    h("button", { type: "button", class: "btn ghost receipt-btn mono", onclick: pickReceipt }, t("receipt.scan"))));
}

async function editEntry(e) {
  const name = h("input", { value: e.title, maxlength: "120" });
  const amount = h("input", { value: formatAmounts(e.amounts), maxlength: "40" });
  const note = h("input", { value: e.note, maxlength: "500" });
  const view = store.getView();
  const rules = e.item_id ? rulesOf(view, e.item_id) : [];
  // The product a rule can be "only" for: the line's preferred one, else the one a rule names.
  const ruled = rules.find((r) => r.product_id && view.products?.[r.product_id]);
  const ruleProduct = resolveProduct(view, e, null)?.product ?? (ruled ? view.products[ruled.product_id] : null);
  const result = await sheet((close) => h("form", { onsubmit: (ev) => { ev.preventDefault(); close("save"); } },
    h("h2", {}, t("list.edit")),
    h("label", { class: "field" }, h("span", { class: "mono" }, t("list.name")), name),
    h("label", { class: "field" }, h("span", { class: "mono" }, t("list.amount")), amount),
    h("label", { class: "field" }, h("span", { class: "mono" }, t("list.note")), note),
    e.item_id ? h("button", { type: "button", class: "btn ghost mono", onclick: () => close("prefer") }, t("product.preferred")) : null,
    e.item_id ? h("button", { type: "button", class: "btn ghost mono", onclick: () => close("rule") }, t("rule.title")) : null,
    rules.map((r) => h("p", { class: "hint now" }, ruleLine(view, r))),
    privateBlock(e.item_id ? view.items[e.item_id] : null),
    h("div", { class: "actions" },
      h("button", { type: "submit", class: "btn primary grow" }, t("common.save")),
      h("button", { type: "button", class: "btn signal", onclick: () => close("delete") }, t("list.delete")))));
  try {
    const item = store.getView().items[e.item_id];
    if (result === "prefer" && item) await preferredSheet(item, { entry: e, store: getStore() });
    if (result === "rule" && item) await dealRuleSheet(item, ruleProduct, { productFirst: Boolean(ruled) });
    if (result === "delete") await store.dispatch({ type: "entry.delete", id: e.id });
    if (result === "save") {
      const op = { type: "entry.update", id: e.id };
      if (name.value.trim() !== e.title) Object.assign(op, { title: name.value, item_id: newId() });
      if (amount.value.trim() !== formatAmounts(e.amounts)) op.amounts = parseAmount(amount.value);
      if (note.value.trim() !== e.note) op.note = note.value;
      if (Object.keys(op).length > 2) await store.dispatch(op);
    }
  } catch (err) {
    toast(err instanceof OpError ? t(`errors.${err.code}`) : t("errors.refused"), { error: true });
  }
}

/**
 * "Dirk · 1+1 gratis · €1,99 · t/m 1 nov", and "+2 meer" when more stores
 * have it. `mine`: the offer is on the line's own product, said first.
 */
function dealLine(found, { mine = false } = {}) {
  const o = found[0];
  const day = new Date(`${o.valid_until}T12:00:00`)
    .toLocaleDateString(getLocale() === "nl" ? "nl-NL" : "en-GB", { day: "numeric", month: "short" });
  const rest = [o.deal, money(o.price_cents) || null, t("list.deal_until", { day })].filter(Boolean).join(" · ");
  return h("span", { class: mine ? "deal mine mono" : "deal mono" },
    mine ? h("span", { class: "deal-tag" }, `${t("list.deal_mine")} · `) : null,
    h("b", {}, o.store), isCoupon(o) ? h("span", { class: "deal-tag" }, ` · ${t("list.coupon")}`) : null,
    ` · ${mine ? rest : `${o.name} · ${rest}`}`,
    found.length > 1 ? h("span", { class: "more-deals" }, ` ${t("list.deal_more", { n: found.length - 1 })}`) : null);
}

/** "Bij Dirk €1,19 · AH €1,65": the line's product is cheaper at the other regular store. */
function cheaperLine({ cheap, dear }) {
  const short = (s) => (s === "Albert Heijn" ? "AH" : s);
  return h("span", { class: "cheaper mono" },
    t("list.cheaper_at", { store: short(cheap.store) }), " ", h("b", {}, money(cheap.cents)),
    ` · ${short(dear.store)} ${money(dear.cents)}`);
}

/**
 * The product this line resolves to at the chosen store, with why and its last
 * price there. A store_only product says its store as "haal bij Lidl" instead.
 */
function productLine(resolved, price) {
  const p = resolved.product;
  const why = whyText(resolved.onlyAt ? { ...resolved.why, store: null } : resolved.why);
  return h("a", { class: "prod mono", href: `#/product/${p.id}`, "aria-label": t("product.open", { name: productLabel(p) }) },
    `→ ${productLabel(p)}`,
    price !== null ? h("span", { class: "prod-price" }, ` · ${money(price)}`) : null,
    why ? h("span", { class: "why" }, ` · ${why}`) : null);
}

/** "haal bij Lidl": the line's product is sold at one store only. */
const onlyAtLine = (store) => h("span", { class: "only-at mono" }, t("list.only_at", { store }));


/** The line's note without an offer Deals once wrote into it: offers are shown live. */
const ownNote = (e) => (isDealNote(e.note) ? "" : e.note);

/** One line under a group: "→ AH Halfvolle melk", "Haal bij Lidl", the note (as the widget's short line). */
function shortLine(e, resolved) {
  const parts = [
    resolved?.onlyAt ? t("list.only_at", { store: resolved.onlyAt }) : resolved ? `→ ${productLabel(resolved.product)}` : null,
    ownNote(e) || null,
  ].filter(Boolean);
  return parts.length ? h("span", { class: "short mono" }, parts.join(" · ")) : null;
}

/**
 * A line's details, opened in place by a tap on the line (Thomas,
 * 28-10-2026): product and store with its last price, the offers, the
 * recipes, amount, note, the deal rules, and what the edit sheet offered.
 */
function lineDetails(e, view, me, resolved, price, offers, cheaper) {
  const who = e.added_by && e.added_by !== me?.member.id ? view.members[e.added_by]?.name : null;
  const rules = e.item_id ? rulesOf(view, e.item_id) : [];
  const amount = formatAmounts(e.amounts);
  // Other stores' shelf prices of the line's product (Checkjebon); with "Ik ben bij…" only that
  // store's, also when his product there is the one he usually buys elsewhere (no preference for that store).
  const priced = resolved?.product ?? (e.item_id ? resolveProduct(view, e, null)?.product : null);
  const prices = priced && !e.checked_at ? pricesLine(view, priced, { store: getStore() }) : null;
  const row = (label, ...value) => h("div", { class: "kv-row" }, h("dt", { class: "mono" }, label), h("dd", {}, ...value));
  const act = (label, onclick, cls = "btn mono") => h("button", { type: "button", class: cls, onclick }, label);
  return h("div", { class: "line-details" },
    h("dl", {},
      resolved ? row(t("list.d_product"), productLine(resolved, price)) : null,
      resolved ? row(t("list.d_store"), resolved.onlyAt ? onlyAtLine(resolved.onlyAt) : (resolved.why.store || resolved.product.store || t("list.anywhere"))) : null,
      amount ? row(t("list.amount"), amount) : null,
      ownNote(e) ? row(t("list.note"), ownNote(e)) : null,
      e.sources?.length ? row(t("list.d_recipes"), t("list.for", { recipes: e.sources.map((s) => s.title).join(", ") })) : null,
      offers.length ? row(t("list.d_offers"), offers) : null,
      prices ? row(t("prices.label"), prices) : null,
      cheaper ? row(t("list.d_cheaper"), cheaperLine(cheaper)) : null,
      rules.length ? row(t("rule.title"), rules.map((r) => h("span", { class: "rule-line" }, ruleLine(view, r)))) : null,
      who ? row(t("list.d_added"), t("list.added_by", { name: who })) : null),
    h("div", { class: "line-actions" },
      act(t("list.edit"), () => editEntry(e)),
      e.checked_at ? null : act(t("names.link"), () => linkSheet(e)),
      e.item_id ? act(t("product.preferred"), () => openPreferred(e)) : null,
      e.item_id ? act(t("rule.title"), () => openRule(e)) : null,
      act(t("list.delete"), () => deleteEntry(e), "btn danger mono")));
}

async function openPreferred(e) {
  const item = store.getView().items[e.item_id];
  if (item) await preferredSheet(item, { entry: e, store: getStore() });
}

async function openRule(e) {
  const view = store.getView();
  const item = view.items[e.item_id];
  if (!item) return;
  const ruled = rulesOf(view, e.item_id).find((r) => r.product_id && view.products?.[r.product_id]);
  const product = resolveProduct(view, e, null)?.product ?? (ruled ? view.products[ruled.product_id] : null);
  await dealRuleSheet(item, product, { productFirst: Boolean(ruled) });
}

/**
 * The × on an open line: off the list at once (entry.delete), with "Terug" in
 * the toast, which puts the same line back (a new line of the same item,
 * amount, note and first recipe).
 */
async function removeEntry(e) {
  try {
    await store.dispatch({ type: "entry.delete", id: e.id });
    toast(t("remove.done", { title: e.title }), {
      action: t("remove.undo"), ms: 7000,
      onAction: () => store.dispatch({
        type: "entry.add", id: newId(), item_id: e.item_id ?? newId(), title: e.title, amounts: e.amounts ?? [], note: e.note ?? "",
        ...(e.sources?.[0] ? { source: e.sources[0] } : {}),
      }).catch((err) => toast(err instanceof OpError ? t(`errors.${err.code}`) : t("errors.refused"), { error: true })),
    });
  } catch (err) {
    toast(err instanceof OpError ? t(`errors.${err.code}`) : t("errors.refused"), { error: true });
  }
}

async function deleteEntry(e) {
  if (!(await confirmSheet(t("list.delete_confirm", { title: e.title }), t("list.delete"), t("common.cancel")))) return;
  try {
    await store.dispatch({ type: "entry.delete", id: e.id });
  } catch (err) {
    toast(err instanceof OpError ? t(`errors.${err.code}`) : t("errors.refused"), { error: true });
  }
}

/**
 * A list line. Only the square box on the left ticks it (Thomas,
 * 28-10-2026: a mistap on the text must never tick); a tap anywhere else
 * opens or closes its details in place. ctx: { view, me, deals, shop,
 * byProduct, expanded: Set of open ids, rerender }.
 */
function entryRow({ entry: e, resolved }, ctx) {
  const { view, me, deals, shop, byProduct, expanded } = ctx;
  const checked = Boolean(e.checked_at);
  const isOpen = expanded.has(e.id);
  const price = resolved ? lastPrice(resolved.product, resolved.onlyAt ?? shop, byProduct) : null;
  const { mine, named } = checked ? { mine: [], named: [] } : liveLineOffers(e, resolved?.product, deals, ctx.hits, shop);
  const cheaper = checked ? null : cheaperElsewhere(view, e, deals, shop, byProduct);
  const toggleOpen = () => {
    if (expanded.has(e.id)) expanded.delete(e.id); else expanded.add(e.id);
    ctx.rerender();
  };
  const tick = (ev) => {
    ev.stopPropagation();
    store.dispatch({ type: "entry.check", id: e.id, checked: !checked });
  };
  const offers = [...mine.map((o) => dealLine([o], { mine: true })), ...named.map((o) => dealLine([o]))];
  // What the line is linked to (30-10-2026): "Nieuw" when the line
  // made its item, what was typed when it is not the item's name, and for a
  // new item the known one it probably meant, one tap away.
  const fresh = !checked && Boolean(e.new_item);
  const typed = e.typed && compactKey(e.typed) !== compactKey(e.title) ? e.typed : null;
  const meant = fresh ? didYouMean(view, e.typed || e.title, e.item_id, { today: localToday() }) : null;
  return h("li", { class: `entry line${checked ? " checked" : ""}${isOpen ? " open" : ""}`, id: `entry-${e.id}` },
    h("button", {
      type: "button", class: "tick", role: "checkbox", "aria-checked": String(checked),
      "aria-label": t(checked ? "list.untick" : "list.tick", { title: e.title }), onclick: tick,
    }, h("span", { class: "box" }, svg(CHECK_SVG))),
    h("button", { type: "button", class: "line-main", "aria-expanded": String(isOpen), onclick: toggleOpen },
      h("span", { class: "ttl" }, e.title, privateMark(view, e.item_id), fresh ? h("span", { class: "new-tag mono" }, t("names.new")) : null),
      h("span", { class: "amt" }, formatAmounts(e.amounts)),
      typed ? h("span", { class: "typed mono" }, t("names.typed", { text: typed })) : null,
      shortLine(e, resolved),
      !isOpen && mine.length ? dealLine(mine, { mine: true }) : null,
      !isOpen && named.length ? dealLine(named) : null,
      !isOpen && cheaper ? cheaperLine(cheaper) : null),
    // × (30-10-2026): a line added by mistake goes, one tap, with undo.
    checked ? null : h("button", { type: "button", class: "del", "aria-label": t("remove.aria", { title: e.title }), onclick: () => removeEntry(e) }, "×"),
    meant ? h("button", { type: "button", class: "meant mono", onclick: () => relink(e, meant.item) },
      t("names.did_you_mean", { name: meant.item.name })) : null,
    isOpen ? lineDetails(e, view, me, resolved, price, offers, cheaper) : null);
}

/**
 * The list. focusId: a line to open, from the widget's "Open in app"
 * (#/entry/<id>): its row is scrolled into view with its details open.
 */
export function mountGroceries(root, focusId = null) {
  const eyebrow = h("div", { class: "eyebrow mono" });
  const bar = h("i", {});
  const readout = h("span", { class: "sig-readout mono" });
  const input = h("input", {
    placeholder: t("list.add_placeholder"), "aria-label": t("list.add_placeholder"),
    autocomplete: "off", enterkeyhint: "done", maxlength: "120",
  });
  const open = h("div", {});
  // "Op tijd opmaken" (phase 4): only there when something in the pantry must be eaten soon.
  const cookAsk = h("div", {});
  // "Hoe was <recipe> gisteren?" (public/app/stars.js): the day after a cook.
  const rateAsk = h("div", {});
  // "Nachtcontrole": the home server's nightly check, when it asks something (public/app/review.js).
  const review = h("div", {});
  const useUp = h("div", {});
  // "Bijna op": only there when something runs out that is not on the list yet.
  const low = h("div", {});
  const cart = h("div", {});
  // "Al nodig?" under the open lines: a hint, not part of the list.
  const soon = h("div", {});
  // "Ik ben bij...": this phone's store for this trip (public/app/shop.js).
  const shopPick = h("select", { class: "shop-pick", "aria-label": t("shop.label") });
  shopPick.addEventListener("change", () => {
    setStore(shopPick.value || null);
    render(store.getView(), store.getStatus());
  });

  // Enter links by itself only to an exact name or alias (also without
  // spaces): exactItem is the server's findItem. Anything else is added as
  // typed, and a new item's line says "Nieuw" with "Bedoel je …?".
  const put = async (op) => {
    try {
      await store.dispatch({ type: "entry.add", id: newId(), ...op });
      input.value = "";
      box.clear();
    } catch (err) {
      toast(err instanceof OpError ? t(`errors.${err.code}`) : t("errors.refused"), { error: true });
    }
  };
  const add = async (ev) => {
    ev.preventDefault();
    const parsed = parseListInput(input.value);
    if (!parsed.title) return;
    const hit = exactItem(store.getView(), parsed.title);
    await put({ ...parsed, item_id: hit?.id ?? newId() });
  };
  // A tapped suggestion: a line of exactly that item.
  const box = suggestBox(input, {
    textOf: (v) => parseListInput(v).title ?? "",
    onPick: (item) => put({ ...parseListInput(input.value), title: item.name, item_id: item.id }),
  });

  root.append(
    h("section", { class: "hero wrap" }, eyebrow, title(t("list.title"), { long: t("list.title").length > 9 })),
    h("section", { class: "signal-strip", "aria-hidden": "true" },
      h("div", { class: "wrap" }, h("span", { class: "sig-label mono" }, t("list.progress")), h("span", { class: "sig-bar" }, bar), readout)),
    groceryTabs("list"),
    h("div", { class: "wrap" },
      review,
      cookAsk,
      rateAsk,
      useUp,
      low,
      h("label", { class: "shop mono" }, h("span", {}, t("shop.label")), shopPick),
      h("form", { class: "add", onsubmit: add }, input, h("button", { type: "submit", class: "btn primary", "aria-label": t("list.add") }, "+")),
      box.list,
      cart, open, soon),
  );

  // null: the basket opens while short (basketOpen); a tap on its heading is remembered.
  let cartChoice = null;
  // The lines whose details are open (a tap on the line).
  const expanded = new Set();
  function render(view, status) {
    const me = store.getMe();
    const all = Object.values(view.entries);
    const todo = all.filter((e) => !e.checked_at).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const done = all.filter((e) => e.checked_at).sort((a, b) => b.checked_at.localeCompare(a.checked_at));
    const total = todo.length + done.length;

    fill(eyebrow,
      h("span", {}, h("b", {}, t("list.to_get", { n: todo.length }))),
      h("span", {}, t("list.in_cart", { n: done.length })),
      syncLine(status));
    bar.style.width = total ? `${(done.length / total) * 100}%` : "0";
    readout.textContent = `${done.length} / ${total}`;

    fill(review, reviewStrip(view, () => render(store.getView(), store.getStatus())));
    fill(cookAsk, cookAskStrip(view, localToday()));
    fill(rateAsk, rateAskStrip(view, localToday()));
    fill(useUp, useUpStrip(view, localToday()));
    fill(low, lowStrip(view, localToday(), () => render(store.getView(), store.getStatus())));

    // Offers count from their first to their last day (public/shared/offers.js).
    const deals = currentOffers(view.offers, new Date().toLocaleDateString("sv-SE"));
    const shop = getStore();
    const stores = storesOf(view, deals);
    if (shop && !stores.includes(shop)) stores.push(shop);
    fill(shopPick, h("option", { value: "" }, t("shop.none")), stores.map((s) => h("option", { value: s }, s)));
    shopPick.value = shop ?? "";
    shopPick.classList.toggle("set", Boolean(shop));
    const byProduct = purchasesByProduct(view.purchases);
    // The basket on top, then the open lines per store as on the widget, the
    // chosen store first (public/shared/list-groups.js listLayout).
    const newest = [...all].sort((x, y) => y.created_at.localeCompare(x.created_at));
    const layout = listLayout(view, newest, shop);
    for (const id of expanded) if (!view.entries[id]) expanded.delete(id);
    // What the Deals tab finds for an item shows on its line too, live (liveLineOffers).
    const hits = dealsFor(view, localToday());
    const ctx = { view, me, deals, shop, byProduct, hits, expanded, rerender: () => render(store.getView(), store.getStatus()) };
    const basket = layout.find((s) => s.kind === "basket");
    const groups = layout.filter((s) => s.kind === "store");

    const details = basket ? h("details", {
      class: "cart", open: basketOpen(basket.lines.length, cartChoice),
      ontoggle: () => { cartChoice = details.open; },
    },
    h("summary", {}, h("h2", {}, t("list.cart")), h("span", { class: "note mono mute" }, String(basket.lines.length))),
    h("ul", { class: "entries" }, basket.lines.map((l) => entryRow(l, { ...ctx, deals: [] }))),
    h("div", { class: "actions" }, h("button", {
      type: "button", class: "btn",
      onclick: () => store.dispatch({ type: "entry.clear_checked", ids: done.map((e) => e.id) }),
    }, t("list.clear_cart")))) : null;
    fill(cart, details);

    const heading = (g) => g.store === null ? t("list.anywhere") : g.away ? t("list.other_store", { store: g.store }) : g.store;
    fill(open, groups.length
      ? groups.map((g) => h("section", { class: `store-group${g.away ? " away" : ""}${shop && !g.away && g.store !== null ? " here" : ""}` },
        h("h3", { class: "sub mono" }, heading(g), h("span", { class: "n" }, `· ${g.lines.length}`)),
        h("ul", { class: "entries" }, g.lines.map((l) => entryRow(l, ctx)))))
      : h("p", { class: "empty" }, t("list.empty")));
    fill(soon, soonSection(view, localToday()));

    const focused = focusId && view.entries[focusId];
    if (focused) {
      focusId = null;
      history.replaceState(null, "", "#/");
      setTimeout(() => {
        document.getElementById(`entry-${focused.id}`)?.scrollIntoView({ block: "center" });
      });
      if (!expanded.has(focused.id)) { expanded.add(focused.id); render(view, status); }
    }
  }

  return store.subscribe(render);
}
