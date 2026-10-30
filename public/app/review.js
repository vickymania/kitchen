// "Nachtcontrole": the report of the nightly Claude check on the home server
// (fetcher/review.mjs, op review.save, synced as reviews). A strip on the
// list when the last report (today's or yesterday's) has something for
// the household; the whole report in a sheet and in Settings. "Gezien" hides the
// strip on this device until a newer report comes.
import { h, sheet } from "./dom.js";
import { t, formatDate } from "./i18n.js";
import { localToday } from "../shared/intervals.js";
import { addDays } from "../shared/shelf-life.js";

const SEEN_KEY = "kitchen.reviewSeen";

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

/** The strip on the list, or null: only for a report of today or yesterday that asks something of the household. */
export function reviewStrip(view, rerender, today = localToday()) {
  const r = latestReview(view);
  if (!r || r.day < addDays(today, -1) || seen(r)) return null;
  const lines = decideOf(r);
  if (!lines.length) return null;
  return h("section", { class: "low-strip cook-ask review-strip", "aria-label": t("review.label") },
    h("h2", { class: "low-label mono" }, t("review.label")),
    h("ul", {}, h("li", { class: "low-row" },
      h("span", { class: "low-name" }, lines[0]),
      lines.length > 1 ? h("span", { class: "low-why mono" }, t("review.more", { n: lines.length - 1 })) : null,
      h("span", { class: "low-acts cook-acts" },
        h("button", { type: "button", class: "btn ghost low-add", onclick: () => reviewSheet(r, rerender) }, t("review.open")),
        h("button", { type: "button", class: "btn ghost low-later", onclick: () => { markSeen(r); rerender(); } }, t("review.seen"))))));
}
