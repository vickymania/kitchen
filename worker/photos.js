// Recipe photos in the PHOTOS KV namespace. The browser shrinks a photo before
// it uploads (public/app/photo.js), so a stored photo is a few hundred kB.
import { randomId } from "./auth.js";

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = { "image/jpeg": "jpg", "image/webp": "webp", "image/png": "png" };

export async function uploadPhoto(request, env, who) {
  const type = (request.headers.get("Content-Type") ?? "").split(";")[0].trim();
  const ext = TYPES[type];
  if (!ext) return { error: "bad_type", status: 415 };
  const length = Number(request.headers.get("Content-Length") ?? 0);
  if (length > MAX_BYTES) return { error: "too_large", status: 413 };
  const body = await request.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > MAX_BYTES) return { error: "too_large", status: 413 };
  return { key: await savePhoto(env, who, body, type) };
}

/**
 * Store image bytes the caller already checked (type in TYPES, at most
 * MAX_BYTES) and return the key. Also used for a recipe page's own image
 * (worker/recipe-import.js), fetched on the server.
 */
export async function savePhoto(env, who, body, type) {
  const key = `p/${randomId()}.${TYPES[type]}`;
  await env.PHOTOS.put(key, body, { metadata: { household: who.householdId, type } });
  return key;
}

export const PHOTO_TYPES = Object.keys(TYPES);
export const PHOTO_MAX_BYTES = MAX_BYTES;

/** GET /photos/p/<id>.<ext>, only for devices of the household that owns it. */
export async function servePhoto(request, env, who) {
  const key = decodeURIComponent(new URL(request.url).pathname.slice("/photos/".length));
  if (!/^p\/[A-Za-z0-9_-]{8,64}\.(jpg|webp|png)$/.test(key)) return new Response("Not found", { status: 404 });
  const hit = await env.PHOTOS.getWithMetadata(key, { type: "stream" });
  if (!hit.value || hit.metadata?.household !== who.householdId) return new Response("Not found", { status: 404 });
  return new Response(hit.value, {
    headers: {
      "Content-Type": hit.metadata.type ?? "image/jpeg",
      // A key never gets new content, so the phone may keep it for good.
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
