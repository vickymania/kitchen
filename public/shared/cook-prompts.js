// "… gekookt?" (28-10-2026): a recipe was put on the list, its lines
// were ticked or bought on a receipt, and nobody marked it cooked (cook mode's
// end or "Gegeten"). From the day after the shopping the list asks
// "Pastapotje HenkTorino gekookt?" with "Ja, gisteren", "Ja, vandaag" and
// "Nog niet"; "nog niet" asks again the next day, at most PROMPT_DAYS days.
//
// The rows (table cook_prompts) are written by the op engine when a line for
// a recipe is ticked or bought (public/shared/ops.js, notePrompt), so they
// survive clearing the cart; "nog niet" is the op recipe.cook_prompt, synced,
// so the other phones do not ask again that day. Pure: no screen, no store.
import { daysBetween } from "./intervals.js";

/** Asked on the days 1..PROMPT_DAYS after the shopping, never on the day itself. */
export const PROMPT_DAYS = 3;

/**
 * The recipes to ask about today: [{ recipe_id, title, shopped_on }], the
 * newest shopping first. A recipe is left out when it was cooked (any cook
 * row on or after the day it was put on the list), when it was answered "nog
 * niet" today, dismissed, deleted, or when the shopping was today or more
 * than PROMPT_DAYS days ago. One question per recipe: its newest shopping.
 * view: { cook_prompts, cooks, recipes }.
 */
export function cookPrompts(view, today) {
  const cooked = new Map();
  for (const c of Object.values(view?.cooks ?? {})) {
    if (!c || c.deleted_at) continue;
    if (!cooked.has(c.recipe_id) || cooked.get(c.recipe_id) < c.cooked_on) cooked.set(c.recipe_id, c.cooked_on);
  }
  const best = new Map();
  for (const p of Object.values(view?.cook_prompts ?? {})) {
    if (!p || p.deleted_at || p.dismissed_at) continue;
    const recipe = view?.recipes?.[p.recipe_id];
    if (!recipe || recipe.deleted_at) continue;
    const days = daysBetween(p.shopped_on, today);
    if (!(days >= 1 && days <= PROMPT_DAYS)) continue;
    if (p.snoozed_on && p.snoozed_on >= today) continue;
    const last = cooked.get(p.recipe_id);
    if (last && last >= (p.listed_on || p.shopped_on)) continue;
    const prev = best.get(p.recipe_id);
    if (!prev || prev.shopped_on < p.shopped_on) best.set(p.recipe_id, { recipe_id: p.recipe_id, title: recipe.title, shopped_on: p.shopped_on });
  }
  return [...best.values()].sort((a, b) => b.shopped_on.localeCompare(a.shopped_on) || a.title.localeCompare(b.title));
}
