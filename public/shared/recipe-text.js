// Reads a recipe written as free text: the notes from Microsoft To Do, or a
// recipe someone pastes into the editor. Returns
//   { servings, ingredients: [parsed lines], notes, nutrition }
//
// The To Do notes were pasted from many websites over the years, so they carry
// checkbox glyphs (▢), headings, nutrition lines, serving counts in several
// spellings, tips, sub-headings ("Deeg:", "- Gehaktmengsel"), a whole list on
// one line, and sometimes the same ingredient block pasted twice.
import { parseIngredient } from "./ingredients.js";

const HEADING_RE = /^(ingredi[eë]nten|ingredients|benodigdheden|bereiding(swijze)?|method|instructions|voedingswaarde.*|nutrition.*|recept)\s*:?$/i;
const SERVINGS_RE = /^(?:recept\s+voor\s+|voor\s+|serves\s+|for\s+)?(\d+)\s*(?:personen|persoon|pers\.?|p\.?|porties|portions|people|servings)\s*:?$/i;
const MAKES_RE = /^voor\s+(\d+)\s+\w+$/i;                  // "Voor 6 burgers"
const NUTRITION_RE = /(calorie|kcal|koolhydraten|carbohydrates|eiwitten|protein)/i;
const NOTE_START_RE = /^(lekker|heerlijk|ook lekker|tip|serveer|serve|delicious|variatie|variation|let op)\b/i;
const STEP_NUMBER_RE = /^\d+(\.\d+)*\)\s/;                  // "1.2) 2 uien" is a step, not 1.2 of something

function nutritionOf(line) {
  const grab = (re) => {
    const m = line.match(re);
    return m ? Number(m[1].replace(",", ".")) : null;
  };
  const n = {
    kcal: grab(/(?:calorie[eë]n|calories|energie)\s*:?\s*(\d+(?:[.,]\d+)?)/i),
    carbs_g: grab(/(?:koolhydraten|carbohydrates|carbs)\s*:?\s*(\d+(?:[.,]\d+)?)/i),
    protein_g: grab(/(?:eiwitten|eiwit|protein)\s*:?\s*(\d+(?:[.,]\d+)?)/i),
    fat_g: grab(/(?:vetten|vet|fat)\s*:?\s*(\d+(?:[.,]\d+)?)/i),
  };
  return Object.values(n).some((v) => v !== null) ? n : null;
}

const words = (s) => s.replace(/\([^)]*\)/g, " ").trim().split(/\s+/).filter(Boolean);

/** Does this line read as a sentence rather than an ingredient? */
export function isProse(line, parsed = parseIngredient(line)) {
  if (NOTE_START_RE.test(line)) return true;
  if (/^[^:]{2,30}:\s+\S/.test(line) && !/^(optioneel|optional|evt)/i.test(line)) return true;
  if (parsed.qty !== null) return false;
  const n = words(line).length;
  if (n >= 5) return true;
  return /[.!?]$/.test(line) && n >= 3;
}

/**
 * "Sate:", "Teriyaki Saus-------", "- Deeg": a sub-heading inside the ingredients.
 * A dash only marks a heading when the lines under it have none; in a list
 * where every line starts with a dash, "- Ketchup, scheut" is an ingredient.
 */
function headingOf(rawLine, line, prevRaw, nextRaw) {
  if (/^.{2,40}:$/.test(line) && !/^(optioneel|optional)/i.test(line)) return line.slice(0, -1).trim();
  if (/^.{2,40}?-{3,}$/.test(line)) return line.replace(/-+$/, "").trim();
  const dashed = (l) => l !== null && /^\s*-/.test(l);
  if (/^-\s/.test(rawLine) && nextRaw !== null && !dashed(nextRaw) && !dashed(prevRaw)) {
    const rest = line.replace(/^-\s*/, "");
    if (words(rest).length <= 3 && parseIngredient(rest).qty === null) return rest;
  }
  return null;
}

