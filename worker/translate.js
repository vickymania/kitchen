// A recipe's translation refreshed after an edit (30-10-2026: every
// recipe in both languages). An edit that changes the title, an ingredient
// line, a step or the notes makes the stored translation stale (public/shared/
// bilingual.js recipeFingerprint); the screens show the original until this
// has run. After the /api/ops answer went out (ctx.waitUntil), each such
// recipe is re-read and, when it still needs one, translated by Claude Haiku
// in ONE request per recipe; the answer is a recipe.translate op whose `of`
// is the version that was sent, so an edit made meanwhile stays stale.
//
// Why Haiku: a recipe is plain kitchen text (amounts, verbs, a few hundred
// words); Haiku translates that well at about a tenth of Sonnet's price, and
// a person can always open the original ("Origineel"). New recipes never come
// here: the import's and the labeller's Sonnet call bring their translation
// in the same call (worker/recipe-import.js, worker/labels.js).
//
// Every translation is paid: the daily counter goes up before the call.
import { fromRow, applyOps } from "./ops-store.js";
import { askClaude, takeSome, CHEAP_MODEL } from "./claude.js";
import { needsTranslation, recipeLang, otherLang, recipeFingerprint, ingredientLines, TRANSLATION_SCHEMA } from "../public/shared/bilingual.js";

export const TRANSLATE_DAILY_LIMIT = 30;   // recipes per household per day

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["translation"],
  properties: { translation: TRANSLATION_SCHEMA },
};

/** The text Claude translates: the recipe as written. */
export function translatePrompt(r) {
  const to = otherLang(recipeLang(r)) === "en" ? "English" : "Dutch";
  const lines = ingredientLines(r).slice(0, 120);
  return [
    `Translate this home recipe into ${to}: natural kitchen ${to}, nothing added or left out.`,
    "Keep every ingredient line as one line in the same order (a heading keeps its colon, amounts stay numbers) and every step as one step.",
    "",
    `Title: ${r.title}`,
    lines.length ? `Ingredients:\n${lines.join("\n")}` : "Ingredients: (none)",
    r.steps?.length ? `Steps:\n${r.steps.slice(0, 60).map((s, i) => `${i + 1}. ${s}`).join("\n")}` : "Steps: (none)",
    r.notes ? `Notes:\n${r.notes}` : "Notes: (none)",
  ].join("\n").slice(0, 16000);
}

/**
 * Translate the recipes `ids` that still need it (missing or stale).
 * Resolves to { asked, written, failed, limited }.
 */
export async function translateRecipes(env, who, ids) {
  const out = { asked: 0, written: 0, failed: 0, limited: false };
  if (!env.ANTHROPIC_API_KEY) return { ...out, off: true };
  const todo = [];
  for (const id of [...new Set(ids)].slice(0, 20)) {
    const row = await env.DB.prepare("SELECT * FROM recipes WHERE id = ? AND household_id = ? AND deleted_at IS NULL").bind(id, who.householdId).first();
    const r = row && fromRow("recipes", row);
    if (r && needsTranslation(r)) todo.push(r);
  }
  if (!todo.length) return out;
  const allowed = await takeSome(env, "translate", who.householdId, todo.length, TRANSLATE_DAILY_LIMIT);
  if (allowed < todo.length) out.limited = true;
  for (const r of todo.slice(0, allowed)) {
    out.asked++;
    const res = await askClaude(env, {
      what: "recipe translation",
      model: CHEAP_MODEL,
      schema: SCHEMA,
      maxTokens: 6000,
      content: [{ type: "text", text: translatePrompt(r) }],
    });
    if (res.failed) {
      out.failed++;
      if (res.failed === "rate_limited") break;
      continue;
    }
    const [result] = await applyOps(env.DB, who, [{
      type: "recipe.translate", op_id: `tr-${crypto.randomUUID()}`, id: r.id,
      translation: { ...res.answer?.translation, lang: otherLang(recipeLang(r)), of: recipeFingerprint(r), by: "claude" },
    }]);
    if (result?.ok) out.written++;
    else out.failed++;
  }
  return out;
}
