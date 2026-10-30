// Finds the times in a recipe step ("laat 10 à 15 minuten pruttelen",
// "bake for 1 hour", "een kwartier") so cook mode can offer a timer for each.
// A range starts at its lower end: check early, add a minute if needed.

const NUMBER = String.raw`(\d+(?:[.,]\d+)?|½|anderhalf|een half|een|half)`;
const UNIT = String.raw`(uur|uren|hours?|hrs?|minuten|minuut|min\.?|minutes?|mins?|seconden|sec\.?|seconds?|secs?)`;
const TIME_RE = new RegExp(String.raw`\b${NUMBER}(?:\s*(?:-|–|à|a|tot|to)\s*(\d+))?\s*${UNIT}(?![a-z])`, "gi");
const QUARTER_RE = /\b(een\s+)?kwartier\b/gi;

function amount(word) {
  const w = word.toLowerCase();
  if (w === "½" || w === "half" || w === "een half") return 0.5;
  if (w === "anderhalf") return 1.5;
  if (w === "een") return 1;
  return Number(w.replace(",", "."));
}

function seconds(n, unit) {
  const u = unit.toLowerCase();
  if (/^(uur|uren|hour|hours|hr|hrs)$/.test(u)) return n * 3600;
  if (/^(sec|seconden|second|seconds|secs)/.test(u)) return n;
  return n * 60;
}

/** [{ label: "10 à 15 minuten", seconds: 600 }] in the order they appear. */
export function findTimers(text) {
  const out = [];
  for (const m of String(text).matchAll(TIME_RE)) {
    const s = Math.round(seconds(amount(m[1]), m[3]));
    if (s >= 10 && s <= 24 * 3600) out.push({ label: m[0].trim(), seconds: s, at: m.index });
  }
  for (const m of String(text).matchAll(QUARTER_RE)) out.push({ label: m[0].trim(), seconds: 900, at: m.index });
  return out.sort((a, b) => a.at - b.at).map(({ label, seconds: s }) => ({ label, seconds: s }));
}

export function clock(totalSeconds) {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const two = (n) => String(n).padStart(2, "0");
  return hh ? `${hh}:${two(mm)}:${two(ss)}` : `${two(mm)}:${two(ss)}`;
}
