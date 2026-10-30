// One recipe: photo, servings you can change, ingredients scaled to them,
// the method, and the two things you do with a recipe: put it on the list,
// or cook it.
import { h, title, toast, sheet, newId, fill } from "./dom.js";
import { t, formatAmount, formatNumber } from "./i18n.js";
import { scaleIngredient, amountOf } from "../shared/ingredients.js";
import * as store from "./store.js";
import { syncLine } from "./status.js";
import { keepScreenOn } from "./wake.js";
import { lastCookedDays } from "../shared/wizard.js";
import { daysBetween } from "../shared/intervals.js";
import { recipeProductSheet, recipeProducts } from "./product.js";
import { cookTakes, cookPending, listCover } from "../shared/pantry.js";
import { OpError } from "../shared/ops.js";
import { packsText } from "./pantry.js";
import { recipeStarsLine } from "./stars.js";
import { sortMeals } from "../shared/labels.js";

const todayLocal = () => new Date().toLocaleDateString("sv-SE");

/**
 * Cooked (or eaten) today, or on `on` ("Ja, gisteren" from the list's
 * "… gekookt?"). Its ingredients come off the pantry (phase 4), scaled to the
 * servings cooked; what the pantry did not have yet waits for the receipt as
 * pending takes (public/shared/pantry.js, cookPending). The toast says what
 * and takes it all back.
 */
export async function markCooked(recipe, { quiet = false, on = null } = {}) {
  // A recipes-only person's cooking never touches the household's pantry or cook records.
  if (store.isGuest()) return;
  const op = { type: "recipe.cooked", id: newId(), recipe_id: recipe.id, cooked_on: on ?? todayLocal() };
  const already = Object.values(store.getView().cooks).find((c) => c.recipe_id === recipe.id && c.cooked_on === op.cooked_on);
  if (!already) await store.dispatch(op);
  // Both from the pantry as it is before this cook takes anything.
  const before = store.getView();
  const plan = { recipe, data: before, today: op.cooked_on, scale: scaleFor(recipe) };
  const takes = cookTakes(plan).map((x) => ({ ...x, event_id: newId() }));
  const pending = cookPending(plan).map((x) => ({ ...x, id: newId() }));
  try {
    if (takes.length) {
      await store.dispatch({
        type: "pantry.use", reason: "cooked", recipe_id: recipe.id, on: op.cooked_on,
        takes: takes.map(({ event_id, pantry_id, amount }) => ({ event_id, pantry_id, amount })),
      });
    }
    if (pending.length) {
      await store.dispatch({
        type: "pantry.pend", recipe_id: recipe.id, cook_id: already?.id ?? op.id, on: op.cooked_on,
        pending: pending.map(({ id, item_id, name, qty, unit, default_portion }) => ({ id, item_id, name, qty, unit, default_portion })),
      });
    }
  } catch (err) {
    toast(err instanceof OpError ? t(`errors.${err.code}`) : t("errors.refused"), { error: true });
    return;
  }
  const undo = () => {
    if (!already) store.dispatch({ type: "recipe.uncooked", id: op.id });
    if (takes.length) store.dispatch({ type: "pantry.unuse", event_ids: takes.map((x) => x.event_id) });
    if (pending.length) store.dispatch({ type: "pantry.unpend", ids: pending.map((x) => x.id) });
  };
  const waiting = pending.length ? t("pantry.cooked_pending", { n: pending.length }) : "";
  if (takes.length) {
    const list = takes.map(takenText).join(", ");
    toast([t("pantry.cooked_taken", { list }), waiting].filter(Boolean).join(" · "), { action: t("recipe.eaten_undo"), onAction: undo, ms: 9000 });
    return;
  }
  if (quiet && !pending.length) return;
  const done = [t("recipe.eaten_done"), waiting].filter(Boolean).join(" · ");
  toast(done, already && !pending.length ? {} : { action: t("recipe.eaten_undo"), onAction: undo, ms: pending.length ? 9000 : undefined });
}

/** One take in the cook toast: "½ Kaas", "wat Ketchup (schatting)" (less than a quarter reads as "some"). */
function takenText(x) {
  const what = x.amount < 0.25 ? t("pantry.taken_little", { title: x.title }) : `${packsText(x.amount)} ${x.title}`;
  return x.estimate ? `${what} ${t("pantry.estimate_mark")}` : what;
}

/** The recipe's amounts for the servings chosen, as cooking and the list sheet scale them. */
const scaleFor = (recipe) => (i) => scaleIngredient(i, recipe.servings, servingsFor(recipe));

function lastEaten(view, recipe) {
  const day = lastCookedDays(view.cooks)[recipe.id];
  if (!day) return null;
  const n = daysBetween(day, todayLocal());
  return n <= 0 ? t("recipe.eaten_today") : t("recipe.eaten_ago", { n });
}

// Servings picked with the stepper, per recipe, for as long as the app is
// open. Cook mode and "add to list" use the same number.
const chosen = new Map();