/** "1 kg aardappelen, zout, peper, ..., 50 g geraspte kaas." as separate lines. */
function splitList(line) {
  if (line.length < 70 || (line.match(/,/g) ?? []).length < 3) return [line];
  const parts = line.replace(/\.$/, "").split(/,\s*/);
  return parts.filter((p) => parseIngredient(p).qty !== null).length >= 2 ? parts : [line];
}

export function parseRecipeText(text) {
  const rawLines = String(text ?? "")
    .replace(/\r/g, "")
    // "olie, peper, zoutIngrediënten": a heading glued to the line before it.
    .replace(/([a-zà-ÿ)])(Ingredi[eë]nten|Ingredients)/g, "$1\n$2")
    .split("\n");

  let servings = null;
  let nutrition = null;
  const ingredients = [];
  const notes = [];
  const seen = new Set();

  const tidy = (l) => l.replace(/­/g, "").replace(/^[\s▢☐□•·]+/, "");
  const filled = (i, step) => {
    for (let j = i + step; j >= 0 && j < rawLines.length; j += step) if (rawLines[j].trim()) return tidy(rawLines[j]);
    return null;
  };

  for (const [index, rawLine] of rawLines.entries()) {
    // ­ is a soft hyphen some sites put in front of a heading.
    const raw = tidy(rawLine);
    let line = raw.replace(/\s+/g, " ").trim()
      .replace(/^(ingredi[eë]nten|ingredients)\s*:?\s+(?=\d)/i, "");
    if (!line || HEADING_RE.test(line)) continue;

    const s = line.match(SERVINGS_RE) ?? line.match(MAKES_RE);
    if (s) {
      servings = servings ?? Number(s[1]);
      continue;
    }
    if (NUTRITION_RE.test(line) && /\d/.test(line) && /[|:]/.test(line)) {
      nutrition = nutrition ?? nutritionOf(line);
      continue;
    }
    const heading = headingOf(raw, line, filled(index, -1), filled(index, 1));
    if (heading) {
      ingredients.push({ qty: null, qty_max: null, unit: null, name: heading, note: "", optional: false, heading: true, raw: line });
      // A new section may need the same thing again ("1 ei" for the dough and
      // for the filling, 30-10-2026): duplicates count per section.
      seen.clear();
      continue;
    }
    for (const part of splitList(line)) {
      const parsed = parseIngredient(part);
      if (!parsed.name || isProse(part, parsed)) {
        notes.push(part);
        continue;
      }
      // The same line twice in one section (a block pasted twice): keep the first.
      const key = parsed.raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      ingredients.push(parsed);
    }
  }

  // A heading with nothing under it is no heading.
  const clean = ingredients.filter((ing, i) => !ing.heading || (ingredients[i + 1] && !ingredients[i + 1].heading));
  return { servings, ingredients: clean, notes: notes.join("\n"), nutrition };
}

/**
 * Some recipes keep their ingredients as the first checklist steps
 * ("300 g macaroni", "Basilicum"). Move those to the ingredients, and stop at
 * the first step that reads as an instruction.
 */
export function ingredientsFromSteps(steps) {
  const moved = [];
  let i = 0;
  for (; i < steps.length; i++) {
    const step = steps[i].trim();
    if (STEP_NUMBER_RE.test(step)) break;
    const parsed = parseIngredient(step);
    if (!parsed.name || isProse(step, parsed) || words(step).length > 6) break;
    moved.push(parsed);
  }
  return { ingredients: moved, steps: steps.slice(i) };
}

/** "Pasta carbonara 4 p", "Chicken teriyaki 2 personen" -> title + servings. */
export function splitTitle(title) {
  const t = String(title ?? "").trim();
  const m = t.match(/^(.*?)\s+(\d+)\s*(?:p|pers\.?|personen|persoon)\.?$/i);
  if (m && m[1]) return { title: m[1].trim(), servings: Number(m[2]) };
  return { title: t, servings: null };
}
