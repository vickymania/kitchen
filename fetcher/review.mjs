// The nightly check on the home server (30-10-2026): after the
// daily run, a headless Claude Code session (`claude -p`, started by
// fetcher/review.sh) reads the run log and the new receipt purchases, fixes
// the clear-cut product-to-item links through the kitchen MCP server
// (mcp/server.mjs, with the reviewer device's own token) and answers a short
// report, which this file stores in review-state/ and sends as review.save.
//
//   node fetcher/review.mjs prepare [--force]   once a day: first the deterministic fixes
//                                               (runNightlyFixes: CLEAR duplicate items merged,
//                                               question-mark names tidied, at most
//                                               NIGHTLY_MERGE_MAX / NIGHTLY_RENAME_MAX, new DOUBT
//                                               groups as questions; review-state/fixes.json),
//                                               then write review-state/prompt.txt
//                                               (fetcher/review-prompt.md + the optional
//                                               fetcher/review-household.md + the inputs)
//                                               and review-state/mcp.json; exit 3 when
//                                               today's check already ran
//   node fetcher/review.mjs save <exit code>    read review-state/claude.json (claude's
//                                               --output-format json), keep the report in
//                                               review-state/last.json and last.txt, log
//                                               turns and cost, send review.save
//   node fetcher/review.mjs pair                link this server as the device
//                                               "Thuisserver controle" with a reviewer code
//                                               (node tools/admin.mjs code --reviewer),
//                                               typed on stdin; the token goes to
//                                               ./reviewer-token (mode 600)
//
// No token is ever printed or logged, and Claude never sees one: the MCP
// server reads the token file itself (KITCHEN_TOKEN_FILE).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { pairDevice } from "./fetch.mjs";
import { NEW_PURCHASES_FILE } from "../tools/import_ah.mjs";
import { localToday } from "../public/shared/intervals.js";
import { REVIEW_MAX_LINES, REVIEW_LINE_MAX } from "../public/shared/ops.js";
import { planGroups, nightlyPlan, familyMembers, decisionSets, NIGHTLY_MERGE_MAX, NIGHTLY_RENAME_MAX, NIGHTLY_REMOVE_MAX } from "../public/shared/dedupe.js";
import { keepFixed } from "../public/shared/ops.js";
import { householdDefaults, mergeOpId, stateOf } from "../tools/dedupe_items.mjs";
import { stableId } from "../tools/import_todo.mjs";
import { linkRecipe, linksStale } from "../public/shared/recipe-links.js";
import { createHash } from "node:crypto";

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(path.join(HOME, "config.env"));
} catch {
  // No config.env: the defaults below.
}
const ORIGIN = (process.env.KITCHEN_ORIGIN || "https://groceries.vexed.works").replace(/\/+$/, "");
/** How the owner reaches this server, for the "log in again" lines. */
const SSH = process.env.REVIEW_SSH || "user@home-server.local";
export const REVIEWER_TOKEN_FILE = path.join(HOME, "reviewer-token");
export const STATE_DIR = path.join(HOME, "review-state");
/** The household's own rules for the prompt, next to fetcher/review-prompt.md; optional and private. */
export const HOUSEHOLD_FILE = "review-household.md";

/** What the prompt gets of the last run's log: its last lines, at most this many characters. */
export const LOG_LINES = 120;
export const LOG_CHARS = 12_000;
/** A new-purchases file older than this is yesterday's run, not this one. */
export const FRESH_HOURS = 20;
export const PURCHASE_CHARS = 20_000;

const log = (...a) => console.log(new Date().toISOString(), "review", ...a);

/** The last lines of the run log, capped. */
export function logTail(text, { lines = LOG_LINES, chars = LOG_CHARS } = {}) {
  const tail = String(text ?? "").replace(/\r/g, "").split("\n").filter(Boolean).slice(-lines).join("\n");
  return tail.length > chars ? tail.slice(-chars) : tail;
}

/** The line fetcher/run.sh writes first in every run: "<iso> run start". */
export const RUN_START = /^\S+ run start$/;

