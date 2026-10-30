// "Nachtcontrole": the report of the nightly Claude check on the home server
// (fetcher/review.mjs, op review.save, synced as reviews). A strip on the
// list when the last report (today's or yesterday's) has something for
// the household; the whole report in a sheet and in Settings. "Gezien" hides the
// strip on this device until a newer report comes. "Wat hij deed": the
// changelog of what the check changed itself (auto_changes, written by the
// worker for the reviewer device), the last AUTO_CHANGES_DAYS days newest
// first, in Settings and in a sheet from the strip when last night changed
// something.
//
// Since the first real night (30-10-2026): every changelog line has
// a real "Terugdraaien" button (change.undo, one tap; the line then says
// "Teruggedraaid"), every linked recipe line a "Klopt niet" (recipe.link_fix
// plus another name for the item), and every merge question in "Beslis jij"
// "Samenvoegen" (item.merge from this device, into the clean name) and
// "Apart houden" (item.apart: never asked again), with a pick of the names
// when there are more than two.
import { h, sheet, toast, newId } from "./dom.js";
import { t, formatDate } from "./i18n.js";
import * as store from "./store.js";
import { localToday } from "../shared/intervals.js";
import { addDays } from "../shared/shelf-life.js";
import { AUTO_CHANGES_DAYS, OpError, findItem } from "../shared/ops.js";
import { nameKey, splitPrep } from "../shared/ingredients.js";
import { itemFacts, pickTarget, apartKey, decisionSets } from "../shared/dedupe.js";
import { isExcluded } from "../shared/excluded.js";

const SEEN_KEY = "kitchen.reviewSeen";
const CHANGES_SEEN_KEY = "kitchen.changesSeen";
const CHANGE_KINDS = ["merge", "move", "alias", "rename", "recipe", "remove", "translate"];

function refused(err) {
  toast(err instanceof OpError ? t(`errors.${err.code}`) : t("errors.refused"), { error: true });
}

/** The changelog rows of the last AUTO_CHANGES_DAYS days, newest first. */
export function recentChanges(view, today = localToday()) {
  const from = addDays(today, -AUTO_CHANGES_DAYS);
  return Object.values(view.auto_changes ?? {})
    .filter((c) => !c.deleted_at && c.day >= from && CHANGE_KINDS.includes(c.what))
    .sort((a, b) => b.day.localeCompare(a.day) || String(b.created_at).localeCompare(String(a.created_at)) || a.id.localeCompare(b.id));
}

/**
 * Can this line be undone with one tap? A merge, another name, a rename and a
 * removal always; a moved product when the line knows where it came from
 * (lines from before 30-10-2026 do not); a recipe's links are fixed per line.
 */
export function canUndo(c) {
  if (c.undone_at) return false;
  if (c.what === "move") return Boolean(c.undo?.from_item_id && c.product_id);
  return ["merge", "alias", "rename", "remove", "translate"].includes(c.what);
}

/** One line: what changed. */
export function changeText(c) {
  const [linked, total] = String(c.target ?? "").split("/");
  const text = t(`review.change_${c.what}`, { name: c.name, target: c.target ?? "", linked: linked ?? "", total: total ?? "" });
  return { text: c.reason ? `${text} (${c.reason})` : text };
}

/** One recipe line of the changelog: "'bloem' → Bloem (zelfde naam)" or "'water': water uit de kraan". */
export function linkText(l) {
  return l.item_id
    ? t("review.link_to", { name: l.name, item: l.item ?? "", how: t(`link.how.${l.how}`) })
    : t("review.link_none", { name: l.name, reason: t(`link.reason.${l.reason}`) });
}

const today = () => new Date().toLocaleDateString("sv-SE");

/** "Terugdraaien": one tap, then the line says so. */
async function undoChange(c, slot) {
  try {
    await store.dispatch({ type: "change.undo", change_id: c.id, on: today() });
    slot.replaceChildren(h("small", { class: "undone mono" }, t("review.undone")));
    toast(t("review.undone_toast", { name: c.name }));
  } catch (err) {
    refused(err);
  }
}

/** The live item a typed name means on this phone, or null. */
function itemNamed(view, name) {
  const item = findItem(view, nameKey(name));
  return item && !item.deleted_at ? item : null;
}

