// The "Voorraad" tab of groceries (phase 4): what is in the house. Ticking the
// list fills it, a receipt fills in the real product, cooking takes from it.
// What must be eaten soon comes first ("Op tijd opmaken"); every row has
// "op", "weggegooid" and "datum". Rules: public/shared/pantry.js.
// "Bijna op" (public/shared/low-stock.js): the strip above the list, the low
// rows marked here, and "waarschuw onder…" per row.
import { h, title, toast, sheet, newId, fill, svg, CHECK_SVG } from "./dom.js";
import { t, getLocale, shownName } from "./i18n.js";
import { formatQty, parseListInput, parseAmount } from "../shared/ingredients.js";
import { OpError } from "../shared/ops.js";
import { pantryGroups, displayAmount, daysLeft, wasteCounts, fromEntry, packSize, parseLowAt, LOW_AT_MAX, withUsage, rowRate, liveRows, supplyDays, RATE_MAX } from "../shared/pantry.js";
import { localToday, daysBetween } from "../shared/intervals.js";
import { KEEPS, SHELF_DAYS_MAX, itemShelfDays, itemOpenedDays, addDays } from "../shared/shelf-life.js";
import { lowStock, lowByKey, stockKey, stockOf, underThreshold } from "../shared/low-stock.js";
import { neededSoon, leftAmount, notYetOp, tickOps, NOT_YET_DAYS } from "../shared/needed-soon.js";
import * as store from "./store.js";
import { syncLine } from "./status.js";
import { groceryTabs } from "./groceries.js";

/** "½", "2", "1¼": packs or pieces as they are read. */
export function packsText(n) {
  return formatQty(displayAmount(n), getLocale());
}

/** "vandaag", "morgen", "over 3 dagen", "2 dagen over datum", or the date itself further out. */
export function whenText(days, day) {
  if (days < 0) return t("pantry.past", { n: -days });
  if (days === 0) return t("pantry.today");
  if (days === 1) return t("pantry.tomorrow");
  if (days <= 6) return t("pantry.in_days", { n: days });
  return new Date(`${day}T12:00:00`).toLocaleDateString(getLocale() === "nl" ? "nl-NL" : "en-GB", { day: "numeric", month: "short" });
}

const refused = (err) => toast(err instanceof OpError ? t(`errors.${err.code}`) : t("errors.refused"), { error: true });

/** "Op" or "weggegooid": all of the row, with an undo. */
async function useUp(row, reason) {
  const eventId = newId();
  try {
    await store.dispatch({ type: "pantry.use", reason, on: localToday(), takes: [{ event_id: eventId, pantry_id: row.id, amount: null }] });
    toast(t(reason === "thrown" ? "pantry.thrown_done" : "pantry.used_done", { title: row.title }), {
      action: t("pantry.undo"), ms: 7000,
      onAction: () => store.dispatch({ type: "pantry.unuse", event_ids: [eventId] }).catch(refused),
    });
  } catch (err) {
    refused(err);
  }
}

// ------------------------------------------------ shelf life per item

/** "houdt dicht ~7 dagen, open ~3 dagen · geschat", or "nog onbekend". */
export function shelfText(item) {
  const days = itemShelfDays(item);
  const opened = itemOpenedDays(item);
  if (days === null && opened === null) return t("shelf.unknown");
  const what = [days === null ? null : days === KEEPS ? t("shelf.keeps") : t("shelf.closed", { n: days }),
    opened === null ? null : t("shelf.open", { n: opened })].filter(Boolean).join(", ");
  const by = item.shelf_source === "claude" ? t("shelf.by_claude") : item.shelf_source === "person" ? t("shelf.by_person") : null;
  return [what, by].filter(Boolean).join(" · ");
}

/**
 * The product screen's lines: the product's own shelf life and, when it
 * differs, what its item says ("Dit product: houdt dicht ~90 dagen · geschat",
 * "Alle Melk: houdt dicht ~7 dagen").
 */
export function productShelfLines(product, item) {
  const own = t("shelf.this_product", { text: shelfText(product) });
  if (!item) return [own];
  const same = itemShelfDays(product) === itemShelfDays(item) && itemOpenedDays(product) === itemOpenedDays(item);
  return same ? [own] : [own, t("shelf.item_rule", { item: item.name, text: shelfText(item) })];
}

