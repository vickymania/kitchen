// Writing or changing a recipe. Ingredients are plain text, one per line,
// the way people already write them; under the field the app shows how it
// read each line, with the same parser the To Do import used. A heading is a
// line that ends with a colon ("Deeg:").
import { h, title, toast, confirmSheet, newId } from "./dom.js";
import { t, formatAmount } from "./i18n.js";
import { parseRecipeText } from "../shared/recipe-text.js";
import { OpError } from "../shared/ops.js";
import * as store from "./store.js";
import { uploadPhoto } from "./photo.js";
import { isOffline } from "./api.js";
import { CUISINES, MAIN_INGREDIENTS, TIME_CLASSES, MEALS, LABEL_FIELDS, sortMeals } from "../shared/labels.js";
import { queueLabel } from "./labels.js";
import { recipeProductButton } from "./recipe.js";
import { importBlock } from "./recipe-import.js";

function ingredientsToText(ings) {
  return ings.map((i) => (i.heading ? `${i.name}:` : i.raw || [formatAmount(i), i.name, i.note ? `(${i.note})` : ""].filter(Boolean).join(" "))).join("\n");
}

export function mountEditor(root, id) {
  const existing = id ? store.getView().recipes[id] : null;
  if (id && !existing) {
    location.hash = "#/";
    return null;
  }
  const recipeId = existing?.id ?? newId();
  let photo = existing?.photo ?? null;

  const name = h("input", { value: existing?.title ?? "", required: true, maxlength: "200" });
  const servings = h("input", { type: "number", min: "1", max: "100", inputmode: "numeric", value: existing?.servings ?? "" });
  const ings = h("textarea", { rows: "10", placeholder: t("edit.ingredients_placeholder") });
  ings.value = existing ? ingredientsToText(existing.ingredients) : "";
  const steps = h("textarea", { rows: "10", placeholder: t("edit.steps_placeholder") });
  steps.value = existing ? existing.steps.join("\n") : "";
  const notes = h("textarea", { rows: "4" });
  notes.value = existing?.notes ?? "";
  const source = h("input", { type: "text", value: existing?.source_url ?? "", placeholder: t("edit.source_placeholder"), maxlength: "500" });
  const preview = h("ul", { class: "preview-ings", "aria-live": "polite" });

  // The wizard's labels. Changing one makes them this person's: Claude never
  // touches them again (it may still fill empty meals, see public/shared/ops.js).
  const choose = (values, prefix, current) => h("select", {},
    h("option", { value: "" }, t("edit.label_unset")),
    values.map((v) => h("option", { value: v, selected: v === current }, t(`${prefix}.${v}`))));
  const labelInputs = {
    cuisine: choose(CUISINES, "labels.cuisine", existing?.cuisine),
    main_ingredient: choose(MAIN_INGREDIENTS, "labels.main", existing?.main_ingredient),
    time_class: choose(TIME_CLASSES, "labels.time", existing?.time_class),
    time_minutes: h("input", { type: "number", min: "1", max: "1440", inputmode: "numeric", value: existing?.time_minutes ?? "" }),
  };
  // Meals are toggles: a recipe can be for more than one.
  const meals = new Set(existing?.meals ?? []);
  const mealToggles = MEALS.map((m) => {
    const b = h("button", {
      type: "button", class: "choice toggle", "aria-pressed": String(meals.has(m)),
      onclick: () => {
        if (meals.has(m)) meals.delete(m);
        else meals.add(m);
        b.setAttribute("aria-pressed", String(meals.has(m)));
      },
    }, t(`labels.meal.${m}`));
    return b;
  });
  const labelValue = (f) => {
    if (f === "meals") return sortMeals([...meals]);
    const v = labelInputs[f].value;
    if (!v) return null;
    return f === "time_minutes" ? Number(v) : v;
  };
  const labelsBy = existing?.labels_by ?? null;
  // Labels Claude gave with an imported draft. Saved unchanged, they stay
  // Claude's (no second paid labelling); one changed makes them this person's.
  let importedLabels = null;
  // Claude's labels carry no badge (30-10-2026: "ingevuld door Claude mag weg").
  const labelsNoteText = (by) => (by === "claude" ? "" : t(`edit.labels_by_${by ?? "none"}`));
  const labelsNote = h("span", { class: "note mono" }, labelsNoteText(labelsBy));

  const showPreview = () => {
    const parsed = parseRecipeText(ings.value);
    preview.replaceChildren(...parsed.ingredients.map((i) => (i.heading
      ? h("li", { class: "head" }, i.name)
      : h("li", {}, h("span", { class: "q" }, formatAmount(i) || "—"), h("span", {}, i.name, i.note ? ` (${i.note})` : "", i.optional ? ` · ${t("recipe.optional")}` : "")))));
  };
  ings.addEventListener("input", showPreview);
  showPreview();

  const thumb = h("img", { alt: "", hidden: !photo, src: photo ? `/photos/${photo}` : null });
  const removePhoto = h("button", { type: "button", class: "btn ghost", hidden: !photo, onclick: () => setPhoto(null) }, t("edit.remove_photo"));
  const photoLabel = h("label", { class: "btn", for: "photo-file" }, photo ? t("edit.change_photo") : t("edit.add_photo"));
  function setPhoto(key) {
    photo = key;
    photoLabel.textContent = key ? t("edit.change_photo") : t("edit.add_photo");
    if (key) thumb.src = `/photos/${key}`;
    thumb.hidden = !key;
    removePhoto.hidden = !key;
  }

  // A draft from photos or a web page (public/app/recipe-import.js) fills
  // the form; nothing is saved until the person taps save.
  const applyDraft = (d) => {
    name.value = d.title ?? "";
    servings.value = d.servings ?? "";
    ings.value = (d.ingredients ?? []).join("\n");
    steps.value = (d.steps ?? []).join("\n");
    notes.value = d.notes ?? "";
    if (d.source_url) source.value = d.source_url;
    importedLabels = d.labels ? Object.fromEntries(LABEL_FIELDS.map((f) => [f, d.labels[f] ?? null])) : null;
    for (const f of ["cuisine", "main_ingredient", "time_class", "time_minutes"]) labelInputs[f].value = importedLabels?.[f] ?? "";
    meals.clear();
    for (const m of importedLabels?.meals ?? []) meals.add(m);
    mealToggles.forEach((b, i) => b.setAttribute("aria-pressed", String(meals.has(MEALS[i]))));
    labelsNote.textContent = labelsNoteText(importedLabels ? "claude" : null);
    showPreview();
  };
  const file = h("input", {
    type: "file", accept: "image/*", class: "sr", id: "photo-file",
    onchange: async () => {
      const f = file.files?.[0];
      if (!f) return;
      toast(t("edit.uploading"));
      try {
        setPhoto(await uploadPhoto(f));
        toast(t("edit.photo_added"));
      } catch (e) {
        toast(isOffline(e) ? t("edit.photo_offline") : t("edit.photo_failed"), { error: true });
      }
      file.value = "";
    },
  });

  const save = async (e) => {
    e.preventDefault();
    const parsed = parseRecipeText(ings.value);
    const extraNotes = parsed.notes && !notes.value.includes(parsed.notes) ? parsed.notes : "";
    const labels = Object.fromEntries(LABEL_FIELDS.map((f) => [f, labelValue(f)]));
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const labelsChanged = LABEL_FIELDS.some((f) => !same(labels[f], existing?.[f] ?? null));
    const labelsAsImported = Boolean(importedLabels) && LABEL_FIELDS.every((f) => same(labels[f], importedLabels[f]));
    try {
      await store.dispatch({
        type: "recipe.put",
        id: recipeId,
        recipe: {
          title: name.value,
          servings: servings.value ? Number(servings.value) : parsed.servings,
          ingredients: parsed.ingredients,
          steps: steps.value.split("\n").map((s) => s.trim()).filter(Boolean),
          notes: [notes.value.trim(), extraNotes].filter(Boolean).join("\n"),
          nutrition: existing?.nutrition ?? parsed.nutrition,
          photo,
          source_url: source.value.trim() || null,
          ...(labelsChanged ? { ...labels, labels_by: labelsAsImported ? "claude" : "person" } : {}),
        },
      });
      // Nobody labelled it yet: Claude does, once it is on the server.
      if (!labelsChanged && !labelsBy) queueLabel(recipeId);
      location.hash = `#/recipe/${recipeId}`;
    } catch (err) {
      toast(err instanceof OpError ? t(`errors.${err.code}`) : t("errors.refused"), { error: true });
    }
  };

  const remove = async () => {
    if (!(await confirmSheet(t("edit.delete_confirm", { title: existing.title }), t("edit.delete"), t("common.cancel")))) return;
    await store.dispatch({ type: "recipe.delete", id: recipeId });
    location.hash = "#/";
  };

  const field = (label, control, hint = null) => h("label", { class: "field" }, h("span", { class: "mono" }, label), control, hint ? h("p", { class: "hint" }, hint) : null);

  root.append(
    h("section", { class: "hero wrap" },
      h("a", { class: "back mono", href: existing ? `#/recipe/${recipeId}` : "#/" }, `← ${existing ? existing.title : t("recipes.title")}`),
      h("div", { class: "eyebrow mono" }, h("span", {}, existing ? t("edit.editing") : t("edit.new"))),
      title(existing ? t("edit.title_edit") : t("edit.title_new"))),
    h("form", { class: "wrap", onsubmit: save },
      existing ? null : h("div", { class: "section-head" }, h("h2", {}, t("import.title"))),
      existing ? null : importBlock({ onDraft: applyDraft, onPhoto: setPhoto }),
      h("div", { class: "section-head" }, h("h2", {}, t("edit.basics"))),
      field(t("edit.name"), name),
      field(t("edit.servings"), servings),
      h("div", { class: "photo-pick" }, thumb,
        photoLabel, file, removePhoto),
      h("div", { class: "section-head" }, h("h2", {}, t("recipe.ingredients"))),
      field(t("edit.ingredients"), ings, t("edit.ingredients_hint")),
      preview,
      // Products per recipe are the groceries side: never for a recipes-only person.
      existing && !store.isGuest() && existing.ingredients.some((i) => !i.heading) ? h("div", { class: "rproducts" },
        h("h3", { class: "mono sub" }, t("edit.products")),
        h("p", { class: "hint" }, t("edit.products_hint")),
        h("ul", { class: "picklist" }, existing.ingredients.filter((i) => !i.heading).map((i) =>
          h("li", { class: "rprod" }, h("span", {}, i.name), recipeProductButton(existing, i.name))))) : null,
      h("div", { class: "section-head" }, h("h2", {}, t("recipe.method"))),
      field(t("edit.steps"), steps, t("edit.steps_hint")),
      h("div", { class: "section-head" }, h("h2", {}, t("recipe.notes"))),
      field(t("edit.notes"), notes),
      field(t("edit.source"), source),
      h("div", { class: "section-head" }, h("h2", {}, t("edit.labels")), labelsNote),
      h("div", { class: "field", role: "group", "aria-label": t("edit.meals") },
        h("span", { class: "mono" }, t("edit.meals")),
        h("div", { class: "choices few meal-toggles" }, mealToggles),
        h("p", { class: "hint" }, t("edit.meals_hint"))),
      h("div", { class: "label-grid" },
        field(t("edit.cuisine"), labelInputs.cuisine),
        field(t("edit.main_ingredient"), labelInputs.main_ingredient),
        field(t("edit.time_class"), labelInputs.time_class),
        field(t("edit.time_minutes"), labelInputs.time_minutes)),
      h("div", { class: "actions" },
        h("button", { type: "submit", class: "btn primary" }, t("edit.save")),
        h("a", { class: "btn", href: existing ? `#/recipe/${recipeId}` : "#/" }, t("common.cancel"))),
      existing ? h("div", { class: "danger-zone" }, h("button", { type: "button", class: "btn ghost sig", onclick: remove }, t("edit.delete"))) : null),
  );
  name.focus();
  return null;
}
