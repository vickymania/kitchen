// Estimates carbohydrates per serving for recipes that have none, from their
// ingredients and the Dutch food composition table NEVO (RIVM).
//
//     node tools/estimate_carbs.mjs --preview [--from <recipes.json>] [--origin <url>]
//     node tools/estimate_carbs.mjs --push <origin> [--include-low]
//
// --preview writes migration/nevo/estimate-report.txt (git-ignored) and sends
// nothing. --push sends one recipe.put per recipe with nutrition.carbs_g (whole
// grams) and nutrition.carbs_estimated = true. Only confidence "high" is pushed
// unless --include-low is given. A recipe that already has carbs is never touched.
//
// The NEVO table is data, not code: download it by hand (the RIVM form needs the
// terms accepted) and unzip it to migration/nevo/data/. Nothing from it is committed.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NEVO_CSV = path.join(ROOT, "migration", "nevo", "data", "NEVO2025_v9.0.csv");
const REPORT = path.join(ROOT, "migration", "nevo", "estimate-report.txt");

// A food with at most this many g carbs per 100 g does not change the answer
// when its amount is missing ("Kaas", "Bacon"); it is still listed.
const NEGLIGIBLE_PER_100G = 1.5;
// A "to taste" item with more than this per 100 g still lowers the confidence.
const TASTE_RICH_PER_100G = 20;

// ---------- NEVO ----------

/** { code -> { code, name, cho } } from the pipe separated NEVO file; cho is g per 100 g. */
export function parseNevo(text) {
  const rows = text.split(/\r?\n/).filter(Boolean).map((l) => l.split("|").map((c) => c.replace(/^"|"$/g, "")));
  const head = rows[0];
  const col = head.findIndex((c) => c.startsWith("CHO (g)"));
  const codeCol = head.findIndex((c) => c.startsWith("NEVO-code"));
  const nameCol = head.findIndex((c) => c.startsWith("Voedingsmiddelnaam"));
  const qtyCol = head.findIndex((c) => c.startsWith("Hoeveelheid"));
  if (col < 0 || codeCol < 0 || nameCol < 0) throw new Error("This does not look like the NEVO file (no CHO column)");
  const foods = new Map();
  for (const r of rows.slice(1)) {
    const cho = Number(String(r[col]).replace(",", "."));
    if (r[qtyCol] !== "per 100g" || r[col] === "" || !Number.isFinite(cho)) continue;
    foods.set(Number(r[codeCol]), { code: Number(r[codeCol]), name: r[nameCol], cho });
  }
  return foods;
}

// ---------- ingredient name -> NEVO food ----------

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

// Weights of one piece, spoon, clove... in grams. These are estimates: a piece
// weight is written next to the food it belongs to (below) or here for all foods.
const GENERIC_G = { clove: 4, pinch: 0.5, tbsp_ml: 15, tsp_ml: 5, dash_ml: 10 };

