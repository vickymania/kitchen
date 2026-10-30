// A photo from the camera or the gallery, made small before it leaves the
// phone: at most 1600 px, JPEG. Drawing it on a canvas also drops the EXIF
// data, so no GPS location goes along.
import { api } from "./api.js";

const LONG_EDGE = 1600;

export async function shrink(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, LONG_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/jpeg", 0.82));
}

/** Upload and return the key for recipe.photo. Needs a connection. */
export async function uploadPhoto(file) {
  const blob = await shrink(file);
  const { key } = await api.upload("/api/photos", blob);
  return key;
}
