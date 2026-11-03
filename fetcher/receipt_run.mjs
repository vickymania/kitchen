// The run shared by the cookie-session receipt imports on the home server
// (fetcher/action_import.mjs, fetcher/kruidvat_import.mjs), on the Lidl
// pattern: a state folder (mode 700) with sent.json per origin and the item
// names, a pull into its cache, ops built by tools/import_ah.mjs buildOps,
// sent through /api/ops with the importer token, sent.json written only after
// every op was accepted. Nothing here prints a token or a cookie.
import fs from "node:fs";
import path from "node:path";
import { addDays } from "../public/shared/shelf-life.js";
import { pushOps, readSent, vocabulary, writeNewPurchases, writeSent, PANTRY_DAYS } from "../tools/import_ah.mjs";
import { isOwn, readOwners } from "../tools/import_lidl.mjs";

export const TITLES_FILE = "history-titles.json";

const readJson = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback);
const count = (ops, type) => ops.filter((o) => o.type === type).length;

/** The state folder with an empty sent.json for `origin` and the item names. Refuses to replace a sent.json. */
export function initState({ stateDir, origin, titlesFrom }) {
  if (fs.existsSync(path.join(stateDir, "sent.json"))) throw new Error(`${path.join(stateDir, "sent.json")} exists already`);
  if (!fs.existsSync(titlesFrom)) throw new Error(`no ${titlesFrom}: seed the AH state first (node fetcher/ah-seed.mjs)`);
  fs.mkdirSync(path.join(stateDir, "receipts"), { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);
  fs.copyFileSync(titlesFrom, path.join(stateDir, TITLES_FILE));
  fs.writeFileSync(path.join(stateDir, "sent.json"), JSON.stringify({ [origin]: [] }, null, 1));
  return stateDir;
}

export function readTokenFile(file, how) {
  try {
    const token = fs.readFileSync(file, "utf8").trim();
    if (token.length >= 20) return token;
  } catch {
    // handled below
  }
  throw new Error(`no token in ${file}: run "${how}" first`);
}

/**
 * One run. `pull(stateDir, say)` fills the cache; `build(stateDir, origin,
 * titles, today)` returns newReceiptOps' shape ({ ops, only, totals, account,
 * own, otherPeople, all }); `preview(built)` is the dry run's preview.txt.
 * Returns { sent, newReceipts }.
 */
export async function runImport(mode, { label, script, stateDir, origin, pull, build, preview, post = fetch, token = null, tokenFile, today, log: say }) {
  const sentFile = path.join(stateDir, "sent.json");
  if (!fs.existsSync(sentFile)) throw new Error(`no ${sentFile}: run "node ${script} init" first`);
  if (!Object.hasOwn(readJson(sentFile, {}), origin)) throw new Error(`sent.json has no entry for ${origin}: made for another origin?`);
  const titlesFile = path.join(stateDir, TITLES_FILE);
  if (!fs.existsSync(titlesFile)) throw new Error(`no ${titlesFile}: run "node ${script} init" first`);
  const titles = JSON.parse(fs.readFileSync(titlesFile, "utf8"));

  await pull(stateDir, (line) => say("pull", line));
  const built = build(stateDir, origin, titles, today);
  const { ops } = built;
  // For the nightly check (fetcher/review.mjs): what this run found new, sent or not.
  writeNewPurchases(stateDir, built, mode === "push" ? label : `${label} (dry run, not sent)`);
  say(`receipts: ${built.account} on the account, ${built.own} own, ${built.otherPeople} someone else's (left out); new: ${built.only.size}`);
  say(`ops: ${ops.length} (${count(ops, "receipt.save")} receipts, ${count(ops, "purchase.add")} purchases, ${ops.filter((o) => o.pantry).length} of them into the pantry, ${count(ops, "product.put")} products, ${count(ops, "preference.set")} preferences; ${built.totals.other} lines kept on the receipt only)`);
  if (mode === "dry-run") {
    fs.writeFileSync(path.join(stateDir, "preview.txt"), preview(built));
    say(`dry-run: nothing sent; ${path.join(stateDir, "preview.txt")} written`);
    return { sent: 0, newReceipts: built.only.size };
  }
  if (!built.only.size) {
    say("no new receipts");
    return { sent: 0, newReceipts: 0 };
  }
  const failed = await pushOps(ops, origin, token ?? readTokenFile(tokenFile, "node fetcher/ah_import.mjs pair"), { post, progress: () => {} });
  if (failed.length) {
    // sent.json is not written: the next run tries these receipts again (the ops are idempotent).
    throw new Error(`refused: ${failed.length} ops, first ${JSON.stringify(failed.slice(0, 5))}`);
  }
  writeSent(stateDir, origin, built.only);
  say(`sent ${ops.length} ops for ${built.only.size} receipts`);
  return { sent: ops.length, newReceipts: built.only.size };
}

/** The "kept on the receipt only" part of a preview: one line per such line, with its day and price. */
export function otherLinesText(all) {
  const fmt = (c) => (c === null || c === undefined ? "?" : `€${(c / 100).toFixed(2).replace(".", ",")}`);
  return all.flatMap((r) => r.lines.filter((l) => l.kind === "other").map((l) => `${r.day}  ${String(l.receiptName).padEnd(50)} ${fmt(l.price_cents)}`));
}

/**
 * The ops for Thomas's receipts in `dir` not yet sent to `origin`:
 * `readCache(dir)` gives every cached receipt (normalised, oldest first),
 * `build(receipts, vocab, { only, pantrySince })` the store's buildOps.
 */
export function newOps(dir, origin, { titles, today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" }), readCache, build }) {
  const all = readCache(dir);
  const owners = readOwners(dir);
  const receipts = all.filter((r) => isOwn(r, owners));
  const sent = readSent(dir, origin);
  const only = new Set(receipts.map((r) => r.id).filter((id) => !sent.has(id)));
  const built = build(receipts, vocabulary(titles), { only, pantrySince: addDays(today, -PANTRY_DAYS) });
  return { ...built, only, all, account: all.length, own: receipts.length, otherPeople: all.length - receipts.length };
}

/** The dry run's preview.txt: counts, every product and its item, the lines kept on the receipt only. */
export function previewText(store, built, hint) {
  const pad = (s, n) => String(s).padEnd(n);
  const all = built.all ?? [];
  const others = otherLinesText(all);
  return [
    `${store} import preview (${new Date().toISOString().slice(0, 10)})`,
    "",
    `Receipts on the account: ${all.length}; own: ${built.own ?? "?"}; towns: ${[...new Set(all.map((r) => r.city ?? "(unknown)"))].join(", ") || "none"}`,
    `Product lines: ${built.totals.lines}   products: ${built.products.length}   kept on the receipt only: ${built.totals.other}   excluded: ${built.totals.excluded}`,
    `Ops: ${built.ops.length} (${count(built.ops, "receipt.save")} receipts, ${count(built.ops, "purchase.add")} purchases, ${built.ops.filter((o) => o.pantry).length} into the pantry)`,
    ...(built.notes?.length ? ["", "== Notes ==", ...built.notes] : []),
    "",
    "== Every product -> item (kind, how) ==",
    ...built.products.map((p) => `${pad(p.item, 26)} ${pad(`${p.kind ?? "?"} ${p.how}`, 22)} ${p.brand ? `${p.brand} ` : ""}${p.name}${p.size ? ` (${p.size})` : ""}  ${p.receipts.size}x`),
    "",
    `== Kept on the receipt only, no product or pantry (${others.length}): ${hint} ==`,
    ...others,
  ].join("\n");
}
