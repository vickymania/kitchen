// "Nachtcontrole": the report of the nightly Claude check on the home server
// (fetcher/review.mjs, op review.save, synced as reviews). A strip on the
// list when the last report (today's or yesterday's) has something for
// the household; the whole report in a sheet and in Settings. "Gezien" hides the
// strip on this device until a newer report comes. "Wat hij deed": the
// changelog of what the check changed itself (auto_changes, written by the
// worker for the reviewer device), the last AUTO_CHANGES_DAYS days newest
// first, in Settings and in a sheet from the strip when last night changed
// something; each line says how to undo it.
import { h, sheet } from "./dom.js";
import { t, formatDate } from "./i18n.js";
import { localToday } from "../shared/intervals.js";
import { addDays } from "../shared/shelf-life.js";
import { AUTO_CHANGES_DAYS } from "../shared/ops.js";

const SEEN_KEY = "kitchen.reviewSeen";
const CHANGES_SEEN_KEY = "kitchen.changesSeen";
const CHANGE_KINDS = ["merge", "move", "alias", "rename", "recipe"];

/** The changelog rows of the last AUTO_CHANGES_DAYS days, newest first. */
export function recentChanges(view, today = localToday()) {
  const from = addDays(today, -AUTO_CHANGES_DAYS);
  return Object.values(view.auto_changes ?? {})
    .filter((c) => !c.deleted_at && c.day >= from && CHANGE_KINDS.includes(c.what))
    .sort((a, b) => b.day.localeCompare(a.day) || String(b.created_at).localeCompare(String(a.created_at)) || a.id.localeCompare(b.id));
}

/** One line: what changed, and how to undo it. */
export function changeText(c) {
  const [linked, total] = String(c.target ?? "").split("/");
  const text = t(`review.change_${c.what}`, { name: c.name, target: c.target ?? "", linked: linked ?? "", total: total ?? "" });
  return { text: c.reason ? `${text} (${c.reason})` : text, undo: t(`review.undo_${c.what}`) };
}

/** One recipe line of the changelog: "'bloem' → Bloem (zelfde naam)" or "'water': water uit de kraan". */
export function linkText(l) {
  return l.item_id
    ? t("review.link_to", { name: l.name, item: l.item ?? "", how: t(`link.how.${l.how}`) })
    : t("review.link_none", { name: l.name, reason: t(`link.reason.${l.reason}`) });
}

/** "Wat hij deed": the changelog as a list, the same in Settings and in the sheet. */
export function changesList(view, today = localToday()) {
  const rows = recentChanges(view, today);
  if (!rows.length) return h("p", { class: "hint" }, t("review.changes_none"));
  return h("ul", { class: "changes" }, rows.map((c) => {
    const { text, undo } = changeText(c);
    return h("li", {},
      c.what === "move" && c.product_id ? h("a", { href: `#/product/${c.product_id}` }, text) : h("span", {}, text),
      h("small", { class: "mono" }, formatDate(c.day)),
      c.what === "recipe" && Array.isArray(c.lines) ? c.lines.map((l) => h("small", { class: "link-line" }, linkText(l))) : null,
      h("small", {}, undo));
  }));
}

/** Last night's changes this device has not seen yet (today's or yesterday's). */
function newChanges(view, today) {
  let seenAt = "";
  try {
    seenAt = localStorage.getItem(CHANGES_SEEN_KEY) ?? "";
  } catch {
    // Storage blocked: every recent change counts as new.
  }
  return recentChanges(view, today).filter((c) => c.day >= addDays(today, -1) && String(c.created_at) > seenAt);
}
function markChangesSeen(view, today) {
  const newest = recentChanges(view, today)[0];
  try {
    if (newest) localStorage.setItem(CHANGES_SEEN_KEY, String(newest.created_at));
  } catch {
    // Storage blocked: the line stays.
  }
}

export function changesSheet(view, onSeen = () => {}, today = localToday()) {
  return sheet((close) => [
    h("h2", {}, t("review.changes")),
    h("div", { class: "review" }, h("div", { class: "review-part" }, changesList(view, today))),
    h("div", { class: "actions" },
      h("button", { type: "button", class: "btn primary", onclick: () => { markChangesSeen(view, today); onSeen(); close(); } }, t("review.seen")),
      h("button", { type: "button", class: "btn", onclick: () => close() }, t("common.close"))),
  ]);
}

/** The newest report, or null. */
export function latestReview(view) {
  return Object.values(view.reviews ?? {}).filter((r) => !r.deleted_at)
    .sort((a, b) => b.day.localeCompare(a.day))[0] ?? null;
}

const decideOf = (r) => [...(r.errors ?? []), ...(r.decide ?? [])];
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

/** The report's lines, the same in the sheet and in Settings. */
export function reviewBody(r) {
  const block = (key, lines) => (lines.length ? h("div", { class: "review-part" },
    h("h3", { class: "low-label mono" }, t(key)),
    h("ul", {}, lines)) : null);
  return [
    block("review.errors", (r.errors ?? []).map((e) => h("li", {}, e))),
    block("review.decide", (r.decide ?? []).map((d) => h("li", {}, d))),
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
export function reviewStrip(view, rerender, today = localToday()) {
  const r = latestReview(view);
  const lines = r && r.day >= addDays(today, -1) && !seen(r) ? decideOf(r) : [];
  const changed = newChanges(view, today);
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
          h("button", { type: "button", class: "btn ghost low-add", onclick: () => changesSheet(view, rerender, today) }, t("review.changes")),
          h("button", { type: "button", class: "btn ghost low-later", onclick: () => { markChangesSeen(view, today); rerender(); } }, t("review.seen")))) : null));
}
