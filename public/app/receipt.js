// A receipt photo, read by Claude (worker/receipts.js), then reviewed here
// before anything is stored. Each product line is matched to an item (and so
// to its open list line, which gets checked off); fix what was misread, then
// Save sends receipt.save and one purchase.add per product line.
//
// Excluded lines (public/shared/excluded.js) never reach this screen: the worker counts them and leaves
// their names out.
import { h, title, toast, newId, fill, sheet } from "./dom.js";
import { t } from "./i18n.js";
import { api, isOffline } from "./api.js";
import { nameKey } from "../shared/ingredients.js";
import { OpError, productKey } from "../shared/ops.js";
import { isExcluded } from "../shared/excluded.js";
import { localToday } from "../shared/intervals.js";
import * as store from "./store.js";
import { money } from "./product.js";
import { preferenceAt } from "../shared/preferences.js";
import { itemKind, kindFits, kindFromName } from "../shared/product-kinds.js";

// Receipts are long and narrow; the small print needs more pixels than a
// recipe photo. Drawing on a canvas also drops the EXIF data (GPS).
const LONG_EDGE = 2200;
const DRAFT_KEY = "kitchen-receipt-draft";

async function shrinkReceipt(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, LONG_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/jpeg", 0.85));
}

function saveDraft(draft) {
  try {
    if (draft) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Private mode: the draft lives as long as the screen.
  }
}

function loadDraft() {
  try {
    return JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? "null");
  } catch {
    return null;
  }
}

const words = (s) => nameKey(s).split(" ").filter((w) => w.length >= 3);

/** The item a receipt line most likely is: a known product, an open list line, a known item, or its own name. */
export function guessItem(view, line) {
  const known = Object.values(view.products ?? {}).find((p) => p.product_key === productKey(line) && p.item_id);
  if (known && view.items[known.item_id]) return view.items[known.item_id].name;
  const lineWords = words(`${line.name} ${line.brand}`);
  const overlap = (title) => {
    const w = words(title);
    // A Dutch compound ends in what it is: "scharreleieren" are "eieren".
    return w.filter((a) => lineWords.some((b) => b === a || b.startsWith(a) || a.startsWith(b) || b.endsWith(a))).length / (w.length || 1);
  };
  let best = null;
  for (const e of Object.values(view.entries)) {
    if (e.checked_at || e.deleted_at) continue;
    const score = overlap(e.title);
    if (score >= 0.5 && (!best || score > best.score)) best = { score, title: e.title };
  }
  if (best) return best.title;
  for (const i of Object.values(view.items)) if (!i.deleted_at && overlap(i.name) === 1) return i.name;
  return line.name;
}

/** Camera or gallery, then read the photo. */
export function pickReceipt() {
  // The file picker must open inside the tap itself, so each button calls
  // readPhoto() before the sheet closes.
  sheet((close) => h("div", {},
    h("h2", {}, t("receipt.scan")),
    h("div", { class: "actions" },
      h("button", { type: "button", class: "btn primary", onclick: () => { readPhoto(true); close(); } }, t("receipt.camera")),
      h("button", { type: "button", class: "btn ghost", onclick: () => { readPhoto(false); close(); } }, t("receipt.gallery")))));
}

/** Read a photo and open the review screen. */
function readPhoto(camera) {
  const input = h("input", { type: "file", accept: "image/*", capture: camera ? "environment" : null });
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    toast(t("receipt.reading"), { ms: 60_000 });
    try {
      const review = await api.upload("/api/receipts/read", await shrinkReceipt(file));
      const view = store.getView();
      const lines = review.lines.map((l) => ({ ...l, key: newId(), item: l.kind === "product" ? guessItem(view, l) : "" }));
      saveDraft({ ...review, bought_on: review.bought_on ?? localToday(), lines });
      document.getElementById("toasts").replaceChildren();
      location.hash = "#/receipt";
    } catch (e) {
      toast(isOffline(e) ? t("receipt.offline") : t(`errors.${e.code}`) === `errors.${e.code}` ? t("receipt.failed") : t(`errors.${e.code}`), { error: true });
    }
  });
  input.click();
}

function openEntryFor(view, itemName) {
  const key = nameKey(itemName);
  const item = Object.values(view.items).find((i) => !i.deleted_at && i.name_key === key);
  if (!item) return { item: null, entry: null };
  const entry = Object.values(view.entries).find((e) => e.item_id === item.id && !e.checked_at && !e.deleted_at) ?? null;
  return { item, entry };
}

