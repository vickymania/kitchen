// The /api routes. Every route except /api/pair needs a paired device; the
// check happens here, once, before any handler runs.
import {
  authenticate, sameOrigin, pair, createCode, createHandoff, createInvite, listInvites, revokeInvite, sessionCookie, clearCookie, importerMayApply, IMPORTER_ONLY_OPS,
  reviewerMayApply, REVIEWER_ONLY_OPS, guestMayApply, GUEST_OWN_OPS,
} from "./auth.js";
import { applyOps, pull } from "./ops-store.js";
import { uploadPhoto } from "./photos.js";
import { readReceipt } from "./receipts.js";
import { labelRecipe } from "./labels.js";
import { importFromPhotos, importFromUrl } from "./recipe-import.js";
import { lookupShelf, shelfFill } from "./shelf.js";
import { lookupKinds } from "./kinds.js";
import { translateRecipes } from "./translate.js";
import { syncOffers } from "./offers.js";
import { parseListInput } from "../public/shared/ingredients.js";
import { isExcluded, isExcludedLookalike } from "../public/shared/excluded.js";
import { mergeProblem, NIGHTLY_MERGE_MAX } from "../public/shared/dedupe.js";
import { takeSome } from "./claude.js";
import { widgetList, widgetNames } from "./widget.js";

// [method, path, handler, options]. tools/map_check.py reads this table and
// demands every route in the route table of the project's connection map. A device with
// a role (worker/auth.js ROLES) may call only a route that names its role:
// `only: "fetcher"` is for the fetcher and nobody else, `roles: ["importer"]`
// lets the importer in next to people's own devices (the reviewer reads
// /api/sync and sends its few ops). A recipes-only person
// (members.recipes_only) may call only a route marked `guest: true`, and
// only on the recipes host; the handler then holds him to the recipe side.
const ROUTES = [
  ["POST", "/api/pair", pairDevice, { open: true }],
  ["GET", "/api/me", me, { guest: true }],
  ["POST", "/api/codes", codes, { guest: true }],
  ["POST", "/api/invites", invites],
  ["GET", "/api/invites", inviteList],
  ["POST", "/api/invites/revoke", inviteRevoke],
  ["POST", "/api/handoff", handoff],
  ["GET", "/api/devices", devices, { guest: true }],
  ["POST", "/api/devices/revoke", revokeDevice, { guest: true }],
  ["POST", "/api/members/remove", removeMember],
  ["POST", "/api/logout", logout, { guest: true }],
  ["GET", "/api/sync", sync, { roles: ["reviewer"], guest: true }],
  ["POST", "/api/ops", ops, { roles: ["importer", "reviewer"], guest: true }],
  ["POST", "/api/quick-add", quickAdd],
  ["GET", "/api/widget", widget],
  ["GET", "/api/widget/names", widgetNamesRoute],
  ["POST", "/api/photos", photos, { raw: true, guest: true }],
  ["POST", "/api/receipts/read", receiptRead, { raw: true }],
  ["POST", "/api/recipes/label", recipeLabel, { guest: true }],
  // Raw: the size of the photos is checked before their JSON is parsed.
  ["POST", "/api/recipes/import/photos", recipeImportPhotos, { raw: true, guest: true }],
  ["POST", "/api/recipes/import/url", recipeImportUrl, { guest: true }],
  ["POST", "/api/items/shelf-fill", itemsShelfFill],
  ["POST", "/api/offers/sync", offersSync, { only: "fetcher" }],
];

const MAX_OPS = 100;

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

const isSecure = (request) => new URL(request.url).protocol === "https:";

/** The app a host serves (the same rule as appFor in worker/index.js). */
export const appOf = (url) => (new URL(url).hostname.startsWith("groceries.") ? "groceries" : "recipes");

/** recipes.vexed.works <-> groceries.vexed.works (and *.localhost in development). */
export function otherAppOrigin(url) {
  const u = new URL(url);
  const [first, ...rest] = u.hostname.split(".");
  const other = first === "groceries" ? "recipes" : "groceries";
  return `${u.protocol}//${[other, ...rest].join(".")}${u.port ? `:${u.port}` : ""}`;
}

