/* Staged, yielding world load.

   The whole world used to be built in one synchronous block inside the Game
   constructor — terrain, road net, 4.7 km of expressway, the town, the traffic
   fleet, the player rig. On a phone that is seconds of solid main-thread work,
   and there is no such thing as a loading screen that animates through it: any
   UI painted before the block is frozen for its entire duration.

   The fix is not a spinner, it is the chunking. The build is expressed as a
   list of stages and the runner below hands the main thread back — long enough
   for a real paint — between every one of them. The screen then genuinely
   redraws N times during the load instead of once at each end.

   Stages are still individually synchronous and individually blocking (a
   single buildHighway() call is hundreds of milliseconds on a phone), so the
   loading screen's own motion has to survive a blocked main thread: see the
   compositor-only animation note on `.loadSweep` in app/globals.css. */

export interface LoadStage {
  /** Shown on the loading screen while this stage runs. */
  label: string;
  /** Share of the total bar this stage is worth. Relative, not a unit — see
      LOAD_WEIGHTS in engine.ts for where the numbers come from. */
  weight: number;
  /** `onStep(0..1)` reports progress WITHIN this stage. Optional, and most
      stages ignore it — but a stage that takes seconds must call it, because
      weighting alone cannot fix a stall. A stage is one jump of the bar no
      matter how it is weighted, so a long one always parks the bar somewhere
      and sits there; the only cure is for it to report from inside. */
  run(onStep?: (frac: number) => void): void | Promise<void>;
}

export interface LoadReport {
  label: string;
  /** 0..1 — how much of the weighted total is finished. */
  frac: number;
}

/** How long a hidden tab is allowed to sit on one stage before the load walks
    on without a paint. Backgrounded tabs stop firing rAF entirely, so without
    this backstop, tabbing away mid-load would strand the player on the loading
    screen until they came back. Deliberately far longer than a frame so it
    never pre-empts the rAF path on a visible, merely-slow device. */
const HIDDEN_TICK_MS = 250;

/** Hand the main thread back until the browser has actually PAINTED.

    rAF on its own is not enough: its callbacks run before the frame is
    composited, so resuming inside one blocks the very paint we are waiting
    for and the bar never moves. Posting a MessageChannel message from inside
    the rAF callback queues a task that lands after that frame's rendering
    opportunity — the earliest moment we can be sure the new label and bar
    position are on the glass.

    Not setTimeout(0): nested timers are clamped to 4 ms and, worse, a timer
    can be serviced in the same turn as the rAF, i.e. still before paint.
    Not scheduler.yield(): it resumes at a priority ABOVE rendering, which is
    exactly right for keeping a page responsive and exactly wrong for "let the
    frame land before I block again". */
export function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let raf = 0;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      /* And drop the frame callback. On the timeout path — a hidden tab — the
         rAF has not fired and will not until the tab is looked at again, which
         may be hours; without this, every stage boundary of a backgrounded
         load leaves a channel and its closure pinned until then, and they all
         wake at once to post into a closed port. */
      cancelAnimationFrame(raf);
      // whichever path lost the race must not be left holding an open port
      ch.port1.close();
      resolve();
    };
    ch.port1.onmessage = finish;
    timer = setTimeout(finish, HIDDEN_TICK_MS);
    raf = requestAnimationFrame(() => ch.port2.postMessage(0));
  });
}

/** Wait for `p`, but give up after `ms` and carry on.

    Used for the asset fetches the load waits on (the traffic bodyshells, the
    donor dash). Waiting is worth it — it is the difference between driving off
    into a finished world and watching it assemble itself over the first few
    seconds — but a phone on a bad connection must never be able to hold the
    player on the loading screen indefinitely. Past the budget the asset simply
    goes back to landing late and popping in, which is the behaviour that
    shipped before this existed. Never rejects: a failed fetch is a resolved
    wait, not a failed load. */
export function withBudget(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const stop = () => {
      clearTimeout(timer);
      resolve();
    };
    void p.then(stop, stop);
  });
}

/** Run `stages` in order, yielding to a paint between each one.

    Returns per-stage wall-clock milliseconds so the weights above can be
    re-tuned against a real device instead of guessed at — the engine hangs the
    result off `__neonx.loadTimings`.

    Throws whatever a stage throws: the caller owns the error state, because
    only it knows what to put on screen. `cancelled` is polled at every stage
    boundary so a teardown mid-load stops promptly instead of finishing a build
    into a destroyed renderer.

    Cancelling is a TEARDOWN, not a pause, and the caller must treat it as one:

      - the stage already running is not interrupted. Stages are individually
        synchronous or await their own budgets, so the abandoned build keeps
        the main thread for the rest of that stage (up to the longest budget in
        LOAD_WEIGHTS' company — see COMPILE_BUDGET_MS) before the next poll
        stops it. Cancel is prompt for the player, not instant for the machine.
      - what the stages built stays built. They append to one scene graph off a
        single seeded rng stream, so a partial run leaves a partial world with
        no point to resume from — running the stages again over it stacks a
        second town on the first, exactly the failure Game.loadFailed exists to
        prevent for a thrown stage.

    So the contract is: cancel, then DROP the object that owns that scene and
    build a fresh one. Never call runStages twice against the same world, and
    never let a later "already loading" fast path hand out the cancelled run's
    promise as if it had finished — a cancelled run resolves like a successful
    one. It reports no READY and returns only the timings of the stages that
    actually ran; the caller's own cancel condition, re-checked after the
    await, is what tells the two apart. */
export async function runStages(
  stages: LoadStage[],
  onProgress: (r: LoadReport) => void,
  cancelled?: () => boolean
): Promise<Record<string, number>> {
  const total = stages.reduce((s, x) => s + x.weight, 0) || 1;
  const timings: Record<string, number> = {};
  let done = 0;
  for (const st of stages) {
    if (cancelled?.()) return timings;
    /* Announce the label BEFORE the work and the progress the previous stages
       earned, then paint. Reporting after the fact would leave the player
       reading the name of the stage that already finished while the next one
       blocks. */
    onProgress({ label: st.label, frac: done / total });
    await yieldToPaint();
    if (cancelled?.()) return timings;
    const t0 = performance.now();
    /* Intra-stage progress. Rounded to whole percent before it is forwarded,
       so a stage reporting every frame cannot churn the DOM for movement
       nobody can see — the bar is ~400px wide, so sub-percent steps are
       sub-pixel. */
    let lastPct = -1;
    await st.run((f) => {
      const c = f < 0 ? 0 : f > 1 ? 1 : f;
      const frac = (done + st.weight * c) / total;
      const pct = Math.round(frac * 100);
      if (pct === lastPct) return;
      lastPct = pct;
      onProgress({ label: st.label, frac });
    });
    timings[st.label] = Math.round(performance.now() - t0);
    done += st.weight;
  }
  onProgress({ label: "READY", frac: 1 });
  return timings;
}