// Order matters: the first rule that matches wins. `code` is a NEVO-code;
// `ignore` marks something that counts as 0 (with the reason shown in the report).
// ml_g: grams per ml. *_g: grams per piece, can, packet, bunch, cup, bowl, cm,
// handful, cube. `units`: the rule only applies for these units. `approx`: NEVO has
// no exact food, a close one stands in; the recipe's confidence drops to low.
const RULES = [
  { re: /^(water|kraanwater|kookwater|heet water|lauw water)\b/, ignore: "water" },
  { re: /^(pici zout|zout|peper|peper en zout|zwarte peper)$/, ignore: "salt and pepper" },
  { re: /(kerrie|curry|komijn|kaneel|paprikapoeder|cayenne|oregano|knoflookpoeder|kurkuma|garam masala|chilipoeder|djintan|dille|djahe|sambal|kruidenmix|burrito mix|taco)/, ignore: "spice", unlessRe: /rijst/ },
  { re: /(peterselie|basilicum|bieslook|koriander|muntblaadjes|tijm)/, ignore: "fresh herb (under 1 g carbs)" },
  { re: /^(chili peper|chilipeper|rode peper|rode chili peper|chili|groene jalapeno peper|verse groene chilipeper)\b/, ignore: "hot pepper (a few g at most)" },
  { re: /(hand- of standmixer|plasticfolie|keukenmachine|aluminiumfolie|^te vetten)/, ignore: "not food" },
  { re: /^maizena/, ignore: "thickener, optional" },

  { re: /(zonnebloemolie|plantaardige olie|olijfolie|sesamolie|wokolie)/, code: 317, ml_g: 0.92 },
  { re: /(gedroogde.*linzen|rode linzen)/, code: 120, approx: "NEVO has no dried red lentils; dried green and brown lentils stand in" },
  { re: /^(witte )?rijst\b/, code: 5, cup_g: 185, cup_approx: true },
  { re: /(gerookte kipfilet)/, code: 2654, piece_g: 100 },
  { re: /^(kip|kipfilet|kippendijenfillet|kippenborst|kippendij)\b/, code: 1634, piece_g: 200 },
  { re: /^ananas/, code: 150 },
  { re: /sperziebonen/, code: 50 },
  { re: /^(rode ui|rode uien)\b/, code: 5459, piece_g: 150 },
  { re: /(lente-ui|lente ui|bosui|lente-uitjes)/, code: 2737, piece_g: 15, bunch_g: 100 },
  { re: /^(ui|uien|grote uien|ui \(gesnipperd\))\b/, code: 63, piece_g: 150 },
  { re: /creme fraiche/, code: 1808, ml_g: 1 },
  { re: /limoensap/, code: 691, ml_g: 1 },
  { re: /^limoen$/, code: 691, piece_g: 70 },
  { re: /bouillon/, code: 1528, ml_g: 1, units: ["ml", "l", "cup"] },
  { re: /bouillon/, code: 429, cube_g: 10, piece_g: 10 },
  { re: /^(eidooiers?)\b/, code: 83, piece_g: 18 },
  { re: /^(grote )?(eieren|ei)\b/, code: 83, piece_g: 55 },
  { re: /(^bloem|patentbloem)/, code: 220 },
  { re: /^melk\b/, code: 286, ml_g: 1.03 },
  { re: /vanillesuiker/, code: 375, packet_g: 8 },
  { re: /sneetjes brood/, code: 248, piece_g: 35 },
  { re: /(roomboter|^boter$|^boter\b)/, code: 310 },
  { re: /^(gehakt|rundergehakt|rund - en lamsgehakt|lamsgehakt|lamsgehakt of rundergehakt)\b/, code: 1405, piece_g: 250 },
  { re: /half om half gehakt/, code: 1434 },
  { re: /nacho/, code: 1937 },
  { re: /^(geraspte kaas|strooi kaas|geraspte belegen kaas|kaas)\b/, code: 513 },
  { re: /parmezaan/, code: 718 },
  { re: /tomatenblokjes|gehakte tomaat/, code: 2293, can_g: 400 },
  { re: /^tomatenpuree/, code: 141, tbsp_g: 15 },
  { re: /^(mais|klein blikje mais)\b/, code: 2900, can_g: 140, piece_g: 140 },
  { re: /zwarte bonen/, code: 5176, can_g: 200 },
  { re: /chili bonen/, code: 5171, can_g: 400 },
  { re: /^(rode paprikas?|puntpaprika|paprika)\b/, code: 884, piece_g: 150 },
  { re: /^knoflook\b/, code: 830, clove_g: 4 },
  { re: /^kokosmelk/, code: 2290, ml_g: 1 },
  { re: /zoete aardappel/, code: 671, piece_g: 300 },
  { re: /naanbroodjes/, code: 2790, piece_g: 90, approx: "NEVO has no naan; pita bread stands in" },
  { re: /griekse yoghurt|^yoghurt/, code: 2503, tbsp_g: 15 },
  { re: /^gember/, code: 832, cm_g: 5 },
  { re: /diepvries spinazie/, code: 651 },
  { re: /spinazie/, code: 51 },
  { re: /diepvries doperwten/, code: 953 },
  { re: /(eiernoedels|macaroni|tagliatelle|farfalle|^pasta$)/, code: 4 },
  { re: /champignons/, code: 19 },
  { re: /^prei\b/, code: 562, piece_g: 200 },
  { re: /^(tomaat|tomaten|cherrytomaatjes|tomaten)$/, code: 60, piece_g: 120 },
  { re: /^ijsbergsla|^krop ijsbergsla/, code: 1399, piece_g: 400 },
  { re: /^komkommer/, code: 2739, piece_g: 300 },
  { re: /^veldsla/, code: 65 },
  { re: /kruidenroomkaas|^roomkaas/, code: 3368, bowl_g: 150 },
  { re: /^(spekjes|bacon|bacon strips)/, code: 639, piece_g: 20 },
  { re: /pijnboompitten/, code: 2176 },
  { re: /paneermeel/, code: 1013 },
  { re: /^ketchup/, code: 462 },
  { re: /italiaanse bollen/, code: 230, piece_g: 70 },
  { re: /(bruine suiker)/, code: 374, tbsp_g: 12 },
  { re: /(kristalsuiker)/, code: 377, tbsp_g: 12 },
  { re: /^honing/, code: 443, tbsp_g: 21, tsp_g: 7 },
  { re: /^mayonaise/, code: 451, tbsp_g: 15 },
  { re: /^mosterd/, code: 824, tsp_g: 5 },
  { re: /^pindakaas/, code: 455 },
  { re: /ketjap/, code: 1215, tbsp_g: 18 },
  { re: /witte azijn/, code: 2615, ml_g: 1 },
  { re: /gebakken uitjes/, code: 1484, tbsp_g: 5 },
  { re: /^(havermoutvlokken)/, code: 213 },
  { re: /^banaan/, code: 151, piece_g: 120 },
  { re: /^bloemkool|middelgrote bloemkool/, code: 14, piece_g: 600 },
  { re: /^(aardappelen|aardappel)\b/, code: 1 },
  { re: /^(zure room)/, code: 812 },
  { re: /^avocado/, code: 689, piece_g: 150 },
  { re: /^mango/, code: 692, piece_g: 300 },
  { re: /^radijs/, code: 124 },
  { re: /^sla$/, code: 2346 },
  { re: /^(shrimp|garnalen)/, code: 3320 },
  { re: /^sesamzaad/, code: 838 },
  { re: /^chorizo|^(70 g )?chorizo/, code: 2996 },
  { re: /^(middelgrote )?tortilla|wraps|bloemtortilla|tortilla wraps/, code: 2359, piece_g: 60 },
  { re: /^worchester|^worcester/, ignore: "sauce splash" },
  { re: /gebraden ham/, code: 1776, piece_g: 100 },
  { re: /gist/, code: 1025, packet_g: 7 },
  { re: /^margarine/, code: 2063 },
  { re: /^bbq saus/, code: 428, ml_g: 1.1 },
  { re: /^broccoli/, code: 921 },
  { re: /^room$/, code: 299 },
  { re: /knoflooksaus/, code: 2573, ml_g: 1 },
  { re: /rode pesto/, code: 3222 },
  { re: /^bloemkool|middelgrote bloemkool/, code: 14, piece_g: 600 },
  { re: /bloemtortilla/, code: 2359, piece_g: 60 },
  { re: /^zure room/, code: 812 },
  { re: /^guacamole/, code: 689 },
  { re: /^chinese groente/, code: 3226 },
];

