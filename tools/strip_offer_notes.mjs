// One-off: list lines whose note is nothing but an offer the Deals tab wrote
// ("Dirk · -37% t/m 3 nov", public/shared/deals.js dealNote) get an empty
// note. Since 30-10-2026 a line's offers are shown live (liveLineOffers), so
// that text only goes stale. A note with anything of a person's own in it is
// left alone (public/shared/store-prices.js isDealNote: the whole note must be
// "<store> · … t/m <day> <month>").
//
//     node tools/strip_offer_notes.mjs [origin]          dry run (default https://groceries.vexed.works)
//     node tools/strip_offer_notes.mjs --write <origin>  send the entry.update ops
//
// Reads /api/sync; the token comes from tools/import_ah.mjs readToken and is
// never printed. Op ids are stable per line and note: a second --write is a replay.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDealNote } from "../public/shared/store-prices.js";
import { stableId } from "./import_todo.mjs";
import { pushOps, readToken } from "./import_ah.mjs";

/** The ops for the live lines (open or in the basket) whose note is only an offer. */
export function stripOps(entries) {
  return entries
    .filter((e) => e && !e.deleted_at && isDealNote(e.note))
    .map((e) => ({ op_id: stableId("op", `strip_offer_notes:${e.id}:${e.note}`), type: "entry.update", id: e.id, note: "" }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const write = args.indexOf("--write");
  const named = write >= 0 ? args[write + 1] : args.find((a) => /^https?:\/\//.test(a));
  if (write >= 0 && !/^https?:\/\//.test(named ?? "")) throw new Error("--write needs an origin, e.g. https://groceries.vexed.works");
  const origin = (named ?? "https://groceries.vexed.works").replace(/\/$/, "");
  const token = readToken();
  const res = await fetch(`${origin}/api/sync`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`/api/sync: ${res.status}`);
  const { entries = [] } = await res.json();
  const ops = stripOps(entries);
  const byId = new Map(entries.map((e) => [e.id, e]));
  console.log(`Against ${origin}: ${ops.length} line(s) with only an offer as note.`);
  for (const op of ops) console.log(`- ${byId.get(op.id).title}: "${byId.get(op.id).note}"`);
  if (write < 0) {
    console.log("\nDry run: nothing written. Add --write <origin> to empty these notes.");
  } else if (ops.length) {
    const failed = await pushOps(ops, origin, token, { progress: () => {} });
    console.log(`Sent ${ops.length}; refused ${failed.length}.`);
    if (failed.length) process.exitCode = 1;
  }
}