export async function handleApi(request, env, ctx = null) {
  const url = new URL(request.url);
  const route = ROUTES.find(([m, p]) => p === url.pathname && m === request.method);
  if (!route) {
    const known = ROUTES.some(([, p]) => p === url.pathname);
    return json({ error: known ? "method_not_allowed" : "not_found" }, known ? 405 : 404);
  }
  const [method, , handler, opts = {}] = route;

  if (method === "POST") {
    const type = request.headers.get("Content-Type") ?? "";
    if (!opts.raw && !type.startsWith("application/json")) return json({ error: "json_required" }, 415);
  }

  let who = null;
  if (!opts.open) {
    who = await authenticate(request, env);
    if (!who) return json({ error: "unpaired" }, 401);
    // "" is a person's own phone or tool.
    const allowed = opts.only ? [opts.only] : ["", ...(opts.roles ?? [])];
    if (!allowed.includes(who.role ?? "")) return json({ error: "forbidden" }, 403);
    // Recipes only: never on the groceries host, never a route not marked guest.
    if (who.recipesOnly && (appOf(url) !== "recipes" || !opts.guest)) return json({ error: "recipes_only" }, 403);
  }
  // Cookies travel with requests from other sites; tools with a Bearer token do not.
  if (method === "POST" && (opts.open || who.viaCookie) && !sameOrigin(request)) {
    return json({ error: "bad_origin" }, 403);
  }

  let body = null;
  if (method === "POST" && !opts.raw) {
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad_json" }, 400);
    }
  }

  const response = await handler({ request, env, url, who, body, ctx });
  if (who?.refresh) response.headers.append("Set-Cookie", sessionCookie(who.refresh, { secure: isSecure(request) }));
  return response;
}

// ------------------------------------------------------------------ handlers

async function pairDevice({ request, env, url, body }) {
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  const out = await pair(env, {
    code: body?.code, handoff: body?.handoff, invite: body?.invite, label: body?.label, ip,
    app: appOf(url), ua: request.headers.get("User-Agent") ?? "", device: body?.device,
  });
  if (out.error) return json({ error: out.error }, out.status);
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(out.token, { secure: isSecure(request) }) });
}

async function me({ env, url, who }) {
  const household = await env.DB.prepare("SELECT id, name FROM households WHERE id = ?").bind(who.householdId).first();
  return json({
    member: { id: who.memberId, name: who.name, locale: who.locale, is_admin: who.isAdmin, recipes_only: who.recipesOnly },
    household,
    device_id: who.deviceId,
    other_app: who.recipesOnly ? null : otherAppOrigin(url),
  });
}

async function codes({ env, who, body }) {
  // A recipes-only person may link another device of his own, nothing more:
  // that device is recipes-only too (the flag is the member's).
  if (who.recipesOnly && body?.for !== undefined) return json({ error: "recipes_only" }, 403);
  const out = await createCode(env, who, body?.for === "new_member"
    ? { newMemberName: body.name ?? "", makeAdmin: Boolean(body.admin) }
    : ["fetcher", "importer", "reviewer"].includes(body?.for) ? { deviceRole: body.for } : {});
  if (out.error) return json({ error: out.error }, out.status);
  return json(out);
}

// A one-time link: {name} makes a recipes-only person (recipes host only);
// {kind: "member", name} a new full member; {kind: "device"} another device of
// the asker. See createInvite.
async function invites({ env, url, who, body }) {
  const kind = body?.kind ?? "guest";
  if (kind === "guest" && appOf(url) !== "recipes") return json({ error: "forbidden" }, 403);
  const out = await createInvite(env, who, { name: body?.name, kind, admin: Boolean(body?.admin) });
  if (out.error) return json({ error: out.error }, out.status);
  return json({ url: `${url.origin}/#/join/${out.token}`, expires_at: out.expires_at });
}

async function inviteList({ env, who }) {
  const out = await listInvites(env, who);
  if (out.error) return json({ error: out.error }, out.status);
  return json(out);
}

async function inviteRevoke({ env, who, body }) {
  const out = await revokeInvite(env, who, body?.id);
  if (out.error) return json({ error: out.error }, out.status);
  return json(out);
}

async function handoff({ env, url, who }) {
  const { token } = await createHandoff(env, who);
  return json({ url: `${otherAppOrigin(url)}/#pair=${token}` });
}

