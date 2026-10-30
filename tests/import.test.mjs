import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMigration, stableId } from "../tools/import_todo.mjs";

const task = (title, extra = {}) => ({ id: `todo-${title}`, title, status: "notStarted", body: { content: "" }, checklistItems: [], photos: [], ...extra });

test("a cookbook page read from its photo fills an idea; a wrong photo is left off", () => {
  const data = {
    lists: {
      recipes: {
        tasks: [
          task("Rijstepap met mango", { photos: [{ file: "page.jpg" }] }),
          task("Zoete aardappels met kajunkruiden", { photos: [{ file: "other-page.jpg" }] }),
          task("Lasagne"),
        ],
      },
      groceries: { tasks: [task("Komijn"), task("Oud", { status: "completed", completedDateTime: { dateTime: "2024-01-01" } })] },
    },
  };
  const pages = {
    "Rijstepap met mango": {
      servings: 4,
      ingredients: ["150 g paprijst", "2 plukjes saffraan (klein)", "4 el vloeibare honing"],
      steps: ["Doe alles in een pan.", "Laat 25 minuten pruttelen."],
      nutrition: { kcal: 276, carbs_g: 63.2 },
    },
    "Zoete aardappels met kajunkruiden": { skip_photo: "shows another recipe" },
  };
  const m = buildMigration(data, pages);
  const [pap, zoete, lasagne] = m.recipes;
  assert.equal(pap.recipe.servings, 4);
  assert.deepEqual(pap.recipe.ingredients.map((i) => [i.qty, i.unit, i.name]), [[150, "g", "paprijst"], [2, "pinch", "saffraan"], [4, "tbsp", "vloeibare honing"]]);
  assert.equal(pap.recipe.steps.length, 2);
  assert.equal(pap.recipe.nutrition.carbs_g, 63.2);
  assert.equal(pap.photoFile, "page.jpg");
  assert.equal(zoete.photoFile, null);
  assert.equal(zoete.recipe.ingredients.length, 0);
  assert.equal(lasagne.recipe.steps.length, 0);
  assert.equal(pap.id, stableId("todo", "todo-Rijstepap met mango"));
  assert.deepEqual(m.entries.map((e) => e.title), ["Komijn"]);
  assert.equal(m.history.length, 1);
});
