// A new recipe read from photos (a cookbook page, a card, a screenshot) or
// from a web page, as a draft for the editor. Nothing is stored here except
// the recipe photo of a web page (fetched into KV, like an upload): the draft
// goes back to public/app/recipe-edit.js and only the person's save makes it
// a recipe.put.
//
// Photos: Claude (vision) reads the recipe in its own language, says which
// photo shows the finished dish and where the food is on it; the phone crops
// that and uploads it through /api/photos.
// A web page: schema.org Recipe JSON-LD when the page has it (no Claude at
// all), else the page's text to Claude. The page's own image (JSON-LD image,
// else og:image) becomes the recipe photo.
//
// The key is the worker secret ANTHROPIC_API_KEY; askClaude never logs or
// returns it.
import { askClaude, takeOne } from "./claude.js";
import { LABEL_SCHEMA, labelPatch } from "./labels.js";
import { TRANSLATION_SCHEMA, LANGS, otherLang } from "../public/shared/bilingual.js";
import { savePhoto, PHOTO_TYPES, PHOTO_MAX_BYTES } from "./photos.js";
import { clampBox } from "../public/shared/recipe-import.js";

/** Imports per household per day, photos and pages together; each can be a paid call. */
export const IMPORT_DAILY_LIMIT = 30;
// A recipes-only person (Henk) counts on his own, per member: he can never
// use up the household's reads (30-10-2026).
export const GUEST_IMPORT_DAILY_LIMIT = 10;
const takeImport = (env, who) => (who.recipesOnly
  ? takeOne(env, "recipe_import_guest", who.memberId, GUEST_IMPORT_DAILY_LIMIT)
  : takeOne(env, "recipe_import", who.householdId, IMPORT_DAILY_LIMIT));
export const MAX_PHOTOS = 4;

// Mutable so a test can shorten the timeout; nothing else changes them.
export const LIMITS = {
  photoBytes: PHOTO_MAX_BYTES,          // per photo, decoded
  bodyBytes: 4 * 7 * 1024 * 1024,       // the JSON with up to 4 base64 photos
  pageBytes: 2 * 1024 * 1024,           // a recipe page; more is not a recipe page
  imageBytes: PHOTO_MAX_BYTES,          // the page's own image
  timeoutMs: 8000,                      // per fetch, redirects included
  redirects: 4,
  textChars: 30000,                     // page text sent to Claude (~9k tokens)
};

const UA = "Mozilla/5.0 (compatible; vexed-kitchen/1.0; +https://recipes.vexed.works)";

// ------------------------------------------------------------ the answer

const RECIPE_PROPERTIES = {
  is_recipe: { type: "boolean", description: "False when this is not a recipe" },
  title: { type: "string", description: "The recipe's name, as written" },
  servings: { type: "integer", description: "For how many people or portions; 0 when not given" },
  ingredients: {
    type: "array",
    items: { type: "string" },
    description: "One line per ingredient as written, amount first (\"200 g bloem\", \"2 uien\", \"snufje zout\"). A sub-heading is its own line ending in a colon (\"Saus:\")",
  },
  steps: { type: "array", items: { type: "string" }, description: "One line per step, without its number" },
  notes: { type: "string", description: "Everything else written with the recipe, in its own words: the introduction above it, tips, variations, and the equipment it lists (as \"Benodigdheden: frituurpan, spuitzak, …\"); empty only when there is nothing" },
  ...LABEL_SCHEMA.properties,
  // Both languages from the same call (0029, 30-10-2026: never a second call for it).
  lang: { type: "string", enum: LANGS, description: "The language the recipe is written in: \"en\" for English, \"nl\" for Dutch (and for any other language)" },
  translation: { ...TRANSLATION_SCHEMA, description: "The whole recipe in the other language: English when lang is nl, Dutch when lang is en" },
};
const RECIPE_REQUIRED = ["is_recipe", "title", "servings", "ingredients", "steps", "notes", ...LABEL_SCHEMA.required, "lang", "translation"];

export const PAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: RECIPE_REQUIRED,
  properties: RECIPE_PROPERTIES,
};

export const PHOTO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...RECIPE_REQUIRED, "dish_photo", "dish_box"],
  properties: {
    ...RECIPE_PROPERTIES,
    dish_photo: { type: "integer", description: "Which photo shows the finished dish (1 is the first); 0 when none does" },
    dish_box: {
      type: "object",
      additionalProperties: false,
      required: ["x", "y", "width", "height"],
      description: "The food on that photo, as fractions (0 to 1) of the photo's width and height; x, y is the top left corner. All 0 when dish_photo is 0",
      properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
    },
  },
};

