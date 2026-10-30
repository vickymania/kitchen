// Dark, light or as the phone is set. A per-device choice, so it lives in
// localStorage, not in the household data; the stylesheet is dark until this
// runs (public/styles/app.css).
export const THEMES = ["dark", "light", "system"];
const KEY = "kitchen.theme";

export function getTheme() {
  try {
    const v = localStorage.getItem(KEY);
    return THEMES.includes(v) ? v : "dark";
  } catch {
    return "dark";
  }
}

export function setTheme(theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Private mode or blocked storage: the choice holds until the page closes.
  }
  applyTheme(theme);
}

export function applyTheme(theme = getTheme()) {
  document.documentElement.dataset.theme = theme;
  // The phone's status bar follows the page background.
  const paper = getComputedStyle(document.documentElement).getPropertyValue("--paper").trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", paper || "#0B0D10");
}

applyTheme();
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => applyTheme());
