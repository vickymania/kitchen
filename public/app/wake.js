// Keeps the screen on while a recipe or cook mode is open (Thomas's wish:
// the phone must not dim while your hands are in the dough). Works in the
// browser and in the installed app; the browser drops the lock when the app
// is hidden, so it is asked for again when it comes back.

export function keepScreenOn() {
  let lock = null;
  let active = true;
  const take = async () => {
    try {
      if (active && document.visibilityState === "visible" && !lock) {
        lock = await navigator.wakeLock?.request("screen");
        lock?.addEventListener("release", () => { lock = null; });
      }
    } catch {
      lock = null;          // not supported, or the battery saver refused
    }
  };
  const onVisible = () => take();
  document.addEventListener("visibilitychange", onVisible);
  take();
  return () => {
    active = false;
    document.removeEventListener("visibilitychange", onVisible);
    lock?.release?.().catch(() => {});
  };
}
