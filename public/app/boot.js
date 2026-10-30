// Entry point of both apps. recipes.html and groceries.html load this file;
// <body data-app> says which one is running.
import "./theme.js";
import { api, isOffline } from "./api.js";
import { toast } from "./dom.js";
import { setLocale, t, applyI18n } from "./i18n.js";
import * as store from "./store.js";
import { mountPairing, consumeHandoff, consumeInvite } from "./pairing.js";
import { mountRecipes } from "./recipes.js";
import { mountRecipe } from "./recipe.js";
import { mountEditor } from "./recipe-edit.js";
import { mountCook } from "./cook.js";
import { mountGroceries } from "./groceries.js";
import { mountAgain } from "./again.js";
import { mountPantry } from "./pantry.js";
import { mountDeals } from "./deals.js";
import { mountRecent } from "./recent.js";
import { mountReceipt } from "./receipt.js";
import { mountProduct } from "./product.js";
import { mountSettings } from "./settings.js";
import { mountWizard } from "./wizard.js";
import { startLabelQueue } from "./labels.js";

const APP = document.body.dataset.app;
const main = document.getElementById("main");

const ROUTES = {
  recipes: [
    [/^$/, mountRecipes],
    [/^recipe\/([\w-]+)$/, mountRecipe],
    [/^recipe\/([\w-]+)\/cook$/, mountCook],
    [/^edit\/([\w-]+)$/, mountEditor],
    [/^new$/, mountEditor],
    [/^wizard$/, mountWizard],
    [/^settings$/, mountSettings],
  ],
  groceries: [
    [/^$/, mountGroceries],
    [/^entry\/([\w-]+)$/, mountGroceries],
    [/^again$/, mountAgain],
    [/^pantry$/, mountPantry],
    [/^deals$/, mountDeals],
    [/^recent$/, mountRecent],
    [/^receipt$/, mountReceipt],
    [/^product\/([\w-]+)$/, mountProduct],
    [/^settings$/, mountSettings],
  ],
};

let unmount = null;

// What a recipes-only person may open: the book, a recipe, cook mode, the
// wizard, Settings, a new recipe and the editor of one he made. Anything
// else falls back to the book, someone else's editor to that recipe.
const GUEST_ROUTES = new Set([mountRecipes, mountRecipe, mountCook, mountWizard, mountSettings, mountEditor]);

function route() {
  const path = location.hash.replace(/^#\/?/, "");
  if (path.startsWith("pair=")) return;
  let hit = ROUTES[APP].find(([re]) => re.test(path)) ?? ROUTES[APP][0];
  if (store.isGuest() && !GUEST_ROUTES.has(hit[1])) hit = ROUTES[APP][0];
  const params = path.match(hit[0])?.slice(1) ?? [];
  const recipe = hit[1] === mountEditor && params[0] ? store.getView().recipes[params[0]] : null;
  if (store.isGuest() && recipe && recipe.created_by !== store.getMe()?.member.id) {
    location.replace(`#/recipe/${recipe.id}`);
    return;
  }
  unmount?.();
  document.body.classList.remove("cooking");
  main.replaceChildren();
  window.scrollTo(0, 0);
  unmount = hit[1](main, ...params) ?? null;
  for (const a of document.querySelectorAll(".topnav a[data-nav]")) {
    if (a.dataset.nav === APP && !path.startsWith("settings")) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}

/**
 * The link to the other app takes this device's pairing along: it asks for a
 * one-time handoff and opens the other app with it. A plain link landed on the
 * code screen there (28-10-2026: "werkt niet"). Offline it stays a
 * plain link.
 */
function wireOtherApp(me) {
  for (const a of document.querySelectorAll(`.topnav a[data-nav]:not([data-nav="${APP}"])`)) {
    a.href = `${me.other_app}/`;
    a.addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        location.href = (await api.post("/api/handoff")).url;
      } catch {
        location.href = a.href;
      }
    });
  }
  for (const a of document.querySelectorAll(`.topnav a[data-nav="${APP}"]`)) a.href = "#/";
}

function showPairing() {
  unmount?.();
  main.replaceChildren();
  unmount = mountPairing(main);
}

async function start() {
  await store.init();
  const cached = store.getMe();
  const guess = navigator.language?.toLowerCase().startsWith("nl") ? "nl" : "en";
  await setLocale(cached?.member.locale ?? guess);

  const handoff = location.hash.match(/^#pair=([\w-]+)$/)?.[1];
  const invite = location.hash.match(/^#\/join\/([\w-]+)$/)?.[1] ?? null;
  if (handoff || invite) history.replaceState(null, "", location.pathname);

  const askMe = async () => {
    try {
      const fresh = await api.get("/api/me");
      await store.setMe(fresh);
      return fresh;
    } catch (e) {
      return isOffline(e) ? cached : null;     // null: the server says not paired
    }
  };
  let me = await askMe();
  // Only a device that is not paired here yet uses the handoff; one that is
  // paired already would otherwise get a second device row on every switch.
  if (!me && handoff && (await consumeHandoff(handoff))) me = await askMe();
  // An invite on a device that is linked already stays unused, for the phone it was meant for.
  if (me && invite) toast(t("pair.already_linked"));
  if (!me && invite && (await consumeInvite(invite))) me = await askMe();
  if (!me) {
    await store.forget();
    showPairing();
    return;
  }
  if (me.member.locale !== cached?.member.locale) await setLocale(me.member.locale);
  if (me.member.recipes_only) {
    for (const a of document.querySelectorAll(`.topnav a[data-nav]:not([data-nav="${APP}"])`)) a.hidden = true;
  } else wireOtherApp(me);

  window.addEventListener("kitchen:unpaired", async () => {
    await store.forget();
    showPairing();
  });
  store.onRefused((code) => toast(t(`errors.${code}`) === `errors.${code}` ? t("errors.refused") : t(`errors.${code}`), { error: true }));
  window.addEventListener("hashchange", route);
  route();
  store.sync();
  if (APP === "recipes") startLabelQueue();
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  // A new version took over: reload once so the screens match it. Not on the
  // very first visit, when there was no old version to replace.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloaded || !hadController) return;
    reloaded = true;
    location.reload();
  });
}

applyI18n(document);
start();
