// "What shall I eat" (#/wizard): five tap questions, which meal first, each with "don't mind",
// then three recipes from the book with a short reason each. The ranking is
// public/shared/wizard.js; this screen only asks and shows.
import { h, title, fill } from "./dom.js";
import { t, getLocale, formatNumber } from "./i18n.js";
import * as store from "./store.js";
import { propose, optionCounts, mealsForHour, QUESTIONS } from "../shared/wizard.js";
import { daysBetween } from "../shared/intervals.js";
import { CUISINES, MAIN_INGREDIENTS, TIME_CLASSES } from "../shared/labels.js";
import { wizardBonus } from "../shared/offers.js";
import { whenText } from "./pantry.js";

const OPTIONS = {
  // The meal that fits the time of day comes first, without being chosen.
  get meal() { return mealsForHour(new Date().getHours()).map((v) => [v, `labels.meal.${v}`]); },
  cuisine: CUISINES.map((v) => [v, `labels.cuisine.${v}`]),
  time: TIME_CLASSES.map((v) => [v, `wizard.time.${v}`]),
  main: MAIN_INGREDIENTS.map((v) => [v, `labels.main.${v}`]),
  carbs: ["light", "normal"].map((v) => [v, `wizard.carbs.${v}`]),
};

export const today = () => new Date().toLocaleDateString("sv-SE");

function sinceDay(day) {
  const d = daysBetween(day, today());
  if (d <= 0) return t("wizard.since_today");
  if (d === 1) return t("wizard.since_yesterday");
  const weekday = new Date(`${day}T12:00:00`).toLocaleDateString(getLocale() === "nl" ? "nl-NL" : "en-GB", { weekday: "long" });
  return t("wizard.since_day", { day: weekday });
}

function reasonText(r) {
  if (r.key === "in_house") return t("wizard.reason.in_house", { name: r.vars.name, since: sinceDay(r.vars.day) });
  // "kipfilet moet op (morgen)": the pantry's date, from public/shared/wizard.js's use_up weight.
  // "★4,5": the household's stars (public/shared/wizard.js, WEIGHTS.stars).
  if (r.key === "stars") return t("rstars.reason", { stars: formatNumber(r.vars.stars) });
  if (r.key === "use_up") return t("wizard.reason.use_up", { name: r.vars.name.toLowerCase(), when: whenText(r.vars.days, today()) });
  return t(`wizard.reason.${r.key}`, r.vars);
}

export function mountWizard(root) {
  const answers = {};
  let step = 0;
  let shown = [];
  let proposals = null;

  const eyebrow = h("div", { class: "eyebrow mono" });
  const body = h("div", { class: "wrap" });
  root.append(
    h("section", { class: "hero wrap" }, h("a", { class: "back mono", href: "#/" }, `← ${t("recipes.title")}`), eyebrow, title(t("wizard.title"), { long: true })),
    body,
  );

  const pick = (value) => {
    answers[QUESTIONS[step]] = value;
    step++;
    if (step === QUESTIONS.length) {
      shown = [];
      next();
    } else render();
  };

  function next() {
    // The synced deals (AH bonus and other stores' folders, phase 3), valid today.
    const view = store.getView();
    proposals = propose({ data: view, answers, bonus: wizardBonus(view.offers, today()), today: today(), exclude: shown });
    shown.push(...proposals.map((p) => p.recipe.id));
    render();
  }

  function question() {
    const key = QUESTIONS[step];
    // Only answers that still lead to a recipe; "don't mind" always does.
    const counts = optionCounts(store.getView().recipes, answers, key, OPTIONS[key].map(([v]) => v));
    const open = OPTIONS[key].filter(([value]) => counts[value] > 0);
    return [
      h("div", { class: "section-head" }, h("h2", {}, t(`wizard.q.${key}`)), h("span", { class: "note mono" }, t("wizard.step", { n: step + 1, total: QUESTIONS.length }))),
      h("div", { class: `choices${key === "meal" || key === "time" || key === "carbs" ? " few" : ""}` },
        // First: the answer people give most, above the fold on a phone.
        h("button", { type: "button", class: "choice any", onclick: () => pick(null) }, t("wizard.any")),
        open.map(([value, label]) => h("button", { type: "button", class: "choice", onclick: () => pick(value) }, t(label)))),
      step > 0 ? h("div", { class: "actions" }, h("button", { type: "button", class: "btn ghost", onclick: () => { step--; render(); } }, `← ${t("wizard.back")}`)) : null,
    ];
  }

  function answerLine() {
    return QUESTIONS.map((k) => {
      const v = answers[k];
      if (!v) return null;
      return t(OPTIONS[k].find(([x]) => x === v)[1]);
    }).filter(Boolean).join(" · ") || t("wizard.any");
  }

  function results() {
    const recipes = Object.values(store.getView().recipes);
    const unlabelled = recipes.filter((r) => !r.labels_by || !r.meals?.length).length;
    return [
      h("div", { class: "section-head" }, h("h2", {}, t("wizard.proposals", { n: proposals.length })), h("span", { class: "note mono" }, answerLine())),
      proposals.length
        ? h("ol", { class: "rows" }, proposals.map((p, i) => h("li", {},
          h("a", { class: "row", href: `#/recipe/${p.recipe.id}` },
            h("span", { class: "idx mono" }, String(i + 1).padStart(2, "0")),
            h("span", { class: "ttl" }, p.recipe.title),
            h("span", { class: "meta" },
              p.idea ? h("span", { class: "tag mono" }, t("wizard.idea")) : null,
              p.reasons.map(reasonText).join(" · ") || (p.idea ? null : t("wizard.reason.none")))))))
        : h("p", { class: "empty" }, shown.length ? t("wizard.no_more") : t("wizard.none")),
      unlabelled ? h("p", { class: "hint top" }, t("wizard.unlabelled", { n: unlabelled })) : null,
      h("div", { class: "actions" },
        proposals.length ? h("button", { type: "button", class: "btn primary", onclick: next }, t("wizard.other_three")) : null,
        h("button", { type: "button", class: "btn", onclick: () => { step = 0; proposals = null; for (const k of QUESTIONS) delete answers[k]; render(); } }, t("wizard.again"))),
    ];
  }

  function render() {
    fill(eyebrow,
      h("span", {}, h("b", {}, t("wizard.from_book", { n: Object.keys(store.getView().recipes).length }))),
      proposals ? h("span", {}, t("wizard.shown", { n: shown.length })) : null);
    fill(body, proposals ? results() : question());
    window.scrollTo(0, 0);
  }

  render();
  return null;
}