/**
 * The shelf-life fields of an item, or of a product (`item` then names the
 * product's item), for a sheet: days closed (or "keeps"), days once opened.
 * op() is the item.shelf or product.shelf op as a person's, or null when
 * nothing was changed (so opening a sheet never turns Claude's value into a
 * person's).
 */
export function shelfInputs(target, { product = false, item = null } = {}) {
  const days = itemShelfDays(target);
  const opened = itemOpenedDays(target);
  const num = (v) => h("input", { type: "number", min: "1", max: String(SHELF_DAYS_MAX), step: "1", inputmode: "numeric", value: v === null ? "" : String(v) });
  const closed = num(days === KEEPS ? null : days);
  const open = num(opened);
  const keeps = h("input", { type: "checkbox", checked: days === KEEPS });
  const sync = () => { closed.disabled = keeps.checked; };
  keeps.addEventListener("change", sync);
  sync();
  const read = (input) => {
    const n = Math.round(Number(input.value));
    return input.value === "" || !Number.isFinite(n) || n < 1 ? null : Math.min(n, SHELF_DAYS_MAX);
  };
  const node = h("div", { class: "shelf-fields" },
    h("p", { class: "hint" }, product
      ? t("shelf.hint_product", { item: item?.name ?? "" })
      : t("shelf.hint", { name: target.name })),
    h("label", { class: "field" }, h("span", { class: "mono" }, t("shelf.closed_field")), closed),
    h("label", { class: "rule-check" }, keeps, h("span", {}, t("shelf.keeps_label"))),
    h("label", { class: "field" }, h("span", { class: "mono" }, t("shelf.open_field")), open));
  const op = () => {
    const nextDays = keeps.checked ? KEEPS : read(closed);
    const nextOpened = read(open);
    if (nextDays === days && nextOpened === opened) return null;
    return product
      ? { type: "product.shelf", product_id: target.id, shelf_days: nextDays, opened_days: nextOpened, source: "person" }
      : { type: "item.shelf", item_id: target.id, shelf_days: nextDays, opened_days: nextOpened, source: "person" };
  };
  return { node, op };
}

/** "Houdbaarheid aanpassen" on the product screen: the product's own values (`opts` as shelfInputs). */
export async function shelfSheet(target, opts = {}) {
  const item = target;
  const fields = shelfInputs(target, opts);
  const result = await sheet((close) => h("form", { onsubmit: (ev) => { ev.preventDefault(); close("save"); } },
    h("h2", {}, t("shelf.title")),
    fields.node,
    h("div", { class: "actions" },
      h("button", { type: "submit", class: "btn primary grow" }, t("common.save")),
      h("button", { type: "button", class: "btn", onclick: () => close(undefined) }, t("common.cancel")))));
  const op = result === "save" ? fields.op() : null;
  if (!op) return;
  try {
    await store.dispatch(op);
    toast(t("shelf.saved", { name: item.name }));
  } catch (err) {
    refused(err);
  }
}

// ------------------------------------------------- used at a steady rate

const near = (x) => Math.abs(x - Math.round(x)) < 0.02 && Math.round(x) >= 1;
const fmt = (n) => formatQty(Math.round(n * 100) / 100, getLocale());

/** A rate per day as it is read and typed: { n, unit } with unit day / week / month / every. */
export function rateParts(perDay) {
  if (!(perDay > 0)) return null;
  if (perDay >= 1 && near(perDay)) return { n: Math.round(perDay), unit: "day" };
  if (near(perDay * 7)) return { n: Math.round(perDay * 7), unit: "week" };
  if (near(perDay * 30)) return { n: Math.round(perDay * 30), unit: "month" };
  // "1 per N dagen" only from every other day: a learned 0,83 a day is "5,8 per week", not "1 per dag".
  if (perDay <= 0.5) return { n: Math.round(1 / perDay), unit: "every" };
  return { n: Math.round(perDay * 7 * 10) / 10, unit: "week" };
}

/** "6 per week", "1 per 30 dagen", "2 per dag". */
export function rateText(perDay) {
  const p = rateParts(perDay);
  if (!p) return t("rate.none");
  if (p.unit === "every") return t("rate.every", { n: p.n });
  return t(`rate.per_${p.unit}`, { n: fmt(p.n) });
}

