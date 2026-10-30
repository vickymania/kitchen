// Who is asking: devices, pairing codes and the session cookie.
//
// There are no passwords. A device becomes part of the household by typing a
// six-digit code that someone in the household made in Settings (or that
// tools/admin.mjs made for the very first device), or by a one-time link from
// the other app on the same phone. The device then holds a long random token
// in an HttpOnly cookie; only its SHA-256 is in D1.

export const COOKIE = "kd";
const COOKIE_DAYS = 400;                 // the maximum Chrome keeps a cookie
const CODE_MINUTES = 15;
const HANDOFF_SECONDS = 120;
const INVITE_DAYS = 7;                   // a "Recepten delen" link
const FAILS_PER_ADDRESS = 10;            // wrong codes per address per day
const FAILS_PER_DAY = 100;               // wrong codes for everyone per day

// Device roles besides a person's own (NULL). A 'fetcher' device (the home
// server that sends the deals) may call only the routes marked `only:
// "fetcher"`. An 'importer' device (the home server's AH receipt import,
// "Thuisserver AH") may call only /api/ops, and only with the ops in
// `importerMayApply`. A 'reviewer' device (the home server's nightly Claude
// check, "Thuisserver controle", fetcher/review.mjs) may read /api/sync and
// send only the ops in `reviewerMayApply`.
export const ROLES = ["fetcher", "importer", "reviewer"];

// What the AH receipt import sends (tools/import_ah.mjs buildOps), and no more,
// plus prices.sync: Checkjebon's shelf prices (fetcher/prices.mjs).
// Never item.merge or product.move: which items are one thing is a person's
// call (tests/item-merge.test.mjs "importer").
const IMPORTER_OPS = new Set(["receipt.save", "purchase.add", "product.put", "preference.set", "prices.sync"]);

/** Ops only the importer device may send: a person's phone or tool never writes shelf prices. */
export const IMPORTER_ONLY_OPS = new Set(["prices.sync"]);

/** Ops only the reviewer device may send: the nightly report is the home server's. */
export const REVIEWER_ONLY_OPS = new Set(["review.save", "recipe.links"]);

// What the nightly check may change (30-10-2026): another name for an
// item and one product moved to an item that exists, both undone in the app;
// a merge of two items the CLEAR rules call one (public/shared/dedupe.js:
// worker/api.js checks the pair, never an excluded item, at most
// NIGHTLY_MERGE_MAX a day); a tidier spelling of an item's name (item.rename,
// the same key only); which item each recipe line means (recipe.links); and its report. Never a new item, never removing a
// name, never anything else. Every change lands in the changelog
// (auto_changes, public/shared/ops.js logChange).
const REVIEWER_OPS = new Set(["item.alias", "product.move", "item.merge", "item.rename", "review.save", "recipe.links"]);

/**
 * May the reviewer device apply this op? item.alias only to add a name (no
 * `remove`); product.move only to an existing item by id (no `title`, which
 * could make a new one); item.merge only by ids (no `into_title`), with its
 * day; item.rename only to a name without a question mark; review.save.
 * worker/api.js then checks a merge's pair and the day's cap.
 */
export function reviewerMayApply(op) {
  if (!op || typeof op !== "object" || !REVIEWER_OPS.has(op.type)) return false;
  if (op.type === "item.alias") return op.remove === undefined;
  if (op.type === "product.move") return op.title === undefined && typeof op.item_id === "string";
  if (op.type === "item.merge") {
    return op.into_title === undefined && typeof op.from_item_id === "string" && typeof op.into_item_id === "string" && typeof op.on === "string";
  }
  if (op.type === "item.rename") return typeof op.item_id === "string" && typeof op.name === "string" && !/[?¿]/.test(op.name);
  if (op.type === "recipe.links") return typeof op.recipe_id === "string" && Array.isArray(op.lines);
  return true;
}

/**
 * May an importer device apply this op? Only the import's op types, and of
 * those nothing that touches a person's choices: a purchase may not tick a
 * list line or set a preference, and a preference only where none was set
 * or cleared (`only_if_unset`), and a product never its `store_only`. The pantry rows come with `purchase.add`
 * (`pantry: true`), not with a pantry op.
 */
