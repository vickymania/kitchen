// Small DOM helpers shared by every screen. No framework: a screen builds its
// elements with h() and rebuilds the part that changed.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElementNS(tag === "svg" || tag === "path" ? "http://www.w3.org/2000/svg" : "http://www.w3.org/1999/xhtml", tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.setAttribute("class", v);
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "value" && "value" in el) el.value = v;
    else if (k === "checked" || k === "disabled" || k === "open") el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

/**
 * Replace an element's children, skipping null and false. The DOM's own
 * replaceChildren(null) writes the word "null" on screen (cook mode did).
 */
export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/**
 * The big uppercase title with the red dot, as on vexed.works. Past nine
 * letters it steps down a size: "INSTELLINGEN." at full size filled a phone
 * and pushed its dot onto a line of its own.
 */
export function title(text, { long = false } = {}) {
  return h("h1", { class: long || String(text).length > 9 ? "long" : null }, text, h("span", { class: "dot" }, "."));
}

export const CHECK_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.8"/></svg>';

// The small lock on a private list line ("Alleen voor mij").
export const LOCK_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>';

export function svg(markup) {
  const t = document.createElement("template");
  t.innerHTML = markup.trim();
  return t.content.firstChild;
}

let toastTimer = null;
/** A short message at the bottom, with an optional action link or button. */
export function toast(message, { action = null, href = null, onAction = null, error = false, ms = 4500 } = {}) {
  const box = document.getElementById("toasts");
  box.replaceChildren();
  const actionEl = action
    ? href
      ? h("a", { href, class: "mono" }, action)
      : h("button", { type: "button", class: "mono", onclick: () => { onAction?.(); box.replaceChildren(); } }, action)
    : null;
  box.append(h("div", { class: `toast${error ? " error" : ""}`, role: error ? "alert" : "status" }, h("span", {}, message), actionEl));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.replaceChildren(), ms);
}

/**
 * A bottom sheet (a modal <dialog>). build(close) returns the content.
 * Resolves with whatever close() was given when it shuts.
 */
export function sheet(build) {
  return new Promise((resolve) => {
    const dlg = h("dialog", { class: "sheet" });
    let value;
    const close = (v) => {
      value = v;
      dlg.close();
    };
    dlg.append(h("div", { class: "sheet-in" }, build(close)));
    dlg.addEventListener("close", () => {
      dlg.remove();
      resolve(value);
    });
    // A tap on the dimmed background closes it.
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) close(undefined);
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}

export async function confirmSheet(message, yes, no) {
  return sheet((close) => [
    h("p", { class: "notes" }, message),
    h("div", { class: "actions" },
      h("button", { type: "button", class: "btn signal", onclick: () => close(true) }, yes),
      h("button", { type: "button", class: "btn", onclick: () => close(false) }, no)),
  ]);
}

/** A unique id for rows and ops made on this device. */
export function newId() {
  const a = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_");
}
