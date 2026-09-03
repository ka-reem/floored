/* Debug-surface gate.

   The engine, the dashboard cluster and the sky all hang live-tuning handles
   off `window` (__neonx, __cluster, __aurora, __clouds, __wall) and narrate
   themselves on the console. That is the test harness and the tuning
   workflow — not something a player's production tab should carry, and not
   something a curious visitor should be able to teleport the car with.

   On in every non-production build (next dev, node-side scripts), and in
   production only when the page URL carries `?debug` (any value but 0/false)
   — which is what test/lib/debug-url.mjs appends for the headless scripts,
   so `next start` runs in .github/workflows/renders.yml still find the hook.
   process.env.NODE_ENV is inlined by the bundler, so the production branch
   is a constant there and the URL parse is the only runtime cost. */
export const DEBUG_HOOKS: boolean = (() => {
  if (process.env.NODE_ENV !== "production") return true;
  try {
    if (typeof location === "undefined") return false;
    const q = new URLSearchParams(location.search).get("debug");
    return q !== null && q !== "0" && q !== "false";
  } catch {
    return false;
  }
})();
