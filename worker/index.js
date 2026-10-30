// One worker serves both apps. The host name decides which page "/" is:
// recipes.vexed.works gets recipes.html, groceries.vexed.works gets
// groceries.html. Both share the API, the database and the files in public/.
import { handleApi, json, otherAppOrigin } from "./api.js";
import { authenticate } from "./auth.js";
import { servePhoto } from "./photos.js";

export function appFor(url) {
  return new URL(url).hostname.startsWith("groceries.") ? "groceries" : "recipes";
}

// Only our own files: no inline script, no third party, no framing.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function secure(response, { html = false } = {}) {
  const r = new Response(response.body, response);
  r.headers.set("X-Content-Type-Options", "nosniff");
  r.headers.set("Referrer-Policy", "no-referrer");
  if (html) {
    r.headers.set("Content-Security-Policy", CSP);
    r.headers.set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  }
  return r;
}

/**
 * groceries.vexed.works for a recipes-only person: one short page with the
 * way to the recipes, never the list's shell. Styled by the app's own sheet
 * (the CSP allows no inline style).
 */
function recipesOnlyPage(url) {
  const recipes = `${otherAppOrigin(url)}/`;
  return new Response(`<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Groceries</title>
<meta name="robots" content="noindex, nofollow">
<link rel="stylesheet" href="/styles/app.css">
</head>
<body data-app="groceries">
<div class="reg tl"></div><div class="reg tr"></div><div class="reg bl"></div><div class="reg br"></div>
<header class="topbar"><div class="wrap">
<a class="brand" href="${recipes}"><svg class="mark" viewBox="189.75 15.75 118.5 118.5" aria-hidden="true"><g fill="none" stroke-width="15" stroke-linejoin="miter" stroke-linecap="butt"><path d="M212 130 L249 75 L286 130" stroke="#C8152C"/><path d="M215 75 L283 75" stroke="#C8152C"/><path d="M212 20 L249 75 L286 20" stroke="currentColor"/></g></svg><span class="wordmark">Recepten</span></a>
</div></header>
<main id="main"><section class="hero wrap">
<div class="eyebrow mono"><span>${url.hostname}</span><span>—</span><span class="sig">Alleen recepten</span></div>
<h1 class="long">Boodschappen<span class="dot">.</span></h1>
</section>
<div class="wrap">
<p class="notes">Je hebt alleen toegang tot de recepten.</p>
<p class="hint" lang="en">You only have access to the recipes.</p>
<div class="actions"><a class="btn primary" href="${recipes}">Naar de recepten</a></div>
</div></main>
</body>
</html>`, { status: 403, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

async function asset(request, env, path, { cache = "no-cache" } = {}) {
  const url = new URL(request.url);
  url.pathname = path;
  url.search = "";
  const res = await env.ASSETS.fetch(new Request(url, request));
  const out = new Response(res.body, res);
  // The app shell must update when it changes; the service worker keeps it
  // offline. Fonts and icons never change under the same name.
  out.headers.set("Cache-Control", cache);
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const app = appFor(url);
    const path = url.pathname;

    if (path.startsWith("/api/")) return secure(await handleApi(request, env, ctx));

    // A recipes-only person on groceries: the page says so, nothing else loads.
    const guest = app === "groceries" && /^\/($|index\.html$|groceries\.html$|photos\/)/.test(path)
      ? (await authenticate(request, env))?.recipesOnly : false;
    if (guest) return secure(path.startsWith("/photos/") ? json({ error: "recipes_only" }, 403) : recipesOnlyPage(url), { html: true });

    if (path.startsWith("/photos/")) {
      const who = await authenticate(request, env);
      if (!who) return secure(json({ error: "unpaired" }, 401));
      return secure(await servePhoto(request, env, who));
    }

    if (path === "/" || path === "/index.html") return secure(await asset(request, env, `/${app}.html`), { html: true });
    if (path === "/manifest.webmanifest") return secure(await asset(request, env, `/${app}.webmanifest`));

    // The service worker carries the build id, so every deploy changes its
    // bytes and phones pick up the new shell (tools/deploy.mjs sets BUILD_ID).
    if (path === "/sw.js") {
      const res = await asset(request, env, "/sw.js", { cache: "no-store" });
      const body = (await res.text()).replace("__BUILD_ID__", env.BUILD_ID ?? "dev");
      return secure(new Response(body, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" } }));
    }

    const long = path.startsWith("/fonts/") || path.startsWith("/icons/");
    const res = await asset(request, env, path, { cache: long ? "public, max-age=31536000, immutable" : "no-cache" });
    return secure(res, { html: path.endsWith(".html") });
  },
};