// A recipes-only person (members.recipes_only, Thomas's father Henk): reads
// the recipe book, cooks from it, gives his own stars, and adds recipes of his
// own, which he may change and delete (30-10-2026). Never a recipe he
// did not make (worker/api.js checks `created_by` before the batch), no list,
// no pantry, no cook record (that drives Thomas's "… gekookt?" and the
// wizard), no member changes.
const GUEST_OPS = new Set(["recipe.rate", "recipe.put", "recipe.delete"]);
export const GUEST_OWN_OPS = new Set(["recipe.put", "recipe.delete"]);

/** May a recipes-only person apply this op type? Anything else refuses the whole batch (worker/api.js ops). */
export function guestMayApply(op) {
  return Boolean(op && typeof op === "object" && GUEST_OPS.has(op.type));
}

/**
 * What kind of device an invite link was opened on, for its label: "Henk -
 * iPhone". `hint` is what the page detected (an iPad's Safari says
 * "Macintosh" in its user agent; the page sees the touch screen), taken only
 * from this list; otherwise the user agent decides; unknown is "telefoon".
 */
export const DEVICE_KINDS = ["iPhone", "iPad", "Android", "Mac", "Windows"];
export function deviceKind(ua, hint) {
  if (DEVICE_KINDS.includes(hint)) return hint;
  const s = String(ua ?? "");
  if (/iPhone|iPod/.test(s)) return "iPhone";
  if (/iPad/.test(s)) return "iPad";
  if (/Android/.test(s)) return "Android";
  if (/Windows/.test(s)) return "Windows";
  if (/Macintosh|Mac OS X/.test(s)) return "Mac";
  return "telefoon";
}

export function importerMayApply(op) {
  if (!op || typeof op !== "object" || !IMPORTER_OPS.has(op.type)) return false;
  if (op.type === "purchase.add") {
    return op.source === "receipt" && op.entry_id === undefined && !op.prefer && op.prefer_recipe_id === undefined;
  }
  if (op.type === "preference.set") return op.only_if_unset === true;
  // "Alleen bij deze winkel" is a person's choice: the import never sets it.
  if (op.type === "product.put") return !(op.product && typeof op.product === "object" && "store_only" in op.product);
  return true;
}

const enc = new TextEncoder();

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomId() {
  return randomToken(12);
}

export function randomCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, "0");
}

// Codes and handoff tokens are stored hashed too: a leaked database holds no
// usable code. The prefix keeps a code and a token from ever colliding.
export const hashCode = (code) => sha256(`code:${code}`);
export const hashHandoff = (token) => sha256(`handoff:${token}`);
export const hashDevice = (token) => sha256(`device:${token}`);
export const hashInvite = (token) => sha256(`invite:${token}`);

