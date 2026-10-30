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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyOp, emptyState, KINDS, OpError } from "../public/shared/ops.js";
import { nameKey, splitPrep } from "../public/shared/ingredients.js";
import { canonicalName, GENERIC } from "../public/shared/item-names.js";
import { numberForms, VARIETIES } from "../public/shared/ingredient-match.js";
import { isExcluded, isExcludedLookalike } from "../public/shared/excluded.js";
import { localToday } from "../public/shared/intervals.js";
import { stableId } from "./import_todo.mjs";
import { pushOps, readToken } from "./import_ah.mjs";

/** Two items bought this often are both established: a link between them is Thomas's call. */
export const HEAVY = 5;

/** Words that never make another product of an item name (sizes, packs, organic, how ripe). */
export const CLEAR_WORDS = new Set([
  "groot", "grote", "klein", "kleine", "middelgrote", "biologisch", "biologische", "bio", "losse", "los",
  "rijp", "rijpe", "eetrijp", "belegen", "large", "small", "medium",
  "verpakking", "formaat", "blik", "blikje", "blikken", "pak", "pakje", "pakken", "doos", "doosje",
  "zak", "zakje", "fles", "flesje", "pot", "potje", "bakje", "stuks", "stuk", "st",
]);

/** Words that may make another product: dropped only as a doubt ("gember gemalen", "gedroogde linzen", "verse pasta"). */
export const DOUBT_WORDS = new Set([
  "gemalen", "gedroogd", "gedroogde", "vers", "verse", "fresh", "pittig", "pittige", "jong", "jonge", "oud", "oude", "extra",
]);

/** Words around a line that say nothing about the product. */
const FILLER = [
  /\bhebben we nog(?: denk)?\b/g, /\bdenk ik\b/g, /\b(?:maybe|misschien|mss|fzo|evt|eventueel)\b/g,
  /^alles voor\s+/, /\buit (?:blik|pot)\b/g, /\bvoor (?:het serveren|op de burger)\b/g,
];

/** A count or weight as a whole word: "2", "500g", "400 g", "8st", "x2", "2x". Litres, cm and % stay: bags and yoghurt differ by them. */
const COUNT = /^(?:\d+(?:[.,]\d+)?(?:g|gr|gram|kg|mg|ml|cl|st|stuks|x)?|x\d+|x)$/;
const UNIT_AFTER_NUMBER = /^(?:g|gr|gram|kg|mg|ml|cl|st|stuks|x)$/;

/** Several things in one line: "Pizza? Geraspte kaas?", "a of b", "a/b", "a en b", "a + b". */
const SEVERAL = /\?\s*\S|\s(?:of|en|and|or|en\/of)\s|\/|\+|&|;|,/i;
const PART_SPLIT = /\?+\s*|\s+(?:en\/of|of|en|and|or)\s+|\/|\+|&|;|,/i;

/** Varieties that are the product itself (no own buying): a flour tortilla is a tortilla. Compact keys. */
export const CLEAR_VARIETIES = [["bloem", "tortilla"]];

/** Names that may be one product; Thomas decides (compact keys, singular). */
export const DOUBT_SYNONYMS = [["tortilla", "wrap"], ["gehaktetomaat", "tomatenblokjes"]];

/**
 * The name as a comparable key and what was dropped to get there:
 * { key, compact, doubt: [reasons], several: [part names] | null }.
 * `key` keeps spaces (for words), `compact` drops them ("gerasptekaas").
 */
