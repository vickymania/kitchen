// Screen text in English and Dutch. Every sentence a person reads comes from
// public/i18n/en.json and nl.json; tools/map_check.py fails when a key is used
// here but missing there, or present in one file and not the other.
//
// Recipes are written in one language and carry a translation into the other
// (0029); items have an English name next to the Dutch one. itemName and
// shownName pick by this language (public/shared/bilingual.js).
import { formatQty } from "../shared/ingredients.js";
import { itemLabel, localName, shownRecipe } from "../shared/bilingual.js";

let dict = {};
let fallback = {};
let locale = "nl";

async function fetchDict(lang) {
  const res = await fetch(`/i18n/${lang}.json`);
  return res.json();
}

export async function setLocale(lang) {
  locale = lang === "en" ? "en" : "nl";
  [dict, fallback] = await Promise.all([fetchDict(locale), locale === "en" ? Promise.resolve(null) : fetchDict("en")]);
  fallback = fallback ?? dict;
  document.documentElement.lang = locale;
  applyI18n(document);
}

export const getLocale = () => locale;

/** An item's name in this language: its English name in English when it has one. */
export const itemName = (item) => itemLabel(item, locale);

/** A recipe's title in this language: its translation's when that is fresh. */
export const recipeTitle = (r) => shownRecipe(r, locale).recipe?.title ?? r?.title ?? "";

/** A Dutch item name (a line's title, a pantry row, "Bijna op") as shown in this language. */
export const shownName = (view, name) => localName(view, locale, name);

function lookup(obj, key) {
  return key.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}

/** t(key, { n: 3 }): a value with { one, other } picks by n; {name} is filled in. */
export function t(key, vars = {}) {
  let v = lookup(dict, key) ?? lookup(fallback, key);
  if (v === undefined) return key;
  if (typeof v === "object") v = vars.n === 1 ? v.one : v.other;
  return String(v).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
}

/** A data-t attribute sets the text; data-t-placeholder / data-t-aria-label set attributes. */
export function applyI18n(root) {
  for (const el of root.querySelectorAll("[data-t]")) el.textContent = t(el.dataset.t);
  for (const el of root.querySelectorAll("[data-t-placeholder]")) el.placeholder = t(el.dataset.tPlaceholder);
  for (const el of root.querySelectorAll("[data-t-aria-label]")) el.setAttribute("aria-label", t(el.dataset.tAriaLabel));
}

export function unitLabel(unit, qty) {
  if (!unit) return "";
  return t(`units.${unit}`, { n: qty === 1 || (qty !== null && qty < 1) ? 1 : 2 });
}

/** "400 gr", "2–3 tenen", "½ el", or the free text someone typed. */
export function formatAmount(a) {
  if (!a) return "";
  if (a.text !== undefined) return a.text;
  if (a.qty === null || a.qty === undefined) return "";
  const q = formatQty(a.qty, locale) + (a.qty_max ? `–${formatQty(a.qty_max, locale)}` : "");
  const u = unitLabel(a.unit, a.qty_max ?? a.qty);
  return u ? `${q} ${u}` : q;
}

export function formatAmounts(list = []) {
  return list.map(formatAmount).filter(Boolean).join(" + ");
}

/** 40,4 in Dutch, 40.4 in English. */
export function formatNumber(n) {
  return Number(n).toLocaleString(locale === "nl" ? "nl-NL" : "en-GB", { maximumFractionDigits: 1 });
}

export function formatTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString(locale === "nl" ? "nl-NL" : "en-GB", { hour: "2-digit", minute: "2-digit" });
}

export function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(locale === "nl" ? "nl-NL" : "en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function collator() {
  return new Intl.Collator(locale === "nl" ? "nl" : "en", { sensitivity: "base", numeric: true });
}
