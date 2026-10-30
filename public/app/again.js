// The "Again" tab of groceries: what is usually bought every so many days and
// is due (or nearly due) now, from the purchase history. A tap puts it on the
// list. Recipe ingredients are left out (public/shared/again-scope.js); each row
// has "verbergen" (with undo) and the hidden ones sit under "verborgen (N)". Kept apart from the list itself on purpose (Thomas, phase 2): the list
// is what someone asked for, this is only a suggestion. Never an excluded thing
// (public/shared/intervals.js filters it).
import { h, title, toast, newId, fill, svg, EYE_SVG, EYE_OFF_SVG } from "./dom.js";
import { t, shownName } from "./i18n.js";
import { OpError } from "../shared/ops.js";
import { dueItems, localToday } from "../shared/intervals.js";
import * as store from "./store.js";
import { syncLine } from "./status.js";
import { groceryTabs } from "./groceries.js";

let showHidden = false;

/** Set the override of an item; the toast offers the way back. */
async function setAgain(d, again, undoTo, message) {
  try {
    await store.dispatch({ type: "item.again", item_id: d.item.id, again });
    toast(message, { action: t("again.undo"), onAction: () => setAgain(d, undoTo, again, t("again.restored", { title: d.name })) });
  } catch (err) {
    toast(err instanceof OpError ? t(`errors.${err.code}`) : t("errors.refused"), { error: true });
  }
}

function row(d) {
  const add = async () => {
    try {
      await store.dispatch({ type: "entry.add", id: newId(), item_id: newId(), title: d.name });
      toast(t("again.added", { title: d.name }), { action: t("add.open_list"), href: "#/" });
    } catch (err) {
      toast(err instanceof OpError ? t(`errors.${err.code}`) : t("errors.refused"), { error: true });
    }
  };
  const status = d.on_list ? t("again.on_list") : d.in_pantry ? t("again.in_pantry") : d.due ? t("again.due") : "";
  const meta = [t("again.last", { n: d.since }), t("again.usually", { n: d.interval })].join(", ");
  return h("li", {
    class: `entry again${d.due ? " due" : ""}`, role: "button", tabindex: d.on_list ? "-1" : "0",
    "aria-disabled": d.on_list ? "true" : null,
    onclick: () => { if (!d.on_list) add(); },
    onkeydown: (ev) => { if (!d.on_list && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); add(); } },
  },
  h("span", { class: "box plus", "aria-hidden": "true" }, d.on_list ? "✓" : "+"),
  h("span", { class: "ttl", lang: "nl" }, shownName(store.getView(), d.name)),
  h("span", { class: "meta" }, status ? h("b", { class: "mono status" }, status) : null, status ? " · " : "", meta),
  h("button", {
    type: "button", class: "again-hide",
    "aria-label": d.hidden ? t("again.show") : t("again.hide"), title: d.hidden ? t("again.show") : t("again.hide"),
    onclick: (ev) => {
      ev.stopPropagation();
      if (d.hidden) setAgain(d, "show", d.again, t("again.shown", { title: d.name }));
      else setAgain(d, "hide", d.again, t("again.hidden_toast", { title: d.name }));
    },
    onkeydown: (ev) => ev.stopPropagation(),
  }, svg(d.hidden ? EYE_SVG : EYE_OFF_SVG)));
}

export function mountAgain(root) {
  const eyebrow = h("div", { class: "eyebrow mono" });
  const body = h("div", {});
  root.append(
    h("section", { class: "hero wrap" }, eyebrow, title(t("again.title"))),
    groceryTabs("again"),
    h("div", { class: "wrap" }, h("p", { class: "hint top" }, t("again.explain")), body),
  );
  let last = null;
  const render = () => {
    if (!last) return;
    const { view, status } = last;
    const full = dueItems(view, localToday());
    const all = full.filter((d) => !d.hidden);
    const hidden = full.filter((d) => d.hidden);
    const due = all.filter((d) => d.due);
    const soon = all.filter((d) => !d.due);
    fill(eyebrow,
      h("span", {}, h("b", {}, t("again.due_count", { n: due.length }))),
      h("span", {}, t("again.known", { n: all.length })),
      syncLine(status));
    fill(body,
      all.length ? null : h("p", { class: "empty" }, t("again.empty")),
      due.length ? h("ul", { class: "entries" }, due.map(row)) : null,
      soon.length ? h("div", { class: "section-head" }, h("h2", {}, t("again.later"))) : null,
      soon.length ? h("ul", { class: "entries" }, soon.map(row)) : null,
      hidden.length ? h("button", {
        type: "button", class: "again-toggle mono", "aria-expanded": String(showHidden),
        onclick: () => { showHidden = !showHidden; render(); },
      }, `${showHidden ? "▾" : "▸"} ${t("again.hidden", { n: hidden.length })}`) : null,
      hidden.length && showHidden ? h("ul", { class: "entries" }, hidden.map(row)) : null);
  };
  return store.subscribe((view, status) => { last = { view, status }; render(); });
}
