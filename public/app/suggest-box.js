// The suggestion list under a name field (public/shared/suggest.js): the add
// box on the list and "Koppel aan…" on a line. Rows are buttons (touch) and
// the field drives them with the arrow keys (a combobox); Enter on a
// highlighted row picks it. Also the relink of a line and "Onthoud als naam".
import { h, toast, sheet, newId, fill } from "./dom.js";
import { t } from "./i18n.js";
import { OpError } from "../shared/ops.js";
import { nameKey } from "../shared/ingredients.js";
import { suggest, exactItem } from "../shared/suggest.js";
import { resolveProduct } from "../shared/preferences.js";
import * as store from "./store.js";
import { productLabel } from "./product.js";
import { getStore } from "./shop.js";

const refused = (err) => toast(err instanceof OpError ? t(`errors.${err.code}`) : t("errors.refused"), { error: true });
const today = () => new Date().toLocaleDateString("sv-SE");

/** The product an item resolves to at this phone's store, for the grey part of a row. */
function productOf(view, item) {
  const p = resolveProduct(view, { item_id: item.id, sources: [] }, getStore())?.product;
  return p ? productLabel(p) : "";
}

/**
 * Wire a suggestion list to `input`. textOf() gives the name part of what was
 * typed ("2 mino" -> "mino"). onPick(item) runs on a tap or Enter on a
 * highlighted row. Returns { list, active(), clear(), refresh() }.
 */
export function suggestBox(input, { textOf = (v) => v, onPick, except = null, keepOpen = false } = {}) {
  const list = h("ul", { class: "suggest", role: "listbox", id: `sg-${newId()}`, "aria-label": t("names.suggestions") });
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-expanded", "false");
  let rows = [];
  let at = -1;
  const mark = () => {
    [...list.children].forEach((li, i) => li.classList.toggle("on", i === at));
    if (at >= 0 && list.children[at]) input.setAttribute("aria-activedescendant", list.children[at].id);
    else input.removeAttribute("aria-activedescendant");
  };
  const pick = (r) => onPick?.(r.item);
  const refresh = () => {
    const view = store.getView();
    const text = textOf(input.value);
    rows = text.trim() ? suggest(view, text, { today: today(), except }) : [];
    at = -1;
    fill(list, rows.map((r, i) => {
      const product = productOf(view, r.item);
      return h("li", { role: "option", id: `${list.id}-${i}` },
        h("button", { type: "button", class: "sg-row", tabindex: "-1",
          // pointerdown keeps the field's focus (the keyboard stays up on a phone).
          onpointerdown: (ev) => ev.preventDefault(), onclick: () => pick(r) },
        h("span", { class: "sg-name" }, r.item.name),
        r.via ? h("span", { class: "sg-also mono" }, t("names.also", { alias: r.via })) : null,
        product ? h("span", { class: "sg-prod mono" }, product) : null));
    }), keepOpen && text.trim() && !rows.length ? h("li", { class: "sg-none mono" }, t("names.no_match")) : null);
    input.setAttribute("aria-expanded", String(rows.length > 0));
  };
  input.addEventListener("input", refresh);
  input.addEventListener("keydown", (ev) => {
    if (!rows.length) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      at = ev.key === "ArrowDown" ? (at + 1) % rows.length : (at <= 0 ? rows.length : at) - 1;
      mark();
    } else if (ev.key === "Enter" && at >= 0) {
      ev.preventDefault();
      pick(rows[at]);
    } else if (ev.key === "Escape") {
      rows = [];
      fill(list);
      input.setAttribute("aria-expanded", "false");
    }
  });
  if (!keepOpen) input.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== input) { rows = []; fill(list); } }, 150));
  return { list, clear: () => { rows = []; at = -1; fill(list); input.setAttribute("aria-expanded", "false"); }, refresh };
}

/**
 * "Onthoud als naam": the typed text becomes another name of the item, so
 * it links by itself next time. Offered after a relink when it does not
 * already link there.
 */
export function rememberOffer(typed, item) {
  const text = String(typed ?? "").trim();
  if (!text || !nameKey(text) || exactItem(store.getView(), text)?.id === item.id) {
    toast(t("names.linked", { name: item.name }));
    return;
  }
  toast(t("names.linked", { name: item.name }), {
    action: t("names.remember"), ms: 9000,
    onAction: () => store.dispatch({ type: "item.alias", id: newId(), item_id: item.id, name: text })
      .then(() => toast(t("names.remembered", { alias: text, name: item.name })))
      .catch(refused),
  });
}

/** The line goes to `item` (entry.update by id), then "Onthoud als naam?". */
export async function relink(e, item) {
  const typed = e.typed || e.title;
  try {
    await store.dispatch({ type: "entry.update", id: e.id, title: item.name, item_id: item.id });
    rememberOffer(typed, item);
  } catch (err) {
    refused(err);
  }
}

/** "Koppel aan…": a name field with the suggestion list, starting from what was typed. */
export async function linkSheet(e) {
  const input = h("input", { value: e.typed || e.title, maxlength: "120", autocomplete: "off", enterkeyhint: "search" });
  let chosen = null;
  const picked = await sheet((close) => {
    const box = suggestBox(input, { except: e.item_id, keepOpen: true, onPick: (item) => { chosen = item; close("pick"); } });
    setTimeout(() => { box.refresh(); input.focus(); input.select(); });
    return h("form", { class: "link-sheet", onsubmit: (ev) => ev.preventDefault() },
      h("h2", {}, t("names.link")),
      h("p", { class: "hint" }, t("names.link_hint")),
      h("label", { class: "field" }, h("span", { class: "mono" }, t("list.name")), input),
      box.list,
      h("div", { class: "actions" }, h("button", { type: "button", class: "btn", onclick: () => close() }, t("common.cancel"))));
  });
  if (picked === "pick" && chosen) await relink(e, chosen);
}
