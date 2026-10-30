// Stars you tap in place (30-10-2026): a recipe's (recipe.rate) on the
// recipe page and in "Hoe was <recipe> gisteren?", and a product's
// (rating.set) on the "Laatst gekocht" tab. A tap on the stars you already
// gave takes them away. The numbers are public/shared/recipe-ratings.js.
import { h, toast, newId } from "./dom.js";
import { t, formatNumber, getLocale } from "./i18n.js";
import { OpError } from "../shared/ops.js";
import * as store from "./store.js";
import { rateAsks, recipeStars, myRecipeRating, recipeCooks, STARS_MAX } from "../shared/recipe-ratings.js";

const refused = (err) => toast(err instanceof OpError ? t(`errors.${err.code}`) : t("errors.refused"), { error: true });

/** Ten star buttons (32 px each: ten fit in a row at 375 px); onPick(n) with n 1..10, or null when the current value is tapped again. */
export function miniStars(current, onPick, { label = "" } = {}) {
  return h("span", { class: "mini-stars", role: "group", "aria-label": label || null },
    Array.from({ length: STARS_MAX }, (_, i) => i + 1).map((n) => h("button", {
      type: "button", class: "mini-star", "aria-label": t("rstars.star", { n }), "aria-pressed": String(Boolean(current) && n <= current),
      onclick: (ev) => { ev.stopPropagation(); onPick(n === current ? null : n); },
    }, "★")));
}

/** "★8,5 · 2 stemmen", or "" without stars. */
export function averageText(stars) {
  return stars ? t("rstars.average", { avg: formatNumber(stars.average), n: stars.count }) : "";
}

/** Rate a recipe as this person (recipe.rate); stars null clears. */
export function rateRecipe(recipeId, stars, { skip = false } = {}) {
  const view = store.getView();
  const me = store.getMe();
  const mine = myRecipeRating(view.recipe_ratings, me?.member.id, recipeId);
  const op = { type: "recipe.rate", id: mine?.id ?? newId(), recipe_id: recipeId, on: new Date().toLocaleDateString("sv-SE") };
  if (skip) op.skip = true; else op.stars = stars;
  return store.dispatch(op).catch(refused);
}

/** The recipe page's line: your stars to tap, and the household's average. */
export function recipeStarsLine(view, recipe) {
  const me = store.getMe();
  const mine = myRecipeRating(view.recipe_ratings, me?.member.id, recipe.id);
  const all = recipeStars(view.recipe_ratings, recipe.id);
  return h("div", { class: "recipe-stars" },
    h("span", { class: "mono mute" }, t("rstars.yours")),
    miniStars(mine?.stars ?? null, (n) => rateRecipe(recipe.id, n), { label: t("rstars.yours") }),
    all ? h("span", { class: "mono avg" }, averageText(all)) : null,
    cooksText(view, recipe.id) ? h("span", { class: "mono mute cook-stats" }, cooksText(view, recipe.id)) : null);
}

/** "6× gekookt · Thomas 4× · Henk 2× · laatst 12 okt", or "" when never cooked. */
export function cooksText(view, recipeId) {
  const c = recipeCooks(view.cooks, recipeId);
  if (!c) return "";
  const people = Object.entries(c.byMember)
    .map(([id, n]) => ({ name: view.members?.[id]?.name, n }))
    .filter((p) => p.name)
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .map((p) => `${p.name} ${p.n}×`);
  const date = new Date(`${c.last}T12:00:00`).toLocaleDateString(getLocale() === "nl" ? "nl-NL" : "en-GB", { day: "numeric", month: "short" });
  // Each part stays on one line when the text wraps.
  return [t("cooked.stats", { n: c.total }), ...people, t("cooked.last", { date })].map((x) => x.replace(/ /g, "\u00a0")).join(" · ");
}

/**
 * "Hoe was <recipe> gisteren?": the day after a cook, once per cook, for
 * this person. A star answers; "Overslaan" skips it on every phone of theirs.
 */
export function rateAskStrip(view, today) {
  const asks = rateAsks(view, store.getMe()?.member.id, today);
  if (!asks.length) return null;
  return h("section", { class: "low-strip cook-ask rate-ask", "aria-label": t("rstars.label") },
    h("h2", { class: "low-label mono" }, t("rstars.label")),
    h("ul", {}, asks.map((a) => h("li", { class: "low-row" },
      h("span", { class: "low-name" }, t("rstars.question", { title: a.title })),
      h("span", { class: "low-acts cook-acts" },
        miniStars(a.stars, (n) => rateRecipe(a.recipe_id, n ?? a.stars), { label: t("rstars.question", { title: a.title }) }),
        h("button", { type: "button", class: "btn ghost low-later", onclick: () => rateRecipe(a.recipe_id, null, { skip: true }) }, t("rstars.skip")))))));
}