const RULES = [
  "Write the recipe out in the language it is written in. Do not translate.",
  "Keep every ingredient exactly as written, whatever it is. Do not add, leave out or change ingredients or amounts.",
  "Pick each label from the allowed values only; count oven or simmering time in time_minutes.",
  "Then, apart from that, give lang and translation: the same recipe (title, every ingredient line in the same order, every step, the notes) in the other language, natural kitchen English or Dutch, nothing added or left out.",
];

const PHOTO_PROMPT = [
  "These photos show one recipe: a cookbook page, a card, handwriting or a screen. There may be more than one page.",
  ...RULES,
  "dish_photo: the photo of the finished dish, if one of them shows it; a photo of only the recipe text is not the dish. A cookbook page with a picture of the dish counts: box only the picture of the food.",
].join("\n");

const PAGE_PROMPT = [
  "Below is the text of a web page with a recipe. If the page has more than one recipe, take the main one. Ignore comments, ads and links.",
  ...RULES,
].join("\n");

const line = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const lines = (list, max, count) => (Array.isArray(list) ? list : [])
  .map((v) => line(v, max)).filter(Boolean).slice(0, count);
/** Fewer than 3 ingredients or no steps: shown for a close look, never padded. */
export const isThin = (ingredients, steps) => ingredients.length < 3 || steps.length === 0;
const servingsOf = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 100 ? n : null;
};

/**
 * Claude's answer as a draft for the editor, or null when it is no recipe.
 * `photos` is how many photos were sent (0 for a page): only then a dish.
 *   { title, servings, ingredients: [lines], steps: [lines], notes,
 *     labels: recipe.put label patch or null, dish: { photo, box } or null,
 *     thin: true when it needs a close look,
 *     lang: 'nl' | 'en' | null, translation: { title, ingredients, steps, notes } in the other language or null }
 */
export function draftOf(answer, { photos = 0 } = {}) {
  if (!answer || typeof answer !== "object" || answer.is_recipe === false) return null;
  const title = line(answer.title, 200);
  const ingredients = lines(answer.ingredients, 300, 150);
  const steps = lines(answer.steps, 2000, 80);
  if (!title || (!ingredients.length && !steps.length)) return null;
  let dish = null;
  const n = Math.round(Number(answer.dish_photo));
  if (photos > 0 && Number.isFinite(n) && n >= 1 && n <= photos) {
    // A dish without a usable box is the whole photo.
    dish = { photo: n - 1, box: clampBox(answer.dish_box) ?? { x: 0, y: 0, width: 1, height: 1 } };
  }
  return {
    title,
    servings: servingsOf(answer.servings),
    ingredients,
    steps,
    notes: String(answer.notes ?? "").trim().slice(0, 2000),
    labels: labelPatch(answer),
    dish,
    thin: isThin(ingredients, steps),
    ...translationOf(answer),
  };
}

/** The answer's language and its translation into the other one, checked; nulls when absent. */
export function translationOf(answer) {
  const lang = LANGS.includes(answer?.lang) ? answer.lang : null;
  const tr = answer?.translation;
  const title = lang && tr && typeof tr === "object" ? line(tr.title, 200) : "";
  if (!title) return { lang, translation: null };
  return {
    lang,
    translation: {
      lang: otherLang(lang),
      title,
      ingredients: lines(tr.ingredients, 300, 150),
      steps: lines(tr.steps, 2000, 80),
      notes: String(tr.notes ?? "").trim().slice(0, 2000),
    },
  };
}

// ------------------------------------------------------------ the page

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", eacute: "é", egrave: "è", euml: "ë",
  ecirc: "ê", aacute: "á", agrave: "à", auml: "ä", iuml: "ï", iacute: "í", ouml: "ö", oacute: "ó",
  uuml: "ü", uacute: "ú", ccedil: "ç", ntilde: "ñ", szlig: "ß", deg: "°", frac12: "½", frac14: "¼",
  frac34: "¾", hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", times: "×",
};