/** The calendar day of an ISO timestamp in Europe/Amsterdam (the household's day), or "". */
export function amsterdamDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/**
 * The log of the most recent run only: from its last "run start" line on. A
 * run that did not start today (Europe/Amsterdam), or a log without any marker,
 * gives a note instead of old errors (30-10-2026: yesterday's Lidl errors were
 * reported after they were solved).
 */
export function lastRunLog(text, today, opts = {}) {
  const all = String(text ?? "").replace(/\r/g, "").split("\n").filter(Boolean);
  let start = -1;
  for (let i = all.length - 1; i >= 0; i--) if (RUN_START.test(all[i])) { start = i; break; }
  if (start < 0) return "(no run today yet: the log has no run start line)";
  const day = amsterdamDay(all[start].split(" ")[0]);
  if (day !== today) return `(no run today yet: the last run in the log started on ${day || "an unknown day"}; its lines are left out)`;
  return logTail(all.slice(start).join("\n"), opts);
}

/** The run's own errors, read from the log tail by rule (the fallback when Claude gives no report). */
export function logErrors(tail) {
  return String(tail).split("\n")
    .filter((l) => /\bFAILED\b|\bexit [1-9]\d*\b|\brefused\b/.test(l))
    .map((l) => l.replace(/^\S+\s+/, "").slice(0, 200))
    .slice(-5);
}

/** The new purchases of today's AH and Lidl runs, each only when written in the last FRESH_HOURS. */
export function newPurchases(home = HOME, now = Date.now()) {
  const parts = [];
  for (const dir of ["ah-state", "lidl-state"]) {
    const file = path.join(home, dir, NEW_PURCHASES_FILE);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      parts.push(`${dir}: no ${NEW_PURCHASES_FILE}`);
      continue;
    }
    if (now - stat.mtimeMs > FRESH_HOURS * 3600_000) {
      parts.push(`${dir}: not run today`);
      continue;
    }
    parts.push(fs.readFileSync(file, "utf8").trim());
  }
  const text = parts.join("\n\n");
  return text.length > PURCHASE_CHARS ? `${text.slice(0, PURCHASE_CHARS)}\n(more lines wait for the next night)` : text;
}

/* ------------------------------- purchases carried over to the next night */

/**
 * The purchase ids the check has seen (review-state/checked-purchases.json)
 * and the ones kitchen_recent_purchases showed tonight (shown-purchases.json,
 * written by mcp/server.mjs through KITCHEN_SHOWN_FILE). Thomas, 30-10-2026:
 * "22 aankopen zijn niet gecontroleerd — wat moet ik daarmee?": a purchase
 * the capped output left out is shown the next night, never reported.
 */
export const CHECKED_FILE = "checked-purchases.json";
export const SHOWN_FILE = "shown-purchases.json";
/** At most this many checked ids are kept (the oldest go first). */
export const CHECKED_MAX = 20_000;

/** Tonight's shown ids added to the checked ones; the shown file is cleared. */
export function markShownChecked(stateDir = STATE_DIR) {
  const shownFile = path.join(stateDir, SHOWN_FILE);
  const shown = readJson(shownFile, []);
  const checkedFile = path.join(stateDir, CHECKED_FILE);
  const had = readJson(checkedFile, []);
  const all = [...new Set([...had, ...(Array.isArray(shown) ? shown : [])])].slice(-CHECKED_MAX);
  fs.writeFileSync(checkedFile, JSON.stringify(all));
  fs.rmSync(shownFile, { force: true });
  return { checked: all.length, added: all.length - had.length };
}

/** The prompt: fetcher/review-prompt.md with today, the log tail, the new purchases and tonight's own fixes filled in. */
export function buildPrompt({ template, today, log: tail, purchases, household = "", fixes = "" }) {
  return template
    .replace("{{TODAY}}", today)
    .replace("{{FIXES}}", fixes.trim() || "(none)")
    .replace("{{HOUSEHOLD}}", household.trim() || "(none)")
    .replace("{{LOG}}", ["```", tail || "(empty)", "```"].join("\n"))
    .replace("{{PURCHASES}}", ["```", purchases || "(none)", "```"].join("\n"));
}

