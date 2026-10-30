// Which items are one thing, from their names alone (30-10-2026):
// the grouping of tools/dedupe_items.mjs, shared with the nightly check
// (fetcher/review.mjs merges the CLEAR groups itself, at most
// NIGHTLY_MERGE_MAX a night) and the worker (worker/api.js checks every merge
// the reviewer device sends with clearPair and mergeProblem). Deterministic:
// the same items give the same groups everywhere. The rules themselves are
// described at the top of tools/dedupe_items.mjs.
import { nameKey, splitPrep } from "./ingredients.js";
import { canonicalName, GENERIC } from "./item-names.js";
import { numberForms, VARIETIES } from "./ingredient-match.js";
import { isExcluded, isExcludedLookalike } from "./excluded.js";
import { apartPair } from "./ops.js";

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

/** Per item: purchases, stock (live pantry amount), deal rules, its own rate, its products. */
export function itemFacts(data) {
  const facts = {};
  for (const i of Object.values(data.items)) {
    if (i.deleted_at) continue;
    facts[i.id] = { item: i, bought: 0, stock: 0, rules: 0, rate: hasOwnRate(i), products: 0 };
  }
  for (const p of Object.values(data.purchases ?? {})) if (!p.deleted_at && facts[p.item_id]) facts[p.item_id].bought++;
  for (const p of Object.values(data.products ?? {})) if (!p.deleted_at && facts[p.item_id]) facts[p.item_id].products++;
  for (const r of Object.values(data.pantry ?? {})) if (!r.deleted_at && facts[r.item_id]) facts[r.item_id].stock += Math.max(0, Number(r.amount) || 0);
  for (const r of Object.values(data.deal_rules ?? {})) if (!r.deleted_at && facts[r.item_id]) facts[r.item_id].rules++;
  return facts;
}

const cleanTitle = (name) => !/[?!\d]|^\s*(?:[-–•·*]|x\s)/i.test(name);

/**
 * A name no group should be called by (30-10-2026: "namen met een
 * vraagteken zijn natuurlijk bullshit voor een overkoepelende naam"): a
 * question mark, a list marker ("x ", "- ") or a filler word of the old lists
 * (maybe, misschien, fzo, denk...).
 */
export function junkName(name) {
  const s = String(name ?? "");
  return /[?¿]/.test(s) || /^\s*(?:[-–•·*]|x\s)/i.test(s)
    || /(?:^|[^\p{L}])(?:maybe|misschien|mss|fzo|denk|evt|eventueel)(?=$|[^\p{L}])/iu.test(s);
}

/* ------------------------------------------- the household's decisions */

/** The key of two names kept apart (item_decisions kind apart). */
export const apartKey = (a, b) => apartPair(a, b).join("|");

/**
 * The household's decisions (item_decisions rows, live) as sets the rules
 * read: apart (name-key pairs), noRename (item ids), keep (item ids: no
 * junk), noAlias ("name key|item id"), noMove ("product id|item id").
 */
export function decisionSets(rows) {
  const out = { apart: new Set(), noRename: new Set(), keep: new Set(), noAlias: new Set(), noMove: new Set() };
  for (const d of Object.values(rows ?? {})) {
    if (!d || d.deleted_at) continue;
    if (d.kind === "apart") out.apart.add(`${d.a}|${d.b}`);
    else if (d.kind === "no_rename") out.noRename.add(d.a);
    else if (d.kind === "keep") out.keep.add(d.a);
    else if (d.kind === "no_alias") out.noAlias.add(`${d.a}|${d.b}`);
    else if (d.kind === "no_move") out.noMove.add(`${d.a}|${d.b}`);
  }
  return out;
}

/* ------------------------------------------------------- junk names */

/** First words that make a line vague: "Iets op stokbroodje", "Ander fizzy", "Meer tapas". */
export const VAGUE_LEAD = new Set(["iets", "ander", "andere", "anders", "meer", "nog", "wat", "something", "other", "more"]);
/** Words that name no product on their own: a line of only these is vague ("Lunch", "Drankje", "Electronica bak"). */
export const VAGUE_WORDS = new Set([
  "lunch", "ontbijt", "avondeten", "abendessen", "abundessen", "diner", "eten", "drinken", "drankje", "drankjes",
  "snack", "snacks", "snackje", "tussendoortje", "fizzy", "electronica", "elektronica", "bak", "spullen", "dingen",
  "boodschappen", "iets", "lekkers", "food", "drink", "drinks", "stuff",
]);