async function devices({ env, who }) {
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.label, d.created_at, d.last_seen_at, d.member_id, m.name AS member_name
       FROM devices d JOIN members m ON m.id = d.member_id
      WHERE m.household_id = ? AND d.revoked_at IS NULL AND m.removed_at IS NULL
        AND (? = 1 OR d.member_id = ?)
      ORDER BY m.name, d.created_at`,
  ).bind(who.householdId, who.isAdmin ? 1 : 0, who.memberId).all();
  return json({ devices: results.map((d) => ({ ...d, current: d.id === who.deviceId })) });
}

async function revokeDevice({ env, who, body }) {
  const id = String(body?.id ?? "");
  const res = await env.DB.prepare(
    `UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
       AND member_id IN (SELECT id FROM members WHERE household_id = ? AND (? = 1 OR id = ?))`,
  ).bind(new Date().toISOString(), id, who.householdId, who.isAdmin ? 1 : 0, who.memberId).run();
  if (!res.meta?.changes) return json({ error: "not_found" }, 404);
  return json({ ok: true });
}

async function removeMember({ env, who, body }) {
  if (!who.isAdmin) return json({ error: "forbidden" }, 403);
  const id = String(body?.id ?? "");
  if (id === who.memberId) return json({ error: "cannot_remove_self" }, 400);
  const now = new Date().toISOString();
  const [, res] = await env.DB.batch([
    env.DB.prepare("UPDATE households SET rev = rev + 1 WHERE id = ?").bind(who.householdId),
    env.DB.prepare(
      `UPDATE members SET removed_at = ?, rev = (SELECT rev FROM households WHERE id = ?)
        WHERE id = ? AND household_id = ? AND removed_at IS NULL`,
    ).bind(now, who.householdId, id, who.householdId),
    env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL").bind(now, id),
  ]);
  if (!res.meta?.changes) return json({ error: "not_found" }, 404);
  return json({ ok: true });
}

async function logout({ request, env, who }) {
  await env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").bind(new Date().toISOString(), who.deviceId).run();
  return json({ ok: true }, 200, { "Set-Cookie": clearCookie({ secure: isSecure(request) }) });
}

async function sync({ env, url, who }) {
  const since = Number(url.searchParams.get("since") ?? 0);
  return json(await pull(env.DB, who.householdId, Number.isFinite(since) && since > 0 ? Math.floor(since) : 0,
    { guest: who.recipesOnly, memberId: who.memberId }));
}

/**
 * A recipes-only person changes or deletes only a recipe he made: every
 * recipe.put / recipe.delete in the batch names a new id or one whose
 * `created_by` is his (tombstones included, so a deleted recipe of Thomas's
 * cannot be put back as his).
 */
async function guestOwnsAll(env, who, list) {
  const ids = [...new Set(list.filter((o) => GUEST_OWN_OPS.has(o?.type)).map((o) => String(o.id ?? "")))];
  if (!ids.length) return true;
  const { results } = await env.DB.prepare(
    `SELECT id, created_by FROM recipes WHERE household_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
  ).bind(who.householdId, ...ids).all();
  return results.every((r) => r.created_by === who.memberId);
}

/**
 * The nightly check never touches an excluded thing (public/shared/excluded.js):
 * no name of it as another name of an item, no product of it moved (its name
 * or brand + name).
 */
async function reviewerTouchesExcluded(env, who, list) {
  if (list.some((o) => (o.type === "item.alias" && isExcluded(String(o.name ?? ""))) || (o.type === "item.translate" && isExcluded(String(o.name_en ?? ""))))) return true;
  const ids = [...new Set(list.filter((o) => o.type === "product.move").map((o) => String(o.product_id ?? "")))];
  if (!ids.length) return false;
  const { results } = await env.DB.prepare(
    `SELECT name, brand FROM products WHERE household_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
  ).bind(who.householdId, ...ids).all();
  return results.some((p) => isExcluded(p.name ?? "") || isExcluded(`${p.brand ?? ""} ${p.name ?? ""}`));
}

/**
 * The nightly check's merges and renames, checked against D1 before anything
 * is applied: a merge only of two live items the CLEAR rules call one
 * (mergeProblem, public/shared/dedupe.js: no excluded name, a clear pair, not
 * two established items, no clashing rate or deal rule); a rename never of
 * an excluded item. A from-item already merged away is a replay: the engine
 * answers it. Returns the reason, or null.
 */
async function reviewerMergeRefused(env, who, list) {
  for (const op of list) {
    if (op.type === "item.rename") {
      const item = await env.DB.prepare("SELECT name FROM items WHERE household_id = ? AND id = ?").bind(who.householdId, op.item_id).first();
      if (item && (isExcluded(item.name) || isExcludedLookalike(item.name))) return "excluded";
      continue;
    }
    if (op.type !== "item.merge") continue;
    const facts = {};
    for (const id of [op.from_item_id, op.into_item_id]) {
      const item = await env.DB.prepare("SELECT id, name, use_per_day, rate_source, private_to, deleted_at FROM items WHERE household_id = ? AND id = ?")
        .bind(who.householdId, id).first();
      if (!item) return "not_found";
      const count = async (table) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE household_id = ? AND item_id = ? AND deleted_at IS NULL`)
        .bind(who.householdId, id).first())?.n ?? 0;
      facts[id] = {
        item, bought: await count("purchases"), rules: await count("deal_rules"),
        rate: item.use_per_day !== null && (item.rate_source === "person" || item.rate_source === "learned"),
      };
    }
    const from = facts[op.from_item_id], into = facts[op.into_item_id];
    if (into.item.deleted_at) return "into_gone";
    if (from.item.deleted_at) continue;
    const why = mergeProblem(from, into);
    if (why) return why;
  }
  return null;
}