function cookieValue(request, name) {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export function sessionCookie(token, { secure = true } = {}) {
  return `${COOKIE}=${token}; Path=/; Max-Age=${COOKIE_DAYS * 86400}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function clearCookie({ secure = true } = {}) {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/**
 * The device and member behind this request, or null.
 * Returns { deviceId, memberId, householdId, isAdmin, name, locale, role, viaCookie, refresh }.
 */
export async function authenticate(request, env) {
  const bearer = request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/)?.[1];
  const token = bearer ?? cookieValue(request, COOKIE);
  if (!token || token.length < 20 || token.length > 100) return null;
  const row = await env.DB.prepare(
    `SELECT d.id AS device_id, d.last_seen_at, d.role, m.*, m.id AS member_id
       FROM devices d JOIN members m ON m.id = d.member_id
      WHERE d.token_hash = ? AND d.revoked_at IS NULL AND m.removed_at IS NULL`,
  ).bind(await hashDevice(token)).first();
  if (!row) return null;

  const now = Date.now();
  const last = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
  // Write last_seen at most once an hour; a poll every few seconds would
  // otherwise turn every read into a write.
  if (now - last > 3600_000) {
    await env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(new Date(now).toISOString(), row.device_id).run();
  }
  return {
    deviceId: row.device_id,
    memberId: row.member_id,
    householdId: row.household_id,
    isAdmin: Boolean(row.is_admin),
    name: row.name,
    locale: row.locale,
    role: row.role ?? null,
    // Recipes only, on every route (worker/api.js): the flag is the person's,
    // so a device he links later is held to it too.
    recipesOnly: Boolean(row.recipes_only),
    viaCookie: !bearer,
    // Slide the cookie forward once a day while the device is in use.
    refresh: !bearer && now - last > 86400_000 ? token : null,
  };
}

/**
 * A cookie can be sent by any site the phone visits. A cross-site POST cannot
 * carry Content-Type: application/json without a preflight, and its Origin is
 * never ours; both are checked before anything changes.
 */
export function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  return origin === new URL(request.url).origin;
}

function day() {
  return new Date().toISOString().slice(0, 10);
}

async function tooManyFailures(env, ip) {
  const { results } = await env.DB.prepare("SELECT bucket, count FROM pairing_failures WHERE bucket IN (?, ?)")
    .bind(`ip:${ip}:${day()}`, `all:${day()}`).all();
  const count = (b) => results.find((r) => r.bucket === b)?.count ?? 0;
  return count(`ip:${ip}:${day()}`) >= FAILS_PER_ADDRESS || count(`all:${day()}`) >= FAILS_PER_DAY;
}

async function recordFailure(env, ip) {
  const up = "INSERT INTO pairing_failures (bucket, count) VALUES (?, 1) ON CONFLICT(bucket) DO UPDATE SET count = count + 1";
  await env.DB.batch([
    env.DB.prepare(up).bind(`ip:${ip}:${day()}`),
    env.DB.prepare(up).bind(`all:${day()}`),
    env.DB.prepare("DELETE FROM pairing_failures WHERE bucket NOT LIKE ?").bind(`%:${day()}`),
  ]);
}

/**
 * Pair this device with a code, a handoff token or an invite token.
 * `app` is the host's app: an invite pairs only on recipes. An invite's
 * device label is made here, "<name> - <device>", from `ua` and `device`.
 * Returns { token, memberId } or { error, status }.
 */
export async function pair(env, { code, handoff, invite, label, ip, app = "recipes", ua = "", device } = {}) {
  if (await tooManyFailures(env, ip)) return { error: "too_many_attempts", status: 429 };

  let hash;
  if (typeof code === "string" && /^\d{6}$/.test(code.trim())) hash = await hashCode(code.trim());
  else if (typeof handoff === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(handoff)) hash = await hashHandoff(handoff);
  else if (typeof invite === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(invite)) {
    // Not even looked up on groceries: the link stays usable on recipes.
    if (app !== "recipes") return { error: "recipes_only", status: 403 };
    hash = await hashInvite(invite);
  } else return { error: "bad_code", status: 400 };

  const now = new Date().toISOString();
  const pc = await env.DB.prepare(
    "SELECT * FROM pairing_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?",
  ).bind(hash, now).first();
  if (!pc) {
    await recordFailure(env, ip);
    return { error: "bad_code", status: 400 };
  }

  // A recipes-only member never gets a device on groceries, whatever the
  // code; checked before the claim, so the code still works on recipes.
  if (app !== "recipes" && (pc.recipes_only || (pc.member_id && await env.DB.prepare(
    "SELECT 1 FROM members WHERE id = ? AND recipes_only = 1").bind(pc.member_id).first()))) {
    return { error: "recipes_only", status: 403 };
  }

  // Claim the code first; a second device with the same code loses here.
  const claim = await env.DB.prepare("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL")
    .bind(now, hash).run();
  if (!claim.meta?.changes) return { error: "bad_code", status: 400 };

  const token = randomToken();
  const deviceId = randomId();
  const stmts = [];
  let memberId = pc.member_id;
  if (pc.kind === "invite") label = `${pc.new_member_name || "?"} - ${deviceKind(ua, device)}`;
  if (!memberId) {
    memberId = randomId();
    stmts.push(env.DB.prepare("UPDATE households SET rev = rev + 1 WHERE id = ?").bind(pc.household_id));
    stmts.push(env.DB.prepare(
      `INSERT INTO members (id, household_id, name, locale, is_admin, created_at, rev)
       VALUES (?, ?, ?, 'nl', ?, ?, (SELECT rev FROM households WHERE id = ?))`,
    ).bind(memberId, pc.household_id, pc.new_member_name || "?", pc.make_admin && !pc.recipes_only ? 1 : 0, now, pc.household_id));
    // Only an invite names the column, so a code still pairs on a database
    // before 0023 (the migration tests stop there).
    if (pc.recipes_only) stmts.push(env.DB.prepare("UPDATE members SET recipes_only = 1 WHERE id = ?").bind(memberId));
  }
  stmts.push(env.DB.prepare("INSERT INTO devices (id, member_id, token_hash, label, role, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(deviceId, memberId, await hashDevice(token), String(label ?? "").slice(0, 80), pc.device_role ?? null, now, now));
  await env.DB.batch(stmts);
  return { token, memberId };
}

/**
 * A six-digit code: for another device of the asking member, or (admins) for
 * a new person, or (admins) for a device with a role (fetcher, importer).
 */
export async function createCode(env, who, { newMemberName, makeAdmin, deviceRole } = {}) {
  if (newMemberName !== undefined && !who.isAdmin) return { error: "forbidden", status: 403 };
  if (deviceRole !== undefined && (!who.isAdmin || !ROLES.includes(deviceRole) || newMemberName !== undefined)) {
    return { error: "forbidden", status: 403 };
  }
  const name = typeof newMemberName === "string" ? newMemberName.trim().slice(0, 60) : null;
  if (newMemberName !== undefined && !name) return { error: "name_required", status: 400 };
  const code = randomCode();
  const now = Date.now();
  const expires = new Date(now + CODE_MINUTES * 60_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO pairing_codes (code_hash, household_id, kind, member_id, new_member_name, make_admin, device_role, created_at, expires_at)
     VALUES (?, ?, 'code', ?, ?, ?, ?, ?, ?)`,
  ).bind(await hashCode(code), who.householdId, name ? null : who.memberId, name, name && makeAdmin ? 1 : 0,
    deviceRole ?? null, new Date(now).toISOString(), expires).run();
  return { code, expires_at: expires };
}

