// Importing a recipe from photos or a web page (worker/recipe-import.js,
// public/shared/recipe-import.js). Claude and every website are mocked:
// globalThis.fetch is replaced, so no test makes a paid call or goes online.
import "./never-suggest.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import worker from "../worker/index.js";
import { makeEnv } from "./d1-shim.mjs";
import { bootstrapSql } from "../tools/admin.mjs";
import {
  draftOf, draftFromJsonLd, jsonLdRecipes, pageText, safeUrl, decodeEntities,
  LIMITS, IMPORT_DAILY_LIMIT, MAX_PHOTOS, PHOTO_SCHEMA, PAGE_SCHEMA,
} from "../worker/recipe-import.js";
import { clampBox, cropRect } from "../public/shared/recipe-import.js";

const HOST = "recipes.localhost:8787";
const FIXTURE = fs.readFileSync(new URL("./fixtures/recipe-jsonld.html", import.meta.url), "utf8");
const PAGE_URL = "https://www.testkeuken.nl/hutspot/";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const B64 = JPEG.toString("base64");

function call(env, method, path, { body, cookie, raw, type, origin = `http://${HOST}` } = {}) {
  const headers = { Origin: origin };
  if (cookie) headers.Cookie = `kd=${cookie}`;
  if (body !== undefined || raw !== undefined) headers["Content-Type"] = type ?? "application/json";
  return worker.fetch(new Request(`http://${HOST}${path}`, {
    method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  }), env);
}

async function household(extra = {}) {
  const env = { ...(await makeEnv()), ...extra };
  await env.DB.exec(await bootstrapSql({ household: "Thuis", name: "Thomas", code: "123456" }));
  const res = await call(env, "POST", "/api/pair", { body: { code: "123456" } });
  const token = res.headers.getSetCookie().map((c) => c.match(/^kd=([^;]+)/)?.[1]).find(Boolean);
  return { env, thomas: token };
}

const claudeReply = (answer, { status = 200, stop = "end_turn", text = null } = {}) =>
  new Response(JSON.stringify({ stop_reason: stop, content: [{ type: "text", text: text ?? JSON.stringify(answer) }] }), { status });

/** Replace fetch: `handler(url, init)` answers every request; every call is recorded. */
function mockFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const entry = { url: String(url), init, body: init.body && String(url).includes("anthropic") ? JSON.parse(init.body) : null };
    calls.push(entry);
    return handler(String(url), init);
  };
  return {
    calls,
    claude: () => calls.filter((c) => c.url.startsWith("https://api.anthropic.com/")),
    restore: () => { globalThis.fetch = original; },
  };
}

const html = (text, headers = {}) => new Response(text, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ...headers } });
const image = () => new Response(JPEG, { status: 200, headers: { "Content-Type": "image/jpeg" } });

const ANSWER = {
  is_recipe: true,
  title: "Hutspot met draadjesvlees",
  servings: 4,
  ingredients: ["Vlees:", "1 kg draadjesvlees", "1,5 kg aardappelen", "1 kg winterpeen"],
  steps: ["1. Bak het vlees.", "Stoof 3 uur en stamp de groente."],
  notes: "",
  cuisine: "dutch",
  main_ingredient: "beef",
  time_class: "elaborate",
  time_minutes: 200,
  meals: ["dinner"],
  dish_photo: 2,
  dish_box: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 },
};

// ----------------------------------------------------------- the crop box

test("crop box: kept inside the photo, refused when it is no box", () => {
  assert.deepEqual(clampBox({ x: 0.1, y: 0.2, width: 0.5, height: 0.6 }), { x: 0.1, y: 0.2, width: 0.5, height: 0.6 });
  assert.deepEqual(clampBox({ x: -0.2, y: 0.5, width: 0.7, height: 0.9 }), { x: 0, y: 0.5, width: 0.5, height: 0.5 }, "cut at the edges");
  assert.deepEqual(clampBox({ x: "0.25", y: "0", width: "0.5", height: "1" }), { x: 0.25, y: 0, width: 0.5, height: 1 }, "numbers as strings");
  for (const bad of [null, undefined, "box", {}, { x: 0, y: 0, width: 0, height: 0 }, { x: 0.1, y: 0.1, width: -1, height: 0.5 },
    { x: 0.95, y: 0, width: 0.5, height: 1 }, { x: 0, y: 0, width: 0.05, height: 1 }, { x: NaN, y: 0, width: 1, height: 1 },
    { x: 1.5, y: 1.5, width: 1, height: 1 }, { x: null, y: 0, width: 1, height: 1 }]) {
    assert.equal(clampBox(bad), null, JSON.stringify(bad));
  }
});

