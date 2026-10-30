// recipes.vexed.works, the book: every recipe as a numbered ruled row, the
// ones that are only a title (an idea, not yet written down) apart.
import { h, title, fill, sheet } from "./dom.js";
import { t, collator, formatNumber } from "./i18n.js";
import { nameKey } from "../shared/ingredients.js";
import * as store from "./store.js";
import { syncLine } from "./status.js";
import { isIdea } from "../shared/wizard.js";
import { MEALS, CUISINES, MAIN_INGREDIENTS, TIME_CLASSES } from "../shared/labels.js";
import { starsByRecipe, cookStats, sortRecipes, SORT_MODES } from "../shared/recipe-ratings.js";
import { localToday } from "../shared/intervals.js";
import { rateAskStrip } from "./stars.js";

// The labels a recipe can be filtered on (28-10-2026): [facet, values,
// the recipe's values]. One value per facet at a time; the words are the
// wizard's (i18n "labels.*").
const FACETS = [
  ["meal", MEALS, (r) => r.meals ?? []],
  ["cuisine", CUISINES, (r) => [r.cuisine]],
  ["main", MAIN_INGREDIENTS, (r) => [r.main_ingredient]],
  ["time", TIME_CLASSES, (r) => [r.time_class]],
];

// The order of the book, remembered on this device (30-10-2026).
const SORT_KEY = "kitchen.recipes.sort";
const loadSort = () => {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return SORT_MODES.includes(v) ? v : "title";
  } catch { return "title"; }
};
const saveSort = (mode) => {
  try { localStorage.setItem(SORT_KEY, mode); } catch { /* private mode: the choice lasts until reload */ }
};

const labelOf = (facet, value) => t(`labels.${facet}.${value}`);

/** The label words of a recipe, so the search box also finds "italiaans" or "ontbijt". */
const labelText = (r) => nameKey(FACETS.flatMap(([facet, , of]) => of(r).filter(Boolean).map((v) => labelOf(facet, v))).join(" "));

const passesFilters = (r, filters, skip = null) =>
  FACETS.every(([facet, , of]) => facet === skip || !filters[facet] || of(r).includes(filters[facet]));

function row(r, index, stars = new Map()) {
  const rated = stars.get(r.id);
  const ings = r.ingredients.filter((i) => !i.heading).length;
  const meta = isIdea(r)
    ? t("recipes.idea")
    : [
      r.servings ? t("recipe.servings", { n: r.servings }) : null,
      ings ? t("recipe.ingredient_count", { n: ings }) : null,
      r.nutrition?.carbs_g !== null && r.nutrition?.carbs_g !== undefined ? t(r.nutrition.carbs_estimated ? "recipe.carbs_short_estimated" : "recipe.carbs_short", { g: formatNumber(r.nutrition.carbs_g) }) : null,
      rated ? `★${formatNumber(rated.average)}` : null,
    ].filter(Boolean).join(" · ");
  return h("li", {},
    h("a", { class: "row", href: `#/recipe/${r.id}` },
      h("span", { class: "idx mono" }, String(index + 1).padStart(2, "0")),
      h("span", { class: "ttl" }, r.title),
      h("span", { class: "meta" }, meta),
      r.photo ? h("span", { class: "st" }, h("img", { class: "thumb", src: `/photos/${r.photo}`, alt: "", loading: "lazy" })) : null));
}

/**
 * A recipes-only person in Safari on an iPhone or iPad: how to keep the book
 * on the home screen. iOS copies the cookie once, when the app is added, so
 * the home-screen app is linked too.
 */
function homeScreenHint() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const installed = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  return store.isGuest() && ios && !installed ? h("p", { class: "hint home-hint" }, t("pair.home_screen")) : null;
}

