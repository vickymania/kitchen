// The "Deals" tab of groceries (28-10-2026): every current offer that
// meets one of his deal rules, the ones he is probably low on first
// ("aanbevolen"), one tap to put it on the list (no note: the line shows its
// offers live, public/shared/deals.js liveLineOffers). Also the "Deal-regel" sheet, opened from a list line's edit sheet and
// the product screen. Rules: public/shared/deals.js and deal-math.js.
import { h, title, toast, sheet, newId, fill } from "./dom.js";
import { t, getLocale } from "./i18n.js";
import { OpError } from "../shared/ops.js";
import { localToday } from "../shared/intervals.js";
import { dealsFor, liveRules, ruleFor, REGULAR_STORES } from "../shared/deals.js";
import { canonicalName } from "../shared/item-names.js";
import { isCoupon } from "../shared/offers.js";
import { resolveProduct } from "../shared/preferences.js";
import * as store from "./store.js";
import { syncLine } from "./status.js";
import { groceryTabs } from "./groceries.js";
import { productLabel, money } from "./product.js";
import { packsText, whenText } from "./pantry.js";

const refused = (err) => toast(err instanceof OpError ? t(`errors.${err.code}`) : t("errors.refused"), { error: true });

const dayText = (day) => new Date(`${day}T12:00:00`).toLocaleDateString(getLocale() === "nl" ? "nl-NL" : "en-GB", { day: "numeric", month: "short" });