export function servingsFor(recipe) {
  return chosen.get(recipe.id) ?? recipe.servings ?? null;
}

export function scaled(recipe) {
  const n = servingsFor(recipe);
  return recipe.ingredients.map((i) => (i.heading ? i : scaleIngredient(i, recipe.servings, n)));
}

function ingredientList(recipe) {
  return h("ul", { class: "ings" }, scaled(recipe).map((i) => i.heading
    ? h("li", { class: "head mono" }, i.name)
    : h("li", { class: i.optional ? "opt" : null },
      h("span", { class: "q" }, formatAmount(i)),
      h("span", { class: "n" }, i.name, i.optional ? ` · ${t("recipe.optional")}` : "", i.note ? h("small", {}, i.note) : null))));
}

// Never bought, and never in the pantry: the tap stays out of the shopping list.
const FROM_THE_TAP = new Set(["water", "kraanwater", "heet water", "kokend water", "kookwater", "lauw water", "ijskoud water"]);

/**
 * "Product voor dit recept": a small button under an ingredient that opens the
 * product sheet with this recipe picked, and shows what is chosen.
 */
export function recipeProductButton(recipe, name) {
  const button = h("button", { type: "button", class: "pp mono" });
  const paint = () => {
    const chosen = recipeProducts(store.getView(), recipe, name);
    button.textContent = chosen ? `→ ${chosen}` : t("recipe.product_pick");
    button.classList.toggle("set", Boolean(chosen));
  };
  button.addEventListener("click", async (ev) => {
    // Inside a <label>: the tap is for the button, not the checkbox.
    ev.preventDefault();
    ev.stopPropagation();
    await recipeProductSheet(recipe, name);
    paint();
  });
  paint();
  return button;
}

/**
 * "In huis?": everything is ticked except what is optional and what the
 * pantry has enough of for this cook (listCover: the same matching and
 * amounts as cooking, on the live amounts); a line says what is at home
 * ("in huis: 1,5", "nog 0,3 in huis"). Untick what you have, tick what you want.
 */
export async function addToList(recipe) {
  const items = scaled(recipe);
  const picks = new Map();
  const cover = listCover({ recipe, data: store.getView(), today: todayLocal(), scale: scaleFor(recipe) });
  const added = await sheet((close) => {
    const count = h("span", {});
    const button = h("button", { type: "button", class: "btn primary grow", onclick: () => close([...picks].filter(([, on]) => on).map(([i]) => i)) }, count);
    const refresh = () => {
      const n = [...picks.values()].filter(Boolean).length;
      count.textContent = t("add.button", { n });
      button.disabled = n === 0;
    };
    const rows = items.map((i, index) => {
      if (i.heading) return h("li", { class: "head mono" }, i.name);
      const home = cover.get(index);
      const on = !i.optional && !FROM_THE_TAP.has(i.name.toLowerCase()) && home?.on !== false;
      const note = home ? t(home.kind === "partial" ? "add.partly" : "add.in_house", { n: formatNumber(home.have) }) : null;
      picks.set(i, on);
      return h("li", {}, h("label", {},
        h("input", { type: "checkbox", checked: on, onchange: (e) => { picks.set(i, e.target.checked); refresh(); } }),
        h("span", {}, i.name, i.optional ? h("small", { class: "mute" }, ` · ${t("recipe.optional")}`) : null,
          note ? h("small", { class: "mute home" }, ` · ${note}`) : null,
          recipeProductButton(recipe, i.name)),
        h("span", { class: "q" }, formatAmount(i))));
    });
    refresh();
    return [
      h("h2", {}, t("add.title")),
      h("p", { class: "hint" }, servingsFor(recipe) ? t("add.for_servings", { n: servingsFor(recipe) }) : t("add.untick")),
      servingsFor(recipe) ? h("p", { class: "hint" }, t("add.untick")) : null,
      h("ul", { class: "picklist" }, rows),
      h("div", { class: "actions" }, button, h("button", { type: "button", class: "btn", onclick: () => close(null) }, t("common.cancel"))),
    ];
  });
  if (!added?.length) return;
  // The list shows the newest line first; adding back to front keeps the
  // recipe's own order on the list.
  for (const i of [...added].reverse()) {
    const amount = amountOf(i);
    await store.dispatch({
      type: "entry.add", id: newId(), item_id: newId(), title: i.name,
      amounts: amount ? [amount] : [],
      source: { recipe_id: recipe.id, title: recipe.title },
    });
  }
  const me = store.getMe();
  toast(t("add.done", { n: added.length }), { action: t("add.open_list"), href: `${me?.other_app ?? ""}/` });
}