/** "Klopt niet" on a linked recipe line: pick the right item; the recipe keeps it, and the line's name becomes another name for it. */
async function fixLinkSheet(view, recipeId, line, slot) {
  const listId = `fix-${newId()}`;
  const input = h("input", { list: listId, autocomplete: "off", maxlength: "120" });
  const go = h("button", { type: "submit", class: "btn primary grow", disabled: true }, t("common.save"));
  const names = Object.values(view.items).filter((i) => !i.deleted_at && !isExcluded(i.name)).map((i) => i.name).sort((a, b) => a.localeCompare(b, "nl"));
  input.addEventListener("input", () => { go.disabled = !itemNamed(view, input.value); });
  const result = await sheet((close) => h("form", { onsubmit: (ev) => { ev.preventDefault(); if (!go.disabled) close("go"); } },
    h("h2", {}, t("review.link_title", { name: line.name })),
    h("p", { class: "hint" }, t("review.link_hint")),
    h("label", { class: "field" }, h("span", { class: "mono" }, t("review.link_item")), input),
    h("datalist", { id: listId }, names.map((n) => h("option", { value: n }))),
    h("div", { class: "actions" }, go, h("button", { type: "button", class: "btn", onclick: () => close() }, t("common.cancel")))));
  const item = result === "go" ? itemNamed(store.getView(), input.value) : null;
  if (!item) return;
  try {
    await store.dispatch({ type: "recipe.link_fix", recipe_id: recipeId, name: line.name, item_id: item.id });
  } catch (err) {
    refused(err);
    return;
  }
  // The line's own words as another name of the item, so the list and cooking find it too.
  const plain = splitPrep(line.name).name;
  const own = itemNamed(store.getView(), plain);
  if (plain && nameKey(plain) !== item.name_key && own?.id !== item.id) {
    try {
      await store.dispatch({ type: "item.alias", id: newId(), item_id: item.id, name: plain });
    } catch {
      // Another item's own name: the recipe's fix alone is enough.
    }
  }
  slot.replaceChildren(h("small", { class: "undone mono" }, t("review.link_fixed", { name: line.name, item: item.name })));
}

/** The recipe a changelog line is about. */
function recipeOf(view, c) {
  const id = c.undo?.recipe_id;
  if (id && view.recipes?.[id]) return id;
  return Object.values(view.recipes ?? {}).find((r) => !r.deleted_at && r.title === c.name)?.id ?? null;
}

/** "Wat hij deed": the changelog as a list, the same in Settings and in the sheet. */
export function changesList(view, now = localToday()) {
  const rows = recentChanges(view, now);
  if (!rows.length) return h("p", { class: "hint" }, t("review.changes_none"));
  return h("ul", { class: "changes" }, rows.map((c) => {
    const { text } = changeText(c);
    const slot = h("div", { class: "change-acts" });
    if (c.undone_at) slot.append(h("small", { class: "undone mono" }, t("review.undone")));
    else if (canUndo(c)) slot.append(h("button", { type: "button", class: "btn small", onclick: () => undoChange(c, slot) }, t("review.undo")));
    else if (c.what === "move") slot.append(h("small", {}, t("review.undo_move")));
    const recipeId = c.what === "recipe" ? recipeOf(view, c) : null;
    return h("li", {},
      c.what === "move" && c.product_id ? h("a", { href: `#/product/${c.product_id}` }, text) : h("span", {}, text),
      h("small", { class: "mono" }, formatDate(c.day)),
      c.what === "recipe" && Array.isArray(c.lines) ? c.lines.map((l) => {
        const lineSlot = h("span", { class: "change-acts" });
        if (l.item_id && recipeId) {
          lineSlot.append(h("button", { type: "button", class: "btn small ghost", onclick: () => fixLinkSheet(view, recipeId, l, lineSlot) }, t("review.link_wrong")));
        }
        return h("div", { class: "link-row" }, h("small", { class: "link-line" }, linkText(l)), lineSlot);
      }) : null,
      slot);
  }));
}