/** "~5 dagen", "~5 weken", "~2 maanden": how long a supply lasts. */
export function supplyText(days) {
  const d = Math.max(0, Math.floor(days));
  if (d >= 60) return t("rate.supply_months", { n: Math.round(d / 30) });
  if (d >= 14) return t("rate.supply_weeks", { n: Math.round(d / 7) });
  return t("rate.supply_days", { n: d });
}

const shortDate = (day) => new Date(`${day}T12:00:00`).toLocaleDateString(getLocale() === "nl" ? "nl-NL" : "en-GB", { day: "numeric", month: "short" });

/**
 * Where a rate comes from, short: "geleerd uit 6 keer", "jouw instelling",
 * "schatting" (Claude), "standaard" (usage-rates.js). A learned rate counts
 * the signals it rests on (items.rate_samples, public/shared/rate-learning.js).
 */
export function rateByText(source, item) {
  if (source === "learned") return t("rate.by_learned", { n: Math.max(1, Number(item?.rate_samples) || 0) });
  return source === "rule" ? t("rate.by_rule") : source === "claude" ? t("rate.by_claude") : t("rate.by_person");
}

/** "6 per week · jouw instelling", "1 per 42 dagen · standaard", "1 per 9 dagen · geleerd uit 3 keer", or "telt niet af". */
export function rateLabel(item, row = null) {
  const rate = rowRate(row ?? { title: item.name, pack_size: "" }, item);
  if (!rate) return t("rate.none");
  return `${rateText(rate.per_day)} · ${rateByText(rate.source, item)}`;
}

const UNITS = ["day", "week", "month", "every"];
const toPerDay = (n, unit) => (unit === "day" ? n : unit === "week" ? n / 7 : unit === "month" ? n / 30 : 1 / n);

/**
 * The usage fields of an item for a sheet: "Verbruik: [N] [per dag | per
 * week | per maand | 1 per … dagen]", "niet aftellen", and a live sentence
 * ("Nu 33, 6 per week: genoeg tot ~5 dec (~5 weken)."). op() is the
 * item.rate op as a person's, null when nothing changed, false when the
 * number is no number. Empty is back to the default (usage-rates.js).
 */
export function rateInputs(item) {
  const own = item.use_per_day ?? null;
  const parts = rateParts(own);
  const n = h("input", { type: "number", min: "0", step: "any", inputmode: "decimal", value: parts ? String(parts.n) : "" });
  const unit = h("select", { "aria-label": t("rate.field") },
    UNITS.map((u) => h("option", { value: u, selected: (parts?.unit ?? "week") === u }, t(`rate.unit_${u}`))));
  const off = h("input", { type: "checkbox", checked: own === 0 });
  const preview = h("p", { class: "hint now rate-preview", "aria-live": "polite" });
  const rule = rowRate({ title: item.name, pack_size: "" }, { ...item, use_per_day: null });
  const read = () => {
    if (off.checked) return 0;
    if (n.value.trim() === "") return null;
    const x = Number(n.value.replace(",", "."));
    if (!Number.isFinite(x) || x <= 0) return undefined;
    return Math.min(RATE_MAX, toPerDay(x, unit.value));
  };
  const update = () => {
    n.disabled = off.checked;
    unit.disabled = off.checked;
    const perDay = read();
    const view = store.getView();
    const today = localToday();
    const trial = { ...item, use_per_day: perDay === undefined ? own : perDay };
    const rows = liveRows(withUsage({ ...view, items: { ...view.items, [item.id]: trial } }, today).pantry)
      .filter((r) => r.item_id === item.id);
    const left = rows.reduce((sum, r) => sum + r.amount, 0);
    const days = supplyDays(rows);
    const effective = perDay === null ? rule?.per_day ?? null : perDay;
    if (perDay === undefined) preview.textContent = t("rate.bad");
    else if (!(effective > 0)) preview.textContent = t("rate.preview_none", { name: item.name });
    else if (!(left > 0) || days === null) preview.textContent = t("rate.preview_empty", { rate: rateText(effective) });
    else {
      preview.textContent = t("rate.preview", { left: packsText(left), rate: rateText(effective),
        date: shortDate(addDays(today, Math.floor(days))), supply: supplyText(days) });
    }
  };
  n.addEventListener("input", update);
  unit.addEventListener("change", update);
  off.addEventListener("change", update);
  update();
  const node = h("div", { class: "rate-fields" },
    h("p", { class: "hint" }, t("rate.hint", { name: item.name })),
    h("p", { class: "hint" }, rule ? t("rate.default_is", { rate: rateText(rule.per_day) }) : t("rate.default_none")),
    h("div", { class: "field" }, h("span", { class: "mono" }, t("rate.field")), h("div", { class: "rate-row" }, n, unit)),
    h("label", { class: "rule-check" }, off, h("span", {}, t("rate.off_label"))),
    preview);
  // What the fields said when the sheet opened: untouched, nothing changes. A
  // learned 0,8387 a day reads "5,9 per week"; saving the date sheet must not
  // turn it into a person's 5,9 and restart the learning.
  const shown = [n.value, unit.value, off.checked];
  const op = () => {
    if (n.value === shown[0] && unit.value === shown[1] && off.checked === shown[2]) return null;
    const perDay = read();
    if (perDay === undefined) return false;
    const next = perDay;
    if (next === own || (next > 0 && own > 0 && Math.abs(next - own) < 1e-9)) return null;
    return { type: "item.rate", item_id: item.id, use_per_day: next, source: "person", on: localToday() };
  };
  return { node, op };
}

