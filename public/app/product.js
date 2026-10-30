// One product ("AH Halfvolle melk 1 l"): what it last cost, where, when it
// was bought, and what each person in the household thinks of it (1-10 stars
// and a short note). From here, or from a list line or a recipe, it becomes
// the product to buy for its item: at any store or one, for any recipe or
// one (public/shared/preferences.js), which the list line then shows.
import { STARS_MAX, nextTap, starFill, starsLabel } from "../shared/recipe-ratings.js";
import { h, title, toast, sheet, newId, fill, svg, LOCK_SVG } from "./dom.js";
import { t, getLocale, formatDate } from "./i18n.js";
import { OpError, productKey } from "../shared/ops.js";
import { nameKey } from "../shared/ingredients.js";
import { resolveIngredient } from "../shared/ingredient-match.js";
import { preferenceAt, preferencesOf } from "../shared/preferences.js";
import { itemKind, orderByFit } from "../shared/product-kinds.js";
import { canonicalStore } from "../shared/stores.js";
import { isExcluded } from "../shared/excluded.js";
import { currentOffers, brandedName } from "../shared/offers.js";
import * as store from "./store.js";
import { syncLine } from "./status.js";
import { storesOf } from "./shop.js";
import { ruleBlock } from "./deals.js";
import { productShelfLines, shelfSheet, rateLabel, rateSheet } from "./pantry.js";
import { pricesLine } from "./prices.js";

/** "AH Halfvolle melk · 1 l" */
export function productLabel(p) {
  return [brandedName(p), p.size].filter(Boolean).join(" · ");
}

export function money(cents) {
  if (cents === null || cents === undefined) return "";
  return new Intl.NumberFormat(getLocale() === "nl" ? "nl-NL" : "en-GB", { style: "currency", currency: "EUR" }).format(cents / 100);
}

/** "★8" or "★6,5" (Dutch comma): ten stars in a row would not fit next to the name. */
export const starsText = (n) => starsLabel(n, getLocale());

function refused(err) {
  toast(err instanceof OpError ? t(`errors.${err.code}`) : t("errors.refused"), { error: true });
}

/** The live ratings of a product, with the person's name. */
export function ratingsOf(view, productId) {
  return Object.values(view.ratings ?? {})
    .filter((r) => r.product_id === productId && !r.deleted_at)
    .map((r) => ({ ...r, name: view.members[r.member_id]?.name ?? "" }));
}

/** "voor Mexicaanse lasagne · bij Dirk", "bij Dirk", "voor Chili" or "" (any store, any recipe). */
export function whyText(why) {
  if (!why) return "";
  if (why.recipe && why.store) return t("product.why_recipe_store", { recipe: why.recipe, store: why.store });
  if (why.recipe) return t("product.why_recipe", { recipe: why.recipe });
  if (why.store) return t("product.why_store", { store: why.store });
  return "";
}

/** "Thomas ★4 · Sam ★2": every person's stars, so choosing is easy. */
function ratingsText(view, productId) {
  return ratingsOf(view, productId).map((r) => `${r.name} ${starsText(r.stars)}`).join(" · ");
}

/** The products known for an item: linked to it, or bought for it from a receipt. */
export function candidatesFor(view, item) {
  if (!item) return [];
  const ids = new Set();
  for (const p of Object.values(view.products ?? {})) if (p.item_id === item.id && !p.deleted_at) ids.add(p.id);
  for (const x of Object.values(view.purchases ?? {})) if (x.item_id === item.id && x.product_id && !x.deleted_at) ids.add(x.product_id);
  return [...ids].map((id) => view.products?.[id]).filter((p) => p && !p.deleted_at);
}

// The item a recipe's ingredient means, with the same resolver as cooking and
// "Op de lijst" ("gemalen nootmuskaat" is Nootmuskaat).
const itemByName = (view, name) => resolveIngredient(name, view)?.item ?? null;

/**
 * Choose the product to buy for an item, at any store or one store, for any
 * recipe or one: one of the products known for it (with everyone's stars),
 * none, or a new one typed in. From a list line (the line's recipes are
 * offered), a recipe (that recipe is picked) or the product screen. `item`
 * is null for a recipe ingredient that was never on the list: `title` names
 * it and the op makes the item.
 * opts: { entry, store, recipe: { id, title }, title }
 */