const TASTE_RE = /(naar smaak|op gevoel|ter garnering|scheut)/;
const toTaste = (ing) => TASTE_RE.test(norm(`${ing.name} ${ing.note ?? ""}`));

function ruleFor(ing) {
  const name = norm(ing.name);
  for (const r of RULES) {
    if (!r.re.test(name)) continue;
    if (r.unlessRe && r.unlessRe.test(name)) continue;
    if (r.units && !r.units.includes(ing.unit)) continue;
    return r;
  }
  return null;
}

/** Grams for an ingredient line, or { why } when the amount cannot be told. */
function toGrams(ing, rule) {
  let qty = ing.qty;
  if (qty === null || qty === undefined) return { why: "no amount" };
  if (ing.qty_max) qty = (qty + ing.qty_max) / 2;
  const noteG = (String(ing.note ?? "") + " " + ing.name).match(/(\d+(?:[.,]\d+)?)\s*(?:g|gr|gram)\b/i);
  const ml = rule.ml_g ?? 1;
  switch (ing.unit) {
    case "g": return { g: qty };
    case "kg": return { g: qty * 1000 };
    case "mg": return { g: qty / 1000 };
    case "ml": return { g: qty * ml };
    case "cl": return { g: qty * 10 * ml };
    case "dl": return { g: qty * 100 * ml };
    case "l": return { g: qty * 1000 * ml };
    case "tbsp": return { g: qty * (rule.tbsp_g ?? GENERIC_G.tbsp_ml * ml) };
    case "tsp": return { g: qty * (rule.tsp_g ?? GENERIC_G.tsp_ml * ml) };
    case "clove": return { g: qty * (rule.clove_g ?? GENERIC_G.clove) };
    case "pinch": return { g: qty * GENERIC_G.pinch };
    case "dash": return { g: qty * GENERIC_G.dash_ml * ml };
    case "cube": return rule.cube_g ? { g: qty * rule.cube_g } : { why: "no cube weight" };
    case "can": return noteG ? { g: qty * Number(noteG[1].replace(",", ".")) } : rule.can_g ? { g: qty * rule.can_g } : { why: "no can weight" };
    case "packet": case "pack": return noteG ? { g: qty * Number(noteG[1].replace(",", ".")) } : rule.packet_g ? { g: qty * rule.packet_g } : { why: "packet size unknown" };
    case "bunch": return rule.bunch_g ? { g: qty * rule.bunch_g } : { why: "no bunch weight" };
    case "cup": return rule.cup_g ? { g: qty * rule.cup_g, approx: rule.cup_approx } : { why: "cup size unknown" };
    case "bowl": return rule.bowl_g ? { g: qty * rule.bowl_g } : { why: "bowl size unknown" };
    case "cm": return rule.cm_g ? { g: qty * rule.cm_g } : { why: "no cm weight" };
    case "handful": return rule.handful_g ? { g: qty * rule.handful_g } : { why: "no handful weight" };
    case "piece": case "slice": case null: case undefined:
      return rule.piece_g ? { g: qty * rule.piece_g } : { why: "no piece weight" };
    default: return { why: `unit "${ing.unit}" not handled` };
  }
}

