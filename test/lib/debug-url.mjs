/* The page URL every headless script opens.

   window.__neonx (and the __cluster/__aurora/__wall tuning handles) are gated
   behind `?debug` in production builds — see game/debug.ts — so a script
   pointed at `next start` (as .github/workflows/renders.yml does) would wait
   on a hook that never appears. Every script routes its goto through here;
   the flag is idempotent, so a --url that already carries it is fine.

   `extra` adds further query params (tier, aurora, ...) in the same call:
     page.goto(debugUrl(URL, { tier }))  →  http://host/?debug=1&tier=... */
export function debugUrl(base, extra = {}) {
  const u = new URL(base);
  u.searchParams.set("debug", "1");
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}
