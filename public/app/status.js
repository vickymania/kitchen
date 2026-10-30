// The sync state in the eyebrow of every screen: synced at 12:04, or offline
// with N changes waiting. In red when something is waiting, so nobody thinks
// the other phone already has it.
import { h } from "./dom.js";
import { t, formatTime } from "./i18n.js";

export function syncLine(status) {
  if (!status.online) {
    return h("span", { class: "sig" }, status.pending ? t("sync.offline_waiting", { n: status.pending }) : t("sync.offline"));
  }
  if (status.pending) return h("span", { class: "sig" }, t("sync.waiting", { n: status.pending }));
  if (!status.lastSync) return h("span", {}, t("sync.syncing"));
  return h("span", {}, t("sync.synced", { time: formatTime(status.lastSync) }));
}
