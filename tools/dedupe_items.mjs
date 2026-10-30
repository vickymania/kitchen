// Duplicate items from the old To Do import (30-10-2026: "ja,
// opruimen"). The 2019-2024 lists made one item per one-off line ("Tomaat
// 500g", "x tomaat", "Maybe avocado", "Gerasptekaas"), so a recipe resolved
// to a stray item instead of the one with the purchases and the stock. This
// computes merge groups from the names alone, deterministically, and prints
// them; it sends item.merge ops only with --write.
//
//     node tools/dedupe_items.mjs [origin]                      dry run (default https://groceries.vexed.works)
//     node tools/dedupe_items.mjs --write <origin>              send the CLEAR groups
//     node tools/dedupe_items.mjs --write <origin> --include "<target>"   ...and that DOUBT group too (repeatable)
//     --target "<name>"  that item is its group's target (repeatable)
//     --exclude "<name>" that item stays out of every group (repeatable)
//
// Two kinds of link between names:
//   clear  the same name once noise is gone (case, punctuation, "x "/"- "/"• ",
//          counts and weights "2", "500g", "8st", "?", "maybe", "hebben we
//          nog denk", "voor het serveren", a preparation after a comma, size
//          words, spaces in compounds, "avocado's"), singular/plural or a
//          SAME name (public/shared/item-names.js), or an explicit variety
//          (bloemtortilla is tortilla).
//   doubt  a word that may change the product (gemalen, gedroogde, verse,
//          pittige: "gember gemalen" is no fresh ginger, "gedroogde linzen"
//          no tin), a "voor ..." purpose, a synonym (tortilla ~ wrap), a
//          resolver variety (rundergehakt ~ gehakt), a likely typo, a line
//          naming several things ("Pizza? Geraspte kaas?") or a member
//          whose own rate or deal rule would lose to the target's.
// A clear link is refused (it becomes doubt) when the group would then hold
// two items bought HEAVY times or more: "Tomaat" and "Tomaten" are both
// established, Thomas decides. A CLEAR group merges into its target; a
// DOUBT group is printed with the clear groups inside it and merges as one
// only with --include "<its target's name>".
// Never touched: never-suggest items (public/shared/excluded.js), generic
// lines (GENERIC) and every --exclude "<name>". Target: a --target "<name>"
// in the group, else most purchases, then stock, then a deal rule or own
// rate, then the shortest clean name. The household's own --target and
// --exclude names live in the private tools/dedupe-household.js (TARGETS,
// EXCLUDES; left out of the public copy), read when it is there, so every
// run (the coordinator's, the nightly check's) uses them. The ops go through the op engine on a
// copy of the live data first (as tools/fix_links_20261030.mjs); op ids are
// stable, so a second --write is a replay. The token comes from mcp/.env
// (tools/import_ah.mjs readToken) and is never printed.
//
// The grouping itself lives in public/shared/dedupe.js (the nightly check
// and the worker use the same rules); this file is the CLI around it.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyOp, emptyState, KINDS, OpError } from "../public/shared/ops.js";
import { nameKey } from "../public/shared/ingredients.js";
import { localToday } from "../public/shared/intervals.js";
import { familyMembers, planGroups, decisionSets } from "../public/shared/dedupe.js";
import { stableId } from "./import_todo.mjs";
import { pushOps, readToken } from "./import_ah.mjs";

export {
  HEAVY, CLEAR_WORDS, DOUBT_WORDS, CLEAR_VARIETIES, DOUBT_SYNONYMS, cleanName, typoDistance, itemFacts, pickTarget, planGroups, familyMembers,
} from "../public/shared/dedupe.js";

/** The op id of merging `from` into `into`: the same here and in the nightly check (fetcher/review.mjs), so either one sending it again is a replay. */
export const mergeOpId = (from, into) => stableId("op", `dedupe_items:${from}:${into}`);
const opId = mergeOpId;

/**
 * The item.merge ops: every CLEAR group into its target, and every DOUBT
 * family whose target's name is in `include` as one group into its target
 * (instead of its clear groups). Throws on an include no family has.
 */
export function planOps({ clear, doubt, facts }, today, include = []) {
  const wanted = new Set(include.map((n) => nameKey(n)));
  const chosen = doubt.filter((f) => wanted.has(nameKey(facts[f.target].item.name)));
  const missing = [...wanted].filter((k) => !chosen.some((f) => nameKey(facts[f.target].item.name) === k));
  if (missing.length) throw new Error(`--include: no DOUBT group with target ${missing.map((k) => `"${k}"`).join(", ")}`);
  const taken = new Set(chosen.flatMap((f) => [f.target, ...familyMembers(f)]));
  const ops = [];
  const notes = [];
  const merge = (from, into) => {
    ops.push({ op_id: opId(from, into), type: "item.merge", from_item_id: from, into_item_id: into, on: today });
    notes.push(`${facts[from].item.name} -> ${facts[into].item.name}`);
  };
  for (const g of clear) {
    if (taken.has(g.target)) continue;
    for (const m of g.members) merge(m.id, g.target);
  }
  for (const f of chosen) for (const id of familyMembers(f)) merge(id, f.target);
  return { ops, notes };
}

/** Run the ops through the op engine on a copy of `data`, as the server will. Never sends anything. */
export function simulate(data, ops, now = new Date().toISOString()) {
  const state = structuredClone(data);
  return ops.map((op) => {
    try {
      const { result, changed } = applyOp(state, op, { memberId: "dedupe-items", isAdmin: true, now });
      return { ok: true, result, rows: changed.length };
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      return { ok: false, error: e.code };
    }
  });
}

