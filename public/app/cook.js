// Cook mode: one step at a time in big type, the screen kept awake, and a
// timer button for every time the step mentions. Timers keep running while
// you move between steps, and ring with sound, vibration and (when the app is
// in the background and allowed to) a notification.
import { h, toast, fill } from "./dom.js";
import { t, formatAmount } from "./i18n.js";
import * as store from "./store.js";
import { scaled, servingsFor, displayed } from "./recipe.js";
import { findTimers, clock } from "./timers.js";
import { keepScreenOn } from "./wake.js";
import { markCooked } from "./recipe.js";

// Running timers survive leaving and re-entering cook mode, as long as the app is open.
const running = [];
let audio = null;

function beep() {
  try {
    audio ??= new AudioContext();
    const now = audio.currentTime;
    for (let i = 0; i < 6; i++) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = i % 2 ? 880 : 1175;
      gain.gain.setValueAtTime(0.0001, now + i * 0.32);
      gain.gain.exponentialRampToValueAtTime(0.35, now + i * 0.32 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.32 + 0.26);
      osc.connect(gain).connect(audio.destination);
      osc.start(now + i * 0.32);
      osc.stop(now + i * 0.32 + 0.3);
    }
  } catch {
    // No sound available; the screen still flashes.
  }
  navigator.vibrate?.([300, 150, 300, 150, 600]);
}

function ring(timer) {
  beep();
  if (document.visibilityState !== "visible" && "Notification" in window && Notification.permission === "granted") {
    navigator.serviceWorker?.ready.then((reg) => reg.showNotification(t("cook.timer_done"), { body: timer.label, tag: timer.id, renotify: true }))
      .catch(() => {});
  }
}

export function mountCook(root, id) {
  const recipe = store.getView().recipes[id];
  if (!recipe) {
    location.hash = `#/recipe/${id}`;
    return null;
  }
  document.body.classList.add("cooking");
  let index = 0;
  let showIngredients = false;
  const releaseScreen = keepScreenOn();

  // Unlock audio on the first tap, so a timer can ring later (browsers block
  // sound that no touch started).
  const unlockAudio = () => {
    try {
      audio ??= new AudioContext();
      audio.resume?.();
    } catch {
      // No Web Audio: timers still flash and vibrate.
    }
  };
  root.addEventListener("pointerdown", unlockAudio, { once: true });

  const stage = h("div", { class: "cook wrap" });
  root.append(stage);

  function startTimer(found) {
    unlockAudio();
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
    running.push({ id: `${Date.now()}`, label: `${t("cook.step_short", { n: index + 1 })} · ${found.label}`, ends: Date.now() + found.seconds * 1000, rung: false });
    render();
  }

  function timersView() {
    if (!running.length) return null;
    return h("div", { class: "running", "aria-live": "polite" }, running.map((tm) => {
      const left = (tm.ends - Date.now()) / 1000;
      return h("div", { class: `timer${left <= 0 ? " done" : ""}` },
        h("span", { class: "left" }, left <= 0 ? "00:00" : clock(left)),
        h("span", { class: "lbl mono" }, tm.label),
        h("button", {
          type: "button", class: "btn ghost", "aria-label": t("cook.stop_timer"),
          onclick: () => { running.splice(running.indexOf(tm), 1); render(); },
        }, "✕"));
    }));
  }

  function render() {
    // The steps and lines as read (the translation when it is shown); markCooked gets the original.
    const shown = displayed(recipe).recipe;
    const steps = shown.steps;
    const step = steps[index] ?? "";
    const found = findTimers(step);
    fill(stage,
      h("div", { class: "cook-top" },
        h("a", { class: "btn ghost", href: `#/recipe/${recipe.id}`, "aria-label": t("cook.close") }, "✕"),
        h("span", { class: "title mono" }, shown.title),
        h("button", { type: "button", class: "btn ghost mono", onclick: () => { showIngredients = !showIngredients; render(); } },
          showIngredients ? t("cook.hide_ingredients") : t("cook.show_ingredients"))),
      timersView(),
      showIngredients
        ? h("ul", { class: "ings cook-ings" }, scaled(shown).map((i) => (i.heading
          ? h("li", { class: "head mono" }, i.name)
          : h("li", {}, h("span", { class: "q" }, formatAmount(i)), h("span", { class: "n" }, i.name)))))
        : null,
      h("div", { class: "cook-main" },
        h("div", { class: "cook-count mono" }, t("cook.step_of", { n: index + 1, total: steps.length }),
          servingsFor(recipe) ? ` · ${t("recipe.servings", { n: servingsFor(recipe) })}` : ""),
        h("p", { class: "cook-step" }, step),
        found.length ? h("div", { class: "timers-found" }, found.map((f) =>
          h("button", { type: "button", class: "btn", onclick: () => startTimer(f) }, `${t("cook.start")} ${clock(f.seconds)}`))) : null),
      h("div", { class: "cook-nav" },
        h("button", { type: "button", class: "btn", disabled: index === 0, onclick: () => { index--; render(); } }, `← ${t("cook.previous")}`),
        index < steps.length - 1
          ? h("button", { type: "button", class: "btn primary", onclick: () => { index++; render(); } }, `${t("cook.next")} →`)
          : h("button", {
            type: "button", class: "btn signal",
            // The end of cook mode counts as cooked today (the wizard's "not eaten for long").
            onclick: async () => { await markCooked(recipe, { quiet: true }); location.hash = `#/recipe/${recipe.id}`; },
          }, t("cook.done"))),
    );
  }

  // Once a second: count down and ring what reached zero.
  const tick = setInterval(() => {
    let changed = false;
    for (const tm of running) {
      if (!tm.rung && tm.ends <= Date.now()) {
        tm.rung = true;
        ring(tm);
        toast(`${t("cook.timer_done")} · ${tm.label}`, { error: true, ms: 10000 });
      }
      changed = true;
    }
    if (changed) {
      const box = stage.querySelector(".running");
      const fresh = timersView();
      if (box && fresh) box.replaceWith(fresh);
      else render();
    }
  }, 1000);

  const onKey = (e) => {
    if (e.key === "ArrowRight" && index < displayed(recipe).recipe.steps.length - 1) { index++; render(); }
    if (e.key === "ArrowLeft" && index > 0) { index--; render(); }
  };
  document.addEventListener("keydown", onKey);

  render();
  return () => {
    clearInterval(tick);
    document.removeEventListener("keydown", onKey);
    releaseScreen();
    document.body.classList.remove("cooking");
  };
}
