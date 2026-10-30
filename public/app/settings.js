// Settings, the same in both apps: your name and language, the people in the
// household, codes to link a device or add a person, and the devices that
// have access (with a way to take it away).
import { h, title, toast, sheet, confirmSheet } from "./dom.js";
import { t, formatDate } from "./i18n.js";
import { api, isOffline } from "./api.js";
import * as store from "./store.js";
import { THEMES, getTheme, setTheme } from "./theme.js";
import { latestReview, reviewBody, changesList } from "./review.js";

async function showCode(promise, explainKey) {
  let out;
  try {
    out = await promise;
  } catch (e) {
    toast(isOffline(e) ? t("settings.needs_connection") : t("errors.refused"), { error: true });
    return;
  }
  await sheet((close) => [
    h("h2", {}, t("settings.code_title")),
    h("p", { class: "code", "aria-live": "polite" }, out.code.replace(/(\d{3})(\d{3})/, "$1 $2")),
    h("p", { class: "hint" }, t(explainKey), " ", t("settings.code_expires")),
    h("div", { class: "actions" }, h("button", { type: "button", class: "btn primary", onclick: () => close() }, t("common.done"))),
  ]);
}

/**
 * "Recepten delen" (admins, on recipes): a name, then a one-time link for a
 * recipes-only person, to share or copy. The server makes it (/api/invites).
 */
function shareRecipes() {
  // One sheet: the name, and in its place the link once it is made.
  return sheet((close) => {
    const body = h("div", {});
    const who = h("input", { maxlength: "60", required: true, value: t("settings.share_default") });
    const make = h("button", { type: "submit", class: "btn primary" }, t("settings.share_make"));
    const showLink = (name, url) => {
      const link = h("input", { class: "share-link", value: url, readonly: true, "aria-label": t("settings.share_link_title", { name }), onfocus: () => link.select() });
      const copy = async () => {
        try {
          await navigator.clipboard.writeText(url);
          toast(t("settings.share_copied"));
        } catch {
          link.select();
        }
      };
      body.replaceChildren(
        h("h2", {}, t("settings.share_link_title", { name })),
        link,
        h("p", { class: "hint" }, t("settings.share_link_expires")),
        h("div", { class: "actions" },
          navigator.share
            ? h("button", { type: "button", class: "btn primary", onclick: () => navigator.share({ title: t("app.recipes"), text: t("settings.share_message"), url }).catch(() => {}) }, t("settings.share_share"))
            : null,
          h("button", { type: "button", class: navigator.share ? "btn" : "btn primary", onclick: copy }, t("settings.share_copy")),
          h("button", { type: "button", class: "btn ghost", onclick: () => close() }, t("common.done"))));
    };
    const submit = async (e) => {
      e.preventDefault();
      const name = who.value.trim();
      if (!name) return;
      make.disabled = true;
      try {
        showLink(name, (await api.post("/api/invites", { name })).url);
      } catch (err) {
        toast(isOffline(err) ? t("settings.needs_connection") : t("errors.refused"), { error: true });
        make.disabled = false;
      }
    };
    body.append(h("form", { onsubmit: submit },
      h("h2", {}, t("settings.share_title")),
      h("label", { class: "field" }, h("span", { class: "mono" }, t("settings.share_name")), who),
      h("div", { class: "actions" }, make,
        h("button", { type: "button", class: "btn", onclick: () => close() }, t("common.cancel")))));
    return body;
  });
}