// ---------- one recipe ----------

/** @returns {{servings, lines, total, perServing, confidence, reasons}} */
export function estimateRecipe(recipe, foods) {
  const lines = [];
  const reasons = [];
  let total = 0;
  const flag = (msg) => reasons.push(msg);
  for (const ing of recipe.ingredients) {
    if (ing.heading) continue;
    const label = ing.raw || `${ing.qty ?? ""} ${ing.unit ?? ""} ${ing.name}`.trim();
    if (ing.optional) {
      lines.push({ label, status: "skipped", detail: "optional, not counted" });
      continue;
    }
    const rule = ruleFor(ing);
    if (rule?.ignore) {
      lines.push({ label, status: "ignored", detail: rule.ignore, carbs: 0 });
      continue;
    }
    if (!rule) {
      if (toTaste(ing)) {
        lines.push({ label, status: "ignored", detail: "to taste, no matching food", carbs: 0 });
      } else {
        lines.push({ label, status: "unmatched", detail: "no NEVO food chosen" });
        flag(`no NEVO food for "${ing.name}"`);
      }
      continue;
    }
    const food = foods.get(rule.code);
    if (!food) {
      lines.push({ label, status: "unmatched", detail: `NEVO code ${rule.code} not in the file` });
      flag(`NEVO code ${rule.code} missing for "${ing.name}"`);
      continue;
    }
    if (toTaste(ing)) {
      lines.push({ label, status: "to_taste", food, carbs: 0, detail: "to taste, counted as 0" });
      if (food.cho > TASTE_RICH_PER_100G) flag(`"${ing.name}" is to taste but carb-rich (${food.cho} g/100 g)`);
      continue;
    }
    const grams = toGrams(ing, rule);
    if (grams.why) {
      if (food.cho <= NEGLIGIBLE_PER_100G) {
        lines.push({ label, status: "negligible", food, carbs: 0, detail: `${grams.why}; ${food.cho} g/100 g, counted as 0` });
      } else {
        lines.push({ label, status: "unclear", food, detail: grams.why });
        flag(`${grams.why} for "${ing.name}" (${food.cho} g/100 g)`);
      }
      continue;
    }
    const carbs = (grams.g * food.cho) / 100;
    total += carbs;
    const approx = rule.approx ?? (grams.approx ? "cup size assumed" : null);
    lines.push({ label, status: "ok", g: grams.g, food, carbs, detail: approx ?? "" });
    if (approx) flag(`"${ing.name}": ${approx}`);
  }
  const servings = recipe.servings > 0 ? recipe.servings : null;
  if (!servings) flag("servings unknown");
  const perServing = servings ? total / servings : null;
  return { servings, lines, total, perServing, confidence: reasons.length ? "low" : "high", reasons };
}

// ---------- the recipes ----------

function readToken() {
  if (process.env.KITCHEN_TOKEN) return process.env.KITCHEN_TOKEN;
  // A git worktree has no mcp/.env; the main kitchen folder next to it does.
  for (const dir of [ROOT, path.resolve(ROOT, "..", "kitchen")]) {
    const env = path.join(dir, "mcp", ".env");
    if (!fs.existsSync(env)) continue;
    const m = fs.readFileSync(env, "utf8").match(/^KITCHEN_TOKEN=(\S+)/m);
    if (m) return m[1];
  }
  throw new Error("No token: run `node tools/admin.mjs token` first");
}

