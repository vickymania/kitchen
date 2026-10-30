// The device's copy of the household, kept in IndexedDB so the app opens and
// works without signal (a supermarket is often a dead zone).
//
//   server  = the last state the worker confirmed, with its change counter
//   outbox  = ops made on this device that the worker has not confirmed yet
//   view    = server + outbox, applied with the same op engine as the worker
//
// Screens read the view and change it only through dispatch(op). When the
// worker answers, confirmed ops leave the outbox and the server state takes
// their place, so a screen never flickers back to the old state.
import { applyOp, emptyState, KINDS } from "../shared/ops.js";
import { api, isOffline } from "./api.js";
import { newId } from "./dom.js";

const DB_NAME = "kitchen";
// The list changes while someone shops; recipes hardly ever. Every poll is a
// worker request, so the recipe book asks less often.
const POLL_MS = document.body.dataset.app === "groceries" ? 4000 : 15000;
const MAX_BACKOFF_MS = 60_000;

let db = null;
let server = { rev: 0, state: emptyState() };
let outbox = [];
let me = null;
let view = emptyState();
const status = { online: navigator.onLine, syncing: false, lastSync: null, pending: 0 };
const listeners = new Set();
const errorListeners = new Set();

// ------------------------------------------------------------ IndexedDB

function idb() {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve((db = req.result));
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const r = d.transaction("kv").objectStore("kv").get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbSet(key, value) {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbClear() {
  const d = await idb();
  return new Promise((resolve) => {
    const tx = d.transaction("kv", "readwrite");
    tx.objectStore("kv").clear();
    tx.oncomplete = () => resolve();
  });
}

// ------------------------------------------------------------- the view

function ctxFor(op) {
  return { memberId: me?.member.id, isAdmin: Boolean(me?.member.is_admin), now: op.at };
}

let lastSignature = "";

function recompute({ force = false } = {}) {
  // A poll that brought nothing new changes nothing on screen.
  const signature = [server.rev, outbox.map((o) => o.op_id).join(","), status.online, status.lastSync?.slice(0, 16)].join("|");
  if (!force && signature === lastSignature) return;
  lastSignature = signature;
  view = structuredClone(server.state);
  for (const op of outbox) {
    try {
      applyOp(view, op, ctxFor(op));
    } catch {
      // The worker will refuse it too and say why; until then it shows nothing.
    }
  }
  status.pending = outbox.length;
  for (const fn of listeners) fn(view, status);
}

export function subscribe(fn) {
  listeners.add(fn);
  fn(view, status);
  return () => listeners.delete(fn);
}

export const getView = () => view;
export const getMe = () => me;
/** A recipes-only person (Henk): the server gives and takes only the recipe side; the screens hide the rest. */
export const isGuest = () => Boolean(me?.member?.recipes_only);
export const getStatus = () => status;

/** Called with (code, op) when the worker refuses one of this device's ops. */
export function onRefused(fn) {
  errorListeners.add(fn);
  return () => errorListeners.delete(fn);
}

// -------------------------------------------------------------- startup

export async function init() {
  try {
    server = (await idbGet("server")) ?? server;
    // A copy saved before phase 2 has no products, purchases, ... yet.
    server.state = { ...emptyState(), ...server.state };
    outbox = (await idbGet("outbox")) ?? [];
    me = (await idbGet("me")) ?? null;
  } catch {
    // Private mode or storage blocked: the app still works while it is open.
  }
  recompute();
  window.addEventListener("online", () => {
    status.online = true;
    sync();
  });
  window.addEventListener("offline", () => {
    status.online = false;
    recompute();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sync();
  });
}

export async function setMe(value) {
  me = value;
  await idbSet("me", value).catch(() => {});
}

/** Forget everything on this device (signed out or unpaired). */
export async function forget() {
  server = { rev: 0, state: emptyState() };
  outbox = [];
  me = null;
  await idbClear().catch(() => {});
  // The service worker keeps recipe photos for offline use (public/sw.js).
  await globalThis.caches?.delete("kitchen-photos").catch(() => {});
  recompute({ force: true });
}

// ------------------------------------------------------------- changes

/**
 * Make a change. Throws OpError straight away when the op is invalid, so the
 * screen can say why; otherwise it shows at once and goes out when it can.
 */
export async function dispatch(op) {
  const full = { ...op, op_id: newId(), at: new Date().toISOString() };
  applyOp(structuredClone(view), full, ctxFor(full));
  outbox.push(full);
  recompute();
  await idbSet("outbox", outbox).catch(() => {});
  sync();
  return full;
}

// ---------------------------------------------------------------- sync

let running = null;
let again = false;
let timer = null;
let backoff = POLL_MS;

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (document.visibilityState === "visible") sync();
    else schedule(POLL_MS);
  }, ms);
}

function mergePull(data) {
  const state = { ...emptyState(), ...(data.full ? {} : server.state) };
  for (const kind of KINDS) {
    for (const row of data[kind] ?? []) {
      if (row.deleted_at || row.removed_at) delete state[kind][row.id];
      else state[kind][row.id] = row;
    }
  }
  server = { rev: data.rev, state };
}

async function syncOnce() {
  const sent = outbox.slice(0, 50);
  if (sent.length) {
    const { results } = await api.post("/api/ops", { ops: sent });
    for (const r of results) {
      if (!r.ok) {
        const op = sent.find((o) => o.op_id === r.op_id);
        for (const fn of errorListeners) fn(r.error, op);
      }
    }
  }
  const data = await api.get(`/api/sync?since=${server.rev}`);
  mergePull(data);
  const done = new Set(sent.map((o) => o.op_id));
  outbox = outbox.filter((o) => !done.has(o.op_id));
  await Promise.all([idbSet("server", server), idbSet("outbox", outbox)]).catch(() => {});
  return outbox.length > 0;
}

/** Push this device's ops, then pull what changed. Only one runs at a time. */
export function sync() {
  if (!me) return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    status.syncing = true;
    try {
      let more = true;
      while (more || again) {
        again = false;
        more = await syncOnce();
      }
      status.online = true;
      status.lastSync = new Date().toISOString();
      backoff = POLL_MS;
    } catch (e) {
      if (isOffline(e)) status.online = false;
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    } finally {
      status.syncing = false;
      running = null;
      recompute();
      schedule(backoff);
    }
  })();
  return running;
}
