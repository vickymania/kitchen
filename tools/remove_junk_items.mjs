// Junk names out of the database (30-10-2026, about the old To Do
// lines the first nightly check renamed as if they were things: "die generic
// dingen horen niet eens in mijn database, weg ermee"). A junk name is a
// vague or shouted line that was never bought as a product
// (public/shared/dedupe.js junkItem: "Lunch", "Meer tapas", "Iets op
// stokbroodje", "Electronica bak", "Kattenbak!!!"). One that clearly means an
// existing item ("Eten minoes!!!" is "Minoes eten") is MERGED into it; one
// that only might ("Kattenbak!!!" and "Kattenbakvulling") is listed as a
// question and left alone; the rest is REMOVED (item.remove: the item, its
// list lines, other names, pantry rows and purchases become tombstones; the
// app's undo is item.unremove). Never renamed into a fake clean item.
//
//     node tools/remove_junk_items.mjs [origin]                 dry run (default https://groceries.vexed.works)
//     node tools/remove_junk_items.mjs --write <origin>         send the merges and removals
//     --name "<item name>"   that item too, although the rule does not flag it (repeatable;
//                            still never an item with a product)
//     --keep "<item name>"   leave that item alone (repeatable)
//
// Prints exactly what goes, with what goes along, after running the ops
// through the op engine on a copy of the live data. Op ids are stable: a
// second --write is a replay. The token comes from mcp/.env
// (tools/import_ah.mjs readToken) and is never printed. The coordinator runs
// it, after reading the dry run.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nameKey } from "../public/shared/ingredients.js";
import { localToday } from "../public/shared/intervals.js";
import { itemFacts, junkItem, junkMeaning, decisionSets } from "../public/shared/dedupe.js";
import { stableId } from "./import_todo.mjs";
import { pushOps, readToken } from "./import_ah.mjs";
import { mergeOpId, simulate, stateOf } from "./dedupe_items.mjs";

/** The op id of a junk removal: the same as the nightly check's, so either one is a replay of the other. */
export const removeOpId = (itemId) => stableId("op", `nightly_remove:${itemId}`);

/**
 * The plan for `data` ({ kind: { id: row } }): { merges: [{ from, into }],
 * removes: [{ id, reason }], asks: [{ from, into }], skipped: [{ id, why }] }.
 * `names`: items to take along although the rule does not flag them;
 * `keepNames`: items to leave alone.
 */
export function junkPlan(data, { names = [], keepNames = [] } = {}) {
  const facts = itemFacts(data);
  const { keep } = decisionSets(data.decisions);
  const wanted = new Set(names.map(nameKey));
  const kept = new Set(keepNames.map(nameKey));
  const out = { merges: [], removes: [], asks: [], skipped: [] };
  const ids = Object.keys(facts).sort((a, b) => facts[a].item.name.localeCompare(facts[b].item.name, "nl") || a.localeCompare(b));
  for (const id of ids) {
    const f = facts[id];
    const key = nameKey(f.item.name);
    if (kept.has(key)) continue;
    let reason = junkItem(f, { keep });
    if (!reason && wanted.has(key)) {
      if (f.products > 0) { out.skipped.push({ id, why: "heeft producten" }); continue; }
      if (f.item.private_to) { out.skipped.push({ id, why: "privé" }); continue; }
      reason = "genoemd";
    }
    if (!reason) continue;
    const meaning = junkMeaning(id, facts);
    if (meaning?.into) out.merges.push({ from: id, into: meaning.into, reason });
    else if (meaning?.ask) out.asks.push({ from: id, into: meaning.ask, reason });
    else out.removes.push({ id, reason });
  }
  return out;
}

/** The ops of a plan: merges first, then removals. */
export function junkOps(plan, today = localToday()) {
  return [
    ...plan.merges.map((m) => ({ op_id: mergeOpId(m.from, m.into), type: "item.merge", from_item_id: m.from, into_item_id: m.into, on: today })),
    ...plan.removes.map((r) => ({ op_id: removeOpId(r.id), type: "item.remove", item_id: r.id, on: today, reason: r.reason })),
  ];
}

const KIND_NL = { entries: "lijstregels", aliases: "andere namen", pantry: "voorraadregels", purchases: "aankopen", preferences: "vaste keuzes", deal_rules: "deal-regels", pending_takes: "open kookregels" };

/** The dry run as text: what is merged, what goes (with what goes along), what is only asked. */
export function planText(data, plan, outcomes) {
  const name = (id) => data.items[id]?.name ?? id;
  const lines = [];
  const along = (o) => Object.entries(o?.result?.removed ?? {}).filter(([, n]) => n).map(([k, n]) => `${n} ${KIND_NL[k] ?? k}`).join(", ");
  lines.push(`SAMENVOEGEN (${plan.merges.length}):`);
  for (const m of plan.merges) lines.push(`  ${name(m.from)} -> ${name(m.into)}`);
  lines.push(`WEG (${plan.removes.length}):`);
  plan.removes.forEach((r, i) => {
    const o = outcomes[plan.merges.length + i];
    lines.push(`  ${name(r.id)} (${r.reason})${o?.ok ? (along(o) ? `: ${along(o)}` : ": alleen de naam") : `: GEWEIGERD ${o?.error ?? ""}`}`);
  });
  if (plan.asks.length) {
    lines.push(`VRAAG, NIET AANGERAAKT (${plan.asks.length}):`);
    for (const a of plan.asks) lines.push(`  ${name(a.from)} samenvoegen met ${name(a.into)}?`);
  }
  if (plan.skipped.length) {
    lines.push(`OVERGESLAGEN (${plan.skipped.length}):`);
    for (const s of plan.skipped) lines.push(`  ${name(s.id)}: ${s.why}`);
  }
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const write = args.indexOf("--write");
  const listed = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  for (const flag of ["--name", "--keep"]) {
    if (listed(flag).some((x) => !x || x.startsWith("--"))) throw new Error(`${flag} needs an item name, e.g. ${flag} "Lunch"`);
  }
  const named = write >= 0 ? args[write + 1] : args.find((a) => /^https?:\/\//.test(a));
  if (write >= 0 && !/^https?:\/\//.test(named ?? "")) throw new Error("--write needs an origin, e.g. https://groceries.vexed.works");
  const origin = (named ?? "https://groceries.vexed.works").replace(/\/$/, "");
  const token = readToken();
  const res = await fetch(`${origin}/api/sync`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`/api/sync: ${res.status}`);
  const data = stateOf(await res.json());
  const plan = junkPlan(data, { names: listed("--name"), keepNames: listed("--keep") });
  const ops = junkOps(plan);
  const outcomes = simulate(data, ops);
  console.log(`Against ${origin}: ${Object.keys(data.items).length} items.\n`);
  console.log(planText(data, plan, outcomes));
  const refused = outcomes.filter((o) => !o.ok);
  if (refused.length) {
    console.log(`\n${refused.length} op(s) would be refused: nothing is sent, also not with --write.`);
    process.exitCode = 1;
  } else if (write < 0) {
    console.log(`\nDry run: nothing written. Add --write <origin> to send ${ops.length} ops.`);
  } else {
    console.log(`\nSending ${ops.length} ops to ${origin}...`);
    const failed = await pushOps(ops, origin, token);
    console.log(`\nSent ${ops.length}; refused ${failed.length}.`);
    if (failed.length) { console.log(JSON.stringify(failed)); process.exitCode = 1; }
  }
}