export async function preferredSheet(item, { entry = null, store: shop = null, recipe = null, title: itemTitle = null } = {}) {
  const view = store.getView();
  const name = item?.name ?? itemTitle;
  const recipes = recipe ? [recipe] : (entry?.sources ?? []).map((x) => ({ id: x.recipe_id, title: x.title }));
  const deals = currentOffers(view.offers, new Date().toLocaleDateString("sv-SE"));
  const storePick = h("select", {},
    h("option", { value: "" }, t("product.any_store")),
    storesOf(view, deals).map((x) => h("option", { value: x }, x)));
  storePick.value = shop ? canonicalStore(shop) : "";
  const recipePick = h("select", {},
    h("option", { value: "" }, t("product.any_recipe")),
    recipes.map((r) => h("option", { value: r.id }, t("product.only_recipe", { recipe: r.title }))));
  recipePick.value = recipe?.id ?? "";

  // Best first: the stars everyone gave, then the newest.
  const avg = (p) => {
    const rs = ratingsOf(view, p.id);
    return rs.length ? rs.reduce((n, r) => n + r.stars, 0) / rs.length : 0;
  };
  const sorted = candidatesFor(view, item).sort((a, b) => avg(b) - avg(a) || String(b.updated_at).localeCompare(String(a.updated_at)));
  // A product of the wrong kind (a snack cup for "Pasta") goes last, with a quiet note.
  const known = orderByFit(sorted, item ? itemKind(view, item.id) : null);
  const group = `pick-${newId()}`;
  const option = (value, label, meta) => {
    const input = h("input", { type: "radio", name: group, value });
    return { input, row: h("li", {}, h("label", {}, input, h("span", { class: "cand" }, h("span", {}, label), meta ? h("small", { class: "mute" }, meta) : null))) };
  };
  const options = [
    ...known.map(({ product: p, misfit }) => option(p.id, productLabel(p),
      [ratingsText(view, p.id), money(p.last_price_cents) || null,
        (p.store_only && p.store ? t("product.only_short", { store: canonicalStore(p.store) }) : canonicalStore(p.store)) || null,
        misfit ? t("product.other_kind") : null].filter(Boolean).join(" · "))),
    option("new", t("product.type_one"), null),
    option("", t("product.none"), null),
  ];
  const brand = h("input", { maxlength: "60", placeholder: "AH" });
  const pname = h("input", { maxlength: "120", value: name ?? "" });
  const size = h("input", { maxlength: "40", placeholder: "200 g" });
  const pstore = h("input", { maxlength: "40", placeholder: "Dirk" });
  pstore.dataset.auto = "1";
  // "Alleen bij Lidl te koop": offered as soon as the new product has a store.
  const onlyBox = h("input", { type: "checkbox" });
  const onlyText = h("span", {});
  const onlyRow = h("label", { class: "rule-check" }, onlyBox, onlyText);
  const showOnly = () => {
    const shopName = canonicalStore(pstore.value);
    onlyRow.hidden = !shopName;
    onlyText.textContent = t("product.store_only", { store: shopName });
  };
  pstore.addEventListener("input", () => { delete pstore.dataset.auto; showOnly(); });
  const typed = h("div", { hidden: true },
    h("label", { class: "field" }, h("span", { class: "mono" }, t("product.name")), pname),
    h("label", { class: "field" }, h("span", { class: "mono" }, t("product.brand")), brand),
    h("label", { class: "field" }, h("span", { class: "mono" }, t("product.size")), size),
    h("label", { class: "field" }, h("span", { class: "mono" }, t("product.store")), pstore),
    onlyRow);
  const picked = () => options.find((o) => o.input.checked)?.input.value ?? "";
  const current = h("p", { class: "hint now mono" });
  // A changed store or recipe picks that scope's own choice.
  const showScope = () => {
    const now = item ? preferenceAt(view.preferences ?? {}, item.id, storePick.value, recipePick.value) : null;
    const product = now ? view.products?.[now.product_id] : null;
    for (const o of options) o.input.checked = o.input.value === (product ? product.id : "");
    typed.hidden = true;
    if (pstore.dataset.auto) pstore.value = storePick.value;
    showOnly();
    current.textContent = product ? t("product.now", { product: productLabel(product) }) : t("product.now_none");
  };
  for (const o of options) o.input.addEventListener("change", () => { typed.hidden = picked() !== "new"; });
  storePick.addEventListener("change", showScope);
  recipePick.addEventListener("change", showScope);
  showScope();

  const result = await sheet((close) => h("form", { onsubmit: (ev) => { ev.preventDefault(); close("save"); } },
    h("h2", {}, t("product.preferred")),
    h("p", { class: "hint" }, t("product.preferred_hint", { item: name })),
    h("div", { class: "scope" },
      h("label", { class: "field" }, h("span", { class: "mono" }, t("product.store")), storePick),
      recipes.length ? h("label", { class: "field" }, h("span", { class: "mono" }, t("product.recipe")), recipePick) : null),
    current,
    h("ul", { class: "picklist cands" }, options.map((o) => o.row)),
    typed,
    h("div", { class: "actions" },
      h("button", { type: "submit", class: "btn primary grow" }, t("common.save")),
      h("button", { type: "button", class: "btn", onclick: () => close() }, t("common.cancel")))));
  if (result !== "save") return;
  const scope = { store: storePick.value, recipe_id: recipePick.value };
  const target = item ? { item_id: item.id } : { title: name, item_id: newId() };
  try {
    const choice = picked();
    if (choice === "new") {
      const typedIn = { name: pname.value, brand: brand.value, size: size.value, store: pstore.value };
      // A product that is known already (same name, brand, size) keeps its id.
      const same = Object.values(store.getView().products).find((p) => p.product_key === productKey(typedIn));
      const productId = same?.id ?? newId();
      // Only ever set here: unticking a known product's flag is the product screen's.
      const only = onlyBox.checked && pstore.value.trim() ? { store_only: true } : {};
      await store.dispatch({ type: "product.put", id: productId, product: { ...typedIn, ...only, ...(item ? { item_id: item.id } : {}) } });
      await store.dispatch({ type: "preference.set", id: newId(), ...target, ...scope, product_id: productId });
    } else if (choice) {
      await store.dispatch({ type: "preference.set", id: newId(), ...target, ...scope, product_id: choice });
    } else if (item) {
      await store.dispatch({ type: "preference.clear", item_id: item.id, ...scope });
    }
  } catch (err) {
    refused(err);
  }
}

