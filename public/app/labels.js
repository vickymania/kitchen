// Asking Claude to label a new recipe (POST /api/recipes/label). The recipe
// must be on the server first, so a request waits until this device's outbox
// is empty and it is online; until then the id waits in localStorage, also
// across a reload. The labels come back through the normal sync.
import { api, isOffline } from "./api.js";
import * as store from "./store.js";

const KEY = "kitchen-label-queue";

function queue() {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}

function save(ids) {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    // Storage blocked: the recipe simply stays without labels.
  }
}

let running = false;

async function flush() {
  if (running) return;
  const status = store.getStatus();
  if (status.pending || !status.online || !queue().length) return;
  running = true;
  try {
    for (const id of queue()) {
      try {
        await api.post("/api/recipes/label", { id });
      } catch (e) {
        if (isOffline(e)) return;
        // A full day (429) tries again later; anything else will not get better.
        if (e.status === 429) return;
      }
      save(queue().filter((x) => x !== id));
    }
  } finally {
    running = false;
  }
}

/** Label this recipe when it can be done. */
export function queueLabel(id) {
  if (!queue().includes(id)) save([...queue(), id]);
  flush();
}

/** Watch the sync status; called once at start. */
export function startLabelQueue() {
  store.subscribe(() => flush());
}