export function mountReceipt(root) {
  const draft = loadDraft();
  if (!draft) {
    root.append(h("section", { class: "hero wrap" }, title(t("receipt.title"))),
      h("div", { class: "wrap" }, h("p", { class: "empty" }, t("receipt.none")),
        h("div", { class: "actions" }, h("button", { type: "button", class: "btn primary", onclick: pickReceipt }, t("receipt.scan")))));
    return null;
  }
  // Each line has its own "keep as preferred" choice (at this receipt's
  // store); unset means the default. A line bought for a recipe can instead
  // keep it only for that recipe (onlyFor: the recipe id).
  const prefer = new Map();
  const onlyFor = new Map();
  const eyebrow = h("div", { class: "eyebrow mono" });
  const store_ = h("input", { value: draft.store, maxlength: "40" });
  // "voortaan deze bij <store>" names the store: say the new one.
  store_.addEventListener("change", () => paint());
  const date = h("input", { type: "date", value: draft.bought_on });
  const list = h("ul", { class: "entries receipt-lines" });
  const items = h("datalist", { id: "receipt-items" });
  const persist = () => saveDraft(draft);

  const sum = () => draft.lines.reduce((s, l) => s + (l.price_cents ?? 0), 0) + (draft.skipped?.cents ?? 0);
  function paintEyebrow() {
    const off = draft.total_cents !== null && Math.abs(sum() - draft.total_cents) > 1;
    fill(eyebrow,
      h("span", {}, h("b", {}, t("receipt.lines", { n: draft.lines.length }))),
      h("span", { class: off ? "sig" : null }, t("receipt.sum", { sum: money(sum()), total: money(draft.total_cents) })),
      off ? h("span", { class: "sig" }, t("receipt.sum_off")) : null,
      draft.skipped?.count ? h("span", {}, t("receipt.skipped", { n: draft.skipped.count })) : null);
  }

  function lineRow(line) {
    const view = store.getView();
    const field = (key, attrs) => {
      const el = h("input", { value: line[key] ?? "", ...attrs });
      el.addEventListener("input", () => {
        line[key] = el.value;
        persist();
        if (key === "item") paintMatch();
      });
      return el;
    };
    const price = h("input", { inputmode: "decimal", value: ((line.price_cents ?? 0) / 100).toFixed(2).replace(".", ","), class: "num" });
    price.addEventListener("input", () => {
      const n = Number(price.value.replace(",", "."));
      if (Number.isFinite(n)) line.price_cents = Math.round(n * 100);
      persist();
      paintEyebrow();
    });
    const qty = h("input", { inputmode: "decimal", value: String(line.qty ?? 1), class: "num" });
    qty.addEventListener("input", () => {
      const n = Number(qty.value.replace(",", "."));
      if (Number.isFinite(n) && n > 0) line.qty = n;
      persist();
    });
    const match = h("div", { class: "match mono" });
    const paintMatch = () => {
      if (line.kind !== "product") return fill(match, t(`receipt.kind_${line.kind}`));
      if (isExcluded(line.item) || isExcluded(line.name)) return fill(match, h("span", { class: "sig" }, t("receipt.left_out")));
      const { item, entry } = openEntryFor(store.getView(), line.item);
      const box = h("input", { type: "checkbox", checked: prefer.get(line.key) ?? keepByDefault(item, entry, line) });
      const source = entry?.sources?.[0] ?? null;
      const only = h("input", { type: "checkbox", checked: onlyFor.get(line.key) === source?.recipe_id && Boolean(source) });
      const onlyLabel = source ? h("label", { class: "keep", hidden: !box.checked }, only, t("receipt.only_for", { recipe: source.title })) : null;
      box.addEventListener("change", () => {
        prefer.set(line.key, box.checked);
        if (onlyLabel) onlyLabel.hidden = !box.checked;
      });
      only.addEventListener("change", () => onlyFor.set(line.key, only.checked ? source.recipe_id : null));
      fill(match,
        h("span", {}, entry ? t("receipt.checks_off", { title: entry.title }) : item ? t("receipt.known_item") : t("receipt.new_item")),
        line.item.trim() ? h("label", { class: "keep" }, box, t("receipt.keep_preferred_at", { store: store_.value.trim() || t("receipt.this_store") })) : null,
        line.item.trim() ? onlyLabel : null);
    };
    paintMatch();
    const remove = () => {
      draft.lines = draft.lines.filter((l) => l !== line);
      persist();
      paint();
    };
    return h("li", { class: `rline${line.kind === "product" ? "" : " minor"}` },
      h("div", { class: "rgrid" },
        h("label", { class: "field name" }, h("span", { class: "mono" }, t("receipt.name")), field("name", { maxlength: "120" })),
        h("label", { class: "field price" }, h("span", { class: "mono" }, t("receipt.price")), price),
        h("label", { class: "field" }, h("span", { class: "mono" }, t("product.brand")), field("brand", { maxlength: "60" })),
        h("label", { class: "field" }, h("span", { class: "mono" }, t("product.size")), field("size", { maxlength: "40" })),
        h("label", { class: "field" }, h("span", { class: "mono" }, t("receipt.qty")), qty),
        line.kind === "product"
          ? h("label", { class: "field item" }, h("span", { class: "mono" }, t("receipt.item")), field("item", { maxlength: "120", list: "receipt-items" }))
          : null),
      match,
      h("button", { type: "button", class: "btn ghost remove mono", onclick: remove }, t("receipt.remove")));
  }

  // Kept by default when the line checks off a list line, nothing is chosen
  // yet for this item at this store (or at any store), and the product is of
  // the item's kind (never a snack cup for "Pasta"; it can still be ticked).
  function keepByDefault(item, entry, line = null) {
    if (!entry) return false;
    if (!item) return true;
    const view = store.getView();
    if (line && !kindFits(itemKind(view, item.id), kindFromName(line.name, line.brand))) return false;
    const prefs = view.preferences ?? {};
    return !preferenceAt(prefs, item.id, store_.value, "") && !preferenceAt(prefs, item.id, "", "");
  }

  function paint() {
    const view = store.getView();
    items.replaceChildren(...Object.values(view.items).filter((i) => !i.deleted_at && !isExcluded(i.name)).map((i) => h("option", { value: i.name })));
    fill(list, draft.lines.map(lineRow));
    paintEyebrow();
  }

  const cancel = () => {
    saveDraft(null);
    location.hash = "#/";
  };

  const save = async (ev) => {
    ev.preventDefault();
    draft.store = store_.value.trim();
    draft.bought_on = date.value || localToday();
    const view = store.getView();
    const receiptId = newId();
    const products = draft.lines.filter((l) => l.kind === "product" && l.name.trim() && l.item.trim()
      && !isExcluded(l.item) && !isExcluded(l.name) && !isExcluded(`${l.brand} ${l.name}`));
    try {
      await store.dispatch({
        type: "receipt.save", id: receiptId, store: draft.store, bought_on: draft.bought_on,
        total_cents: draft.total_cents, lines: draft.lines.map(({ name, brand, size, qty, price_cents, kind }) => ({ name, brand, size, qty, price_cents, kind })),
      });
      let checked = 0;
      for (const l of products) {
        const { item, entry } = openEntryFor(store.getView(), l.item);
        const known = Object.values(view.products ?? {}).find((p) => p.product_key === productKey(l));
        const keep = prefer.get(l.key) ?? keepByDefault(item, entry, l);
        const recipeOnly = keep ? onlyFor.get(l.key) ?? null : null;
        if (entry) checked++;
        await store.dispatch({
          type: "purchase.add", id: newId(), source: "receipt", receipt_id: receiptId,
          title: l.item, item_id: newId(), bought_on: draft.bought_on, store: draft.store,
          qty: l.qty, price_cents: l.price_cents,
          product: { id: known?.id ?? newId(), name: l.name, brand: l.brand, size: l.size },
          ...(entry ? { entry_id: entry.id } : {}),
          // A receipt read today is what is in the house now (phase 4).
          pantry: true,
          ...(recipeOnly ? { prefer_recipe_id: recipeOnly } : { prefer: keep }),
        });
      }
      saveDraft(null);
      toast(t("receipt.saved", { n: products.length, checked }));
      location.hash = "#/";
    } catch (err) {
      toast(err instanceof OpError ? t(`errors.${err.code}`) : t("errors.refused"), { error: true });
    }
  };

  root.append(
    h("section", { class: "hero wrap" }, eyebrow, title(t("receipt.title"))),
    h("form", { class: "wrap", onsubmit: save },
      h("p", { class: "hint top" }, t("receipt.review_hint")),
      h("div", { class: "rhead" },
        h("label", { class: "field" }, h("span", { class: "mono" }, t("receipt.store")), store_),
        h("label", { class: "field" }, h("span", { class: "mono" }, t("receipt.date")), date)),
      list, items,
      h("div", { class: "actions" },
        h("button", { type: "submit", class: "btn primary grow" }, t("receipt.save")),
        h("button", { type: "button", class: "btn", onclick: cancel }, t("common.cancel")))),
  );
  paint();
  return null;
}