/** The product sheet for a recipe's ingredient, with that recipe picked. */
export function recipeProductSheet(recipe, ingredientName) {
  const item = itemByName(store.getView(), ingredientName);
  return preferredSheet(item, { recipe: { id: recipe.id, title: recipe.title }, title: ingredientName });
}

/** "AH Tortilla chips · Dirk Tortilla chips (Dirk)": this recipe's products for an ingredient, or "". */
export function recipeProducts(view, recipe, ingredientName) {
  const item = itemByName(view, ingredientName);
  if (!item) return "";
  return preferencesOf(view.preferences ?? {}, item.id)
    .filter((p) => p.recipe_id === recipe.id && view.products?.[p.product_id] && !view.products[p.product_id].deleted_at)
    .map((p) => {
      const product = view.products[p.product_id];
      if (product.store_only && product.store) return `${productLabel(product)} (${t("product.only_short", { store: canonicalStore(product.store) })})`;
      return p.store ? `${productLabel(product)} (${p.store})` : productLabel(product);
    })
    .join(" · ");
}

function ratingForm(product, mine) {
  let stars = mine?.stars ?? 0;
  const buttons = Array.from({ length: STARS_MAX }, (_, i) => i + 1).map((n) => h("button", {
    type: "button", class: "star", "aria-label": t("product.stars", { n }),
    onclick: () => { stars = nextTap(stars, n) ?? 0; paint(); },
  }, "★"));
  // A half star is drawn half full (data-fill, public/styles/app.css).
  const paint = () => buttons.forEach((b, i) => {
    const fill = starFill(stars, i + 1);
    b.dataset.fill = fill;
    b.setAttribute("aria-pressed", fill === "full" ? "true" : fill === "half" ? "mixed" : "false");
  });
  paint();
  const note = h("input", { maxlength: "280", value: mine?.note ?? "", placeholder: t("product.note_placeholder") });
  const save = async (ev) => {
    ev.preventDefault();
    if (!stars) return toast(t("product.pick_stars"), { error: true });
    try {
      await store.dispatch({ type: "rating.set", id: mine?.id ?? newId(), product_id: product.id, stars, note: note.value });
      toast(t("settings.saved"));
    } catch (err) {
      refused(err);
    }
  };
  const clear = async () => {
    try {
      await store.dispatch({ type: "rating.set", product_id: product.id, stars: null });
    } catch (err) {
      refused(err);
    }
  };
  return h("form", { class: "rate", onsubmit: save },
    h("div", { class: "stars", role: "group", "aria-label": t("product.your_rating") }, buttons),
    h("label", { class: "field" }, h("span", { class: "mono" }, t("product.note")), note),
    h("div", { class: "actions" },
      h("button", { type: "submit", class: "btn primary grow" }, t("product.rate")),
      mine ? h("button", { type: "button", class: "btn", onclick: clear }, t("product.unrate")) : null));
}

