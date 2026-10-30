import assert from "node:assert/strict";
import { test } from "node:test";
import { findTimers, clock } from "../public/app/timers.js";
import { parseListInput } from "../public/shared/ingredients.js";

test("times in Dutch and English steps", () => {
  const s = (text) => findTimers(text).map((x) => x.seconds);
  assert.deepEqual(s("Laat ca. 10 minuten zachtjes pruttelen."), [600]);
  assert.deepEqual(s("Kook de linzen in 500 milliliter water zo'n 10 à 15 minuten."), [600]);
  assert.deepEqual(s("Leg het op een warme plek en wacht anderhalf uur."), [5400]);
  assert.deepEqual(s("Bake for 1 hour, then rest 5 mins."), [3600, 300]);
  assert.deepEqual(s("Laat een kwartier rusten."), [900]);
  assert.deepEqual(s("Bak 5 à 6 minuten langzaam."), [300]);
  assert.deepEqual(s("Verwarm de oven voor op 180 graden."), []);
  assert.deepEqual(s("Voeg 2 tl kerrie toe."), []);
});

test("a clock reads like a kitchen timer", () => {
  assert.equal(clock(600), "10:00");
  assert.equal(clock(59.2), "01:00");
  assert.equal(clock(5400), "1:30:00");
  assert.equal(clock(-3), "00:00");
});

test("the add box of the list", () => {
  assert.deepEqual(parseListInput("2 ui"), { title: "ui", amounts: [{ qty: 2, unit: null }], note: "" });
  assert.deepEqual(parseListInput("500 gr gehakt"), { title: "gehakt", amounts: [{ qty: 500, unit: "g" }], note: "" });
  assert.deepEqual(parseListInput("305 printer inkt"), { title: "305 printer inkt", amounts: [], note: "" });
  assert.deepEqual(parseListInput("Lovey ❤️"), { title: "Lovey ❤️", amounts: [], note: "" });
  assert.deepEqual(parseListInput("  Waspods "), { title: "Waspods", amounts: [], note: "" });
});
