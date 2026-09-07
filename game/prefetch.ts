/* Warm the browser's HTTP cache for the world build's big downloads while
   the player is still reading the main menu.

   THE PROBLEM. The load's two heaviest stages do not start their fetches
   until they run: PUTTING CARS ON THE ROAD asks for the 14 traffic
   bodyshells (~2.7 MB) and WARMING THE ENGINE asks for the donor exterior
   (1.4 MB) and the donor cabin (5.7 MB). On a phone on 4G that is ten
   megabytes that begin arriving several seconds INTO a loading screen, and
   both stages give up on them early by design (FLEET_BUDGET_MS,
   DASH_BUDGET_MS) — so what the budgets actually buy on a slow link is a
   world that assembles itself over the first seconds of driving.

   Meanwhile the player spent however long reading the board with the
   connection completely idle.

   THE FIX is not to build anything early — a world build on the menu freezes
   the menu, because every stage is one synchronous block (see loading.ts) —
   it is to move the DOWNLOADS, which cost no main-thread time at all, into
   that idle window. Nothing about the load changes: the same stages ask for
   the same files in the same order, and find them already in the cache.

   <link rel="prefetch"> rather than fetch(): it is the lowest priority the
   platform has, so it yields to the engine chunk and to anything the page
   asks for in earnest, the response lands in the ordinary HTTP cache where
   GLTFLoader's own request will find it, and nothing is parsed or decoded —
   no JS runs, no memory is held, and a prefetch that is still in flight when
   the real request goes out is joined rather than duplicated.

   WHAT IT COSTS. Data, for a visitor who never presses DRIVE. That is the
   honest trade and it is why this asks first: a metered or slow connection
   (Save-Data, 2g) is skipped entirely, and the caller only arms it once the
   menu is up and idle. */

/** True when the browser says this connection should not be spent on
    speculation — the Save-Data header the player switched on, or a
    connection so slow that ten megabytes of guessing would be the only
    thing on it. Absent on Safari/Firefox, where the answer is "go ahead". */
function speculationUnwelcome(): boolean {
  const c = (navigator as unknown as {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
  if (!c) return false;
  if (c.saveData) return true;
  return c.effectiveType === "slow-2g" || c.effectiveType === "2g";
}

const asked = new Set<string>();

/** Queue `urls` for prefetch, in order, skipping anything already asked for.
    Safe to call more than once; idempotent per URL for the life of the page. */
export function prefetchAssets(urls: string[]): string[] {
  if (typeof document === "undefined" || speculationUnwelcome()) return [];
  const done: string[] = [];
  for (const href of urls) {
    if (asked.has(href)) continue;
    asked.add(href);
    const l = document.createElement("link");
    l.rel = "prefetch";
    l.href = href;
    /* Same origin, and the real request is a plain GLTFLoader fetch with no
       credentials mode set, so the cache entry this creates matches it. */
    document.head.appendChild(l);
    done.push(href);
  }
  return done;
}