export function cleanName(name) {
  let text = String(name ?? "").replace(/[’‘`´]/g, "'").replace(/[¿¡]/g, "?");
  const doubt = [];
  // Markers of the old lists: "x tomaat", "- Tomaat", "• guacamole".
  text = text.replace(/^(?:\s*(?:[-–•·*]+|x)\s+)+/i, "").trim();
  if (/\([^)]*\)/.test(text)) doubt.push("tekst tussen haakjes");
  text = text.replace(/\([^)]*\)/g, " ");
  // "Tomaat, voor op de burger", "Rode ui, in ringen": the preparation is no product.
  text = splitPrep(text).name;
  text = text.replace(/[?!]+\s*$/, "").trim();
  const several = SEVERAL.test(text) ? text.split(PART_SPLIT).map((x) => x.trim()).filter(Boolean) : null;
  // "avocado's", "tortilla's" (the apostrophe plural) and "10%" (kept as a word).
  text = text.toLowerCase().replace(/'s\b/g, "").replace(/(\d+)\s*%/g, " $1pct ");
  for (const re of FILLER) text = text.replace(re, " ");
  const purpose = text.match(/\s+voor\s+.+$/);
  if (purpose && !several) {
    doubt.push(`"${purpose[0].trim()}"`);
    text = text.slice(0, purpose.index);
  }
  const words = nameKey(text).split(" ").filter(Boolean);
  const kept = [];
  for (const [i, w] of words.entries()) {
    if (COUNT.test(w) || CLEAR_WORDS.has(w)) continue;
    if (UNIT_AFTER_NUMBER.test(w) && i > 0 && /^\d/.test(words[i - 1])) continue;
    if (DOUBT_WORDS.has(w)) { doubt.push(`"${w}"`); continue; }
    kept.push(w);
  }
  const key = kept.join(" ");
  return { key, compact: key.replace(/ /g, ""), doubt, several: several && several.length > 1 ? several : null };
}

/** Damerau-Levenshtein distance up to `max` (more is max + 1). */
export function typoDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

/** Two compact keys that look like one typed twice: long enough, same start, at most 1 (or 2 from 12 letters) apart. */
function looksLikeTypo(a, b) {
  if (a === b || Math.min(a.length, b.length) < 8 || a.slice(0, 5) !== b.slice(0, 5)) return false;
  // One the other plus letters is another product (tomatenpuree / tomatenpureesaus), not a typo.
  if (a.startsWith(b) || b.startsWith(a)) return false;
  if (/\d/.test(a) || /\d/.test(b)) return false;
  return typoDistance(a, b, 2) <= (Math.min(a.length, b.length) >= 12 ? 2 : 1);
}

const hasOwnRate = (i) => i.use_per_day !== null && i.use_per_day !== undefined && (i.rate_source === "person" || i.rate_source === "learned");

/** Per item: purchases, stock (live pantry amount), deal rules, its own rate. */
export function itemFacts(data) {
  const facts = {};
  for (const i of Object.values(data.items)) {
    if (i.deleted_at) continue;
    facts[i.id] = { item: i, bought: 0, stock: 0, rules: 0, rate: hasOwnRate(i) };
  }
  for (const p of Object.values(data.purchases ?? {})) if (!p.deleted_at && facts[p.item_id]) facts[p.item_id].bought++;
  for (const r of Object.values(data.pantry ?? {})) if (!r.deleted_at && facts[r.item_id]) facts[r.item_id].stock += Math.max(0, Number(r.amount) || 0);
  for (const r of Object.values(data.deal_rules ?? {})) if (!r.deleted_at && facts[r.item_id]) facts[r.item_id].rules++;
  return facts;
}

const cleanTitle = (name) => !/[?!\d]|^\s*(?:[-–•·*]|x\s)/i.test(name);

/**
 * The item a group merges into: a name in `targets` (the household's choice,
 * --target), then most purchases, then stock, then a deal rule or own rate,
 * then the shortest clean name.
 */
export function pickTarget(ids, facts, targets = new Set()) {
  const chosen = (f) => (targets.has(nameKey(f.item.name)) ? 1 : 0);
  return [...ids].sort((a, b) => {
    const x = facts[a], y = facts[b];
    return (chosen(y) - chosen(x)) || (y.bought - x.bought) || (y.stock - x.stock) || ((y.rules > 0 || y.rate) - (x.rules > 0 || x.rate))
      || (cleanTitle(y.item.name) - cleanTitle(x.item.name)) || (x.item.name.length - y.item.name.length)
      || x.item.name.localeCompare(y.item.name, "nl") || a.localeCompare(b);
  })[0];
}

/** Would merging `from` into `into` throw away a rate or deal rule someone set on `from`? */
function conflict(from, into) {
  const reasons = [];
  if (from.rate && into.rate && from.item.use_per_day !== into.item.use_per_day) reasons.push("eigen verbruik botst");
  if (from.rules && into.rules) reasons.push("deal-regel botst");
  return reasons;
}

/**
 * The merge groups of `data` ({ kind: { id: row } }, live rows):
 * { clear: [group], doubt: [family] } where a group is { target, members:
 * [{ id, reason }] } and a family is { target, groups: [group], extra:
 * [{ id, reason }] } (every member of a family, clear groups included,
 * merges into its target only with --include).
 */
export function planGroups(data, { targets = [], excludes = [] } = {}) {
  const facts = itemFacts(data);
  const chosen = new Set(targets.map((n) => nameKey(n)));
  const left = new Set(excludes.map((n) => nameKey(n)));
  const ids = Object.keys(facts).filter((id) => {
    const name = facts[id].item.name;
    return !isExcluded(name) && !isExcludedLookalike(name) && !GENERIC.has(nameKey(name)) && !left.has(nameKey(name));
  }).sort();
  const clean = Object.fromEntries(ids.map((id) => [id, cleanName(facts[id].item.name)]));
  const usable = ids.filter((id) => clean[id].compact && !GENERIC.has(clean[id].key) && !clean[id].several);
  const leaves = ids.filter((id) => clean[id].several);

  // Union-find twice: clear links, then clear + doubt (the families).
  const parent = {}, family = {};
  const find = (p, x) => (p[x] === x ? x : (p[x] = find(p, p[x])));
  for (const id of usable) parent[id] = family[id] = id;
  const heavyIn = {};
  for (const id of usable) heavyIn[id] = facts[id].bought >= HEAVY ? 1 : 0;
  const doubtLinks = [];
  const linkClear = (a, b, reason) => {
    const ra = find(parent, a), rb = find(parent, b);
    if (ra === rb) return;
    if (heavyIn[ra] + heavyIn[rb] > 1) return linkDoubt(a, b, `${reason}, beide vaak gekocht`);
    parent[rb] = ra;
    heavyIn[ra] += heavyIn[rb];
    unite(a, b);
  };
  const unite = (a, b) => {
    const fa = find(family, a), fb = find(family, b);
    if (fa !== fb) family[fb] = fa;
  };
  const linkDoubt = (a, b, reason) => {
    doubtLinks.push([a, b, reason]);
    unite(a, b);
  };

  // Keys: the clean compact key, and the key without its doubt words dropped separately.
  const byCompact = new Map();
  for (const id of usable) {
    const k = clean[id].compact;
    if (!byCompact.has(k)) byCompact.set(k, []);
    byCompact.get(k).push(id);
  }
  // A member without doubt words is the anchor of its key; one with them joins by doubt.
  for (const [, group] of [...byCompact].sort(([a], [b]) => a.localeCompare(b))) {
    const plain = group.filter((id) => !clean[id].doubt.length);
    const anchor = plain[0] ?? group[0];
    for (const id of group) {
      if (id === anchor) continue;
      if (clean[id].doubt.length || clean[anchor].doubt.length) linkDoubt(anchor, id, `zonder ${[...clean[id].doubt, ...clean[anchor].doubt].join(", ")}`);
      else linkClear(anchor, id, "zelfde naam");
    }
  }
  const keys = [...byCompact.keys()].sort();
  const anchorOf = (k) => byCompact.get(k)?.find((id) => !clean[id].doubt.length) ?? byCompact.get(k)?.[0];
  // Singular/plural and SAME names.
  for (const k of keys) {
    const a = anchorOf(k);
    for (const form of numberForms(k)) if (byCompact.has(form) && form !== k) linkClear(a, anchorOf(form), "enkelvoud/meervoud");
    const same = canonicalName(k).key.replace(/ /g, "");
    if (same !== k && byCompact.has(same)) linkClear(a, anchorOf(same), "zelfde product");
  }
  // Varieties, in either number: clear (bloemtortillas) and the resolver's (rundergehakt ~ gehakt, a doubt here).
  const formsOf = (k) => [k, ...numberForms(k)];
  const productKey = (k, prefix, product) => {
    if (!k.startsWith(prefix) || k.length <= prefix.length) return null;
    const rest = k.slice(prefix.length);
    if (!formsOf(rest).includes(product)) return null;
    return formsOf(product).find((x) => byCompact.has(x)) ?? null;
  };
  for (const k of keys) {
    for (const [prefix, product] of CLEAR_VARIETIES) {
      const to = productKey(k, prefix, product);
      if (to) linkClear(anchorOf(to), anchorOf(k), `soort ${product}`);
    }
    for (const [prefix, product] of VARIETIES) {
      const to = productKey(k, prefix, product);
      if (to) linkDoubt(anchorOf(to), anchorOf(k), `soort ${product}`);
    }
  }
  // Synonyms (both number forms) and typos: doubt.
  for (const [x, y] of DOUBT_SYNONYMS) {
    const xs = keys.filter((k) => formsOf(x).includes(k) || formsOf(k).includes(x));
    const ys = keys.filter((k) => formsOf(y).includes(k) || formsOf(k).includes(y));
    if (xs.length && ys.length) linkDoubt(anchorOf(ys[0]), anchorOf(xs[0]), `${x} ~ ${y}`);
  }
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (looksLikeTypo(keys[i], keys[j])) linkDoubt(anchorOf(keys[i]), anchorOf(keys[j]), "tikfout?");
    }
  }

  // Clear components.
  const comps = new Map();
  for (const id of usable) {
    const r = find(parent, id);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(id);
  }
  // A line naming several things joins the one family its parts name, when they name only one.
  const leafOf = new Map();
  for (const id of leaves) {
    const hits = new Set();
    for (const part of clean[id].several) {
      const c = cleanName(part);
      if (!c.compact || GENERIC.has(c.key)) continue;
      for (const k of formsOf(c.compact)) if (byCompact.has(k)) hits.add(find(family, anchorOf(k)));
    }
    if (hits.size === 1) leafOf.set(id, [...hits][0]);
  }

  const groupOf = (members) => {
    const target = pickTarget(members, facts, chosen);
    const rest = members.filter((id) => id !== target).sort((a, b) => facts[b].bought - facts[a].bought || facts[a].item.name.localeCompare(facts[b].item.name, "nl"));
    return { target, members: rest.map((id) => ({ id, reason: "" })) };
  };
  const clear = [];
  const doubtByFamily = new Map();
  for (const [, members] of comps) {
    const fam = find(family, members[0]);
    const famMembers = usable.filter((id) => find(family, id) === fam);
    const famLeaves = [...leafOf].filter(([, r]) => find(family, r) === fam).map(([id]) => id);
    if (famMembers.length === members.length && !famLeaves.length && members.length > 1) {
      const g = groupOf(members);
      // A member whose own rate or deal rule would lose to the target's: Thomas decides.
      const conflicts = g.members.map((m) => [m, conflict(facts[m.id], facts[g.target])]).filter(([, c]) => c.length);
      if (!conflicts.length) { clear.push(g); continue; }
      g.members = g.members.filter((m) => !conflicts.some(([c]) => c === m));
      if (g.members.length) clear.push(g);
      doubtByFamily.set(fam, { target: g.target, groups: g.members.length ? [g] : [], extra: conflicts.map(([m, c]) => ({ id: m.id, reason: c.join(", ") })) });
      continue;
    }
    if (famMembers.length === 1 && !famLeaves.length) continue;
    if (!doubtByFamily.has(fam)) {
      const all = [...famMembers, ...famLeaves];
      const target = pickTarget(famMembers, facts, chosen);
      doubtByFamily.set(fam, { target, groups: [], extra: [], all });
    }
    const f = doubtByFamily.get(fam);
    if (members.length > 1) {
      const g = groupOf(members);
      // Inside a doubt family a clear group still merges on its own, unless a member conflicts.
      const ok = g.members.filter((m) => !conflict(facts[m.id], facts[g.target]).length);
      for (const m of g.members) if (!ok.includes(m)) f.extra.push({ id: m.id, reason: conflict(facts[m.id], facts[g.target]).join(", ") });
      if (ok.length) { g.members = ok; f.groups.push(g); clear.push(g); }
    }
  }
  const doubt = [];
  for (const [fam, f] of doubtByFamily) {
    const inGroups = new Set(f.groups.flatMap((g) => [g.target, ...g.members.map((m) => m.id)]));
    const famIds = f.all ?? [f.target, ...f.groups.flatMap((g) => [g.target, ...g.members.map((m) => m.id)]), ...f.extra.map((m) => m.id)];
    const links = doubtLinks.filter(([a]) => find(family, a) === fam);
    const linkReason = (id) => links.find(([a, b]) => a === id || b === id)?.[2];
    for (const id of famIds) {
      if (id === f.target || inGroups.has(id) || f.extra.some((m) => m.id === id)) continue;
      f.extra.push({ id, reason: leafOf.has(id) ? "noemt meer dingen" : linkReason(id) ?? linkReason(find(parent, id)) ?? "via een ander lid" });
    }
    for (const g of f.groups) if (g.target !== f.target && !f.extra.some((m) => m.id === g.target)) {
      f.extra.push({ id: g.target, reason: linkReason(g.target) ?? links.map(([, , r]) => r).find((r) => r) ?? "" });
    }
    doubt.push({ target: f.target, groups: f.groups, extra: f.extra.filter((m) => m.id !== f.target) });
  }
  const size = (g) => g.members.length;
  clear.sort((a, b) => size(b) - size(a) || facts[b.target].bought - facts[a.target].bought || facts[a.target].item.name.localeCompare(facts[b.target].item.name, "nl"));
  doubt.sort((a, b) => facts[b.target].bought - facts[a.target].bought || facts[a.target].item.name.localeCompare(facts[b.target].item.name, "nl"));
  return { clear, doubt, facts };
}

/** Every item id of a doubt family except its target. */
export function familyMembers(f) {
  const out = new Set();
  for (const g of f.groups) { out.add(g.target); for (const m of g.members) out.add(m.id); }
  for (const m of f.extra) out.add(m.id);
  out.delete(f.target);
  return [...out];
}

const opId = (from, into) => stableId("op", `dedupe_items:${from}:${into}`);

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
  const groups = planGroups(data, { targets, excludes });
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
