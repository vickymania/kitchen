// "Foto's" and "Van een website" on the new-recipe screen. Both ask the
// worker (worker/recipe-import.js) for a draft and hand it to the editor
// (public/app/recipe-edit.js), which fills its fields; nothing is saved here.
//
// Photos are shrunk first (public/app/photo.js: 1600 px JPEG, no EXIF). When
// Claude names the photo of the finished dish, that part is cut out on a
// canvas and uploaded as the recipe photo; the person can pick another photo
// or none.
import { h, fill } from "./dom.js";
import { t } from "./i18n.js";
import { api, isOffline } from "./api.js";
import { shrink, uploadPhoto } from "./photo.js";
import { cropRect } from "../shared/recipe-import.js";

const MAX_PHOTOS = 4;   // the same as MAX_PHOTOS in worker/recipe-import.js

function base64Of(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** The box of a photo as a JPEG of its own. */
export async function cropDish(blob, box) {
  const bitmap = await createImageBitmap(blob);
  const r = cropRect(box, bitmap.width, bitmap.height);
  if (!r) {
    bitmap.close?.();
    return blob;
  }
  const canvas = document.createElement("canvas");
  canvas.width = r.sw;
  canvas.height = r.sh;
  canvas.getContext("2d").drawImage(bitmap, r.sx, r.sy, r.sw, r.sh, 0, 0, r.sw, r.sh);
  bitmap.close?.();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/jpeg", 0.85));
}

/** A known error code's sentence, else the general one. */
function errorText(e) {
  if (isOffline(e)) return t("import.offline");
  const key = `errors.${e.code}`;
  return t(key) === key ? t("import.failed") : t(key);
}

/**
 * The import block. `onDraft(draft)` fills the form; `onPhoto(key|null)`
 * sets the recipe photo. Returns the element.
 */
export function importBlock({ onDraft, onPhoto }) {
  const photos = [];            // shrunk JPEG blobs, in the order Claude sees them
  let mode = null;              // "photos" | "url" | null
  let busy = false;
  let dish = null;              // { photo, box } from the last answer

  const status = h("p", { class: "import-status", "aria-live": "polite", hidden: true });
  const say = (text, { error = false } = {}) => {
    status.textContent = text ?? "";
    status.hidden = !text;
    status.classList.toggle("sig", error);
  };

  // ---- photos
  const thumbs = h("div", { class: "import-thumbs" });
  const readBtn = h("button", { type: "button", class: "btn primary", disabled: true, onclick: () => readPhotos() }, t("import.read"));
  const addInput = (camera) => {
    const input = h("input", { type: "file", accept: "image/*", multiple: !camera, capture: camera ? "environment" : null });
    input.addEventListener("change", async () => {
      const files = [...(input.files ?? [])];
      if (photos.length + files.length > MAX_PHOTOS) say(t("import.max_photos"), { error: true });
      else say(null);
      for (const f of files.slice(0, MAX_PHOTOS - photos.length)) {
        try {
          photos.push(await shrink(f));
        } catch {
          say(t("import.failed"), { error: true });
        }
      }
      paintThumbs();
    });
    input.click();
  };
  const cameraBtn = h("button", { type: "button", class: "btn", onclick: () => addInput(true) }, t("import.camera"));
  const galleryBtn = h("button", { type: "button", class: "btn", onclick: () => addInput(false) }, t("import.gallery"));

  // After a read: which photo is the recipe photo. Claude's pick is marked;
  // a tap on another one (whole photo) or on "Geen" changes it.
  const pickRow = h("div", { class: "import-pick", hidden: true });
  let chosen = null;

  function paintThumbs() {
    fill(thumbs, photos.map((b, i) => {
      const url = URL.createObjectURL(b);
      return h("div", { class: "import-thumb" },
        h("img", { src: url, alt: t("import.photo_n", { n: i + 1 }), onload: () => URL.revokeObjectURL(url) }),
        busy ? null : h("button", {
          type: "button", class: "import-x", "aria-label": t("import.remove_photo"),
          onclick: () => { photos.splice(i, 1); paintThumbs(); },
        }, "×"));
    }));
    readBtn.disabled = busy || !photos.length;
    cameraBtn.disabled = galleryBtn.disabled = busy || photos.length >= MAX_PHOTOS;
  }

  async function usePhoto(index) {
    chosen = index;
    paintPick();
    if (index === null) {
      onPhoto(null);
      return;
    }
    say(t("import.photo_uploading"));
    try {
      const box = dish && dish.photo === index ? dish.box : null;
      const blob = box ? await cropDish(photos[index], box) : photos[index];
      onPhoto(await uploadPhoto(blob));
      say(t("import.photo_done"));
    } catch (e) {
      say(isOffline(e) ? t("import.offline") : t("import.photo_failed"), { error: true });
    }
  }

  function paintPick() {
    pickRow.hidden = photos.length === 0 || busy;
    fill(pickRow,
      h("span", { class: "mono" }, t("import.dish_photo")),
      h("div", { class: "import-thumbs" },
        photos.map((b, i) => {
          const url = URL.createObjectURL(b);
          return h("button", {
            type: "button", class: "import-thumb", "aria-pressed": String(chosen === i),
            "aria-label": t("import.photo_n", { n: i + 1 }), onclick: () => usePhoto(i),
          }, h("img", { src: url, alt: "", onload: () => URL.revokeObjectURL(url) }));
        }),
        h("button", { type: "button", class: "btn ghost", "aria-pressed": String(chosen === null), onclick: () => usePhoto(null) }, t("import.no_photo"))));
  }

  async function readPhotos() {
    if (busy || !photos.length) return;
    busy = true;
    paintThumbs();
    pickRow.hidden = true;
    say(t("import.reading"));
    try {
      const data = await Promise.all(photos.map(async (b) => ({ type: "image/jpeg", data: await base64Of(b) })));
      const draft = await api.post("/api/recipes/import/photos", { photos: data });
      dish = draft.dish;
      onDraft(draft);
      busy = false;
      paintThumbs();
      say(draft.thin ? t("import.thin") : t("import.done"));
      if (dish) await usePhoto(dish.photo);
      else {
        chosen = null;
        paintPick();
      }
    } catch (e) {
      busy = false;
      paintThumbs();
      say(errorText(e), { error: true });
    }
  }

  const photoPanel = h("div", { class: "import-panel", hidden: true },
    thumbs,
    h("div", { class: "actions" }, cameraBtn, galleryBtn, readBtn),
    pickRow);

  // ---- a web page
  const url = h("input", { type: "url", inputmode: "url", placeholder: "https://", "aria-label": t("import.url") });
  const fetchBtn = h("button", { type: "button", class: "btn primary", onclick: () => readUrl() }, t("import.fetch"));
  url.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      readUrl();
    }
  });
  async function readUrl() {
    const value = url.value.trim();
    if (busy || !value) return;
    busy = true;
    fetchBtn.disabled = true;
    say(t("import.fetching"));
    try {
      const draft = await api.post("/api/recipes/import/url", { url: value });
      onDraft(draft);
      if (draft.photo) onPhoto(draft.photo);
      say(draft.thin ? t("import.thin") : t("import.done"));
    } catch (e) {
      say(errorText(e), { error: true });
    } finally {
      busy = false;
      fetchBtn.disabled = false;
    }
  }
  const urlPanel = h("div", { class: "import-panel", hidden: true }, h("div", { class: "import-url" }, url, fetchBtn));

  // ---- the two choices
  const photosTab = h("button", { type: "button", class: "choice toggle", "aria-pressed": "false", onclick: () => open("photos") }, t("import.photos"));
  const urlTab = h("button", { type: "button", class: "choice toggle", "aria-pressed": "false", onclick: () => open("url") }, t("import.website"));
  function open(next) {
    if (busy) return;
    mode = mode === next ? null : next;
    photosTab.setAttribute("aria-pressed", String(mode === "photos"));
    urlTab.setAttribute("aria-pressed", String(mode === "url"));
    photoPanel.hidden = mode !== "photos";
    urlPanel.hidden = mode !== "url";
    if (mode === "url") url.focus();
  }

  return h("div", { class: "import" },
    h("div", { class: "choices import-choices" }, photosTab, urlTab),
    photoPanel, urlPanel, status);
}