/** "felix, sheba of whiskas" */
const wordList = (words, joiner) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} ${t(joiner)} ${words.at(-1)}` : words[0] ?? "");

/** "check of het amandelmelk is": a hit whose kind the folder does not name. */
export const checkText = (missing) => t("deals.check", { words: wordList(missing, "rule.and") });

/** "Alleen als het €1,25 of minder per stuk kost · alleen in de aanbieding · alleen bij AH en Dirk" */
export function ruleSummary(rule) {
  if (!rule) return "";
  const parts = [];
  if (rule.require_words?.length) parts.push(t("rule.p_require", { words: wordList(rule.require_words, "rule.and") }));
  if (rule.max_price_cents) parts.push(t("rule.p_max", { price: money(rule.max_price_cents) }));
  if (rule.min_discount_pct) parts.push(t("rule.p_offer_min", { n: rule.min_discount_pct }));
  else if (rule.offer_only) parts.push(t("rule.p_offer"));
  if (rule.max_unit_price_cents && rule.unit) parts.push(t(`rule.p_unit_${rule.unit}`, { price: money(rule.max_unit_price_cents) }));
  parts.push(!rule.detour ? t("rule.p_regular", { stores: REGULAR_STORES.join(" & ") })
    : rule.detour_min_discount_pct ? t("rule.p_detour_min", { n: rule.detour_min_discount_pct }) : t("rule.p_detour"));
  if (rule.match_words?.length) parts.push(t("rule.p_match", { words: wordList(rule.match_words, "rule.or") }));
  if (rule.exclude_words?.length) parts.push(t("rule.p_exclude", { words: wordList(rule.exclude_words, "rule.or") }));
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A rule with what it is for: "alleen Edet …: Alleen als het …" or just the summary for any product. */
export function ruleLine(view, rule) {
  const product = rule.product_id ? view.products?.[rule.product_id] : null;
  return product ? `${t("rule.only_product", { product: shortLabel(product) })}: ${ruleSummary(rule)}` : ruleSummary(rule);
}

/** "1,25" or "1.25" or "€ 1,25" → 125; empty → null; nonsense → NaN. */
function euroCents(text) {
  const s = String(text ?? "").replace(/[€\s]/g, "").replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : NaN;
}

/** "Edet Amandelmelk vochtig toiletpapier · 42 stuks": the brand once, also when the name starts with it. */
const shortLabel = (p) => productLabel(p.brand && p.name.toLowerCase().startsWith(p.brand.toLowerCase()) ? { ...p, brand: "" } : p);

/** "Felix, sheba ,, whiskas" → ["felix", "sheba", "whiskas"] (the op makes them nameKeys); none → null. */
const wordsOf = (text) => {
  const list = [...new Set(String(text ?? "").split(",").map((w) => w.trim().toLowerCase()).filter(Boolean))];
  return list.length ? list : null;
};

const euroText = (cents) => (cents ? (cents / 100).toFixed(2).replace(".", getLocale() === "nl" ? "," : ".") : "");

/**
 * The deal rule of an item, or of one product of it. product: the product to
 * offer as "alleen dit product" (the product screen's, or the line's
 * preferred one); the rule for "any product" is always there.
 */
export async function dealRuleSheet(item, product = null, { productFirst = Boolean(product) } = {}) {
  const view = store.getView();
  const scopePick = h("select", {},
    h("option", { value: "" }, t("rule.any_product", { item: item.name })),
    product ? h("option", { value: product.id }, t("rule.only_product", { product: shortLabel(product) })) : null);
  scopePick.value = productFirst && product ? product.id : "";

  const box = (label) => {
    const input = h("input", { type: "checkbox" });
    return { input, row: h("label", { class: "rule-check" }, input, h("span", {}, label)) };
  };
  const max = box(t("rule.max_price"));
  const maxIn = h("input", { inputmode: "decimal", maxlength: "8", placeholder: "1,25", "aria-label": t("rule.max_price") });
  const offer = box(t("rule.offer_only"));
  const minIn = h("input", { type: "number", min: "1", max: "95", step: "1", inputmode: "numeric", placeholder: "20", "aria-label": t("rule.min_discount") });
  const unit = box(t("rule.max_unit"));
  const unitIn = h("input", { inputmode: "decimal", maxlength: "8", placeholder: "4,00", "aria-label": t("rule.max_unit") });
  const unitPick = h("select", { "aria-label": t("rule.max_unit") },
    ["kg", "l", "piece"].map((u) => h("option", { value: u }, t(`rule.unit_${u}`))));
  const detour = box(t("rule.detour"));
  const detourMinIn = h("input", { type: "number", min: "1", max: "95", step: "1", inputmode: "numeric", placeholder: "50", "aria-label": t("rule.detour_min") });
  const words = (label, example, hint) => {
    const input = h("input", { type: "text", maxlength: "200", autocomplete: "off", autocapitalize: "none", placeholder: example, "aria-label": label });
    return { input, row: h("label", { class: "field rule-words" }, h("span", { class: "mono" }, label), input, h("span", { class: "hint" }, hint)) };
  };
  const matchIn = words(t("rule.match_words"), "felix, sheba", t("rule.match_hint"));
  const requireIn = words(t("rule.require_words"), "amandelmelk", t("rule.require_hint"));
  const excludeIn = words(t("rule.exclude_words"), "salade, pizza", t("rule.exclude_hint"));
  const preview = h("p", { class: "hint now rule-preview" });

  const current = () => ruleFor(store.getView(), item.id, scopePick.value);
  const load = () => {
    const r = current();
    max.input.checked = Boolean(r?.max_price_cents);
    maxIn.value = euroText(r?.max_price_cents);
    offer.input.checked = Boolean(r?.offer_only);
    minIn.value = r?.min_discount_pct ? String(r.min_discount_pct) : "";
    unit.input.checked = Boolean(r?.max_unit_price_cents);
    unitIn.value = euroText(r?.max_unit_price_cents);
    unitPick.value = r?.unit ?? "kg";
    detour.input.checked = Boolean(r?.detour);
    detourMinIn.value = r?.detour_min_discount_pct ? String(r.detour_min_discount_pct) : "";
    matchIn.input.value = (r?.match_words ?? []).join(", ");
    requireIn.input.value = (r?.require_words ?? []).join(", ");
    excludeIn.input.value = (r?.exclude_words ?? []).join(", ");
  };
  // What the form says now, as the op would set it (null: not valid yet).
  const draft = () => {
    const out = {
      max_price_cents: max.input.checked ? euroCents(maxIn.value) : null,
      offer_only: offer.input.checked,
      min_discount_pct: offer.input.checked && minIn.value ? Number(minIn.value) : null,
      max_unit_price_cents: unit.input.checked ? euroCents(unitIn.value) : null,
      unit: unit.input.checked ? unitPick.value : null,
      detour: detour.input.checked,
      detour_min_discount_pct: detour.input.checked && detourMinIn.value ? Number(detourMinIn.value) : null,
      match_words: wordsOf(matchIn.input.value),
      require_words: wordsOf(requireIn.input.value),
      exclude_words: wordsOf(excludeIn.input.value),
    };
    if (Number.isNaN(out.max_price_cents) || Number.isNaN(out.max_unit_price_cents)) return null;
    const pctOk = (n) => n === null || (Number.isInteger(n) && n >= 1 && n <= 95);
    if (!pctOk(out.min_discount_pct) || !pctOk(out.detour_min_discount_pct)) return null;
    if (max.input.checked && !out.max_price_cents) return null;
    if (unit.input.checked && !out.max_unit_price_cents) return null;
    return out;
  };
  const paint = () => {
    const d = draft();
    maxIn.disabled = !max.input.checked;
    minIn.disabled = !offer.input.checked;
    unitIn.disabled = !unit.input.checked;
    unitPick.disabled = !unit.input.checked;
    detourMinIn.disabled = !detour.input.checked;
    const empty = d && !d.max_price_cents && !d.offer_only && !d.max_unit_price_cents && !d.detour && !d.match_words && !d.require_words && !d.exclude_words;
    preview.textContent = !d ? t("rule.p_incomplete") : empty ? t("rule.p_empty") : ruleSummary(d);
  };
  for (const el of [max.input, maxIn, offer.input, minIn, unit.input, unitIn, unitPick, detour.input, detourMinIn, matchIn.input, requireIn.input, excludeIn.input]) {
    el.addEventListener("input", paint);
    el.addEventListener("change", paint);
  }
  scopePick.addEventListener("change", () => { load(); paint(); });
  load();
  paint();

  const result = await sheet((close) => h("form", { class: "rule-form", onsubmit: (ev) => { ev.preventDefault(); close("save"); } },
    h("h2", {}, t("rule.title")),
    h("p", { class: "hint" }, t("rule.hint")),
    product ? h("label", { class: "field" }, h("span", { class: "mono" }, t("rule.for")), scopePick) : null,
    h("div", { class: "rule-opts" },
      max.row, h("div", { class: "rule-sub" }, h("span", { class: "mono" }, "€"), maxIn, h("span", { class: "mute" }, t("rule.per_piece"))),
      offer.row, h("div", { class: "rule-sub" }, h("span", { class: "mute" }, t("rule.min_discount")), minIn, h("span", { class: "mono" }, "%")),
      unit.row, h("div", { class: "rule-sub" }, h("span", { class: "mono" }, "€"), unitIn, unitPick),
      detour.row, h("div", { class: "rule-sub" }, h("span", { class: "mute" }, t("rule.detour_min")), detourMinIn, h("span", { class: "mono" }, "%"))),
    matchIn.row,
    requireIn.row,
    excludeIn.row,
    preview,
    h("div", { class: "actions" },
      h("button", { type: "submit", class: "btn primary grow" }, t("common.save")),
      current() ? h("button", { type: "button", class: "btn", onclick: () => close("clear") }, t("rule.clear")) : null,
      h("button", { type: "button", class: "btn", onclick: () => close() }, t("common.cancel")))));
  try {
    const productId = scopePick.value;
    if (result === "clear") {
      await store.dispatch({ type: "deal_rule.clear", item_id: item.id, product_id: productId });
      toast(t("rule.cleared"));
    }
    if (result !== "save") return;
    const d = draft();
    if (!d) return toast(t("rule.p_incomplete"), { error: true });
    if (!d.max_price_cents && !d.offer_only && !d.max_unit_price_cents && !d.detour && !d.match_words && !d.require_words && !d.exclude_words) {
      if (current()) await store.dispatch({ type: "deal_rule.clear", item_id: item.id, product_id: productId });
      return;
    }
    await store.dispatch({ type: "deal_rule.set", id: newId(), item_id: item.id, product_id: productId, ...d });
    toast(t("rule.saved"), { action: t("deals.open"), href: "#/deals" });
  } catch (err) {
    refused(err);
  }
}

/** The rule block of a list line's item or a product: its summary and the button. */
export function ruleBlock(view, item, product = null) {
  const own = product ? ruleFor(view, item.id, product.id) : null;
  const any = ruleFor(view, item.id, "");
  const lines = [
    own ? `${t("rule.only_product", { product: shortLabel(product) })}: ${ruleSummary(own)}` : null,
    any ? `${t("rule.any_product", { item: item.name })}: ${ruleSummary(any)}` : null,
  ].filter(Boolean);
  return h("div", { class: "rule-block" },
    h("div", { class: "section-head" }, h("h2", {}, t("rule.title"))),
    lines.length ? lines.map((l) => h("p", { class: "hint now" }, l)) : h("p", { class: "hint" }, t("rule.none_yet")),
    h("div", { class: "actions" },
      h("button", { type: "button", class: lines.length ? "btn" : "btn primary", onclick: () => dealRuleSheet(item, product) },
        lines.length ? t("rule.change") : t("rule.set"))));
}

/** "op: niets meer in huis", "bijna op: nog ½", "weer nodig: meestal elke 30 dagen" */
function lowText(low, today) {
  if (!low) return "";
  if (low.code === "pantry_low") return t("deals.low.pantry_low", { n: packsText(low.amount) });
  if (low.code === "pantry_use_by") return t("deals.low.pantry_use_by", { when: whenText(Math.round((Date.parse(low.use_by) - Date.parse(today)) / 86_400_000), low.use_by) });
  if (low.code === "again_due") return t("deals.low.again_due", { n: low.interval });
  if (low.code === "pantry_runs_out") return t("deals.low.pantry_runs_out", { n: Math.max(0, low.days) });
  if (low.code === "again_soon") return t("deals.low.again_soon", { n: Math.max(1, low.days) });
  return t(`deals.low.${low.code}`);
}

/** "€1,20 per stuk (bij 2) · €2,40/kg"; a single pack's price and the discount are already in the row. */
function priceText(eff) {
  const parts = [];
  if (eff.piece_cents !== null && eff.min_qty > 1) parts.push(`${t("deals.each", { price: money(Math.round(eff.piece_cents)) })} ${t("deals.buy_n", { n: eff.min_qty })}`);
  if (eff.per.kg !== null) parts.push(t("deals.per_kg", { price: money(Math.round(eff.per.kg)) }));
  if (eff.per.l !== null) parts.push(t("deals.per_l", { price: money(Math.round(eff.per.l)) }));
  if (eff.per.piece !== null && eff.per.piece !== eff.piece_cents) parts.push(t("deals.per_piece", { price: money(Math.round(eff.per.piece)) }));
  return parts.join(" · ");
}

/** "-55%" with its weight: deep (50% and more), mid (30-49%), else quiet; null when unknown. */
export function discountBadge(pct) {
  if (pct === null || pct === undefined || pct < 1) return null;
  const n = Math.round(pct);
  return h("span", { class: `disc mono ${n >= 50 ? "deep" : n >= 30 ? "mid" : "low"}`, style: `--pct:${Math.min(100, n)}%` }, `-${n}%`);
}

/** "koop je vaak" or "koop je vaak · check: jij koopt AH Houdbare volle melk": a hit without a rule. */
export const oftenText = (hit) => [t("deals.often"), hit.check ? t("deals.often_check", { what: hit.check[0] }) : null].filter(Boolean).join(" · ");

function dealRow(hit, view, today, open) {
  const o = hit.offer;
  const onList = open.has(hit.item.id) || open.has(canonicalName(hit.item.name).key);
  const name = [o.brand && !o.name.toLowerCase().includes(o.brand.toLowerCase()) ? o.brand : null, o.name].filter(Boolean).join(" ");
  const add = async () => {
    try {
      // No note: the line shows its current offers live (liveLineOffers), so an ended one never stays behind.
      await store.dispatch({ type: "entry.add", id: newId(), item_id: newId(), title: hit.item.name });
      toast(t("deals.added", { title: hit.item.name }), { action: t("add.open_list"), href: "#/" });
    } catch (err) {
      refused(err);
    }
  };
  return h("li", { class: `entry deal-hit${hit.low ? " rec" : ""}${hit.check ? " check" : ""}` },
    h("span", { class: "box plus", "aria-hidden": "true" }, hit.check ? "?" : hit.low ? "!" : "€"),
    h("span", { class: "ttl" }, hit.item.name),
    h("span", { class: "amt mono" }, hit.eff.piece_cents !== null ? money(Math.round(hit.eff.piece_cents)) : "", discountBadge(hit.eff.discount_pct)),
    hit.low ? h("span", { class: "rec-why mono" }, `${t("deals.recommended")} · ${lowText(hit.low, today)}`) : null,
    hit.often ? h("span", { class: "often-why mono" }, oftenText(hit)) : null,
    hit.check && !hit.often ? h("span", { class: "check-why mono" }, checkText(hit.check)) : null,
    h("span", { class: "deal mono" }, h("b", {}, o.store), isCoupon(o) ? h("span", { class: "deal-tag" }, ` · ${t("list.coupon")}`) : null, hit.detour ? h("span", { class: "detour-tag" }, ` · ${t("deals.detour")}`) : null, ` · ${name}${o.size ? ` · ${o.size}` : ""}${o.deal ? ` · ${o.deal}` : ""} · ${t("deals.until", { day: dayText(o.valid_until) })}`),
    h("span", { class: "meta" }, priceText(hit.eff)),
    h("span", { class: "stock-acts" },
      onList
        ? h("span", { class: "btn ghost mono on-list", "aria-disabled": "true" }, t("deals.on_list"))
        : h("button", { type: "button", class: "btn ghost mono", onclick: add }, t("deals.add")),
      h("button", { type: "button", class: "btn ghost mono", onclick: () => dealRuleSheet(hit.item, hit.rule.product_id ? view.products[hit.rule.product_id] : hit.product, { productFirst: Boolean(hit.rule.product_id) }) }, t("deals.rule"))));
}

function ruleRow(r, view) {
  const item = view.items[r.item_id];
  const product = r.product_id ? view.products?.[r.product_id] : null;
  const preferred = product ?? resolveProduct(view, { item_id: item.id, sources: [] }, null)?.product ?? null;
  return h("li", {
    class: "entry again", role: "button", tabindex: "0",
    onclick: () => dealRuleSheet(item, preferred, { productFirst: Boolean(product) }),
    onkeydown: (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); dealRuleSheet(item, preferred, { productFirst: Boolean(product) }); } },
  },
  h("span", { class: "box plus", "aria-hidden": "true" }, "⋯"),
  h("span", { class: "ttl" }, item.name),
  h("span", { class: "amt" }),
  h("span", { class: "meta" }, [product ? shortLabel(product) : null, ruleSummary(r)].filter(Boolean).join(" — ")));
}

export function mountDeals(root) {
  const eyebrow = h("div", { class: "eyebrow mono" });
  const body = h("div", {});
  root.append(
    h("section", { class: "hero wrap" }, eyebrow, title(t("deals.title"))),
    groceryTabs("deals"),
    h("div", { class: "wrap" }, h("p", { class: "hint top" }, t("deals.explain")), body),
  );
  return store.subscribe((view, status) => {
    const today = localToday();
    const rules = liveRules(view);
    const hits = dealsFor(view, today);
    // An open "Vochtig tp" line is "Vochtig toiletpapier" on the list too (item-names.js SAME).
    const open = new Set(Object.values(view.entries).filter((e) => !e.checked_at && !e.deleted_at)
      .flatMap((e) => [e.item_id, canonicalName(view.items[e.item_id]?.name ?? e.title).key]));
    const rec = hits.filter((x) => x.low).length;
    const often = hits.filter((x) => x.often).length;
    fill(eyebrow,
      h("span", {}, h("b", {}, t("deals.count", { n: hits.length }))),
      rec ? h("span", { class: "sig" }, t("deals.rec_count", { n: rec })) : null,
      often ? h("span", {}, t("deals.often_count", { n: often })) : null,
      h("span", {}, t("deals.rules_count", { n: rules.length })),
      syncLine(status));
    fill(body,
      !hits.length ? h("p", { class: "empty" }, t(rules.length ? "deals.none" : "deals.none_often")) : null,
      hits.length ? h("ul", { class: "entries" }, hits.map((x) => dealRow(x, view, today, open))) : null,
      !rules.length ? h("div", { class: "empty deals-empty" },
        h("p", {}, t("deals.empty_rules")),
        h("p", { class: "mute" }, t("deals.empty_how"))) : null,
      rules.length ? h("div", { class: "section-head" }, h("h2", {}, t("deals.rules_title")), h("span", { class: "note mono" }, String(rules.length))) : null,
      rules.length ? h("ul", { class: "entries" }, rules.map((r) => ruleRow(r, view))) : null);
  });
}