async function fetchRecipes(origin) {
  const res = await fetch(`${origin}/api/sync?since=0`, { headers: { Authorization: `Bearer ${readToken()}` } });
  if (!res.ok) throw new Error(`/api/sync: ${res.status}`);
  return (await res.json()).recipes.filter((r) => !r.deleted_at);
}

const cookable = (r) => r.ingredients?.some((i) => !i.heading);
const hasCarbs = (r) => r.nutrition?.carbs_g !== null && r.nutrition?.carbs_g !== undefined;
export const needsEstimate = (r) => cookable(r) && !hasCarbs(r);

function report(results) {
  const out = ["Carbs per serving, estimated from NEVO 2025/9.0 (RIVM). Values are g per 100 g, available carbohydrates.", ""];
  for (const { recipe: r, est } of results) {
    out.push(`=== ${r.title}  (${r.id})  servings=${est.servings ?? "unknown"}`);
    for (const l of est.lines) {
      const food = l.food ? `NEVO ${l.food.code} ${l.food.name} (${l.food.cho} g/100 g)` : "-";
      const grams = l.g !== undefined ? `${Math.round(l.g * 10) / 10} g` : "";
      const carbs = l.carbs !== undefined ? `${Math.round(l.carbs * 10) / 10} g carbs` : "";
      out.push(`    [${l.status}] ${l.label}  ->  ${grams}  ->  ${food}  ->  ${carbs}${l.detail ? `  | ${l.detail}` : ""}`);
    }
    out.push(`    TOTAL ${Math.round(est.total * 10) / 10} g carbs  ->  ${est.perServing === null ? "per serving: unknown" : `${Math.round(est.perServing)} g per serving`}  | confidence ${est.confidence}`);
    for (const why of est.reasons) out.push(`      - ${why}`);
    out.push("");
  }
  return out.join("\n");
}

function summary(results) {
  const rows = results.map(({ recipe: r, est }) => `${r.title.padEnd(48)} ${est.perServing === null ? "?" : Math.round(est.perServing)}\t${est.confidence}`);
  return rows.join("\n");
}

async function push(results, origin, { includeLow }) {
  const ops = [];
  for (const { recipe: r, est } of results) {
    if (est.perServing === null) continue;
    if (est.confidence !== "high" && !includeLow) continue;
    const carbs = Math.round(est.perServing);
    ops.push({
      op_id: `op-${createHash("sha256").update(`carbs:${r.id}:${carbs}`).digest("hex").slice(0, 24)}`,
      type: "recipe.put",
      id: r.id,
      recipe: { nutrition: { ...(r.nutrition ?? {}), carbs_g: carbs, carbs_estimated: true } },
    });
  }
  const token = readToken();
  const failed = [];
  for (let i = 0; i < ops.length; i += 50) {
    const res = await fetch(`${origin}/api/ops`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ops: ops.slice(i, i + 50) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`/api/ops: ${res.status} ${JSON.stringify(body)}`);
    failed.push(...body.results.filter((x) => !x.ok));
  }
  console.log(`Sent ${ops.length} recipes.`);
  if (failed.length) {
    console.log(`Refused: ${JSON.stringify(failed)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : null; };
  if (!fs.existsSync(NEVO_CSV)) {
    console.error(`NEVO file missing: ${path.relative(ROOT, NEVO_CSV)} (download it from rivm.nl and unzip)`);
    process.exit(1);
  }
  const foods = parseNevo(fs.readFileSync(NEVO_CSV, "utf8"));
  const pushOrigin = arg("--push")?.replace(/\/$/, "");
  const origin = pushOrigin ?? (arg("--origin") ?? "https://recipes.vexed.works").replace(/\/$/, "");
  const from = arg("--from");
  const recipes = from ? JSON.parse(fs.readFileSync(from, "utf8")) : await fetchRecipes(origin);
  const results = recipes.filter(needsEstimate).map((recipe) => ({ recipe, est: estimateRecipe(recipe, foods) }));
  if (process.argv.includes("--preview")) {
    fs.writeFileSync(REPORT, report(results));
    console.log(`Report: ${path.relative(ROOT, REPORT)}\n${summary(results)}`);
  }
  if (pushOrigin) await push(results, pushOrigin, { includeLow: process.argv.includes("--include-low") });
}
