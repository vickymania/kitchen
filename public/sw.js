// Service worker for both apps (each host registers its own copy).
//
// The shell (pages, scripts, styles, texts, fonts, icons) is cached so the app
// opens in a shop without signal. The worker puts the build id in VERSION on
// every deploy, so a new version means a new cache and phones update.
//
// /api/ never touches the cache: recipes and the list live in IndexedDB
// (public/app/store.js), and an API answer from a cache would be a lie.
// Recipe photos are cached after they were seen once, so a recipe shows its
// photo offline; signing out deletes that cache (store.forget).
//
// tools/map_check.py fails when a file of the shell is missing from SHELL.
const VERSION = "__BUILD_ID__";
const SHELL_CACHE = `kitchen-shell-${VERSION}`;
const PHOTO_CACHE = "kitchen-photos";

const SHELL = [
  "/",
  "/recipes.html",
  "/groceries.html",
  "/manifest.webmanifest",
  "/styles/app.css",
  "/i18n/en.json",
  "/i18n/nl.json",
  "/app/boot.js",
  "/app/api.js",
  "/app/store.js",
  "/app/dom.js",
  "/app/i18n.js",
  "/app/status.js",
  "/app/pairing.js",
  "/app/recipes.js",
  "/app/recipe.js",
  "/app/recipe-edit.js",
  "/app/recipe-import.js",
  "/app/cook.js",
  "/app/timers.js",
  "/app/wake.js",
  "/app/photo.js",
  "/app/groceries.js",
  "/app/settings.js",
  "/app/theme.js",
  "/app/again.js",
  "/app/receipt.js",
  "/app/product.js",
  "/app/suggest-box.js",
  "/app/wizard.js",
  "/app/labels.js",
  "/app/shop.js",
  "/app/pantry.js",
  "/app/deals.js",
  "/app/stars.js",
  "/app/recent.js",
  "/app/prices.js",
  "/app/review.js",
  "/shared/again-scope.js",
  "/shared/product-kinds.js",
  "/shared/intervals.js",
  "/shared/cook-prompts.js",
  "/shared/recipe-ratings.js",
  "/shared/store-prices.js",
  "/shared/recent-purchases.js",
  "/shared/item-names.js",
  "/shared/item-find.js",
  "/shared/ingredient-match.js",
  "/shared/suggest.js",
  "/shared/ingredients.js",
  "/shared/recipe-text.js",
  "/shared/recipe-import.js",
  "/shared/ops.js",
  "/shared/excluded.js",
  "/shared/excluded-words.js",
  "/shared/labels.js",
  "/shared/wizard.js",
  "/shared/pantry.js",
  "/shared/shelf-life.js",
  "/shared/usage-rates.js",
  "/shared/rate-learning.js",
  "/shared/default-portions.js",
  "/shared/offers.js",
  "/shared/stores.js",
  "/shared/preferences.js",
  "/shared/deal-math.js",
  "/shared/deals.js",
  "/shared/low-stock.js",
  "/shared/needed-soon.js",
  "/shared/list-groups.js",
  "/fonts/chakra-petch-400-latin.woff2",
  "/fonts/chakra-petch-500-latin.woff2",
  "/fonts/chakra-petch-600-latin.woff2",
  "/fonts/chakra-petch-700-latin.woff2",
  "/fonts/share-tech-mono-400-latin.woff2",
  "/icons/recipes-192.png",
  "/icons/groceries-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // cache: "reload" skips the browser cache, so the shell is this version's.
    await cache.addAll(SHELL.map((url) => new Request(url, { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("kitchen-shell-") && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    // Every page of the app is the same page; the route is in the hash.
    event.respondWith(fromShell(new Request("/"), req));
    return;
  }

  if (url.pathname.startsWith("/photos/")) {
    event.respondWith((async () => {
      const cache = await caches.open(PHOTO_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  event.respondWith(fromShell(req, req));
});

/**
 * The cached copy, or the network. A shell file that comes in from the
 * network is cached on the way, so a cache the browser evicted (or that was
 * cleared) refills on the next visit with signal instead of staying empty.
 */
async function fromShell(key, req) {
  const cache = await caches.open(SHELL_CACHE);
  // Under `wrangler dev` the version never changes, so the network goes
  // first there (fresh files while building) and the cache is the fallback.
  if (VERSION === "dev") {
    try {
      const res = await fetch(req, { cache: "no-store" });
      if (res.ok && SHELL.includes(new URL(key.url).pathname)) await cache.put(key, res.clone());
      return res;
    } catch {
      return (await cache.match(key, { ignoreSearch: true })) ?? Response.error();
    }
  }
  const hit = await cache.match(key, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && SHELL.includes(new URL(key.url).pathname)) await cache.put(key, res.clone());
  return res;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (all[0]) return all[0].focus();
    return self.clients.openWindow("/");
  })());
});