export function mountRecipe(root, id) {
  const body = h("div", {});
  root.append(body);

  function render(view, status) {
    const r = view.recipes[id];
    if (!r) {
      fill(body, h("div", { class: "wrap" },
        h("a", { class: "back mono", href: "#/" }, `← ${t("recipes.title")}`),
        h("p", { class: "empty" }, t("recipe.not_found"))));
      return;
    }
    const n = servingsFor(r);
    const ings = r.ingredients.filter((i) => !i.heading).length;
    const stepper = r.servings
      ? h("div", { class: "stepper", role: "group", "aria-label": t("recipe.servings_label") },
        h("button", { type: "button", "aria-label": t("recipe.fewer"), onclick: () => { if (n > 1) { chosen.set(r.id, n - 1); render(store.getView(), store.getStatus()); } } }, "−"),
        h("output", { class: "mono" }, t("recipe.servings", { n })),
        h("button", { type: "button", "aria-label": t("recipe.more"), onclick: () => { chosen.set(r.id, n + 1); render(store.getView(), store.getStatus()); } }, "+"))
      : h("span", { class: "mono mute" }, t("recipe.servings_unknown"));
    const carbs = r.nutrition?.carbs_g;
    // Recipes only: no list, no pantry; cooking is just reading; edits only to his own recipes.
    const guest = store.isGuest();
    const editable = !guest || r.created_by === store.getMe()?.member.id;

    fill(body,
      h("section", { class: "hero wrap" },
        h("a", { class: "back mono", href: "#/" }, `← ${t("recipes.title")}`),
        h("div", { class: "eyebrow mono" },
          ings ? h("span", {}, h("b", {}, t("recipe.ingredient_count", { n: ings }))) : null,
          r.steps.length ? h("span", {}, t("recipe.step_count", { n: r.steps.length })) : null,
          syncLine(status)),
        title(r.title, { long: r.title.length > 9 }),
        r.photo ? h("figure", { class: "photo" }, h("img", { src: `/photos/${r.photo}`, alt: "" })) : null,
        h("div", { class: "facts" }, stepper,
          carbs !== null && carbs !== undefined
            ? h("span", { class: "mono" }, t("recipe.carbs", { g: formatNumber(carbs) }), h("span", { class: "mute" }, ` · ${t(r.nutrition.carbs_estimated ? "recipe.carbs_estimated" : "recipe.carbs_source")}`))
            : null,
          lastEaten(view, r) ? h("span", { class: "mono mute" }, lastEaten(view, r)) : null),
        labelsLine(r),
        recipeStarsLine(view, r),
        h("div", { class: "actions" },
          ings && !guest ? h("button", { type: "button", class: "btn primary", onclick: () => addToList(r) }, t("recipe.add_to_list")) : null,
          r.steps.length ? h("a", { class: guest ? "btn primary" : "btn", href: `#/recipe/${r.id}/cook` }, t("recipe.cook")) : null,
          guest ? null : h("button", { type: "button", class: "btn ghost", onclick: () => markCooked(r) }, t("recipe.eaten")),
          editable ? h("a", { class: "btn ghost", href: `#/edit/${r.id}` }, t("recipe.edit")) : null)),
      h("div", { class: "wrap two" },
        h("div", {},
          h("div", { class: "section-head" }, h("h2", {}, t("recipe.ingredients"))),
          ings ? ingredientList(r) : h("p", { class: "empty" }, t("recipe.no_ingredients"))),
        h("div", {},
          h("div", { class: "section-head" }, h("h2", {}, t("recipe.method"))),
          r.steps.length ? h("ol", { class: "steps" }, r.steps.map((s) => h("li", {}, s))) : h("p", { class: "empty" }, t("recipe.no_steps")),
          r.notes ? h("div", { class: "section-head" }, h("h2", {}, t("recipe.notes"))) : null,
          r.notes ? h("p", { class: "notes" }, r.notes) : null)),
      h("footer", { class: "foot wrap mono" }, r.source_url ? h("a", { href: r.source_url, rel: "noopener noreferrer", target: "_blank" }, t("recipe.source")) : null),
    );
  }

  const unsubscribe = store.subscribe(render);
  const releaseScreen = keepScreenOn();
  return () => {
    unsubscribe();
    releaseScreen();
  };
}

/**
 * The wizard's labels on the recipe page itself (30-10-2026), not only
 * in the editor: meal(s), main ingredient, cuisine, time. "Anders" is left out.
 */
function labelsLine(r) {
  const parts = [
    ...sortMeals(r.meals ?? []).map((m) => t(`labels.meal.${m}`)),
    r.main_ingredient && r.main_ingredient !== "other" ? t(`labels.main.${r.main_ingredient}`) : null,
    r.cuisine && r.cuisine !== "other" ? t(`labels.cuisine.${r.cuisine}`) : null,
    r.time_minutes ? t("recipe.minutes", { n: r.time_minutes }) : r.time_class ? t(`labels.time.${r.time_class}`) : null,
  ].filter(Boolean);
  return parts.length ? h("div", { class: "recipe-labels mono" }, parts.map((p) => h("span", {}, p))) : null;
}