/** The MCP config for claude: only the kitchen server, with the reviewer's token file and the checked-purchases files. */
export function mcpConfig(home = HOME, origin = ORIGIN, stateDir = path.join(home, "review-state")) {
  return {
    mcpServers: {
      kitchen: {
        command: process.execPath,
        args: [path.join(home, "mcp", "server.mjs")],
        env: {
          KITCHEN_TOKEN_FILE: path.join(home, "reviewer-token"), KITCHEN_ORIGIN: origin,
          KITCHEN_CHECKED_FILE: path.join(stateDir, CHECKED_FILE), KITCHEN_SHOWN_FILE: path.join(stateDir, SHOWN_FILE),
        },
      },
    },
  };
}

/** Did today's check run already (review-state/last-day)? */
export function ranToday({ stateDir = STATE_DIR, today = localToday() } = {}) {
  const dayFile = path.join(stateDir, "last-day");
  return fs.existsSync(dayFile) && fs.readFileSync(dayFile, "utf8").trim() === today;
}

/* ----------------------------------------- the deterministic fixes */

/** The file tonight's fixes are kept in, read again by save. */
export const FIXES_FILE = "fixes.json";
/** The DOUBT groups already put in front of the household, so each is asked once. */
export const DOUBT_SEEN_FILE = "doubt-seen.json";
/** At most this many new DOUBT groups asked a night. */
export const DOUBT_MAX = 5;
/** At most this many recipes (re)linked a night; the rest the next night. */
export const RECIPE_LINK_MAX = 20;

/**
 * The recipe.links ops for every live recipe whose stored links are missing,
 * made for an older version, or differ from today's answer (a new item, an
 * alias), at most `max`, longest waiting first; plus the lines no item was
 * found for ("never"), for Claude to look at. Op ids are stable per answer:
 * the same answer again is a replay.
 */
export function recipeLinkOps(data, { max = RECIPE_LINK_MAX } = {}) {
  const ops = [], unlinked = [];
  const recipes = Object.values(data.recipes ?? {}).filter((r) => !r.deleted_at)
    .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)) || a.id.localeCompare(b.id));
  for (const r of recipes) {
    if (ops.length >= max) break;
    // A line the household fixed ("Klopt niet", recipe.link_fix) stays as they said.
    const lines = keepFixed(linkRecipe(r, data), r.ingredient_links?.fixed);
    if (!lines.length || !linksStale(r, lines)) continue;
    const hash = createHash("sha256").update(JSON.stringify([r.id, r.updated_at, lines])).digest("hex").slice(0, 24);
    ops.push({ op_id: `op-rl-${hash}`, type: "recipe.links", recipe_id: r.id, at: r.updated_at ?? null, lines, note: r.title });
    for (const l of lines) if (l.reason === "never") unlinked.push(`${r.title}: ${l.name}`);
  }
  return { ops, unlinked };
}