/**
 * Why a name is no thing (30-10-2026: "die generic dingen horen niet
 * eens in mijn database"), or null: shouting ("Kattenbak!!!"), several
 * things in one line, a vague first word ("Iets op stokbroodje") or only
 * vague words ("Lunch", "Electronica bak"). A question mark alone is no junk:
 * "Knoflookpoeder?" is a thing with a bad spelling (tidyName).
 */
export function junkReason(name) {
  const s = String(name ?? "");
  if (/!{2,}/.test(s)) return "uitroeptekens";
  const c = cleanName(s);
  if (c.several) return "meer dingen";
  const words = nameKey(s.replace(/[!?¿¡]/g, " ")).split(" ").filter(Boolean);
  if (!words.length) return "leeg";
  if (words.length > 1 && VAGUE_LEAD.has(words[0])) return "vaag";
  if (words.every((w) => VAGUE_WORDS.has(w))) return "vaag";
  return null;
}

/**
 * Is this item junk the nightly check may clean up, and why (or null)? Its
 * name says so (junkReason), and it is no real thing in the data: never
 * bought as a product (no product row: the old To Do lines are notes), no
 * deal rule, no rate of its own, not private, nothing on the never-suggest
 * list, and the household did not undo its removal (decision keep).
 */
export function junkItem(f, { keep = new Set() } = {}) {
  const name = f?.item?.name ?? "";
  if (!f || f.item.private_to || keep.has(f.item.id) || isExcluded(name) || isExcludedLookalike(name)) return null;
  if (f.products > 0 || f.rules > 0 || f.rate) return null;
  return junkReason(name);
}

/** A junk name without its noise: "Eten minoes!!!!!" -> "Eten minoes". */
const plainOf = (name) => String(name ?? "").replace(/[!?¿¡]+/g, " ").replace(/\s+/g, " ").trim();
const sortedWords = (name) => {
  const key = cleanName(plainOf(name)).key;
  return key ? key.split(" ").sort().join(" ") : "";
};

/**
 * Does junk name `junk` clearly mean the item named `name`? The same words
 * in another order ("Eten minoes!!!" is "Minoes eten"), or the name without
 * its noise is a CLEAR pair with it ("Kattenbakvulling!!!"). Never a guess.
 */
export function junkMeans(junk, name) {
  if (!junkReason(junk) || junkReason(name)) return false;
  const plain = plainOf(junk);
  if (!plain || junkReason(plain) === "meer dingen") return false;
  const a = sortedWords(plain);
  return Boolean(a) && (a === sortedWords(name) || clearPair(plain, name));
}

/**
 * What a junk item means among the live items: { into } when exactly one
 * other item is clearly it (junkMeans), { ask } when exactly one other
 * name starts with it and is longer ("Kattenbak!!!" and "Kattenbakvulling":
 * the household decides), else null (it goes).
 */
export function junkMeaning(id, facts) {
  const name = facts[id].item.name;
  const others = Object.keys(facts).filter((x) => x !== id && !facts[x].item.private_to && !junkReason(facts[x].item.name));
  const sure = others.filter((x) => junkMeans(name, facts[x].item.name));
  if (sure.length === 1) return { into: sure[0] };
  if (sure.length > 1) return { ask: pickTarget(sure, facts) };
  const compact = cleanName(plainOf(name)).compact;
  if (compact.length < 6) return null;
  const starts = others.filter((x) => {
    const c = cleanName(facts[x].item.name).compact;
    return c.length > compact.length && c.startsWith(compact);
  });
  return starts.length === 1 ? { ask: starts[0] } : null;
}

/**
 * The tidy spelling of a name that only a question mark spoils ("Knoflookpoeder?"
 * -> "Knoflookpoeder"), or null: the same key (item.rename allows nothing
 * else), one thing (not "Taart? Pruimen?"), no other junk.
 */