test("crop box: the pixel rectangle has a little room and never leaves the photo", () => {
  assert.deepEqual(cropRect({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, 1000, 800, 0), { sx: 250, sy: 200, sw: 500, sh: 400 });
  const r = cropRect({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, 1000, 800);
  assert.ok(r.sx < 250 && r.sy < 200 && r.sw > 500 && r.sh > 400, "padded");
  const edge = cropRect({ x: 0, y: 0, width: 1, height: 1 }, 1600, 1200);
  assert.deepEqual(edge, { sx: 0, sy: 0, sw: 1600, sh: 1200 }, "the padding stops at the photo's edge");
  const over = cropRect({ x: 0.8, y: 0.8, width: 0.9, height: 0.9 }, 100, 100);
  assert.ok(over.sx + over.sw <= 100 && over.sy + over.sh <= 100);
  assert.equal(cropRect(null, 100, 100), null);
  assert.equal(cropRect({ x: 0, y: 0, width: 1, height: 1 }, 0, 100), null);
});

// ----------------------------------------------------------- Claude's answer

test("answer: a full answer becomes a draft, the lines kept as written", () => {
  const d = draftOf(ANSWER, { photos: 2 });
  assert.equal(d.title, "Hutspot met draadjesvlees");
  assert.equal(d.servings, 4);
  assert.deepEqual(d.ingredients, ["Vlees:", "1 kg draadjesvlees", "1,5 kg aardappelen", "1 kg winterpeen"], "as written, the heading too");
  assert.deepEqual(d.labels, { cuisine: "dutch", main_ingredient: "beef", time_class: "elaborate", time_minutes: 200, meals: ["dinner"], labels_by: "claude" });
  assert.deepEqual(d.dish, { photo: 1, box: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 } });
  assert.equal(d.thin, false);
});

test("answer: missing or wrong fields are dropped or refuse the draft", () => {
  assert.equal(draftOf(null), null);
  assert.equal(draftOf("not json"), null);
  assert.equal(draftOf({ ...ANSWER, is_recipe: false }), null, "not a recipe");
  assert.equal(draftOf({ ...ANSWER, title: "  " }), null, "no title");
  assert.equal(draftOf({ ...ANSWER, ingredients: [], steps: [] }), null, "nothing to cook");
  const { title: _t, ...noTitle } = ANSWER;
  assert.equal(draftOf(noTitle), null);

  const odd = draftOf({ title: "Soep", ingredients: "1 ui", steps: [null, "", "Kook."], servings: "veel", cuisine: "martian", dish_photo: 1 });
  assert.deepEqual(odd.ingredients, [], "a string is no list");
  assert.deepEqual(odd.steps, ["Kook."]);
  assert.equal(odd.servings, null);
  assert.equal(odd.labels, null, "no label from the vocabulary");
  assert.equal(odd.dish, null, "a page has no dish photo");
  assert.equal(odd.thin, true, "few ingredients: flagged, never padded");

  assert.equal(draftOf({ ...ANSWER, dish_photo: 3 }, { photos: 2 }).dish, null, "a photo that was not sent");
  assert.equal(draftOf({ ...ANSWER, dish_photo: 0 }, { photos: 2 }).dish, null, "none shows the dish");
  assert.deepEqual(draftOf({ ...ANSWER, dish_box: { x: 2, y: 2, width: 0, height: 0 } }, { photos: 2 }).dish,
    { photo: 1, box: { x: 0, y: 0, width: 1, height: 1 } }, "a broken box is the whole photo");
  assert.equal(draftOf({ ...ANSWER, servings: 0 }).servings, null);
  assert.equal(draftOf({ ...ANSWER, steps: [] }).thin, true, "no steps: flagged");
});

// ----------------------------------------------------------- JSON-LD

test("JSON-LD: a real-world-shaped page gives the recipe without Claude", () => {
  const found = jsonLdRecipes(FIXTURE);
  assert.equal(found.length, 1, "the broken block is skipped, the @graph is searched");
  const d = draftFromJsonLd(found[0]);
  assert.equal(d.title, "Hutspot met draadjesvlees & jus");
  assert.equal(d.servings, 4);
  assert.deepEqual(d.ingredients, [
    "1 kg draadjesvlees", "2 uien", "½ el bloem", "1,5 kg kruimige aardappelen", "1 kg winterpeen", "2 laurierblaadjes", "1 boterham met mosterd",
  ]);
  assert.deepEqual(d.steps, [
    "Snijd het vlees in blokjes en bestrooi met bloem.",
    "Snipper de uien.",
    "Bak het vlees bruin, voeg de uien toe en schenk er water & laurier bij.",
    "Leg de boterham erop en stoof 3 uur op laag vuur. Kook de aardappelen met de peen en stamp ze fijn.",
  ]);
  assert.equal(d.image, "/images/hutspot-1200x800.jpg");
  assert.equal(d.labels, null, "labels come from the labeller after the save");
});

test("JSON-LD: other shapes (string steps, plain image, no ingredients)", () => {
  const page = `<script type="application/ld+json">[{"@type":"Recipe","name":"Pannenkoeken","recipeYield":"8 stuks",
    "recipeIngredient":["250 g bloem","2 eieren","500 ml melk"],"recipeInstructions":"Meng alles.\\nBak dun.",
    "image":"https://cdn.testkeuken.nl/p.jpg"}]</script>
    <script type="application/ld+json">{"@type":"Recipe","name":"Leeg"}</script>`;
  const [a, b] = jsonLdRecipes(page);
  const d = draftFromJsonLd(a);
  assert.deepEqual([d.servings, d.steps, d.image], [8, ["Meng alles.", "Bak dun."], "https://cdn.testkeuken.nl/p.jpg"]);
  assert.equal(draftFromJsonLd(b), null, "no ingredients: Claude reads the page instead");
  assert.equal(decodeEntities("&#233;&#x20AC;&amp;&unknown;"), "é€&&unknown;");
});

test("page text: scripts, menus and footers are left out", () => {
  const text = pageText(FIXTURE);
  assert.ok(text.startsWith("Hutspot met draadjesvlees & jus | Testkeuken"));
  assert.ok(text.includes("Stamppot met lang gestoofd, zacht vlees."));
  assert.ok(!text.includes("Contact") && !text.includes("©") && !text.includes("@graph"));
  assert.equal(pageText(`<p>${"x".repeat(100)}</p>`, 50).length, 50, "cut at the limit");
});

test("URLs: only public http(s) host names are fetched", () => {
  assert.equal(safeUrl(PAGE_URL).href, PAGE_URL);
  assert.equal(safeUrl("https://www.ah.nl/allerhande/recept/R-R1#reviews").href, "https://www.ah.nl/allerhande/recept/R-R1");
  for (const bad of ["", "nonsense", "file:///etc/passwd", "ftp://x.nl/a", "javascript:alert(1)", "http://localhost/", "http://127.0.0.1/",
    "http://10.0.0.1/", "http://[::1]/", "http://router/", "http://nas.local/", "http://recipes.localhost:8787/", "https://x.nl:8443/",
    "https://user:pw@x.nl/", `https://x.nl/${"a".repeat(600)}`, "http://192.168.178.1/admin"]) {
    assert.equal(safeUrl(bad), null, bad);
  }
});

// ----------------------------------------------------------- the routes

test("route: both are closed to a device that is not paired, and to other sites", async () => {
  const { env, thomas } = await household({ ANTHROPIC_API_KEY: "test-key-not-real" });
  const net = mockFetch(() => claudeReply(ANSWER));
  try {
    const photos = JSON.stringify({ photos: [{ type: "image/jpeg", data: B64 }] });
    assert.equal((await call(env, "POST", "/api/recipes/import/photos", { raw: photos })).status, 401);
    assert.equal((await call(env, "POST", "/api/recipes/import/url", { body: { url: PAGE_URL } })).status, 401);
    assert.equal((await call(env, "POST", "/api/recipes/import/photos", { cookie: thomas, raw: photos, origin: "https://evil.example" })).status, 403);
    assert.equal((await call(env, "POST", "/api/recipes/import/url", { cookie: thomas, body: { url: PAGE_URL }, origin: "https://evil.example" })).status, 403);
    assert.equal((await call(env, "GET", "/api/recipes/import/url", { cookie: thomas })).status, 405);
    assert.equal(net.calls.length, 0, "nothing fetched, no paid call");
  } finally {
    net.restore();
  }
});

test("route: a page with JSON-LD becomes a draft without Claude; its image goes into the photo store", async () => {
  const { env, thomas } = await household({ ANTHROPIC_API_KEY: "test-key-not-real" });
  const before = await (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();
  const net = mockFetch((url) => {
    if (url === PAGE_URL) return html(FIXTURE);
    if (url === "https://www.testkeuken.nl/images/hutspot-1200x800.jpg") return image();
    return new Response("no", { status: 404 });
  });
  let res;
  try {
    res = await call(env, "POST", "/api/recipes/import/url", { cookie: thomas, body: { url: PAGE_URL } });
  } finally {
    net.restore();
  }
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(net.claude().length, 0, "JSON-LD needs no Claude");
  assert.equal(d.via, "json_ld");
  assert.equal(d.source_url, PAGE_URL);
  assert.equal(d.title, "Hutspot met draadjesvlees & jus");
  assert.ok(d.ingredients.includes("1 kg winterpeen"));
  assert.match(d.photo, /^p\/[A-Za-z0-9_-]+\.jpg$/);
  const stored = env.PHOTOS.map.get(d.photo);
  assert.equal(stored.metadata.household.length > 0, true);
  assert.deepEqual([...stored.value], [...JPEG]);
  assert.ok(net.calls.every((c) => c.init.redirect === "manual" && c.init.signal), "every fetch has a timeout and checks redirects");
  const after = await (await call(env, "GET", "/api/sync?since=0", { cookie: thomas })).json();
  assert.equal(after.rev, before.rev, "nothing is saved: the draft goes to the editor");
  assert.equal(after.recipes.length, 0);
});

test("route: a page without JSON-LD goes to Claude as text; og:image is the photo", async () => {
  const { env, thomas } = await household({ ANTHROPIC_API_KEY: "test-key-not-real" });
  const page = `<html><head><title>Oma's soep</title><meta content="/img/soep.png" property="og:image"></head>
    <body><script>track()</script><h1>Oma's soep</h1><p>Deze soep maakte oma elke zondag, met verse bouillon.</p><ul><li>1 ui</li><li>1 l bouillon</li><li>snufje nootmuskaat</li></ul><p>Kook 20 minuten.</p></body></html>`;
  const net = mockFetch((url) => {
    if (url.startsWith("https://api.anthropic.com/")) {
      return claudeReply({ ...ANSWER, title: "Oma's soep", ingredients: ["1 ui", "1 l bouillon", "snufje nootmuskaat"], steps: ["Kook 20 minuten."] });
    }
    if (url === "https://soep.testkeuken.nl/r/1") return html(page);
    if (url === "https://soep.testkeuken.nl/img/soep.png") return new Response(JPEG, { headers: { "Content-Type": "image/png" } });
    return new Response("no", { status: 404 });
  });
  let res;
  try {
    res = await call(env, "POST", "/api/recipes/import/url", { cookie: thomas, body: { url: "https://soep.testkeuken.nl/r/1" } });
  } finally {
    net.restore();
  }
  assert.equal(res.status, 200);
  const d = await res.json();
  const [claude] = net.claude();
  assert.equal(claude.body.model, "claude-sonnet-5-5");
  assert.equal(claude.body.output_config.effort, "low");
  assert.deepEqual(claude.body.output_config.format.schema, PAGE_SCHEMA);
  const prompt = claude.body.messages[0].content[0].text;
  assert.ok(prompt.includes("1 l bouillon") && !prompt.includes("track()"), "the page's text, no scripts");
  assert.ok(prompt.includes("Do not translate") && prompt.includes("exactly as written"));
  assert.deepEqual([d.via, d.title, d.dish, d.labels.labels_by], ["claude", "Oma's soep", null, "claude"]);
  assert.ok(d.ingredients.includes("snufje nootmuskaat"), "kept as written");
  assert.match(d.photo, /\.png$/);
  assert.ok(!JSON.stringify(d).includes("test-key"));
});

test("route: photos are read in one call; the dish photo and its box come back", async () => {
  const { env, thomas } = await household({ ANTHROPIC_API_KEY: "test-key-not-real" });
  const net = mockFetch(() => claudeReply(ANSWER));
  let res;
  try {
    res = await call(env, "POST", "/api/recipes/import/photos", {
      cookie: thomas, raw: JSON.stringify({ photos: [{ type: "image/jpeg", data: B64 }, { type: "image/jpeg", data: B64 }] }),
    });
  } finally {
    net.restore();
  }
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(net.calls.length, 1, "one paid call per import");
  const body = net.calls[0].body;
  assert.deepEqual(body.output_config.format.schema, PHOTO_SCHEMA);
  assert.deepEqual(body.messages[0].content.map((c) => c.type), ["text", "image", "text", "image", "text"]);
  assert.equal(body.messages[0].content[3].source.data, B64);
  assert.deepEqual(d.dish, { photo: 1, box: ANSWER.dish_box });
  assert.deepEqual(d.labels.meals, ["dinner"]);
  assert.equal(net.calls[0].init.headers["x-api-key"], "test-key-not-real");
  assert.ok(!JSON.stringify(d).includes("test-key"));
});

test("route: bad JSON, a refusal or an API error from Claude is one short error", async () => {
  const { env, thomas } = await household({ ANTHROPIC_API_KEY: "test-key-not-real" });
  const raw = JSON.stringify({ photos: [{ type: "image/jpeg", data: B64 }] });
  const cases = [
    [() => claudeReply(null, { text: "{not json" }), 422, "import_unreadable"],
    [() => claudeReply({}, { stop: "refusal" }), 422, "import_unreadable"],
    [() => claudeReply({}, { stop: "max_tokens" }), 422, "import_unreadable"],
    [() => claudeReply({ ...ANSWER, is_recipe: false }), 422, "not_a_recipe"],
    [() => claudeReply({ ...ANSWER, title: "" }), 422, "not_a_recipe"],
    [() => new Response("{}", { status: 529 }), 502, "import_failed"],
    [() => new Response("{}", { status: 429 }), 429, "too_many_imports"],
    [() => { throw new TypeError("network"); }, 502, "import_failed"],
  ];
  for (const [reply, status, error] of cases) {
    const net = mockFetch(reply);
    try {
      const res = await call(env, "POST", "/api/recipes/import/photos", { cookie: thomas, raw });
      const body = await res.json();
      assert.deepEqual([res.status, body.error], [status, error], `${status} ${error}`);
      assert.ok(!JSON.stringify(body).includes("test-key"));
    } finally {
      net.restore();
    }
  }
});

test("route limits: photos (count, size, type, body) are refused before any paid call", async () => {
  const off = await household();
  const one = JSON.stringify({ photos: [{ type: "image/jpeg", data: B64 }] });
  assert.equal((await call(off.env, "POST", "/api/recipes/import/photos", { cookie: off.thomas, raw: one })).status, 503, "no key");

  const { env, thomas } = await household({ ANTHROPIC_API_KEY: "test-key-not-real" });
  const post = (raw, type) => call(env, "POST", "/api/recipes/import/photos", { cookie: thomas, raw, type });
  const net = mockFetch(() => claudeReply(ANSWER));
  const saved = { ...LIMITS };
  try {
    const many = JSON.stringify({ photos: Array.from({ length: MAX_PHOTOS + 1 }, () => ({ type: "image/jpeg", data: B64 })) });
    assert.deepEqual([(await post(many)).status], [400]);
    assert.equal((await post(JSON.stringify({ photos: [] }))).status, 400);
    assert.equal((await post(JSON.stringify({ photos: [{ type: "image/gif", data: B64 }] }))).status, 415);
    assert.equal((await post(JSON.stringify({ photos: [{ type: "image/jpeg", data: "<not base64>" }] }))).status, 415);
    assert.equal((await post(one, "text/plain")).status, 415, "JSON only");
    assert.equal((await post("{broken")).status, 400);
    LIMITS.photoBytes = 4;
    assert.equal((await post(one)).status, 413, "a photo over the limit");
    LIMITS.photoBytes = saved.photoBytes;
    LIMITS.bodyBytes = 20;
    assert.equal((await post(one)).status, 413, "a body over the limit");
    assert.equal(net.calls.length, 0, "no paid call for a refused request");
  } finally {
    Object.assign(LIMITS, saved);
    net.restore();
  }
});

test("route limits: a page too large, too slow, redirected inward or not a page", async () => {
  const { env, thomas } = await household({ ANTHROPIC_API_KEY: "test-key-not-real" });
  const read = async (url, handler) => {
    const net = mockFetch(handler);
    try {
      const res = await call(env, "POST", "/api/recipes/import/url", { cookie: thomas, body: { url } });
      return { status: res.status, error: (await res.json()).error, calls: net.calls };
    } finally {
      net.restore();
    }
  };
  const saved = { ...LIMITS };
  try {
    let r = await read("http://127.0.0.1/admin", () => html(FIXTURE));
    assert.deepEqual([r.status, r.error, r.calls.length], [400, "bad_url", 0]);

    r = await read(PAGE_URL, () => html("x", { "Content-Length": String(LIMITS.pageBytes + 1) }));
    assert.deepEqual([r.status, r.error], [422, "page_too_large"], "said by its length");
    r = await read(PAGE_URL, () => html("x".repeat(LIMITS.pageBytes + 10)));
    assert.deepEqual([r.status, r.error], [422, "page_too_large"], "counted while reading");

    LIMITS.timeoutMs = 30;
    r = await read(PAGE_URL, (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    assert.deepEqual([r.status, r.error], [422, "page_timeout"]);
    LIMITS.timeoutMs = saved.timeoutMs;

    r = await read(PAGE_URL, () => new Response(null, { status: 302, headers: { Location: "http://localhost:8787/api/me" } }));
    assert.deepEqual([r.status, r.error, r.calls.length], [400, "bad_url", 1], "a redirect to an inside address is not followed");
    r = await read(PAGE_URL, () => new Response(null, { status: 301, headers: { Location: PAGE_URL } }));
    assert.deepEqual([r.status, r.error, r.calls.length], [422, "page_unreachable", LIMITS.redirects + 1], "redirects are counted");
    r = await read(PAGE_URL, () => new Response("%PDF", { headers: { "Content-Type": "application/pdf" } }));
    assert.deepEqual([r.status, r.error], [422, "not_a_recipe"]);
    r = await read(PAGE_URL, () => new Response("gone", { status: 404, headers: { "Content-Type": "text/html" } }));
    assert.deepEqual([r.status, r.error], [422, "page_unreachable"]);
    r = await read(PAGE_URL, () => html("<p>kort</p>"));
    assert.deepEqual([r.status, r.error, r.calls.length], [422, "not_a_recipe", 1], "too little text: no paid call");

    // A JSON-LD page whose image is too large still imports, without a photo.
    LIMITS.imageBytes = 2;
    r = await (async () => {
      const net = mockFetch((url) => (url === PAGE_URL ? html(FIXTURE) : image()));
      try {
        return await (await call(env, "POST", "/api/recipes/import/url", { cookie: thomas, body: { url: PAGE_URL } })).json();
      } finally {
        net.restore();
      }
    })();
    assert.deepEqual([r.title, r.photo], ["Hutspot met draadjesvlees & jus", null]);
  } finally {
    Object.assign(LIMITS, saved);
  }
});

test("route limits: imports per household per day", async () => {
  const { env, thomas } = await household({ ANTHROPIC_API_KEY: "test-key-not-real" });
  const net = mockFetch(() => claudeReply(ANSWER));
  try {
    const raw = JSON.stringify({ photos: [{ type: "image/jpeg", data: B64 }] });
    const statuses = [];
    for (let i = 0; i < IMPORT_DAILY_LIMIT + 1; i++) {
      statuses.push((await call(env, "POST", "/api/recipes/import/photos", { cookie: thomas, raw })).status);
    }
    assert.deepEqual([statuses.slice(0, -1).every((s) => s === 200), statuses.at(-1)], [true, 429]);
    assert.equal(net.claude().length, IMPORT_DAILY_LIMIT);
    const url = await call(env, "POST", "/api/recipes/import/url", { cookie: thomas, body: { url: PAGE_URL } });
    assert.equal(url.status, 429, "pages count in the same bucket");
  } finally {
    net.restore();
  }
});

test("the editor's files parse (no test imports them; a syntax error left the phone with a blank page once)", async () => {
  const { spawnSync } = await import("node:child_process");
  for (const f of ["public/app/recipe-edit.js", "public/app/recipe-import.js", "public/shared/recipe-import.js"]) {
    const { fileURLToPath } = await import("node:url");
    const run = spawnSync(process.execPath, ["--check", fileURLToPath(new URL(`../${f}`, import.meta.url))]);
    assert.equal(run.status, 0, `${f}: ${run.stderr}`);
  }
});