export function mountSettings(root) {
  const me = store.getMe();
  // A recipes-only person: his devices, the theme and signing out; nothing of the household.
  const guest = Boolean(me.member.recipes_only);
  const devices = h("ul", { class: "kv" });
  const people = h("ul", { class: "kv" });

  const name = h("input", { value: me.member.name, maxlength: "60" });
  const lang = h("select", {}, h("option", { value: "nl" }, "Nederlands"), h("option", { value: "en" }, "English"));
  lang.value = me.member.locale;

  const saveYou = async (e) => {
    e.preventDefault();
    const op = { type: "member.update", id: me.member.id };
    if (name.value.trim() && name.value.trim() !== me.member.name) op.name = name.value;
    if (lang.value !== me.member.locale) op.locale = lang.value;
    if (Object.keys(op).length === 2) return;
    await store.dispatch(op);
    await store.setMe({ ...me, member: { ...me.member, name: op.name?.trim() ?? me.member.name, locale: op.locale ?? me.member.locale } });
    if (op.locale) {
      // Every screen and the topbar change language; a reload is the simplest way.
      await store.sync();
      location.reload();
      return;
    }
    toast(t("settings.saved"));
  };

  const addPerson = async () => {
    const who = h("input", { maxlength: "60", required: true });
    const admin = h("input", { type: "checkbox" });
    const ok = await sheet((close) => h("form", { onsubmit: (e) => { e.preventDefault(); close(true); } },
      h("h2", {}, t("settings.add_person")),
      h("label", { class: "field" }, h("span", { class: "mono" }, t("settings.their_name")), who),
      h("label", { class: "field" }, admin, " ", t("settings.make_admin")),
      h("p", { class: "hint" }, t("settings.admin_explain")),
      h("div", { class: "actions" }, h("button", { type: "submit", class: "btn primary" }, t("settings.make_code")),
        h("button", { type: "button", class: "btn", onclick: () => close(false) }, t("common.cancel")))));
    if (ok && who.value.trim()) {
      await showCode(api.post("/api/codes", { for: "new_member", name: who.value.trim(), admin: admin.checked }), "settings.code_person");
    }
  };

  const openOther = async () => {
    try {
      const { url } = await api.post("/api/handoff");
      location.href = url;
    } catch (e) {
      toast(isOffline(e) ? t("settings.needs_connection") : t("errors.refused"), { error: true });
    }
  };

  async function loadDevices() {
    try {
      const { devices: list } = await api.get("/api/devices");
      devices.replaceChildren(...list.map((d) => h("li", {},
        h("span", { class: "grow" }, d.label || t("settings.unnamed_device"),
          h("small", {}, [me.member.is_admin ? d.member_name : null, t("settings.linked_on", { date: formatDate(d.created_at) }),
            d.current ? t("settings.this_device") : null].filter(Boolean).join(" · "))),
        d.current ? null : h("button", {
          type: "button", class: "btn ghost",
          onclick: async () => {
            if (!(await confirmSheet(t("settings.revoke_confirm", { name: d.label }), t("settings.revoke"), t("common.cancel")))) return;
            await api.post("/api/devices/revoke", { id: d.id }).catch(() => toast(t("errors.refused"), { error: true }));
            loadDevices();
          },
        }, t("settings.revoke")))));
    } catch {
      devices.replaceChildren(h("li", { class: "mute" }, t("settings.needs_connection")));
    }
  }

  function renderPeople(view) {
    const list = Object.values(view.members).sort((a, b) => a.name.localeCompare(b.name));
    people.replaceChildren(...list.map((m) => h("li", {},
      h("span", { class: "grow" }, m.name, h("small", {}, [m.is_admin ? t("settings.admin") : null, m.recipes_only ? t("settings.recipes_only") : null,
        m.id === me.member.id ? t("settings.you") : null].filter(Boolean).join(" · "))),
      me.member.is_admin && m.id !== me.member.id
        ? h("button", {
          type: "button", class: "btn ghost",
          onclick: async () => {
            if (!(await confirmSheet(t("settings.remove_confirm", { name: m.name }), t("settings.remove"), t("common.cancel")))) return;
            await api.post("/api/members/remove", { id: m.id }).catch(() => toast(t("errors.refused"), { error: true }));
            store.sync();
            loadDevices();
          },
        }, t("settings.remove"))
        : null)));
  }

  const signOut = async () => {
    if (!(await confirmSheet(t("settings.sign_out_confirm"), t("settings.sign_out"), t("common.cancel")))) return;
    await api.post("/api/logout").catch(() => {});
    await store.forget();
    location.reload();
  };

  // This device only, applied at once: no save button.
  const theme = h("select", { onchange: () => setTheme(theme.value) },
    THEMES.map((v) => h("option", { value: v }, t(`settings.theme_${v}`))));
  theme.value = getTheme();

  // The last nightly check (public/app/review.js), on groceries only.
  // "Wat hij deed": its own changes of the last 60 days, newest first.
  const review = h("div", {});
  const changes = h("div", { class: "review-part" });
  const renderReview = (view) => {
    const r = latestReview(view);
    review.replaceChildren(...(r ? [h("p", { class: "mono mute" }, formatDate(r.day)), ...reviewBody(r).filter(Boolean)] : [h("p", { class: "hint" }, t("review.none"))]));
    changes.replaceChildren(h("h3", { class: "low-label mono" }, t("review.changes")), changesList(view));
  };

  const otherApp = document.body.dataset.app === "recipes" ? t("app.groceries") : t("app.recipes");
  root.append(
    h("section", { class: "hero wrap" },
      h("div", { class: "eyebrow mono" }, h("span", {}, h("b", {}, me.household?.name ?? "")), h("span", {}, me.member.name)),
      title(t("settings.title"))),
    h("div", { class: "wrap settings" },
      guest ? null : h("section", {},
        h("div", { class: "section-head" }, h("h2", {}, t("settings.you_title"))),
        h("form", { onsubmit: saveYou },
          h("label", { class: "field" }, h("span", { class: "mono" }, t("settings.name")), name),
          h("label", { class: "field" }, h("span", { class: "mono" }, t("settings.language")), lang),
          h("div", { class: "actions" }, h("button", { type: "submit", class: "btn primary" }, t("common.save"))))),
      h("section", {},
        h("div", { class: "section-head" }, h("h2", {}, t("settings.this_phone"))),
        h("label", { class: "field" }, h("span", { class: "mono" }, t("settings.theme")), theme),
        guest ? null : h("p", { class: "hint" }, t("settings.other_app_explain", { app: otherApp })),
        h("div", { class: "actions" },
          guest ? null : h("button", { type: "button", class: "btn primary", onclick: openOther }, t("settings.open_other", { app: otherApp })),
          h("button", { type: "button", class: "btn", onclick: () => showCode(api.post("/api/codes", {}), "settings.code_device") }, t("settings.link_device")))),
      guest ? null : h("section", {},
        h("div", { class: "section-head" }, h("h2", {}, t("settings.household"))),
        people,
        me.member.is_admin ? h("div", { class: "actions" }, h("button", { type: "button", class: "btn", onclick: addPerson }, t("settings.add_person"))) : null),
      me.member.is_admin && document.body.dataset.app === "recipes" ? h("section", {},
        h("div", { class: "section-head" }, h("h2", {}, t("settings.share_title"))),
        h("p", { class: "hint" }, t("settings.share_explain")),
        h("div", { class: "actions" }, h("button", { type: "button", class: "btn", onclick: shareRecipes }, t("settings.share_make")))) : null,
      !guest && document.body.dataset.app === "groceries" ? h("section", {},
        h("div", { class: "section-head" }, h("h2", {}, t("review.label"))),
        h("div", { class: "review" }, review, changes)) : null,
      h("section", {},
        h("div", { class: "section-head" }, h("h2", {}, t("settings.devices"))),
        devices,
        h("div", { class: "actions" }, h("button", { type: "button", class: "btn ghost sig", onclick: signOut }, t("settings.sign_out"))))),
  );
  loadDevices();
  return store.subscribe((view) => {
    renderPeople(view);
    renderReview(view);
  });
}