/** Last night's changes this device has not seen yet (today's or yesterday's). */
function newChanges(view, now) {
  let seenAt = "";
  try {
    seenAt = localStorage.getItem(CHANGES_SEEN_KEY) ?? "";
  } catch {
    // Storage blocked: every recent change counts as new.
  }
  return recentChanges(view, now).filter((c) => c.day >= addDays(now, -1) && String(c.created_at) > seenAt);
}
function markChangesSeen(view, now) {
  const newest = recentChanges(view, now)[0];
  try {
    if (newest) localStorage.setItem(CHANGES_SEEN_KEY, String(newest.created_at));
  } catch {
    // Storage blocked: the line stays.
  }
}

export function changesSheet(view, onSeen = () => {}, now = localToday()) {
  return sheet((close) => [
    h("h2", {}, t("review.changes")),
    h("div", { class: "review" }, h("div", { class: "review-part" }, changesList(view, now))),
    h("div", { class: "actions" },
      h("button", { type: "button", class: "btn primary", onclick: () => { markChangesSeen(view, now); onSeen(); close(); } }, t("review.seen")),
      h("button", { type: "button", class: "btn", onclick: () => close() }, t("common.close"))),
  ]);
}

/** The newest report, or null. */
export function latestReview(view) {
  return Object.values(view.reviews ?? {}).filter((r) => !r.deleted_at)
    .sort((a, b) => b.day.localeCompare(a.day))[0] ?? null;
}

/** A question as its line of text (a merge question is { text, ids | names }). */
export const decideText = (d) => (typeof d === "string" ? d : d?.text ?? "");

const decideOf = (r) => [...(r.errors ?? []), ...(r.decide ?? []).map(decideText)];
const seenMark = (r) => `${r.id}|${r.updated_at}`;

function seen(r) {
  try {
    return localStorage.getItem(SEEN_KEY) === seenMark(r);
  } catch {
    return false;
  }
}
function markSeen(r) {
  try {
    localStorage.setItem(SEEN_KEY, seenMark(r));
  } catch {
    // Storage blocked: the strip stays until a newer report.
  }
}

/**
 * Where a merge question stands on this phone: the names it asks about with
 * their live items, and "merged" (fewer than two live items left), "apart"
 * (every pair kept apart) or "open".
 */
export function questionState(view, d) {
  if (!d || typeof d !== "object") return null;
  const asked = d.ids?.length
    ? d.ids.map((id) => ({ id, item: view.items?.[id] && !view.items[id].deleted_at ? view.items[id] : null }))
    : (d.names ?? []).map((name) => ({ id: null, item: itemNamed(view, name), name }));
  const items = [];
  for (const a of asked) if (a.item && !items.some((i) => i.id === a.item.id)) items.push(a.item);
  const { apart } = decisionSets(view.decisions);
  const pairs = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) pairs.push(apartKey(items[i].name, items[j].name));
  const status = items.length < 2 ? "merged" : pairs.every((p) => apart.has(p)) ? "apart" : "open";
  return { items, status };
}

/** "Samenvoegen": the chosen items into the clean name (the rules' own pick, else the dedupe pick); the names left out stay apart from it. */
async function mergeChosen(view, d, chosen, left) {
  const facts = itemFacts(view);
  const ids = chosen.map((i) => i.id).filter((id) => facts[id]);
  const intoId = d.into && ids.includes(d.into) ? d.into : pickTarget(ids, facts);
  const into = view.items[intoId];
  for (const item of chosen) {
    if (item.id === intoId) continue;
    await store.dispatch({ type: "item.merge", from_item_id: item.id, into_item_id: intoId, on: today() });
  }
  for (const item of left) await store.dispatch({ type: "item.apart", names: [into.name, item.name] });
  return into;
}