async function ops({ env, who, body, ctx }) {
  const list = body?.ops;
  if (!Array.isArray(list) || list.length > MAX_OPS) return json({ error: "bad_ops" }, 400);
  // The whole request is refused before anything is applied.
  if (who.role === "importer" && !list.every(importerMayApply)) return json({ error: "forbidden" }, 403);
  if (who.role === "reviewer" && (!list.every(reviewerMayApply) || await reviewerTouchesExcluded(env, who, list)
    || await reviewerMergeRefused(env, who, list))) {
    return json({ error: "forbidden" }, 403);
  }
  // At most NIGHTLY_MERGE_MAX merges a day from the nightly check (usage_limits, bucket auto_merge:<household>:<day>).
  const merges = who.role === "reviewer" ? list.filter((o) => o.type === "item.merge").length : 0;
  if (merges && (await takeSome(env, "auto_merge", who.householdId, merges, NIGHTLY_MERGE_MAX)) < merges) {
    return json({ error: "too_many_merges" }, 429);
  }
  if (who.recipesOnly && (!list.every(guestMayApply) || !(await guestOwnsAll(env, who, list)))) {
    return json({ error: "recipes_only" }, 403);
  }
  if (who.role !== "importer" && list.some((o) => IMPORTER_ONLY_OPS.has(o?.type))) return json({ error: "forbidden" }, 403);
  if (who.role !== "reviewer" && list.some((o) => REVIEWER_ONLY_OPS.has(o?.type))) return json({ error: "forbidden" }, 403);
  const unknownShelf = new Set();
  const unknownShelfProducts = new Set();
  const unknownKind = new Set();
  const untranslatedItems = new Set();
  const untranslatedRecipes = new Set();
  const results = await applyOps(env.DB, who, list, { unknownShelf, unknownShelfProducts, unknownKind, untranslatedItems, untranslatedRecipes });
  // After this answer went out, Claude Haiku in as few requests as it takes:
  // the shelf life of what was bought or put in the pantry without one
  // (worker/shelf.js), the kind of a product neither AH's category nor the
  // name rules know (worker/kinds.js), and a new item's English name in
  // whichever of those two requests already goes (0029: the shelf request
  // names the items it asks about; the kinds request the rest, alone only
  // when neither other request is due). Nobody waits for it.
  const shelfDue = unknownShelf.size || unknownShelfProducts.size;
  if ((shelfDue || unknownKind.size || untranslatedItems.size) && env.ANTHROPIC_API_KEY && ctx?.waitUntil) {
    ctx.waitUntil((async () => {
      let named = new Set();
      if (shelfDue) {
        const shelf = await lookupShelf(env, who, [...unknownShelf], { productIds: [...unknownShelfProducts], nameIds: [...untranslatedItems] })
          .catch(() => { console.log("shelf lookup failed"); return null; });
        named = shelf?.named ?? named;
      }
      const left = [...untranslatedItems].filter((x) => !named.has(x));
      if (unknownKind.size || left.length) {
        await lookupKinds(env, who, [...unknownKind], { itemIds: left }).catch(() => console.log("kind lookup failed"));
      }
    })());
  }
  // An edit made a recipe's translation stale: Haiku translates it again (worker/translate.js).
  if (untranslatedRecipes.size && env.ANTHROPIC_API_KEY && ctx?.waitUntil) {
    ctx.waitUntil(translateRecipes(env, who, [...untranslatedRecipes]).catch(() => console.log("recipe translation failed")));
  }

  const head = await env.DB.prepare("SELECT rev FROM households WHERE id = ?").bind(who.householdId).first();
  return json({ results, rev: head?.rev ?? 0 });
}