/**
 * "Alleen bij Lidl te koop" (28-10-2026): the line then always says
 * "haal bij Lidl". It needs a store: a product without one picks it here.
 */
function storeOnlyBlock(p, view) {
  const shopName = canonicalStore(p.store);
  const box = h("input", { type: "checkbox", checked: Boolean(p.store_only) });
  const pick = shopName ? null : h("select", { "aria-label": t("product.store") },
    h("option", { value: "" }, t("product.pick_store")),
    storesOf(view, currentOffers(view.offers, new Date().toLocaleDateString("sv-SE"))).map((x) => h("option", { value: x }, x)));
  box.addEventListener("change", () => {
    const patch = { store_only: box.checked, ...(pick && pick.value ? { store: pick.value } : {}) };
    store.dispatch({ type: "product.put", id: p.id, product: patch }).catch((err) => {
      box.checked = Boolean(p.store_only);
      refused(err);
    });
  });
  return h("div", { class: "store-only" },
    pick ? h("label", { class: "field" }, h("span", { class: "mono" }, t("product.store")), pick) : null,
    h("label", { class: "rule-check" }, box,
      h("span", {}, shopName ? t("product.store_only", { store: shopName }) : t("product.store_only_any"))));
}

/**
 * "Alleen voor mij" (30-10-2026): the item is then only his; nobody
 * else in the household sees it anywhere (worker/privacy.js). A household
 * member may set it; only he clears it. A guest never sees this.
 */
export function privateBlock(item) {
  const me = store.getMe()?.member;
  if (!item || !me || store.isGuest()) return null;
  const mine = item.private_to === me.id;
  if (item.private_to && !mine) return null;
  const box = h("input", { type: "checkbox", checked: mine });
  box.addEventListener("change", () => {
    store.dispatch({ type: "item.private", item_id: item.id, private: box.checked }).catch((err) => {
      box.checked = mine;
      refused(err);
    });
  });
  return h("div", { class: "private-block" },
    h("label", { class: "rule-check" }, box, h("span", {}, t("private.toggle"))),
    h("p", { class: "hint" }, t(mine ? "private.on" : "private.off")));
}

/** The lock a private line shows its owner. */
export function privateMark(view, itemId) {
  const me = store.getMe()?.member;
  const item = itemId ? view.items?.[itemId] : null;
  if (!me || !item?.private_to || item.private_to !== me.id) return null;
  return h("span", { class: "lock", role: "img", "aria-label": t("private.mark"), title: t("private.mark") }, svg(LOCK_SVG));
}

// ------------------------------------------- merge an item, move a product

const liveItemNamed = (view, name) => {
  const key = nameKey(name);
  return key ? Object.values(view.items).find((i) => !i.deleted_at && i.name_key === key) ?? null : null;
};

/** "Tonijn, Minoestuna, …": the live item names but `except`, never an excluded thing, for a datalist. */
function itemOptions(view, except, listId) {
  const names = Object.values(view.items).filter((i) => !i.deleted_at && i.id !== except && !isExcluded(i.name)).map((i) => i.name).sort((a, b) => a.localeCompare(b));
  return h("datalist", { id: listId }, names.map((n) => h("option", { value: n })));
}

/** "11 aankopen, 4 producten, 1 vaste keuze": what moves, from counts per kind. */
function countsText(counts) {
  const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => t(`merge.count_${k}`, { n }));
  return parts.length ? parts.join(", ") : t("merge.count_none");
}

/** "Zeeparel Tonijnstukken in water · 145 g": the brand once, also when AH's name starts with it. */
const shortLabel = (p) => [p.brand && !nameKey(p.name).startsWith(nameKey(p.brand)) ? `${p.brand} ${p.name}` : p.name, p.size].filter(Boolean).join(" · ");

const liveCount = (rows, keep) => Object.values(rows ?? {}).filter((r) => !r.deleted_at && keep(r)).length;

