// Pack sizes for the pantry rows that have none (20-11-2026: the
// pantry is "uit balans"; 87 rows had no pack size, so a recipe amount was
// compared by guessing). A row without a pack_size gets the household's own
// pack of its item (householdPack in public/shared/pantry.js: the row's
// product, the item's preferences, the product bought most often), through
// sizeFor: never when the household knows none, and never a pack counted in
// pieces on a row holding more than 1 (that row counts pieces itself). The
// amount never changes. One pantry.update { id, pack_size, on } per row; the
// engine settles a counted-down item first, so today's amount stays.
//
//     node tools/fill_pantry_sizes.mjs [origin]          dry run (default https://groceries.vexed.works)
//     node tools/fill_pantry_sizes.mjs --write <origin>  send the ops
//
// The ops run through the op engine on a copy of the live data first; op ids
// are stable, so a second --write is a replay. The token comes from mcp/.env
// (tools/import_ah.mjs readToken) and is never printed. The coordinator runs
// it, after the dry run was read.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyOp, OpError } from "../public/shared/ops.js";
import { liveRows, sizeFor } from "../public/shared/pantry.js";
import { localToday } from "../public/shared/intervals.js";
import { stableId } from "./import_todo.mjs";
import { pushOps, readToken } from "./import_ah.mjs";
import { stateOf } from "./dedupe_items.mjs";

/** The op id of giving one row its size: the same on every run. */
export const sizeOpId = (rowId, size) => stableId("op", `fill_pantry_sizes:${rowId}:${size}`);

/**
 * What would change: [{ row, pack_size }] for every live row without a size
 * whose household pack is known (sizeFor), by title. Never an excluded thing
 * (liveRows). data: the engine's state.
 */
export function planSizes(data) {
  return liveRows(data.pantry)
    .map((row) => ({ row, pack_size: sizeFor(data, row) }))
    .filter((x) => x.pack_size)
    .sort((a, b) => a.row.title.localeCompare(b.row.title, "nl") || a.row.id.localeCompare(b.row.id));
}

/** The pantry.update ops of a plan. */
export function sizeOps(plan, today) {
  return plan.map(({ row, pack_size }) => ({ op_id: sizeOpId(row.id, pack_size), type: "pantry.update", id: row.id, pack_size, on: today }));
}

/** Run the ops through the op engine on a copy of `data`, as the server will. Never sends anything. */
export function simulate(data, ops, now = new Date().toISOString()) {
  const state = structuredClone(data);
  return ops.map((op) => {
    try {
      applyOp(state, op, { memberId: "fill-pantry-sizes", isAdmin: true, now });
      const row = state.pantry[op.id];
      return { ok: true, amount: row?.amount ?? null };
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      return { ok: false, error: e.code };
    }
  });
}

/* --------------------------------------------------------------- CLI */

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const write = args.indexOf("--write");
  const named = write >= 0 ? args[write + 1] : args.find((a) => /^https?:\/\//.test(a));
  if (write >= 0 && !/^https?:\/\//.test(named ?? "")) throw new Error("--write needs an origin, e.g. https://groceries.vexed.works");
  const origin = (named ?? "https://groceries.vexed.works").replace(/\/$/, "");
  const token = readToken();
  const res = await fetch(`${origin}/api/sync`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`/api/sync: ${res.status}`);
  const data = stateOf(await res.json());
  const unsized = liveRows(data.pantry).filter((r) => !r.pack_size).length;
  const plan = planSizes(data);
  const ops = sizeOps(plan, localToday());
  const outcomes = simulate(data, ops);
  console.log(`Against ${origin}: ${unsized} pantry rows without a pack size; ${plan.length} get the household's pack.\n`);
  plan.forEach(({ row, pack_size }, i) => {
    const o = outcomes[i];
    console.log(`  ${row.title} (${row.amount}) -> ${pack_size}${o.ok ? (o.amount === row.amount ? "" : `  [amount ${row.amount} -> ${o.amount}: settled]`) : `  REFUSED: ${o.error}`}`);
  });
  const refused = outcomes.filter((o) => !o.ok);
  if (refused.length) {
    console.log(`\n${refused.length} op(s) would be refused: nothing is sent, also not with --write.`);
    process.exitCode = 1;
  } else if (write < 0) {
    console.log("\nDry run: nothing written. Add --write <origin> to send them.");
  } else if (ops.length) {
    console.log(`\nSending ${ops.length} ops to ${origin}...`);
    const failed = await pushOps(ops, origin, token);
    console.log(`Sent ${ops.length}; refused ${failed.length}.`);
    if (failed.length) { console.log(JSON.stringify(failed)); process.exitCode = 1; }
  }
}