const fact = (f) => `[${f.bought}b${f.stock ? `, voorraad ${f.stock}` : ""}${f.rules ? ", deal" : ""}${f.rate ? ", eigen verbruik" : ""}]`;
const named = (facts, id) => `${facts[id].item.name} ${fact(facts[id])}`;

/** The readable tables: CLEAR (the `top` biggest, or all) and every DOUBT family. */
export function groupsText({ clear, doubt, facts }, { top = Infinity } = {}) {
  const lines = [];
  const merged = clear.reduce((n, g) => n + g.members.length, 0);
  lines.push(`ZEKER: ${clear.length} groepen, ${merged} items gaan op in hun doel.`);
  for (const g of clear.slice(0, top)) {
    lines.push(`  ${named(facts, g.target)}  <-  ${g.members.map((m) => named(facts, m.id)).join(" · ")}`);
  }
  if (clear.length > top) lines.push(`  ... en nog ${clear.length - top} groepen van ${clear[top].members.length + 1} namen of minder (--all toont ze)`);
  lines.push("", `TWIJFEL: ${doubt.length} groepen, alleen met --include "<doel>":`);
  for (const f of doubt) {
    lines.push(`  ${named(facts, f.target)}`);
    for (const g of f.groups) lines.push(`      zeker al: ${named(facts, g.target)} <- ${g.members.map((m) => named(facts, m.id)).join(" · ")}`);
    for (const m of f.extra) lines.push(`      twijfel: ${named(facts, m.id)}${m.reason ? ` (${m.reason})` : ""}`);
  }
  return lines.join("\n");
}

/** The sync answer as the engine's state: { kind: { id: row } }, live rows only. */
export function stateOf(sync) {
  const state = emptyState();
  for (const kind of KINDS) for (const row of sync[kind] ?? []) if (!row.deleted_at) state[kind][row.id] = row;
  return state;
}

/** The household's own targets and exclusions (tools/dedupe-household.js, private), or none. */
export async function householdDefaults() {
  try {
    const m = await import("./dedupe-household.js");
    return { TARGETS: [...(m.TARGETS ?? [])], EXCLUDES: [...(m.EXCLUDES ?? [])] };
  } catch (e) {
    if (e?.code !== "ERR_MODULE_NOT_FOUND") throw e;
    return { TARGETS: [], EXCLUDES: [] };
  }
}

/* --------------------------------------------------------------- CLI */

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const write = args.indexOf("--write");
  const listed = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  const include = listed("--include");
  for (const flag of ["--include", "--target", "--exclude"]) {
    if (listed(flag).some((x) => !x || x.startsWith("--"))) throw new Error(`${flag} needs an item name, e.g. ${flag} "Tomaten"`);
  }
  const household = await householdDefaults();
  const targets = [...household.TARGETS, ...listed("--target")];
  const excludes = [...household.EXCLUDES, ...listed("--exclude")];
  const named = write >= 0 ? args[write + 1] : args.find((a) => /^https?:\/\//.test(a));
  if (write >= 0 && !/^https?:\/\//.test(named ?? "")) throw new Error("--write needs an origin, e.g. https://groceries.vexed.works");
  const origin = (named ?? "https://groceries.vexed.works").replace(/\/$/, "");
  const token = readToken();
  const res = await fetch(`${origin}/api/sync`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`/api/sync: ${res.status}`);
  const data = stateOf(await res.json());
  // Names the household keeps apart (item_decisions) are never grouped.
  const groups = planGroups(data, { targets, excludes, apart: decisionSets(data.decisions).apart });
  const known = new Set(Object.values(groups.facts).map((f) => nameKey(f.item.name)));
  const unknown = [...targets, ...excludes].filter((n) => !known.has(nameKey(n)));
  if (unknown.length) console.log(`Note: no live item named ${unknown.map((n) => `"${n}"`).join(", ")} (merged already?).`);
  if (targets.length || excludes.length) console.log(`Targets: ${targets.join(", ") || "-"}; left out: ${excludes.join(", ") || "-"}.`);
  const plan = planOps(groups, localToday(), include);
  const outcomes = simulate(data, plan.ops);
  console.log(`Against ${origin}: ${Object.keys(groups.facts).length} items.\n`);
  console.log(groupsText(groups, { top: args.includes("--all") ? Infinity : 30 }));
  const refused = outcomes.map((o, i) => [o, i]).filter(([o]) => !o.ok);
  const moved = {};
  for (const o of outcomes) if (o.ok) for (const [k, n] of Object.entries(o.result.moved ?? {})) moved[k] = (moved[k] ?? 0) + n;
  console.log(`\n${plan.ops.length} item.merge ops${include.length ? ` (with ${include.join(", ")})` : ""}; the engine moves ${Object.entries(moved).filter(([, n]) => n).map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`).join(", ") || "nothing"}.`);
  if (refused.length) {
    for (const [o, i] of refused) console.log(`  REFUSED ${plan.notes[i]}: ${o.error}`);
    console.log(`${refused.length} op(s) would be refused: nothing is sent, also not with --write.`);
    process.exitCode = 1;
  } else if (write < 0) {
    console.log("Dry run: nothing written. Add --write <origin> to send the CLEAR groups.");
  } else {
    console.log(`Sending ${plan.ops.length} ops to ${origin}...`);
    const failed = await pushOps(plan.ops, origin, token);
    console.log(`\nSent ${plan.ops.length}; refused ${failed.length}.`);
    if (failed.length) { console.log(JSON.stringify(failed)); process.exitCode = 1; }
  }
}