export function tidyName(name) {
  const s = String(name ?? "").trim();
  const m = s.match(/^[¿?\s]*([^?¿]+?)[?¿!\s]*$/);
  if (!m || m[1] === s) return null;
  const tidy = m[1].trim().replace(/\s+/g, " ");
  const out = tidy.charAt(0).toLocaleUpperCase("nl") + tidy.slice(1);
  if (!out || nameKey(out) !== nameKey(s) || junkName(out) || cleanName(out).several) return null;
  return out;
}

/**
 * The item a group merges into: a name in `targets` (the household's choice,
 * --target), then a name that is no junk (junkName), then most purchases,
 * then stock, then a deal rule or own rate, then the shortest clean name.
 */
export function pickTarget(ids, facts, targets = new Set()) {
  const chosen = (f) => (targets.has(nameKey(f.item.name)) ? 1 : 0);
  const decent = (f) => (junkName(f.item.name) || junkReason(f.item.name) ? 0 : 1);
  return [...ids].sort((a, b) => {
    const x = facts[a], y = facts[b];
    return (chosen(y) - chosen(x)) || (decent(y) - decent(x)) || (y.bought - x.bought) || (y.stock - x.stock) || ((y.rules > 0 || y.rate) - (x.rules > 0 || x.rate))
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
export function planGroups(data, { targets = [], excludes = [], apart = new Set() } = {}) {
  const facts = itemFacts(data);
  // Two names the household keeps apart (item_decisions) are never linked, clear or doubt.
  const isApart = (a, b) => apart.size > 0 && apart.has(apartKey(facts[a].item.name, facts[b].item.name));
  const chosen = new Set(targets.map((n) => nameKey(n)));
  const left = new Set(excludes.map((n) => nameKey(n)));
  const ids = Object.keys(facts).filter((id) => {
    const name = facts[id].item.name;
    // A private item is nobody's duplicate: it is left out of every group.
    return !facts[id].item.private_to && !isExcluded(name) && !isExcludedLookalike(name) && !GENERIC.has(nameKey(name)) && !left.has(nameKey(name));
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
    if (isApart(a, b)) return;
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
    if (isApart(a, b)) return;
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

/* ------------------------------------------------- the nightly check */

/** At most this many item.merge ops a day from the nightly check (fetcher/review.mjs; worker/api.js counts them in usage_limits). */
export const NIGHTLY_MERGE_MAX = 10;
/** At most this many names tidied a night (item.rename, tidyName). */
export const NIGHTLY_RENAME_MAX = 10;
/** At most this many junk items removed a night (item.remove; worker/api.js counts them in usage_limits). */
export const NIGHTLY_REMOVE_MAX = 10;

/** The compact keys a name stands for by the CLEAR rules alone, or null when it has a doubt word, a purpose, several things or is generic. */
function clearForms(name) {
  const c = cleanName(name);
  if (!c.compact || c.doubt.length || c.several || GENERIC.has(c.key) || GENERIC.has(nameKey(name))) return null;
  const out = new Set();
  const add = (k) => { for (const f of [k, ...numberForms(k)]) out.add(f); };
  add(c.compact);
  add(canonicalName(c.compact).key.replace(/ /g, ""));
  for (const [prefix, product] of CLEAR_VARIETIES) {
    const rest = c.compact.startsWith(prefix) ? c.compact.slice(prefix.length) : "";
    if (rest && [rest, ...numberForms(rest)].includes(product)) add(product);
  }
  return out;
}

/**
 * Are these two names one product by the CLEAR rules, pairwise: the same
 * clean name, singular/plural, a SAME name or a clear variety, neither with
 * a doubt word, never generic, never on the never-suggest list? The worker
 * checks every merge of the reviewer device with it; the nightly check
 * sends only pairs that pass (a link through a third name does not count).
 */
export function clearPair(a, b) {
  for (const n of [a, b]) if (isExcluded(n) || isExcludedLookalike(n)) return false;
  const x = clearForms(a), y = clearForms(b);
  if (!x || !y) return false;
  for (const k of x) if (y.has(k)) return true;
  return false;
}

/**
 * Why the nightly check may not merge `from` into `into`, or null. Both are
 * facts as itemFacts makes them ({ item, bought, rules, rate }): an
 * excluded name, no clear pair, two established items (HEAVY), two own
 * rates that differ, two deal rules. The same answer on the home server and
 * in the worker.
 */
export function mergeProblem(from, into, { apart = new Set() } = {}) {
  const a = from.item.name, b = into.item.name;
  if ([a, b].some((n) => isExcluded(n) || isExcludedLookalike(n))) return "excluded";
  // A private item (items.private_to) never merges with a public one or another member's.
  if ((from.item.private_to ?? null) !== (into.item.private_to ?? null)) return "private";
  // "Apart houden", or a merge the household undid.
  if (apart.has(apartKey(a, b))) return "apart";
  // A junk name that clearly means the other ("Eten minoes!!!" -> "Minoes eten") counts as clear.
  if (!clearPair(a, b) && !junkMeans(a, b)) return "not_clear";
  if (from.bought >= HEAVY && into.bought >= HEAVY) return "both_heavy";
  const why = conflict(from, into);
  if (why.length) return from.rules && into.rules ? "deal_rule" : "rate";
  return null;
}

/**
 * Tonight's merges from planGroups' answer: every CLEAR group's members into
 * its target, in the groups' order, at most `max`. A pair mergeProblem
 * refuses waits in `held`; what is over the cap is counted in `left` and
 * comes the next night. `renames`: live names only a question mark spoils
 * get their tidy spelling (tidyName; item.rename), tonight's targets first,
 * at most `maxRenames`; never an excluded thing.
 */
export function nightlyPlan({ clear, facts }, { max = NIGHTLY_MERGE_MAX, maxRenames = NIGHTLY_RENAME_MAX, maxRemoves = NIGHTLY_REMOVE_MAX,
  decisions = decisionSets([]) } = {}) {
  const merges = [], held = [];
  let left = 0;
  const { apart, keep, noRename } = decisions;
  const isJunk = (id) => Boolean(junkItem(facts[id], { keep }));
  for (const g of clear) {
    for (const m of g.members) {
      const why = mergeProblem(facts[m.id], facts[g.target], { apart });
      if (why) held.push({ from: m.id, into: g.target, why });
      else if (merges.length < max) merges.push({ from: m.id, into: g.target, how: "clear" });
      else left++;
    }
  }
  // Junk names (30-10-2026): one that clearly means an item is merged
  // into it, one that might is asked, the rest goes (item.remove). Never renamed.
  const busy = new Set(merges.flatMap((m) => [m.from, m.into]));
  const removes = [], junkAsks = [];
  for (const id of Object.keys(facts).sort((a, b) => facts[a].item.name.localeCompare(facts[b].item.name, "nl") || a.localeCompare(b))) {
    if (busy.has(id)) continue;
    const reason = junkItem(facts[id], { keep });
    if (!reason) continue;
    const meaning = junkMeaning(id, facts);
    if (meaning?.into) {
      const why = mergeProblem(facts[id], facts[meaning.into], { apart });
      if (why === "apart") continue;
      if (why) held.push({ from: id, into: meaning.into, why });
      else if (merges.length < max) { merges.push({ from: id, into: meaning.into, how: "junk" }); busy.add(id); }
      else left++;
    } else if (meaning?.ask) {
      if (!apart.has(apartKey(facts[id].item.name, facts[meaning.ask].item.name))) junkAsks.push({ from: id, into: meaning.ask });
    } else if (removes.length < maxRemoves) {
      removes.push({ id, reason });
    } else {
      left++;
    }
  }
  const merged = new Set(merges.map((m) => m.from));
  const targets = new Set(merges.map((m) => m.into));
  const renames = Object.keys(facts)
    .filter((id) => !merged.has(id) && !noRename.has(id) && !isJunk(id))
    .map((id) => ({ id, name: tidyName(facts[id].item.name), was: facts[id].item.name }))
    .filter((r) => r.name && !isExcluded(r.was) && !isExcludedLookalike(r.was))
    .sort((a, b) => (targets.has(b.id) - targets.has(a.id)) || a.was.localeCompare(b.was, "nl") || a.id.localeCompare(b.id))
    .slice(0, maxRenames);
  return { merges, held: held.filter((h) => h.why !== "apart"), left, renames, removes, junkAsks };
}