/** A one-time link that signs the same member into the other app. */
export async function createHandoff(env, who) {
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO pairing_codes (code_hash, household_id, kind, member_id, created_at, expires_at)
     VALUES (?, ?, 'handoff', ?, ?, ?)`,
  ).bind(await hashHandoff(token), who.householdId, who.memberId, new Date(now).toISOString(),
    new Date(now + HANDOFF_SECONDS * 1000).toISOString()).run();
  return { token };
}

/**
 * "Recepten delen" (admins): a one-time link that makes a recipes-only
 * person, valid INVITE_DAYS. Only its hash is stored; the token travels in
 * the link's fragment (#/join/<token>), which no server log sees. A live
 * recipes-only person of the same name gets the new device instead of a
 * second person, so a new phone keeps his stars.
 */
export async function createInvite(env, who, { name } = {}) {
  if (!who.isAdmin || who.recipesOnly || who.role) return { error: "forbidden", status: 403 };
  const clean = typeof name === "string" ? name.trim().slice(0, 60) : "";
  if (!clean) return { error: "name_required", status: 400 };
  const existing = await env.DB.prepare(
    `SELECT id, name FROM members WHERE household_id = ? AND recipes_only = 1 AND removed_at IS NULL
        AND lower(name) = lower(?) ORDER BY created_at LIMIT 1`,
  ).bind(who.householdId, clean).first();
  const token = randomToken();
  const now = Date.now();
  const expires = new Date(now + INVITE_DAYS * 86400_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO pairing_codes (code_hash, household_id, kind, member_id, new_member_name, make_admin, recipes_only, created_at, expires_at)
     VALUES (?, ?, 'invite', ?, ?, 0, 1, ?, ?)`,
  ).bind(await hashInvite(token), who.householdId, existing?.id ?? null, existing?.name ?? clean,
    new Date(now).toISOString(), expires).run();
  return { token, expires_at: expires };
}