/** One question of "Beslis jij": its text, and for a merge question the names to pick and the two buttons. */
function decideItem(view, d) {
  const q = questionState(view, d);
  if (!q) return h("li", {}, d);
  const slot = h("div", { class: "decide-acts" });
  const li = h("li", {}, h("span", {}, d.text), slot);
  if (q.status !== "open") {
    slot.append(h("small", { class: "undone mono" }, t(q.status === "apart" ? "review.kept_apart" : "review.merged")));
    return li;
  }
  // More than two names: tick which ones are one thing.
  const boxes = q.items.length > 2
    ? q.items.map((item) => ({ item, box: h("input", { type: "checkbox", checked: true }) }))
    : q.items.map((item) => ({ item, box: { checked: true } }));
  const picked = () => boxes.filter((b) => b.box.checked).map((b) => b.item);
  const done = (key, args) => slot.replaceChildren(h("small", { class: "undone mono" }, t(key, args)));
  const merge = async () => {
    const chosen = picked();
    if (chosen.length < 2) return toast(t("review.pick_two"), { error: true });
    try {
      const into = await mergeChosen(store.getView(), d, chosen, q.items.filter((i) => !chosen.includes(i)));
      done("review.merged_into", { target: into.name });
    } catch (err) {
      refused(err);
    }
  };
  const apart = async () => {
    const chosen = picked();
    if (chosen.length < 2) return toast(t("review.pick_two"), { error: true });
    try {
      await store.dispatch({ type: "item.apart", names: chosen.map((i) => i.name) });
      done("review.kept_apart");
    } catch (err) {
      refused(err);
    }
  };
  // (DOM append writes "null" for a null child: only real elements here.)
  if (q.items.length > 2) slot.append(h("div", { class: "decide-pick" }, boxes.map(({ item, box }) => h("label", { class: "check" }, box, h("span", {}, item.name)))));
  slot.append(
    h("div", { class: "decide-buttons" },
      h("button", { type: "button", class: "btn small primary", onclick: merge }, t("review.merge_yes")),
      h("button", { type: "button", class: "btn small", onclick: apart }, t("review.merge_no"))));
  return li;
}

/** The report's lines, the same in the sheet and in Settings. */
export function reviewBody(r, view = store.getView()) {
  const block = (key, lines) => (lines.length ? h("div", { class: "review-part" },
    h("h3", { class: "low-label mono" }, t(key)),
    h("ul", {}, lines)) : null);
  return [
    block("review.errors", (r.errors ?? []).map((e) => h("li", {}, e))),
    block("review.decide", (r.decide ?? []).map((d) => decideItem(view, d))),
    block("review.fixed", (r.fixed ?? []).map((f) => h("li", {}, f.text, f.undo ? h("small", {}, f.undo) : null))),
    !decideOf(r).length && !(r.fixed ?? []).length ? h("p", { class: "hint" }, t("review.all_good")) : null,
  ];
}

export function reviewSheet(r, onSeen = () => {}) {
  return sheet((close) => [
    h("h2", {}, t("review.title", { date: formatDate(r.day) })),
    h("div", { class: "review" }, reviewBody(r)),
    h("div", { class: "actions" },
      h("button", { type: "button", class: "btn primary", onclick: () => { markSeen(r); onSeen(); close(); } }, t("review.seen")),
      h("button", { type: "button", class: "btn", onclick: () => close() }, t("common.close"))),
  ]);
}

/**
 * The strip on the list, or null: a report of today or yesterday that asks
 * something of the household, and/or a line for what the check changed itself
 * since this device last looked, with "Wat hij deed".
 */
export function reviewStrip(view, rerender, now = localToday()) {
  const r = latestReview(view);
  const lines = r && r.day >= addDays(now, -1) && !seen(r) ? decideOf(r) : [];
  const changed = newChanges(view, now);
  if (!lines.length && !changed.length) return null;
  return h("section", { class: "low-strip cook-ask review-strip", "aria-label": t("review.label") },
    h("h2", { class: "low-label mono" }, t("review.label")),
    h("ul", {},
      lines.length ? h("li", { class: "low-row" },
        h("span", { class: "low-name" }, lines[0]),
        lines.length > 1 ? h("span", { class: "low-why mono" }, t("review.more", { n: lines.length - 1 })) : null,
        h("span", { class: "low-acts cook-acts" },
          h("button", { type: "button", class: "btn ghost low-add", onclick: () => reviewSheet(r, rerender) }, t("review.open")),
          h("button", { type: "button", class: "btn ghost low-later", onclick: () => { markSeen(r); rerender(); } }, t("review.seen")))) : null,
      changed.length ? h("li", { class: "low-row" },
        h("span", { class: "low-name" }, t("review.changes_new", { n: changed.length })),
        h("span", { class: "low-acts cook-acts" },
          h("button", { type: "button", class: "btn ghost low-add", onclick: () => changesSheet(view, rerender, now) }, t("review.changes")),
          h("button", { type: "button", class: "btn ghost low-later", onclick: () => { markChangesSeen(view, now); rerender(); } }, t("review.seen")))) : null));
}