/**
 * "Samenvoegen met…" (30-10-2026: the cat's tuna sat under "Tonijn",
 * its rate on "Minoestuna"): the whole item goes into another one (item.merge
 * in public/shared/ops.js). The sheet says what moves before anything does.
 */
async function mergeSheet(item) {
  const view = store.getView();
  const listId = `merge-${newId()}`;
  const input = h("input", { list: listId, autocomplete: "off", maxlength: "120" });
  const summary = h("p", { class: "notes merge-summary" });
  const go = h("button", { type: "submit", class: "btn signal grow", disabled: true }, t("merge.do"));
  const target = () => {
    const into = liveItemNamed(view, input.value);
    return into && into.id !== item.id ? into : null;
  };
  const counts = {
    purchases: liveCount(view.purchases, (r) => r.item_id === item.id),
    products: liveCount(view.products, (r) => r.item_id === item.id),
    pantry: liveCount(view.pantry, (r) => r.item_id === item.id),
    entries: liveCount(view.entries, (r) => r.item_id === item.id),
    preferences: liveCount(view.preferences, (r) => r.item_id === item.id),
    deal_rules: liveCount(view.deal_rules, (r) => r.item_id === item.id),
  };
  const show = () => {
    const into = target();
    go.disabled = !into;
    summary.classList.toggle("mute", !into);
    summary.textContent = into
      ? t("merge.summary", { from: item.name, into: into.name, what: countsText(counts) })
      : input.value.trim() ? t("merge.unknown") : t("merge.pick");
  };
  input.addEventListener("input", show);
  show();
  const result = await sheet((close) => h("form", { onsubmit: (ev) => { ev.preventDefault(); if (target()) close("go"); } },
    h("h2", {}, t("merge.title", { item: item.name })),
    h("p", { class: "hint" }, t("merge.hint")),
    h("label", { class: "field" }, h("span", { class: "mono" }, t("merge.into")), input),
    itemOptions(view, item.id, listId),
    summary,
    h("div", { class: "actions" }, go,
      h("button", { type: "button", class: "btn", onclick: () => close() }, t("common.cancel")))));
  const into = result === "go" ? target() : null;
  if (!into) return;
  try {
    await store.dispatch({ type: "item.merge", from_item_id: item.id, into_item_id: into.id, on: new Date().toLocaleDateString("sv-SE") });
    toast(t("merge.done", { from: item.name, into: into.name }));
  } catch (err) {
    refused(err);
  }
}

/**
 * "Ander item…": this one product goes to another item (or a new one), with
 * what was bought of it and its pantry rows (product.move); both items stay.
 */
async function moveSheet(p, item) {
  const view = store.getView();
  const listId = `move-${newId()}`;
  const input = h("input", { list: listId, autocomplete: "off", maxlength: "120" });
  const summary = h("p", { class: "notes merge-summary" });
  const go = h("button", { type: "submit", class: "btn primary grow", disabled: true }, t("move.do"));
  const counts = {
    purchases: liveCount(view.purchases, (r) => r.product_id === p.id),
    pantry: liveCount(view.pantry, (r) => r.product_id === p.id),
  };
  const name = () => input.value.replace(/\s+/g, " ").trim();
  const show = () => {
    const to = liveItemNamed(view, name());
    const ok = Boolean(name()) && !isExcluded(name()) && to?.id !== item?.id;
    go.disabled = !ok;
    summary.classList.toggle("mute", !ok);
    summary.textContent = ok
      ? [t("move.summary", { product: shortLabel(p), from: item?.name ?? "-", to: to?.name ?? name(), what: countsText(counts) }),
        to ? "" : t("move.new", { to: name() })].filter(Boolean).join(" ")
      : t("move.pick");
  };
  input.addEventListener("input", show);
  show();
  const result = await sheet((close) => h("form", { onsubmit: (ev) => { ev.preventDefault(); if (!go.disabled) close("go"); } },
    h("h2", {}, t("move.title")),
    h("p", { class: "hint" }, t("move.hint", { product: shortLabel(p), item: item?.name ?? "-" })),
    h("label", { class: "field" }, h("span", { class: "mono" }, t("move.to")), input),
    itemOptions(view, item?.id, listId),
    summary,
    h("div", { class: "actions" }, go,
      h("button", { type: "button", class: "btn", onclick: () => close() }, t("common.cancel")))));
  if (result !== "go") return;
  const to = liveItemNamed(store.getView(), name());
  try {
    await store.dispatch({ type: "product.move", product_id: p.id, ...(to ? { item_id: to.id } : { title: name(), item_id: newId() }),
      on: new Date().toLocaleDateString("sv-SE") });
    toast(t("move.done", { product: shortLabel(p), to: to?.name ?? name() }));
  } catch (err) {
    refused(err);
  }
}