/** "Verbruik aanpassen" on the product screen. */
export async function rateSheet(item) {
  const fields = rateInputs(item);
  const result = await sheet((close) => h("form", { onsubmit: (ev) => { ev.preventDefault(); close("save"); } },
    h("h2", {}, t("rate.title")),
    fields.node,
    h("div", { class: "actions" },
      h("button", { type: "submit", class: "btn primary grow" }, t("common.save")),
      h("button", { type: "button", class: "btn", onclick: () => close(undefined) }, t("common.cancel")))));
  if (result !== "save") return;
  const op = fields.op();
  if (op === false) {
    toast(t("rate.bad"), { error: true });
    return;
  }
  if (!op) return;
  try {
    await store.dispatch(op);
    toast(t("rate.saved", { name: item.name }));
  } catch (err) {
    refused(err);
  }
}

/** The date sheet: the real use-by date, the amount, the item's shelf life, or remove a mistake. */
async function editRow(row) {
  const item = store.getView().items?.[row.item_id] ?? null;
  // A row with a product follows the product's shelf life: that is what is edited here.
  const product = row.product_id ? store.getView().products?.[row.product_id] ?? null : null;
  const shelfOf = product ?? item;
  const shelf = shelfOf ? shelfInputs(shelfOf, product ? { product: true, item } : {}) : null;
  const rate = item ? rateInputs(item) : null;
  const day = h("input", { type: "date", value: row.use_by ?? "" });
  const amount = h("input", { type: "number", min: "0", max: "1000", step: "0.25", inputmode: "decimal", value: String(displayAmount(row.amount)) });
  const result = await sheet((close) => h("form", { onsubmit: (ev) => { ev.preventDefault(); close("save"); } },
    h("h2", {}, row.title),
    h("label", { class: "field" }, h("span", { class: "mono" }, t("pantry.use_by")), day),
    h("p", { class: "hint" }, row.use_by_source === "estimate" && row.use_by ? t("pantry.estimate_hint") : t("pantry.no_date_hint")),
    h("label", { class: "field" }, h("span", { class: "mono" }, t("pantry.amount")), amount),
    shelf ? h("h3", { class: "mono sub" }, `${t("shelf.title")} · ${product ? productShelfLines(product, item).join(" · ") : shelfText(shelfOf)}`) : null,
    shelf ? shelf.node : null,
    rate ? h("h3", { class: "mono sub" }, `${t("rate.title")} · ${rateLabel(item, row)}`) : null,
    rate ? rate.node : null,
    h("div", { class: "actions" },
      h("button", { type: "submit", class: "btn primary grow" }, t("common.save")),
      h("button", { type: "button", class: "btn", onclick: () => close("remove") }, t("pantry.remove")))));
  try {
    if (result === "remove") await store.dispatch({ type: "pantry.remove", id: row.id });
    if (result === "save") {
      const op = { type: "pantry.update", id: row.id, on: localToday() };
      const typed = day.value || null;
      if (typed !== (row.use_by ?? null) || (typed && row.use_by_source === "estimate")) op.use_by = typed;
      const n = Number(amount.value);
      if (amount.value !== "" && Number.isFinite(n) && n !== displayAmount(row.amount)) op.amount = Math.max(0, n);
      // Typed down to nothing: that is "op", with an event, so "Bijna op" hears it ran out.
      // The item's shelf life first: the row's estimate follows it.
      const shelfOp = shelf?.op();
      if (shelfOp) await store.dispatch(shelfOp);
      // The rate first: a corrected amount then starts the new countdown.
      const rateOp = rate?.op();
      if (rateOp === false) toast(t("rate.bad"), { error: true });
      else if (rateOp) await store.dispatch(rateOp);
      if (op.amount === 0) {
        delete op.amount;
        if (Object.keys(op).length > 3) await store.dispatch(op);
        await useUp(row, "used");
      } else if (Object.keys(op).length > 3) await store.dispatch(op);
    }
  } catch (err) {
    refused(err);
  }
}