const nameList = (names) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} en ${names.at(-1)}` : names[0] ?? "");

/**
 * Tonight's fixes from a full sync, by the rules of tools/dedupe_items.mjs
 * (public/shared/dedupe.js), never by Claude's judgement: the CLEAR groups'
 * merges (nightlyPlan: pairwise clear, never an excluded item, at most
 * `max`) with the tool's own op ids, the tidy spellings (item.rename), and
 * as questions the DOUBT groups (and held pairs) not in `seen` yet, at most
 * DOUBT_MAX. `seen` null is the first run: every group there is now is
 * recorded, none asked (the old ones wait on the backlog already).
 */
export function nightlyFixes(sync, { targets = [], excludes = [], today = localToday(), seen = null, max = NIGHTLY_MERGE_MAX, maxRenames = NIGHTLY_RENAME_MAX,
  maxRemoves = NIGHTLY_REMOVE_MAX } = {}) {
  const data = stateOf(sync);
  // What the household decided (Apart houden, an undone change): never done or asked again.
  const decisions = decisionSets(data.decisions);
  const groups = planGroups(data, { targets, excludes, apart: decisions.apart });
  const plan = nightlyPlan(groups, { max, maxRenames, maxRemoves, decisions });
  const name = (id) => groups.facts[id]?.item.name ?? data.items[id]?.name ?? id;
  const ops = [
    ...plan.renames.map((r) => ({ op_id: stableId("op", `nightly_rename:${r.id}:${r.name}`), type: "item.rename", item_id: r.id, name: r.name, note: `${r.was} -> ${r.name}` })),
    ...plan.merges.map((m) => ({ op_id: mergeOpId(m.from, m.into), type: "item.merge", from_item_id: m.from, into_item_id: m.into, on: today, note: `${name(m.from)} -> ${name(m.into)}` })),
    // Junk names that mean nothing (30-10-2026: "weg ermee"): removed, never renamed.
    ...plan.removes.map((r) => ({ op_id: stableId("op", `nightly_remove:${r.id}`), type: "item.remove", item_id: r.id, on: today, reason: r.reason, note: `${name(r.id)} weg (${r.reason})` })),
  ];
  // Every question gets "Samenvoegen" / "Apart houden" in the app: the item ids, the clean target first.
  const asks = [
    ...groups.doubt.map((f) => {
      const ids = [f.target, ...familyMembers(f).sort((a, b) => name(a).localeCompare(name(b), "nl"))];
      const names = ids.map(name);
      return { key: `doubt:${[...names].sort().join("|")}`, text: `${nameList(names)} samenvoegen?`, ids, into: f.target };
    }),
    ...plan.held.map((h) => ({ key: `held:${name(h.from)}>${name(h.into)}`, text: `${name(h.from)} samenvoegen met ${name(h.into)}?`, ids: [h.into, h.from], into: h.into })),
    ...plan.junkAsks.map((j) => ({ key: `junk:${name(j.from)}>${name(j.into)}`, text: `${name(j.from)} samenvoegen met ${name(j.into)}?`, ids: [j.into, j.from], into: j.into })),
  ];
  const known = new Set(seen ?? asks.map((a) => a.key));
  const fresh = asks.filter((a) => !known.has(a.key)).slice(0, DOUBT_MAX);
  return {
    ops, decide: fresh.map(({ text, ids, into }) => ({ text, ids, into })),
    seen: [...new Set([...known, ...fresh.map((a) => a.key)])], left: plan.left,
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Runs tonight's fixes against the app with the reviewer token: one op per
 * request (one refusal never stops the others; 429 is the day's cap), then
 * keeps what happened in review-state/fixes.json: { day, done: [notes],
 * decide, errors }. The changes themselves land in the app's changelog
 * (auto_changes), written by the worker. Never throws: a failure is an error line.
 */
export async function runNightlyFixes({ home = HOME, stateDir = STATE_DIR, today = localToday(), origin = ORIGIN, get = fetch, post = fetch, token = null, say = log, household = null } = {}) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const out = { day: today, done: [], decide: [], errors: [], unlinked: [] };
  try {
    const bearer = token ?? readReviewerToken(path.join(home, "reviewer-token"));
    const res = await get(`${origin}/api/sync?since=0`, { headers: { Authorization: `Bearer ${bearer}` } });
    if (!res.ok) throw new Error(`/api/sync: ${res.status}`);
    const sync = await res.json();
    const { TARGETS, EXCLUDES } = household ?? await householdDefaults();
    const seenFile = path.join(stateDir, DOUBT_SEEN_FILE);
    const fixes = nightlyFixes(sync, { targets: TARGETS, excludes: EXCLUDES, today, seen: readJson(seenFile, null) });
    out.decide = fixes.decide;
    for (const op of fixes.ops) {
      const { note, ...sent } = op;
      const r = await post(`${origin}/api/ops`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ ops: [sent] }),
      });
      const body = await r.json().catch(() => ({}));
      // The day's cap: the rest waits for the next night, nobody needs to hear it.
      if (r.status === 429) { say(`${sent.type} cap reached`); continue; }
      if (r.ok && body.results?.[0]?.ok) out.done.push(note);
      else if (r.status === 403) say("refused", note);
      else out.errors.push(`Nachtcontrole kon niet aanpassen: ${note.replace(" -> ", " naar ")}.`);
    }
    fs.writeFileSync(seenFile, JSON.stringify(fixes.seen, null, 1));
    // Recipes: which item each line means, on the items as they are after the merges.
    const after = await get(`${origin}/api/sync?since=0`, { headers: { Authorization: `Bearer ${bearer}` } });
    if (!after.ok) throw new Error(`/api/sync: ${after.status}`);
    const links = recipeLinkOps(stateOf(await after.json()));
    out.unlinked = links.unlinked.slice(0, 60);
    for (const op of links.ops) {
      const { note, ...sent } = op;
      const r = await post(`${origin}/api/ops`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ ops: [sent] }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok && body.results?.[0]?.ok) out.done.push(`linked recipe ${note}`);
      else out.errors.push(`Nachtcontrole kon ${note} niet koppelen.`);
    }
    say(`fixes: ${out.done.length} done (${fixes.ops.length} planned, ${fixes.left} for later), ${out.decide.length} new questions, ${out.errors.length} refused`);
  } catch (e) {
    out.errors.push("Nachtcontrole kon niet samenvoegen.");
    say("fixes FAILED", e.message);
  }
  fs.writeFileSync(path.join(stateDir, FIXES_FILE), JSON.stringify(out, null, 2));
  return out;
}

/** Tonight's fixes for the prompt, so Claude does not ask about them again; and the recipe lines no item was found for. */
export function fixesText(fixes) {
  return [
    ...(fixes?.done ?? []).map((d) => `- done: ${d}`),
    ...(fixes?.decide ?? []).map((d) => `- asked already: ${d}`),
    ...(fixes?.unlinked ?? []).map((u) => `- recipe line without an item: ${u}`),
  ].join("\n");
}

/** Once a day: writes prompt.txt and mcp.json. Returns false when today's check already ran. */
export function prepare({ home = HOME, stateDir = STATE_DIR, today = localToday(), force = false, now = Date.now(), fixes = null } = {}) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const dayFile = path.join(stateDir, "last-day");
  if (!force && ranToday({ stateDir, today })) return false;
  fs.writeFileSync(dayFile, `${today}\n`);
  let logText = "";
  try {
    logText = fs.readFileSync(path.join(home, "fetcher.log"), "utf8");
  } catch {
    // no log yet
  }
  const template = fs.readFileSync(path.join(home, "fetcher", "review-prompt.md"), "utf8");
  // The household's own rules (its item names, its pet): private, never in the public copy.
  let household = "";
  try {
    household = fs.readFileSync(path.join(home, "fetcher", HOUSEHOLD_FILE), "utf8");
  } catch {
    // none: the general rules only
  }
  fs.writeFileSync(path.join(stateDir, "prompt.txt"), buildPrompt({ template, today, log: lastRunLog(logText, today), purchases: newPurchases(home, now), household, fixes: fixesText(fixes) }));
  fs.writeFileSync(path.join(stateDir, "mcp.json"), JSON.stringify(mcpConfig(home, ORIGIN, stateDir), null, 2));
  // A shown file left by a run that never saved: those purchases were not judged, show them again.
  fs.rmSync(path.join(stateDir, SHOWN_FILE), { force: true });
  return true;
}

/** The first {...} in a text that parses as JSON, or null. */
function jsonIn(text) {
  const s = String(text ?? "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

const clip = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, REVIEW_LINE_MAX);
const list = (v) => (Array.isArray(v) ? v.map(clip).filter(Boolean).slice(0, REVIEW_MAX_LINES) : []);
const ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * One question of the report: a line, or a merge question { text, names }
 * (Claude's: the items by name) or { text, ids, into } (the rules'), which
 * the app answers with "Samenvoegen" / "Apart houden".
 */
export function decideLine(v) {
  if (typeof v === "string") return clip(v);
  if (!v || typeof v !== "object") return "";
  const text = clip(v.text);
  if (!text) return "";
  const ids = Array.isArray(v.ids) ? v.ids.filter((x) => typeof x === "string" && ID.test(x)).slice(0, 12) : [];
  const names = Array.isArray(v.names ?? v.merge) ? (v.names ?? v.merge).map((n) => clip(n).slice(0, 120)).filter(Boolean).slice(0, 12) : [];
  if (ids.length > 1) return { text, ids, ...(typeof v.into === "string" && ID.test(v.into) ? { into: v.into } : {}) };
  if (names.length > 1) return { text, names };
  return text;
}
const decideList = (v) => (Array.isArray(v) ? v.map(decideLine).filter(Boolean).slice(0, REVIEW_MAX_LINES) : []);

/** Claude Code's own words when its login is gone (expired or revoked): "Please run /login", "OAuth token has expired"... */
export const AUTH_FAILED = /\/login\b|not logged in|log in again|invalid api key|oauth token|authentication_error|unauthori[sz]ed|\b401\b/i;

/** The lines a failed check puts in front of the household: why, and for a lost login how to log in again. */
export function failureLines(kind, { code = 0, ssh = SSH } = {}) {
  if (kind === "auth") {
    return ["Claude op je server moet opnieuw inloggen.", `ssh ${ssh}`, "cd ~/kitchen-fetcher && ~/.local/bin/claude, dan /login"];
  }
  const why = {
    timeout: "het duurde te lang.",
    turns: "er waren te veel stappen nodig.",
    budget: "het werd te duur.",
    missing: "Claude staat niet op de server.",
    unreadable: "het rapport was niet leesbaar.",
  }[kind] ?? `Claude stopte met een fout (code ${code}).`;
  return [`Nachtcontrole is niet gelukt: ${why}`];
}

/**
 * The report from claude's JSON output (`--output-format json`: result,
 * is_error, subtype, num_turns, total_cost_usd), or a report that says what
 * went wrong with the check itself. `exitCode` 124 is the timeout, 127 no
 * claude; `stderr` is claude's own error output (a lost login shows there or
 * in `result`).
 */
export function readReport(raw, { exitCode = 0, tail = "", stderr = "", ssh = SSH } = {}) {
  let out = null;
  try {
    out = raw ? JSON.parse(raw) : null;
  } catch {
    out = null;
  }
  const meta = {
    turns: Number.isFinite(out?.num_turns) ? out.num_turns : null,
    cost_usd: Number.isFinite(out?.total_cost_usd) ? out.total_cost_usd : null,
    subtype: out?.subtype ?? null,
  };
  const answer = out && !out.is_error ? jsonIn(out.result) : null;
  if (answer && typeof answer === "object" && !Array.isArray(answer)) {
    const fixed = (Array.isArray(answer.fixed) ? answer.fixed : [])
      .map((f) => ({ text: clip(f?.text), undo: clip(f?.undo) })).filter((f) => f.text).slice(0, REVIEW_MAX_LINES);
    const errors = list(answer.errors);
    return { ok: true, failure: null, meta, report: { run_ok: answer.run_ok !== false && !errors.length, errors, fixed, decide: decideList(answer.decide) } };
  }
  // No usable answer: why, and the run's own errors by rule.
  const said = `${out?.result ?? ""}\n${stderr ?? ""}`;
  const failure = exitCode === 127 ? "missing"
    : AUTH_FAILED.test(said) ? "auth"
      : exitCode === 124 ? "timeout"
        : /max_turns/.test(meta.subtype ?? "") ? "turns"
          : /budget/.test(meta.subtype ?? "") ? "budget"
            : out && !out.is_error && exitCode === 0 ? "unreadable"
              : "crash";
  const errors = logErrors(tail);
  return { ok: false, failure, meta, report: { run_ok: !errors.length, errors, fixed: [], decide: failureLines(failure, { code: exitCode, ssh }) } };
}

/** The report as text, for review-state/last.txt. */
export function reportText(day, report) {
  return [
    `Nachtcontrole ${day}`,
    report.errors.length ? "Run: fouten" : "Run: goed",
    ...report.errors.map((e) => `- ${e}`),
    ...(report.fixed.length ? ["Opgelost:", ...report.fixed.map((f) => `- ${f.text}${f.undo ? ` (${f.undo})` : ""}`)] : []),
    ...(report.decide.length ? ["Beslissen:", ...report.decide.map((d) => `- ${typeof d === "string" ? d : d.text}`)] : []),
  ].join("\n");
}

/** The op that stores the report in the app (public/shared/ops.js review.save). */
export function reviewOp(day, report, meta) {
  return {
    op_id: `rv-${day}-${randomBytes(6).toString("hex")}`,
    type: "review.save",
    day,
    run_ok: report.run_ok,
    fixed: report.fixed,
    decide: report.decide,
    errors: report.errors,
    ...(meta.turns !== null ? { turns: meta.turns } : {}),
    ...(meta.cost_usd !== null ? { cost_cents: Math.round(meta.cost_usd * 100) } : {}),
  };
}

function readReviewerToken(file = REVIEWER_TOKEN_FILE) {
  try {
    const token = fs.readFileSync(file, "utf8").trim();
    if (token.length >= 20) return token;
  } catch {
    // handled below
  }
  throw new Error(`no token in ${file}: run "node fetcher/review.mjs pair" first`);
}

/** Reads claude's output, keeps the report on the server and sends it to the app. */
export async function save({ exitCode = 0, home = HOME, stateDir = STATE_DIR, today = localToday(), origin = ORIGIN, post = fetch, token = null, say = log } = {}) {
  let raw = "";
  try {
    raw = fs.readFileSync(path.join(stateDir, "claude.json"), "utf8");
  } catch {
    // no output: readReport says so
  }
  let tail = "";
  try {
    tail = logTail(fs.readFileSync(path.join(home, "fetcher.log"), "utf8"));
  } catch {
    // no log
  }
  let stderr = "";
  try {
    stderr = fs.readFileSync(path.join(stateDir, "claude.err"), "utf8").slice(-4000);
  } catch {
    // none
  }
  const { ok, failure, meta, report } = readReport(raw, { exitCode, tail, stderr });
  // Tonight's own fixes (runNightlyFixes): their questions and refusals go first.
  const fixes = readJson(path.join(stateDir, FIXES_FILE), null);
  if (fixes?.day === today) {
    report.decide = [...(fixes.decide ?? []).map(decideLine), ...report.decide].filter(Boolean).slice(0, REVIEW_MAX_LINES);
    report.errors = [...(fixes.errors ?? []).map(clip), ...report.errors].filter(Boolean).slice(0, REVIEW_MAX_LINES);
    if (report.errors.length) report.run_ok = false;
  }
  // What kitchen_recent_purchases showed tonight is checked; the rest comes the next night.
  const carried = markShownChecked(stateDir);
  say(`purchases checked: ${carried.added} tonight, ${carried.checked} in all`);
  fs.writeFileSync(path.join(stateDir, "last.json"), JSON.stringify({ day: today, exit: exitCode, failure, ...meta, ...report }, null, 2));
  fs.writeFileSync(path.join(stateDir, "last.txt"), `${reportText(today, report)}\n`);
  say(`claude exit ${exitCode}, ${ok ? "report" : `no report (${failure})`}; turns ${meta.turns ?? "?"}, cost $${meta.cost_usd?.toFixed(3) ?? "?"}; `
    + `fixed ${report.fixed.length}, decide ${report.decide.length}, run errors ${report.errors.length}`);
  const res = await post(`${origin}/api/ops`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token ?? readReviewerToken(path.join(home, "reviewer-token"))}` },
    body: JSON.stringify({ ops: [reviewOp(today, report, meta)] }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.results?.[0]?.ok) throw new Error(`review.save refused: ${res.status} ${body.error ?? body.results?.[0]?.error ?? ""}`.trim());
  say("report sent");
  return { ok, failure, report, meta };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  try {
    if (mode === "prepare") {
      if (!process.argv.includes("--force") && ranToday()) {
        log("already ran today");
        process.exitCode = 3;
      } else {
        const fixes = await runNightlyFixes();
        prepare({ force: true, fixes });
      }
    } else if (mode === "save") {
      await save({ exitCode: Number(process.argv[3] ?? 0) || 0 });
    } else if (mode === "pair") {
      await pairDevice({ origin: ORIGIN, file: REVIEWER_TOKEN_FILE, label: "Thuisserver controle", prompt: "Reviewer code (6 digits): " });
    } else {
      console.log("Usage: node fetcher/review.mjs prepare|save <exit>|pair  (see the top of this file)");
      process.exitCode = 2;
    }
  } catch (e) {
    log("FAILED", e.message);
    process.exitCode = 1;
  }
}