/** The item's other names (item.alias): "Pluizenbolbrokkenman" is "Minoes brokken". */
function aliasesOf(view, item) {
  return Object.values(view.aliases ?? {}).filter((a) => !a.deleted_at && a.item_id === item.id)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** "Andere namen": each one with a remove button, and "Naam toevoegen". */
function namesBlock(view, item) {
  const remove = (a) => store.dispatch({ type: "item.alias", item_id: item.id, name: a.name, remove: true })
    .then(() => toast(t("names.removed", { alias: a.name, name: item.name }))).catch(refused);
  const list = aliasesOf(view, item);
  return [
    h("div", { class: "section-head" }, h("h2", {}, t("names.title"))),
    list.length
      ? h("div", { class: "names" }, list.map((a) => h("span", { class: "name-chip" }, a.name,
        h("button", { type: "button", "aria-label": t("names.remove", { alias: a.name }), onclick: () => remove(a) }, "×"))))
      : h("p", { class: "hint" }, t("names.none")),
    h("div", { class: "actions" }, h("button", { type: "button", class: "btn ghost", onclick: () => addNameSheet(item) }, t("names.add"))),
  ];
}

async function addNameSheet(item) {
  const input = h("input", { maxlength: "120", autocomplete: "off", enterkeyhint: "done" });
  const result = await sheet((close) => {
    setTimeout(() => input.focus());
    return h("form", { onsubmit: (ev) => { ev.preventDefault(); if (input.value.trim()) close("save"); } },
      h("h2", {}, t("names.add_title", { item: item.name })),
      h("label", { class: "field" }, h("span", { class: "mono" }, t("list.name")), input),
      h("div", { class: "actions" },
        h("button", { type: "submit", class: "btn primary grow" }, t("names.save")),
        h("button", { type: "button", class: "btn", onclick: () => close() }, t("common.cancel"))));
  });
  const name = input.value.replace(/\s+/g, " ").trim();
  if (result !== "save" || !name) return;
  try {
    await store.dispatch({ type: "item.alias", id: newId(), item_id: item.id, name });
    toast(t("names.remembered", { alias: name, name: item.name }));
  } catch (err) {
    refused(err);
  }
}

export function mountProduct(root, productId) {
  const eyebrow = h("div", { class: "eyebrow mono" });
  const head = h("div", {});
  const body = h("div", { class: "wrap" });
  root.append(h("section", { class: "hero wrap" }, h("a", { class: "back mono", href: "#/" }, t("product.back")), eyebrow, head), body);

  // A change from another phone re-renders the screen; the rating form is
  // kept as long as this person's own rating did not change, so a note being
  // typed is not wiped.
  let form = null;
  let formKey = null;
  return store.subscribe((view, status) => {
    const p = view.products?.[productId];
    if (!p) {
      fill(head, title(t("product.title")));
      fill(eyebrow, syncLine(status));
      fill(body, h("p", { class: "empty" }, t("product.not_found")));
      return;
    }
    const me = store.getMe();
    const item = p.item_id ? view.items[p.item_id] : null;
    const bought = Object.values(view.purchases ?? {})
      .filter((x) => x.product_id === p.id && !x.deleted_at)
      .sort((a, b) => b.bought_on.localeCompare(a.bought_on));
    const ratings = ratingsOf(view, p.id);
    const mine = ratings.find((r) => r.member_id === me?.member.id);
    const others = ratings.filter((r) => r.member_id !== me?.member.id);
    // Where this product is the one to buy: any store, at Dirk, for a recipe.
    const scopes = item ? preferencesOf(view.preferences ?? {}, item.id).filter((x) => x.product_id === p.id) : [];
    const shop = canonicalStore(p.store);
    const anyStore = scopes.some((x) => !x.store && !x.recipe_id);
    const atStore = shop && scopes.some((x) => x.store === shop && !x.recipe_id);
    const where = scopes.map((x) => whyText({ recipe: x.recipe_id ? view.recipes?.[x.recipe_id]?.title ?? "?" : null, store: x.store || null })
      || t("product.any_store")).join(", ");
    const toggle = (s, on) => store.dispatch(on
      ? { type: "preference.clear", item_id: item.id, store: s, recipe_id: "" }
      : { type: "preference.set", id: newId(), item_id: item.id, store: s, recipe_id: "", product_id: p.id }).catch(refused);
    const key = `${mine?.id ?? ""}:${mine?.updated_at ?? ""}`;
    if (key !== formKey) {
      form = ratingForm(p, mine);
      formKey = key;
    }

    fill(eyebrow,
      p.brand ? h("span", {}, h("b", {}, p.brand)) : null,
      p.size ? h("span", {}, p.size) : null,
      p.last_price_cents !== null ? h("span", {}, money(p.last_price_cents)) : null,
      p.store ? h("span", {}, p.store) : null,
      syncLine(status));
    fill(head, title(p.name, { long: p.name.length > 9 }));
    // Other stores' shelf prices (Checkjebon), only when this very product was found there.
    const prices = pricesLine(view, p);

    fill(body,
      prices ? h("p", { class: "hint prices-hint" }, h("span", { class: "mono mute" }, `${t("prices.label")} `), prices) : null,
      h("div", { class: "section-head" }, h("h2", {}, t("product.ratings"))),
      h("ul", { class: "rows" },
        others.map((r) => h("li", { class: "row static rating" },
          h("span", { class: "ttl" }, r.name),
          h("span", { class: "st sig", "aria-label": t("product.stars", { n: r.stars }) }, starsText(r.stars)),
          r.note ? h("span", { class: "meta" }, r.note) : null)),
        others.length ? null : h("li", { class: "empty" }, t("product.no_ratings"))),
      h("h3", { class: "mono sub" }, t("product.your_rating")),
      form,
      item ? h("div", { class: "section-head" }, h("h2", {}, item.name)) : null,
      item ? h("p", { class: "hint" }, scopes.length ? t("product.is_preferred", { item: item.name, where }) : t("product.not_preferred", { item: item.name })) : null,
      item ? h("div", { class: "actions" },
        h("button", { type: "button", class: anyStore ? "btn" : "btn primary", onclick: () => toggle("", anyStore) },
          anyStore ? t("product.unprefer") : t("product.make_preferred")),
        shop ? h("button", { type: "button", class: "btn", onclick: () => toggle(shop, atStore) },
          atStore ? t("product.unprefer_at", { store: shop }) : t("product.make_preferred_at", { store: shop })) : null,
        h("button", { type: "button", class: "btn ghost", onclick: () => preferredSheet(item, { store: shop || null }) }, t("product.more_choices"))) : null,
      // Under the wrong item, or two items of one thing (item.merge, product.move).
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn ghost", onclick: () => moveSheet(p, item) }, t("move.button")),
        item ? h("button", { type: "button", class: "btn ghost", onclick: () => mergeSheet(item) }, t("merge.button")) : null),
      // Other names of the item: typed on the list, they land on it.
      item ? namesBlock(view, item) : null,
      privateBlock(item),
      // The product's own shelf life (it wins over its item's); the item's too when it differs.
      h("div", { class: "section-head" }, h("h2", {}, t("shelf.title"))),
      productShelfLines(p, item).map((line) => h("p", { class: "hint" }, line)),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn ghost", onclick: () => shelfSheet(p, { product: true, item }) }, t("shelf.edit"))),
      item ? h("div", { class: "section-head" }, h("h2", {}, t("rate.title"))) : null,
      item ? h("p", { class: "hint" }, rateLabel(item)) : null,
      item ? h("div", { class: "actions" },
        h("button", { type: "button", class: "btn ghost", onclick: () => rateSheet(item) }, t("rate.edit"))) : null,
      storeOnlyBlock(p, view),
      item ? ruleBlock(view, item, p) : null,
      bought.length ? h("div", { class: "section-head" }, h("h2", {}, t("product.bought")), h("span", { class: "note mono" }, String(bought.length))) : null,
      bought.length ? h("ul", { class: "rows" }, bought.slice(0, 30).map((x) => h("li", { class: "row static rating" },
        h("span", { class: "meta" }, [formatDate(x.bought_on), x.store].filter(Boolean).join(" · ")),
        h("span", { class: "st mono" }, money(x.price_cents))))) : null);
  });
}
