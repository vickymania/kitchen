// The screen for a device that is not part of the household yet: type the
// six-digit code someone made in Settings. Also takes the one-time link from
// the other app (#pair=...), which needs no typing.
import { api } from "./api.js";
import { h, title, toast } from "./dom.js";
import { t } from "./i18n.js";

function deviceLabel() {
  const ua = navigator.userAgent;
  const app = t(`app.${document.body.dataset.app}`);
  if (/iPhone/.test(ua)) return `iPhone · ${app}`;
  if (/iPad/.test(ua)) return `iPad · ${app}`;
  if (/Android/.test(ua)) return `Android · ${app}`;
  if (/Windows/.test(ua)) return `Windows · ${app}`;
  if (/Mac OS/.test(ua)) return `Mac · ${app}`;
  return app;
}

/** What the invite's label says after the name ("Henk - iPhone"); an iPad's Safari says "Macintosh". */
export function deviceHint() {
  const ua = navigator.userAgent;
  if (/iPhone|iPod/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  if (/Mac OS/.test(ua)) return "Mac";
  return undefined;     // the server reads the user agent, else "telefoon"
}

/** "Recepten delen": the one-time link #/join/<token> pairs this device as that person. */
export async function consumeInvite(token) {
  try {
    await api.post("/api/pair", { invite: token, device: deviceHint() });
    return true;
  } catch (e) {
    toast(e.code === "too_many_attempts" ? t("pair.too_many") : t("pair.invite_used"), { error: true });
    return false;
  }
}

export async function consumeHandoff(token) {
  try {
    await api.post("/api/pair", { handoff: token, label: deviceLabel() });
    return true;
  } catch {
    toast(t("pair.link_expired"), { error: true });
    return false;
  }
}

export function mountPairing(root) {
  const code = h("input", {
    class: "code-input", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6",
    pattern: "[0-9]{6}", required: true, "aria-label": t("pair.code"),
  });
  const label = h("input", { value: deviceLabel(), maxlength: "80" });
  const submit = h("button", { type: "submit", class: "btn primary" }, t("pair.link"));

  const form = h("form", {
    class: "pair",
    onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        await api.post("/api/pair", { code: code.value.replace(/\D/g, ""), label: label.value });
        location.reload();
      } catch (err) {
        const why = { too_many_attempts: "pair.too_many", recipes_only: "errors.recipes_only" }[err.code] ?? "pair.wrong_code";
        toast(t(why), { error: true });
        submit.disabled = false;
        code.select();
      }
    },
  },
  h("p", { class: "notes" }, t("pair.explain")),
  h("label", { class: "field" }, h("span", { class: "mono" }, t("pair.code")), code),
  h("label", { class: "field" }, h("span", { class: "mono" }, t("pair.device_name")), label),
  h("div", { class: "actions" }, submit));

  root.append(h("section", { class: "hero wrap" },
    h("div", { class: "eyebrow mono" }, h("span", {}, location.hostname), h("span", {}, "—"), h("span", { class: "sig" }, t("pair.not_linked"))),
    title(t("pair.title"))),
  h("div", { class: "wrap" }, form));
  code.focus();
}