// One typed line ("2 ui", "500 gr gehakt") from the Android widget, read by
// the same parser as the add box and applied as an ordinary entry.add. The
// client picks op_id once and resends it unchanged, so a retry after a lost
// answer returns the first result instead of adding the line twice.
async function quickAdd({ env, who, body }) {
  const parsed = parseListInput(typeof body?.text === "string" ? body.text.slice(0, 200) : "");
  if (!parsed.title) return json({ error: "title_required" }, 400);
  const opId = String(body?.op_id ?? "");
  // A tapped suggestion (1.6): `item_id` of that item and its `title`; the
  // amount still comes from the typed text.
  const linked = typeof body?.item_id === "string" && typeof body?.title === "string" && body.title.trim();
  const [result] = await applyOps(env.DB, who, [{
    type: "entry.add", op_id: opId, id: opId, item_id: `i${opId}`.slice(0, 64), ...parsed,
    ...(linked ? { item_id: body.item_id, title: body.title.slice(0, 120) } : {}),
  }]);
  if (!result.ok) return json({ error: result.error }, 400);
  const head = await env.DB.prepare("SELECT rev FROM households WHERE id = ?").bind(who.householdId).first();
  return json({ ok: true, title: parsed.title, result: result.result, rev: head?.rev ?? 0 });
}

// A photo of a receipt in, the lines for the review screen out. Stores nothing.
async function receiptRead({ request, env, who }) {
  const out = await readReceipt(request, env, who);
  if (out.error) return json({ error: out.error }, out.status);
  return json(out.review);
}

// Claude labels one recipe for the wizard; the labels arrive as a recipe.put.
async function recipeLabel({ env, who, body }) {
  // A recipes-only person labels only a recipe he made (the labels arrive as a recipe.put).
  if (who.recipesOnly && !(await guestOwnsAll(env, who, [{ type: "recipe.put", id: body?.id }]))) {
    return json({ error: "recipes_only" }, 403);
  }
  const out = await labelRecipe(env, who, body);
  if (out.error) return json({ error: out.error }, out.status);
  return json(out);
}

// Photos of a recipe, read by Claude, as a draft for the editor. Stores nothing.
async function recipeImportPhotos({ request, env, who }) {
  const out = await importFromPhotos(request, env, who);
  if (out.error) return json({ error: out.error }, out.status);
  return json(out.draft);
}

// A recipe page as a draft for the editor; its image goes into the photo store.
async function recipeImportUrl({ env, who, body }) {
  const out = await importFromUrl(env, who, body);
  if (out.error) return json({ error: out.error }, out.status);
  return json(out.draft);
}

// The one-off fill of shelf lives (tools/fill_shelf_life.mjs): 25 items per call.
async function itemsShelfFill({ env, who, body }) {
  const out = await shelfFill(env, who, body);
  if (out.error) return json({ error: out.error }, out.status);
  return json(out.result);
}

// The full set of current deals from the home server; only the difference is written.
async function offersSync({ env, who, body }) {
  const out = await syncOffers(env, who, body);
  if (out.error) return json({ error: out.error }, out.status);
  return json(out.result);
}

// The Android widget's list, grouped by store with the details per line
// (worker/widget.js). ?since=<rev>: nothing changed costs one row read.
async function widget({ env, url, who }) {
  const since = Number(url.searchParams.get("since") ?? 0);
  return json(await widgetList(env.DB, who.householdId, Number.isFinite(since) && since > 0 ? Math.floor(since) : 0, undefined, who.memberId, who.locale));
}

// The widget's suggestion names (worker/widget.js widgetNames): once a day.
async function widgetNamesRoute({ env, who }) {
  return json(await widgetNames(env.DB, who.householdId, undefined, who.memberId, who.locale));
}

async function photos({ request, env, who }) {
  const out = await uploadPhoto(request, env, who);
  if (out.error) return json({ error: out.error }, out.status);
  return json(out);
}