/** "tot vandaag", "tot morgen", "tot do 30 okt", or "2 dagen over datum". */
function untilText(days, day) {
  if (days < 0) return t("pantry.past", { n: -days });
  const when = days === 0 ? t("pantry.today") : days === 1 ? t("pantry.tomorrow")
    : new Date(`${day}T12:00:00`).toLocaleDateString(getLocale() === "nl" ? "nl-NL" : "en-GB", { weekday: "short", day: "numeric", month: "short" });
  return t("pantry.until", { when });
}

// ------------------------------------------------------------- "Bijna op"

/** "100 g", "3 st" or "¼": what is left, in grams when the pack size says so. */
function leftText(left) {
  return amountText(leftAmount(left));
}

/** leftAmount() as it reads: "100 g", "3 st", "½". The widget's twin is SoonText.kt. */
function amountText({ qty, base }) {
  const n = formatQty(qty, getLocale());
  if (base === "g" || base === "ml") return `${n} ${base}`;
  if (base === "piece") return `${n} ${t("low.pieces")}`;
  return n;
}

/** "nog 100 g · te weinig voor Nasi", "vandaag op", "nog ¼ · onder 300 g". */
export function lowReasonText(low, today) {
  if (low.code === "empty") {
    const ago = daysBetween(low.on, today);
    return ago <= 0 ? t("low.empty_today") : t("low.empty_ago", { n: ago });
  }
  const why = low.code === "recipe" ? t("low.recipe", { recipe: low.recipe.title })
    : low.low_at ? t("low.below", { low_at: low.low_at }) : t("low.below_default");
  // Counted down: "nog 5 · ~6 dagen".
  if (low.code === "below" && !low.low_at && low.days_left !== null && low.days_left !== undefined) {
    return `${t("low.left", { left: leftText(low.left) })} · ${supplyText(low.days_left)}`;
  }
  // Under a quarter counted in packs: "nog ¼ · minder dan ¼ pak" says nothing twice.
  if (low.code === "below" && !low.low_at && low.left.base === null) return why;
  return `${t("low.left", { left: leftText(low.left) })} · ${why}`;
}