export function mountRecipes(root) {
  let query = "";
  const filters = {};
  let sortMode = loadSort();
  const eyebrow = h("div", { class: "eyebrow mono" });
  const list = h("div", {});
  const chips = h("div", { class: "filters" });
  const rateAsk = h("div", {});
  const rerender = () => render(store.getView(), store.getStatus());

  // One sheet with every facet; a value shows only when it still leaves a
  // recipe, given the other filters and the search.
  const openFilters = () => sheet((close) => {
    const pool = Object.values(store.getView().recipes).filter(matchesQuery);
    return h("div", {},
      h("h2", {}, t("recipes.filter_title")),
      FACETS.map(([facet, values, of]) => {
        const rest = pool.filter((r) => passesFilters(r, filters, facet));
        const open = values.filter((v) => filters[facet] === v || rest.some((r) => of(r).includes(v)));
        if (!open.length) return null;
        return h("div", { class: "filter-group" },
          h("div", { class: "mono label" }, t(`recipes.facet.${facet}`)),
          h("div", { class: "choices meal-toggles" }, open.map((v) => h("button", {
            type: "button", class: "choice toggle", "aria-pressed": String(filters[facet] === v),
            onclick: () => {
              if (filters[facet] === v) delete filters[facet];
              else filters[facet] = v;
              close();
              rerender();
            },
          }, `${labelOf(facet, v)} ${rest.filter((r) => of(r).includes(v)).length}`))));
      }),
      h("div", { class: "actions" }, h("button", { type: "button", class: "btn", onclick: () => close() }, t("common.done"))));
  });

  const openSort = () => sheet((close) => h("div", {},
    h("h2", {}, t("recipes.sort_title")),
    h("div", { class: "choices meal-toggles" }, SORT_MODES.map((m) => h("button", {
      type: "button", class: "choice toggle", "aria-pressed": String(sortMode === m),
      onclick: () => { sortMode = m; saveSort(m); close(); rerender(); },
    }, t(`recipes.sort_by.${m}`)))),
    h("div", { class: "actions" }, h("button", { type: "button", class: "btn", onclick: () => close() }, t("common.done")))));

  const matchesQuery = (r) => !query || nameKey(r.title).includes(query) || labelText(r).includes(query)
    || r.ingredients.some((i) => nameKey(i.name).includes(query));
  const search = h("input", {
    type: "search", placeholder: t("recipes.search"), "aria-label": t("recipes.search"), enterkeyhint: "search",
    oninput: () => {
      query = nameKey(search.value);
      rerender();
    },
  });

  root.append(
    h("section", { class: "hero wrap" }, eyebrow, title(t("recipes.title"))),
    h("div", { class: "wrap" },
      rateAsk,
      h("a", { class: "wizard-cta", href: "#/wizard" }, h("span", {}, t("wizard.cta")), h("span", { class: "mono" }, t("wizard.cta_note"))),
      homeScreenHint(),
      h("div", { class: "search" }, search, h("a", { class: "btn primary", href: "#/new" }, t("recipes.new"))),
      chips,
      list),
  );

  function render(view, status) {
    const stars = starsByRecipe(view.recipe_ratings);
    const all = sortRecipes(Object.values(view.recipes), sortMode, { stars, cooks: cookStats(view.cooks), compare: (a, b) => collator().compare(a, b) });
    const hits = all.filter((r) => matchesQuery(r) && passesFilters(r, filters));
    const active = FACETS.filter(([facet]) => filters[facet]);
    fill(chips,
      h("button", { type: "button", class: "btn ghost mono", onclick: openFilters }, t("recipes.filter")),
      h("button", { type: "button", class: "btn ghost mono", onclick: openSort }, sortMode === "title" ? t("recipes.sort") : `${t("recipes.sort")}: ${t(`recipes.sort_by.${sortMode}`)}`),
      active.map(([facet]) => h("button", {
        type: "button", class: "chip", "aria-label": t("recipes.remove_filter", { label: labelOf(facet, filters[facet]) }),
        onclick: () => { delete filters[facet]; rerender(); },
      }, `${labelOf(facet, filters[facet])} ×`)));
    const ready = hits.filter((r) => !isIdea(r));
    fill(rateAsk, rateAskStrip(view, localToday()));
    const ideas = hits.filter(isIdea);

    fill(eyebrow,
      h("span", {}, h("b", {}, t("recipes.count", { n: all.length }))),
      h("span", {}, t("recipes.with_photo", { n: all.filter((r) => r.photo).length })),
      syncLine(status),
    );

    fill(list,
      h("div", { class: "section-head" }, h("h2", {}, t("recipes.cook")), h("span", { class: "note mono" }, String(ready.length))),
      ready.length ? h("ol", { class: "rows" }, ready.map((r, i) => row(r, i, stars))) : h("p", { class: "empty" }, query || active.length ? t("recipes.no_match") : t("recipes.empty")),
      ideas.length ? h("div", { class: "section-head" }, h("h2", {}, t("recipes.ideas")), h("span", { class: "note mono" }, t("recipes.ideas_note"))) : null,
      ideas.length ? h("ol", { class: "rows" }, ideas.map((r, i) => row(r, ready.length + i, stars))) : null,
    );
  }

  return store.subscribe(render);
}
