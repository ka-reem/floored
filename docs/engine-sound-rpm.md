# Why the engine didn't sound like it was revving

Written 2026-08-21, alongside the change that fixed it. Read this before
retuning `ENGINE_TUNE_DEFAULT`, `RPM_ANCHORS`, `LOOP_F0`, or anything in
`stepEngineSpeed()`.

## The report

> "It sounds like it's kind of idling and then it's just getting louder. It
> doesn't actually sound like the RPMs are increasing, like a real car would.
> And then when you let go of the gas, the RPMs glitch and go down really
> fast — it teleports, instead of a natural car where it's vroom, and then it
> lowers slowly."

Two separate root causes, in two different files, that happened to produce one
complaint. Neither was a mixing problem, which is why the previous commit
(085e9b1, "Make the engine louder and give it real low-end rumble") did not
help: it made a wrong sound louder.

## Cause 1 — the rpm signal had no engine in it (`game/physics.ts`)

`car.rpm` was pure driveline kinematics and nothing else:

```ts
car.rpm = clamp(|u| / WR * gearRatio(gear) * FINAL * 9.549, IDLE_RPM, revLimit)
```

Road speed through the current gear. No flywheel, no clutch, no converter.
Three consequences, all audible:

**It could not leave idle.** Clamped at `IDLE_RPM` (850) with the car
stationary, flooring the throttle from rest moved the engine's *pitch* not at
all. The only thing that responded was the audio mixer's throttle terms
(`thr * 0.23` on the sampled ladder, `thr * 0.105` on the synth). An engine
whose loudness climbs while its pitch stands still is, exactly and literally,
"idling and just getting louder."

It was worse than that: at 850rpm the audio's own idle machinery was fully
engaged while the player had the pedal on the floor —
`idleness = clamp01(1 - (rpm-850)/1100)` was **1.0**, so the idle wobble LFO
was at full depth, and `idleMix = (1 - smoothstep(950, 2000, rpm)) * (1 - thr*0.6)`
was **0.4**, so the recorded *idle bed* was playing at 40% during a
full-throttle launch. The game was mixing in a literal idle recording and
turning it up.

**Gear changes teleported it.** 1st→2nd is 3.54:2.13, so a wide-open upshift
dropped the needle ~2900rpm between two consecutive 1/120s physics steps —
328,000 rpm/s. The tachometer snapped (it lerps at 0.38/frame) and the audio's
pitch snapped with it.

**Lifting off fired spurious upshifts.** The shift map read the raw pedal:

```ts
const upR = lerp(revLimit * 0.7, revLimit * REDLINE_FRAC, thrCmd);
```

Releasing the throttle collapsed `upR` from `revLimit*0.985` to `revLimit*0.7`
within a single frame, instantly satisfying the upshift test at whatever rpm
the car was pulling — and, because one upshift only drops the revs by one
ratio step, satisfying it *again* 0.24s later. Lifting off in 4th at 6800rpm
fired two upshifts in a quarter second. That is the "teleport when you come
off the gas."

### The fix

A flywheel model, `stepEngineSpeed()`, with its own state:

- **Converter slip.** `target = max(wheelRpm, IDLE + thr*(STALL - IDLE))`,
  `STALL_RPM = 2450`. Off the line the engine leads the car; the wheels catch
  up to it. Taking the **max** rather than crossfading on a lock factor is
  deliberate — a crossfade sags (flare to 2450, drag back to ~1900 as the lock
  factor rises against a wheel speed that hasn't caught up, then climb again),
  and nothing with a converter in it does that.
- **Shift sweep.** On a gear change, capture `rpmShiftFrom` and `shiftLen`,
  then drive the needle from the old speed to the new one on a `sstep()`
  S-curve over the shift's own window. The rate limiter is **bypassed**
  entirely while shifting — the S-curve is smooth by construction, and with
  the throttle cut to a quarter through a shift the limiter's allowance worked
  out around 40rpm/step against the ~150 the sweep needs, so it fell behind
  its own sweep and then closed the gap in three frames. Same teleport, one
  step removed.
- **Rev hang** (`REV_HANG = 0.16s`), applied as a **brake on the downward
  slew rate** (×0.18), not as a floor under the target. A floor plateaus the
  revs dead flat, and a sixth of a second of frozen pitch is its own artefact.
  Suppressed entirely during a shift, for the same reason as above.
- **Asymmetric slew.** Up scales with throttle (spare torque accelerating the
  engine's own inertia), down is slower (pumping and friction losses only).
  That asymmetry *is* the "vroom, and then it lowers slowly" shape. Both open
  up ~9× once the clutch is locked, because there the driveline is physically
  turning the engine and can change its speed faster than the engine could
  alone — so the limiter only bites at launches, lifts and shifts.
- **Lagged pedal** (`car.thrPrev`, ~0.35s trail) feeds the upshift map, the
  way a real automatic filters pedal input. The lift-off upshift now arrives
  once, deliberately.

**`car.rpmDrive` is new and holds the old kinematic value.** `engineTorque()`,
`limiterFactor()`, the rev limiter and the shift scheduler all still read it,
so **handling is bit-identical**. The flywheel model is deliberately a
display/audio change only — feeding a lagged rpm into the torque curve would
retune every car's acceleration as a side effect. If you ever want the model
in the physics loop, that is a separate, deliberate retune.

Guarded by `test/engine-rpm-check.mjs` (`npm run engine-rpm`): compiles the
real physics module and asserts the properties that were broken, not a trace.
Worst single-step motion went from ~2900rpm to 134–165rpm across the roster.

## Cause 2 — the sample ladder's pitch ran backwards (`game/audio.ts`)

This is the more surprising one. The four recorded loops were treated as an
rpm ladder with `RPM_ANCHORS = [1050, 2400, 4200, 6400]` and
`playbackRate = rpm / anchor`. The anchors were documented as "tuning anchors,
not measured engine speeds" — and they were wrong by a factor of four.

Measured fundamentals (autocorrelation, confidence 0.83–0.95, confirmed
against spectral peaks sitting on these frequencies and their multiples;
loop_0 also shows the half-order at 21.5Hz, exactly what a four-stroke does):

| loop | measured f0 | anchor claimed |
|---|---|---|
| loop_0 | 42.9 Hz | 1050 rpm |
| loop_1 | 60.0 Hz | 2400 rpm |
| loop_2 | 64.7 Hz | 4200 rpm |
| loop_3 | 69.9 Hz | 6400 rpm |

The loops span **1.63×** in pitch. The anchors claimed they spanned **6.1×**.

With `playbackRate = rpm/anchor`, the pitch you actually heard was
`f_measured * rpm/anchor` — which rises ~2.3× inside a band and then falls
~38% the instant the crossfade moves to the next loop. Three times over the
rev range:

```
rpm    heard pitch (old)
1600   56.3 Hz
1850   56.7 Hz
2100   56.4 Hz   <- flat through the entire useful driving range
2600   64.2 Hz
3100   67.7 Hz
3350   66.3 Hz   <- and now falling
3850   62.6 Hz
4100   63.5 Hz
```

Net span idle→redline: **2.33×, non-monotonic, with six backward jumps.** The
true firing frequency spans 8.71×. And because the two loops crossfading
inside a band were up to **1.63× apart in pitch** — a musical fifth — the
equal-power crossfade was blending two dissonant voices rather than morphing
one timbre into another. That's the muddy beating quality on top of the
missing rev sweep.

### The fix

`playbackRate` is now derived from each loop's **measured** fundamental
against the engine's **true firing frequency** (`base2 = rpm * cyl / 120`):

```ts
playbackRate[i] = clamp(base2 / LOOP_F0[i], RATE_MIN, RATE_MAX)
```

All four loops therefore sound in unison at the correct pitch at every rpm.
`RPM_ANCHORS` survives but is now purely a **texture** schedule — which loop
is playing no longer changes what note you hear, only its character, which is
what the original comment always claimed the design did.

Result: pitch tracks rpm exactly, **8.71× span, zero backward jumps**, worst
crossfade dissonance 1.06× (was 1.63×; 1.00 is unison).

### The unavoidable concession

The engine needs 850→7400rpm (8.7×) and these recordings span 1.63×, so the
top of the rev range genuinely cannot be covered by stretching them — at
redline loop_3 would need to play at 3.5×, which reads as a chipmunk. So:

- `LADDER_STRETCH = 2.8` sets where the recordings stop reading as an engine.
  Past it (`~5900rpm` on a four, lower on a six — a six fires 1.5× more often
  at the same rpm and these are four-cylinder recordings) the synth tonal
  body fades up and takes the top end, where it is generated at exactly the
  right frequency and has no range limit. The ladder fades back to texture
  underneath rather than stacking a chipmunked copy on top.
- `RATE_MAX = 3.6` is a separate, looser *sanity* clamp. Pitch must keep
  tracking to redline even at low level: a loop pinned at a fixed rate becomes
  a drone sitting a third under a synth voice that is still climbing, and two
  engine voices at different pitches beat against each other.
- `SYNTH_FLOOR = 0.2` keeps a correctly-pitched fundamental under the
  recordings at *all* rpm. Sampled mode previously muted the oscillator path
  outright (`driveTrim -> 0`) and handed the whole engine to four recordings
  that could not carry a rev sweep.

**If you ever replace the loops**, re-measure their fundamentals and update
`LOOP_F0`; that is the only number that has to be right. Better source
material — an actual ladder spanning 3–4× in pitch — would let
`LADDER_STRETCH` go up and the synth takeover move toward the redline or
disappear.

## What is deliberately unchanged

- Handling. `rpmDrive` keeps the torque path bit-identical.
- Tyre, wind, road-rumble, transmission-whine and traffic layers.
- The `ENGINE_TUNE_DEFAULT` loudness/rumble stage from 085e9b1 — that work is
  fine, it was just amplifying a broken signal.

## What to listen for

1. **Standing start, floor it.** The note should climb to ~2450rpm and *hold*
   while the car catches up, then keep rising. No idle wobble, no idle bed.
2. **Full-throttle run through the gears.** Pitch should sweep up, then sweep
   *down across* each shift over about a quarter second — not snap.
3. **Lift off at speed.** A brief hang, then a slow fall. No cliff, and only
   one upshift.
4. **Redline.** Should get sharper and harder as the synth takes over, not
   thinner.