export function decodeEntities(text) {
  return String(text ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (s) => decodeEntities(String(s ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/** Every JSON-LD object on the page whose @type is Recipe. */
export function jsonLdRecipes(html) {
  const found = [];
  const walk = (v, depth) => {
    if (depth > 8 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const type = v["@type"];
    if (type === "Recipe" || (Array.isArray(type) && type.includes("Recipe"))) found.push(v);
    for (const [k, x] of Object.entries(v)) if (k !== "@context" && typeof x === "object") walk(x, depth + 1);
  };
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of String(html).matchAll(re)) {
    try {
      walk(JSON.parse(m[1].trim().replace(/^<!--|-->$/g, "")), 0);
    } catch {
      // A broken block on the page: the next one, or Claude.
    }
  }
  return found;
}

function stepsOf(instructions) {
  const out = [];
  const add = (v) => {
    if (!v) return;
    if (typeof v === "string") {
      // One string with every step: split on lines, or keep it whole.
      for (const s of v.replace(/<\/(p|li)>|<br\s*\/?>/gi, "\n").split(/\n+/)) {
        const t = stripTags(s);
        if (t) out.push(t);
      }
    } else if (Array.isArray(v)) {
      for (const x of v) add(x);
    } else if (typeof v === "object") {
      if (v.itemListElement) add(v.itemListElement);           // HowToSection
      else add(v.text ?? v.name ?? "");                         // HowToStep
    }
  };
  add(instructions);
  return out.map((s) => s.slice(0, 2000)).slice(0, 80);
}

function imageOf(v) {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(imageOf).find(Boolean) ?? null;
  if (typeof v === "object") return imageOf(v.url ?? v.contentUrl ?? v["@id"]);
  return null;
}

/**
 * A JSON-LD Recipe as a draft (the same shape as draftOf), or null when it
 * has no name or no ingredients. Its image URL comes along as `image`.
 */
export function draftFromJsonLd(node) {
  const title = line(stripTags(node?.name), 200);
  const ingredients = (Array.isArray(node?.recipeIngredient) ? node.recipeIngredient
    : Array.isArray(node?.ingredients) ? node.ingredients : [])
    .map((s) => line(stripTags(s), 300)).filter(Boolean).slice(0, 150);
  if (!title || !ingredients.length) return null;
  const yieldText = Array.isArray(node.recipeYield) ? node.recipeYield.join(" ") : String(node.recipeYield ?? "");
  return {
    title,
    servings: servingsOf(yieldText.match(/\d+/)?.[0]),
    ingredients,
    steps: stepsOf(node.recipeInstructions),
    // The page's own introduction (30-10-2026: the notes stayed empty while a fine text sat above the recipe).
    notes: line(stripTags(String(node.description ?? "")), 2000),
    // The labels are Claude's job after the save (worker/labels.js), as for a typed recipe.
    labels: null,
    dish: null,
    thin: false,
    image: imageOf(node.image),
  };
}

function metaContent(html, names) {
  for (const m of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    if (key && names.includes(key)) {
      const content = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      if (content) return decodeEntities(content.trim());
    }
  }
  return null;
}

/** The page as plain text lines for Claude: no scripts, styles, menus or footers. */
export function pageText(html, max = LIMITS.textChars) {
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  const body = String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|nav|footer|aside|form|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(p|div|li|ul|ol|h[1-6]|tr|section|article|header|br|table|dd|dt)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  const text = decodeEntities(body).split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
  return `${title ? `${title}\n\n` : ""}${text}`.slice(0, max);
}

/**
 * A URL the worker may fetch: http(s) on a public host name, default port, no
 * user info, no IP address, at most 500 characters (recipe.put's limit).
 */
export function safeUrl(text) {
  let u;
  try {
    u = new URL(String(text ?? "").trim());
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || host.startsWith("[") || /^[\d.]+$/.test(host)) return null;
  if (/(^|\.)(localhost|local|internal|lan|home|test|invalid|example)$/.test(host)) return null;
  u.hash = "";
  return u.href.length <= 500 ? u : null;
}

/**
 * GET with a byte limit and a timeout over the whole fetch, following at
 * most LIMITS.redirects redirects, each one checked by safeUrl.
 * Resolves to { bytes, type, url } or { error }: "bad_url", "page_timeout",
 * "page_too_large", "page_unreachable", "bad_type".
 */
export async function fetchLimited(url, { maxBytes, types }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.timeoutMs);
  try {
    let current = url;
    let res;
    for (let hop = 0; ; hop++) {
      res = await globalThis.fetch(current.href, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": UA, Accept: types.join(", ") },
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("Location") : null;
      if (!location) break;
      if (hop >= LIMITS.redirects) return { error: "page_unreachable" };
      current = safeUrl(new URL(location, current).href);
      if (!current) return { error: "bad_url" };
    }
    if (!res.ok) return { error: "page_unreachable" };
    const type = (res.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
    if (!types.includes(type)) return { error: "bad_type" };
    if (Number(res.headers.get("Content-Length") ?? 0) > maxBytes) return { error: "page_too_large" };
    const chunks = [];
    let size = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          controller.abort();
          return { error: "page_too_large" };
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    return { bytes, type, url: current };
  } catch {
    return { error: controller.signal.aborted ? "page_timeout" : "page_unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/** The page's own image into the photo store; null when there is none or it fails. */
async function pagePhoto(env, who, html, image, base) {
  const src = image ?? metaContent(html, ["og:image", "og:image:url", "og:image:secure_url", "twitter:image"]);
  let url = null;
  try {
    url = src ? safeUrl(new URL(src, base).href) : null;
  } catch {
    url = null;
  }
  if (!url) return null;
  const got = await fetchLimited(url, { maxBytes: LIMITS.imageBytes, types: PHOTO_TYPES });
  if (got.error || !got.bytes.byteLength) return null;
  return savePhoto(env, who, got.bytes, got.type);
}

// ------------------------------------------------------------ the routes

const failed = (out) => (out.failed === "rate_limited"
  ? { status: 429, error: "too_many_imports" }
  : out.failed === "network" || out.failed === "api"
    ? { status: 502, error: "import_failed" }
    : { status: 422, error: "import_unreadable" });

/**
 * POST /api/recipes/import/photos, body { photos: [{ type, data }] }: data
 * is base64 of a JPEG, PNG or WebP the phone already shrank. Raw route: the
 * size is checked before the JSON is parsed.
 */
export async function importFromPhotos(request, env, who) {
  if (!(request.headers.get("Content-Type") ?? "").startsWith("application/json")) return { status: 415, error: "json_required" };
  if (!env.ANTHROPIC_API_KEY) return { status: 503, error: "import_off" };
  if (Number(request.headers.get("Content-Length") ?? 0) > LIMITS.bodyBytes) return { status: 413, error: "too_large" };
  const text = await request.text();
  if (text.length > LIMITS.bodyBytes) return { status: 413, error: "too_large" };
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { status: 400, error: "bad_json" };
  }
  const photos = Array.isArray(body?.photos) ? body.photos : [];
  if (!photos.length) return { status: 400, error: "no_photos" };
  if (photos.length > MAX_PHOTOS) return { status: 400, error: "too_many_photos" };
  for (const p of photos) {
    if (!PHOTO_TYPES.includes(p?.type) || typeof p.data !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(p.data)) {
      return { status: 415, error: "bad_type" };
    }
    if (Math.floor((p.data.length * 3) / 4) > LIMITS.photoBytes) return { status: 413, error: "too_large" };
  }
  if (!(await takeImport(env, who))) return { status: 429, error: "too_many_imports" };

  const out = await askClaude(env, {
    what: "recipe photos",
    schema: PHOTO_SCHEMA,
    maxTokens: 14000,
    content: [
      ...photos.flatMap((p, i) => [
        { type: "text", text: `Photo ${i + 1}:` },
        { type: "image", source: { type: "base64", media_type: p.type, data: p.data } },
      ]),
      { type: "text", text: PHOTO_PROMPT },
    ],
  });
  if (out.failed) return failed(out);
  const draft = draftOf(out.answer, { photos: photos.length });
  if (!draft) return { status: 422, error: "not_a_recipe" };
  return { draft };
}

/** POST /api/recipes/import/url, body { url }. */
export async function importFromUrl(env, who, body) {
  const url = safeUrl(body?.url);
  if (!url) return { status: 400, error: "bad_url" };
  if (!(await takeImport(env, who))) return { status: 429, error: "too_many_imports" };

  const page = await fetchLimited(url, { maxBytes: LIMITS.pageBytes, types: ["text/html", "application/xhtml+xml"] });
  if (page.error) return { status: page.error === "bad_url" ? 400 : 422, error: page.error === "bad_type" ? "not_a_recipe" : page.error };
  const html = new TextDecoder().decode(page.bytes);

  let draft = jsonLdRecipes(html).map(draftFromJsonLd).find(Boolean) ?? null;
  let via = "json_ld";
  if (!draft) {
    if (!env.ANTHROPIC_API_KEY) return { status: 503, error: "import_off" };
    const text = pageText(html);
    if (text.length < 80) return { status: 422, error: "not_a_recipe" };
    const out = await askClaude(env, {
      what: "recipe page",
      schema: PAGE_SCHEMA,
      maxTokens: 14000,
      content: [{ type: "text", text: `${PAGE_PROMPT}\n\n<page url="${url.href}">\n${text}\n</page>` }],
    });
    if (out.failed) return failed(out);
    draft = draftOf(out.answer);
    if (!draft) return { status: 422, error: "not_a_recipe" };
    via = "claude";
  }
  const { image = null, ...rest } = draft;
  rest.thin = isThin(rest.ingredients, rest.steps);
  const photo = await pagePhoto(env, who, html, image, page.url);
  return { draft: { ...rest, photo, source_url: url.href, via } };
}