// "Niet nu": per device, for the rest of the day (localStorage, in try/catch:
// a private window or blocked storage just shows everything).
const SNOOZE_KEY = "kitchen.lowSnooze";
function snoozed() {
  try {
    return JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}
function snooze(key, today) {
  try {
    const all = Object.fromEntries(Object.entries(snoozed()).filter(([, day]) => day === today));
    all[key] = today;
    localStorage.setItem(SNOOZE_KEY, JSON.stringify(all));
  } catch {
    // Storage blocked: nothing to remember it in.
  }
}

/** One tap: the item on the list, with its pack size when that is a weight ("1 kg"). */
async function lowToList(low) {
  const pack = packSize(low.pack_size);
  const amounts = pack && pack.base !== "piece" ? parseAmount(low.pack_size) : [];
  try {
    await store.dispatch({ type: "entry.add", id: newId(), item_id: newId(), title: low.title, ...(amounts.length ? { amounts } : {}) });
    toast(t("low.added", { title: low.title }));
  } catch (err) {
    refused(err);
  }
}

const STRIP_ROWS = 4;
let stripOpen = false;

/**
 * "Bijna op (N)" above the list: per thing why, "op de lijst" and "niet nu".
 * Null when nothing is low (or everything low was put off for today).
 */
export function lowStrip(view, today, rerender) {
  const off = snoozed();
  const lows = lowStock(view, today).filter((l) => off[l.key] !== today);
  if (!lows.length) return null;
  const shown = stripOpen ? lows : lows.slice(0, STRIP_ROWS);
  const line = (l) => h("li", { class: "low-row" },
    h("span", { class: "low-name" }, shownName(view, l.name)),
    h("span", { class: "low-why mono" }, lowReasonText(l, today)),
    h("span", { class: "low-acts" },
      h("button", { type: "button", class: "btn ghost mono low-add", onclick: () => lowToList(l) }, t("low.add")),
      h("button", { type: "button", class: "btn ghost mono low-later", onclick: () => { snooze(l.key, today); rerender(); } }, t("low.snooze"))));
  return h("section", { class: "low-strip", "aria-label": t("low.title") },
    h("h2", { class: "low-label mono" }, t("low.count", { n: lows.length })),
    h("ul", {}, shown.map(line)),
    lows.length > STRIP_ROWS
      ? h("button", { type: "button", class: "btn ghost mono low-more", onclick: () => { stripOpen = !stripOpen; rerender(); } },
        stripOpen ? t("low.less") : t("low.more", { n: lows.length - STRIP_ROWS }))
      : null);
}

// ------------------------------------------------------------- "Al nodig?"

/** "nog 5 · ~6 dagen", "nog ½", "gisteren op": what is left of a needed-soon thing. */
export function soonText(n, today) {
  if (n.code === "empty") {
    const ago = daysBetween(n.on, today);
    return ago <= 0 ? t("low.empty_today") : t("low.empty_ago", { n: ago });
  }
  const left = t("low.left", { left: amountText(n.amount) });
  return n.days_left !== null && n.days_left !== undefined ? `${left} · ${supplyText(n.days_left)}` : left;
}

/**
 * "Nog niet": a counted-down thing gets NOT_YET_DAYS of use more left, a low
 * thing without a rate stays out of "Al nodig?" that long (notYetOp).
 */
async function notYet(n) {
  const today = localToday();
  const op = notYetOp(store.getView(), today, n, newId);
  try {
    await store.dispatch(op);
    toast(t(op.type === "item.not_yet" ? "soon.back_in" : "soon.more_left", { name: shownName(store.getView(), n.name), n: NOT_YET_DAYS }));
  } catch (err) {
    refused(err);
  }
}

// Keys ticked on this screen whose ops are on their way: a second tap adds nothing.
const ticking = new Set();

/**
 * The row's tick box: one tap puts it in the basket, as if it had been on the
 * list and was ticked (tickOps: entry.add + entry.check of one new line).
 */
async function tickSoon(n) {
  if (ticking.has(n.key)) return;
  ticking.add(n.key);
  try {
    for (const op of tickOps(n, newId(), newId())) await store.dispatch(op);
  } catch (err) {
    refused(err);
  } finally {
    ticking.delete(n.key);
  }
}

/**
 * "Al nodig?" under the list (public/shared/needed-soon.js): what may as well
 * come along, each with what is left. Like a list line, only the box on the
 * left ticks (into the basket); "Nog niet" says there is more than the app
 * thinks. Null when nothing runs out soon.
 */
export function soonSection(view, today) {
  const soon = neededSoon(view, today);
  if (!soon.length) return null;
  return h("section", { class: "store-group soon", "aria-label": t("soon.title") },
    h("h3", { class: "sub mono" }, t("soon.title"), h("span", { class: "n" }, `· ${soon.length}`)),
    h("p", { class: "soon-hint" }, t("soon.hint")),
    h("ul", { class: "entries" }, soon.map((n) => h("li", { class: "entry line soon-line" },
      h("button", {
        type: "button", class: "tick", role: "checkbox", "aria-checked": "false",
        "aria-label": t("list.tick", { title: shownName(view, n.name) }), onclick: () => tickSoon(n),
      }, h("span", { class: "box" }, svg(CHECK_SVG))),
      h("div", { class: "line-main" },
        h("span", { class: "ttl" }, shownName(view, n.name)),
        h("button", { type: "button", class: "btn ghost mono soon-not-yet", onclick: () => notYet(n) }, t("soon.not_yet")),
        h("span", { class: "short mono" }, soonText(n, today)))))));
}

/** The sentence under the "waarschuw onder" box, live while typing. */
function lowPreview(name, typed, off, left) {
  if (off) return t("low.preview_off", { name });
  if (!typed) return t("low.preview_default", { name });
  const threshold = parseLowAt(typed);
  if (!threshold) return t("low.preview_bad");
  const under = underThreshold(left, threshold);
  if (under === null) return t("low.preview_unsure", { name, low_at: typed });
  const now = t("low.preview_now", { left: leftText(left) });
  return `${t("low.preview_set", { name, low_at: typed })} ${now}${under ? ` ${t("low.preview_low_now")}` : ""}`;
}

/** "Waarschuw onder…": the item's threshold, or never. */
async function lowSheet(r) {
  const view = store.getView();
  const item = view.items[r.item_id];
  if (!item) return;
  const name = item.name;
  const { left } = stockOf(withUsage(view, localToday()), stockKey(r, view.items));
  const input = h("input", { value: item.low_at ?? "", maxlength: String(LOW_AT_MAX), placeholder: t("low.placeholder"), autocomplete: "off", enterkeyhint: "done" });
  const off = h("input", { type: "checkbox", checked: Boolean(item.low_off) });
  const preview = h("p", { class: "hint now low-preview", "aria-live": "polite" });
  const update = () => {
    input.disabled = off.checked;
    preview.textContent = lowPreview(name, input.value.trim(), off.checked, left);
  };
  input.addEventListener("input", update);
  off.addEventListener("change", update);
  update();
  const result = await sheet((close) => h("form", { onsubmit: (ev) => { ev.preventDefault(); close("save"); } },
    h("h2", {}, t("low.sheet_title", { name })),
    h("label", { class: "field" }, h("span", { class: "mono" }, t("low.field")), input),
    h("label", { class: "low-off" }, off, h("span", {}, t("low.off_label"))),
    preview,
    h("div", { class: "actions" },
      h("button", { type: "submit", class: "btn primary grow" }, t("common.save")),
      h("button", { type: "button", class: "btn", onclick: () => close(undefined) }, t("common.cancel")))));
  if (result !== "save") return;
  const typed = input.value.trim() || null;
  if (typed && !off.checked && !parseLowAt(typed)) {
    toast(t("low.preview_bad"), { error: true });
    return;
  }
  const op = { type: "item.low", item_id: item.id };
  if (!off.checked && typed !== (item.low_at ?? null)) op.low_at = typed;
  if (off.checked !== Boolean(item.low_off)) op.low_off = off.checked;
  if (Object.keys(op).length > 2) await store.dispatch(op).catch(refused);
}

/** The row's small "waarschuw onder…" button, saying the setting when there is one. */
function lowSetButton(r, view) {
  const item = view.items?.[r.item_id];
  const label = item?.low_off ? t("low.set_off") : item?.low_at ? t("low.set_at", { low_at: item.low_at }) : t("low.set");
  return h("button", { type: "button", class: "btn ghost mono low-set", onclick: () => lowSheet(r) }, label);
}

function row(r, today, waste, view, lows) {
  const days = daysLeft(r, today);
  const date = r.use_by
    ? `${untilText(days, r.use_by)}${r.use_by_source === "estimate" ? ` · ${t("pantry.estimated")}` : ""}`
    : t("pantry.no_date");
  const thrown = waste[r.item_id]?.count ?? 0;
  // Counted down (withUsage): "6 per week (geleerd uit 3 keer) · nog ~5 weken" in place of a date it does not need.
  const usage = r.per_day > 0
    ? `${rateText(r.per_day)} (${rateByText(r.rate_source, view.items?.[r.item_id])}) · ${t("rate.left", { supply: supplyText(r.days_left ?? 0) })}`
    : null;
  const meta = [usage && !r.use_by ? usage : date, usage && r.use_by ? usage : null, r.pack_size ? t("pantry.pack_of", { size: r.pack_size }) : null,
    thrown >= 2 ? t("pantry.thrown_before", { n: thrown }) : null].filter(Boolean).join(" · ");
  const late = days !== null && days <= 0;
  const low = lows.get(stockKey(r, view.items));
  return h("li", { class: `entry stock${late ? " late" : days !== null && days <= 2 ? " soon" : ""}${low ? " low" : ""}` },
    h("span", { class: "box amt-box mono", "aria-label": t("pantry.amount") }, packsText(r.amount)),
    h("span", { class: "ttl" }, shownName(view, r.title)),
    h("span", { class: "amt" }),
    h("span", { class: "meta" }, meta),
    low ? h("span", { class: "low-mark mono" }, `${t("low.title")} · ${lowReasonText(low, today)}${low.listed ? ` · ${t("low.on_list")}` : ""}`) : null,
    h("span", { class: "stock-acts" },
      h("button", { type: "button", class: "btn ghost mono", onclick: () => useUp(r, "used") }, t("pantry.used")),
      h("button", { type: "button", class: "btn ghost mono", onclick: () => useUp(r, "thrown") }, t("pantry.thrown")),
      h("button", { type: "button", class: "btn ghost mono", onclick: () => editRow(r) }, t("pantry.date")),
      lowSetButton(r, view)));
}

/**
 * The strip at the top of the list when something must be eaten soon: the
 * first few by name and when, linking to the pantry tab. Null when nothing is due.
 */
export function useUpStrip(view, today) {
  const { due } = pantryGroups(withUsage(view, today).pantry, today);
  if (!due.length) return null;
  const names = due.slice(0, 3).map((r) => `${r.title} (${whenText(daysLeft(r, today), r.use_by)})`).join(", ");
  return h("a", { class: "use-up", href: "#/pantry" },
    h("span", { class: "use-up-label mono" }, t("pantry.due_title")),
    h("span", { class: "use-up-names" }, names, due.length > 3 ? ` ${t("pantry.more", { n: due.length - 3 })}` : ""),
    h("span", { class: "use-up-go mono", "aria-hidden": "true" }, "→"));
}

export function mountPantry(root) {
  const eyebrow = h("div", { class: "eyebrow mono" });
  const body = h("div", {});
  const input = h("input", {
    placeholder: t("pantry.add_placeholder"), "aria-label": t("pantry.add_placeholder"),
    autocomplete: "off", enterkeyhint: "done", maxlength: "120",
  });
  const add = async (ev) => {
    ev.preventDefault();
    const parsed = parseListInput(input.value);
    if (!parsed.title) return;
    const { amount, pack_size } = fromEntry(parsed);
    try {
      await store.dispatch({ type: "pantry.add", id: newId(), item_id: newId(), title: parsed.title, amount, pack_size, on: localToday() });
      input.value = "";
    } catch (err) {
      refused(err);
    }
  };
  root.append(
    h("section", { class: "hero wrap" }, eyebrow, title(t("pantry.title"))),
    groceryTabs("pantry"),
    h("div", { class: "wrap" },
      h("form", { class: "add", onsubmit: add }, input, h("button", { type: "submit", class: "btn primary", "aria-label": t("pantry.add") }, "+")),
      body),
  );
  return store.subscribe((stored, status) => {
    const today = localToday();
    // What is left today: counted-down rows (the cat's pouches) at their live amount.
    const view = withUsage(stored, today);
    const { due, rest } = pantryGroups(view.pantry, today);
    const waste = wasteCounts(view.pantry_events);
    const lows = lowByKey(view, today);
    const line = (r) => row(r, today, waste, view, lows);
    fill(eyebrow,
      h("span", {}, h("b", {}, t("pantry.count", { n: due.length + rest.length }))),
      due.length ? h("span", {}, t("pantry.due_count", { n: due.length })) : null,
      syncLine(status));
    fill(body,
      due.length + rest.length ? null : h("p", { class: "empty" }, t("pantry.empty")),
      due.length ? h("div", { class: "section-head" }, h("h2", {}, t("pantry.due_title"))) : null,
      due.length ? h("ul", { class: "entries" }, due.map(line)) : null,
      due.length && rest.length ? h("div", { class: "section-head" }, h("h2", {}, t("pantry.rest_title"))) : null,
      rest.length ? h("ul", { class: "entries" }, rest.map(line)) : null);
  });
}
