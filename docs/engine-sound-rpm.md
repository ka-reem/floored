# Why the engine didn't sound like it was revving

Written 2026-08-21, alongside the change that fixed it. Read this before
retuning `ENGINE_TUNE_DEFAULT`, `ladderAnchors()`, `LOOP_F0`, or anything in
`stepEngineSpeed()`.

Causes 1 and 2 are the original write-up. **Cause 3 was added later the same
day**, after a second report — *"it sounds like an ugly motorcycle"* — and it
is the one that replaced the sample set. If you are here because the engine
sounds like the wrong size of engine, start there.

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

### The unavoidable concession — and how it was removed

*This section described the state of things before 2026-08-21. It is kept
because the reasoning still explains what the constants are for; the numbers
in it are superseded by "Cause 3" below.*

The engine needs 850→7400rpm (8.7×) and those recordings spanned 1.63×, so the
top of the rev range genuinely could not be covered by stretching them — at
redline loop_3 would need to play at 3.5×, which reads as a chipmunk. So:

- `LADDER_STRETCH` sets where the recordings stop reading as an engine. Past
  it the synth tonal body fades up and takes the top end, where it is
  generated at exactly the right frequency and has no range limit. The ladder
  fades back to texture underneath rather than stacking a chipmunked copy on
  top.
- `RATE_MAX` is a separate, looser *sanity* clamp. Pitch must keep tracking to
  redline even at low level: a loop pinned at a fixed rate becomes a drone
  sitting a third under a synth voice that is still climbing, and two engine
  voices at different pitches beat against each other.
- `SYNTH_FLOOR = 0.2` keeps a correctly-pitched fundamental under the
  recordings at *all* rpm. Sampled mode previously muted the oscillator path
  outright (`driveTrim -> 0`) and handed the whole engine to four recordings
  that could not carry a rev sweep.

**If you ever replace the loops**, re-measure their fundamentals and update
`LOOP_F0`; that is the only number that has to be right.

## Cause 3 — the loops were one recording, pitch-shifted four ways

Fixing the pitch model (above) left a second complaint standing: *"it sounds
like an ugly motorcycle."* That one was not a bug in the code. It was the
source material, and no amount of retuning could have fixed it.

The four loops came from OpenGameArt's "racing car engine sound loops" by
domasx2. That page says, in the author's own words, that the files were made
by "cutting out a piece from" one public-domain recording, "editing to loop
semi-smoothly and adjusting pitch", and that the **"difference between the
files is pitch only."** They were never four rpm points. They were one sound
at four pitches — which is exactly why they measured 42.9/60.0/64.7/69.9Hz, a
span of 1.63×, against the 8.7× the engine needs.

Resampling moves **formants**, not just pitch. Every resonance of the recorded
car — airbox, bore, exhaust length, the cabin around the microphone — scales
with the playback rate. Play a car up 2× and you do not hear that car revving
higher; you hear a physically smaller engine. So the old set was wrong at both
ends at once:

| rpm | dominant loop | playback rate | what it sounds like |
|---|---|---|---|
| 850 (idle) | loop_0 | **0.66×** | formants down a third — a bus |
| 2500 | loop_1 | 1.39× | passable |
| 4000 | loop_2 | **2.06×** | formants up an octave — a motorbike |
| 6000+ | loop_3 | 2.40× (clamped) | ladder faded out, synth carrying |

4000rpm is the middle of the driving range, and there the *dominant* loop was
at 2.06×. That is the report.

### The fix: one real recording, five rungs

Replaced with five loops cut from a **single continuous 55-second take** —
freesound 141459 by escortmarius, CC0, a 1985 Ford Escort Mk3 accelerating
away from a traffic light with the microphone inside the cabin. One car, one
microphone, one road, so the formants are identical from rung to rung and the
only thing the crossfade changes is engine speed. (An ordinary saloon, and an
in-cabin mic, both on purpose: the game is played from the dashcam POV.)

| loop | f0 | rpm on a four | cut from |
|---|---|---|---|
| loop_0 | 25.38 Hz | 761 | idle at the lights |
| loop_1 | 57.74 Hz | 1732 | steady cruise, t≈50s |
| loop_2 | 67.74 Hz | 2032 | steady pull, t≈41s |
| loop_3 | 80.83 Hz | 2425 | mid pull, t≈21s |
| loop_4 | 99.70 Hz | 2991 | top of a pull, t≈25s |

Span **3.93×**, against 1.63×. Resulting playback rates:

| rpm | 850 | 1200 | 2000 | 3000 | 4000 | 5000 |
|---|---|---|---|---|---|---|
| old | 0.66× | 0.93× | 1.55× | 1.67× | **2.06×** | 2.40× |
| new | **1.12×** | 1.58×/0.69× | 0.98× | **1.00×** | **1.34×** | 1.67× |

**`LOOP_F0` is now exact, not estimated.** Each loop is cut as a whole number
of engine cycles, so its length *is* its pitch — looping *n* samples makes the
result periodic at `rate/n` whatever was recorded in it, and a four fires four
times per cycle, so `f0 = 4 * cycles * 44100 / samples`. Every value was
cross-checked against the written file's spectrum and agrees within 1.2%.

Measuring them was the hard part. In a cabin recording made on a phone — whose
microphone rolls off hard below ~100Hz — the **fourth engine order is the
loudest thing in the spectrum**, 10–20× the firing fundamental, and a
four-stroke additionally puts real energy on the crank-rev component at half
the firing rate. Generic pitch detectors pick the octave wrong in both
directions; autocorrelation and harmonic-sum detectors disagreed with each
other by factors of 2 and 3 on the same window. The octave was pinned by
physical argument instead: the idle section can only be ~750rpm, and the drops
between pulls can only be gear-ratio steps. Both agree the dominant peak is
consistently 2× the firing frequency.

### Constants that moved, and why

- **`RPM_ANCHORS` is gone**, replaced by `ladderAnchors(cyl)` =
  `LOOP_F0[i] * 120 / cyl`. A loop should be dominant exactly where it plays
  at 1.0×, and that rpm is a *property* of the loop and the engine's cylinder
  count, not a number to pick. The old hardcoded `[1050, 2400, 4200, 6400]`
  could only ever be right for one cylinder count and was right for none.
- **`LADDER_STRETCH` 2.0 → 1.9.** Looks like a cut, is a large increase: it
  multiplies the *top* loop, which went 69.9 → 99.7Hz. The ladder's ceiling
  moves 4194 → 5683rpm on a four and the synth handover moves from beginning
  at 3271rpm to beginning at 4433. The recordings carry ~1500rpm more of the
  range, at 1.48× stretch where they used to be at 2.16× by 4200rpm.
- **`RATE_MAX` 2.4 → 2.6.** It was cut to 2.4 on the motorbike complaint,
  which was the right diagnosis of the wrong constant. It can go back to being
  a sanity stop; on a four it first binds at 7800rpm, above every redline in
  `PROFILES`.
- **The crossfade is now positioned in log rpm.** The rungs are spaced
  geometrically, and what the ear tracks is the *ratio* to each loop's home
  pitch. Linear positioning held the lower loop in the mix past the point
  where it was the worse-matched of the two.
- **`SYNTH_FLOOR` deliberately unchanged at 0.2.** The argument that put it
  there is weaker now, but it is also filling in the fundamental the phone mic
  barely captured, and that job remains.

### The honest limitation

There is one hole in the ladder, between loop_0 and loop_1: 25.4 → 57.7Hz, a
**2.27× gap covering 761–1732rpm**. The recording goes from idle straight into
a launch with nothing steady in between, and no rung was invented to fill it —
a pitch-shifted one would be precisely the thing this change exists to remove.
Around 1000–1500rpm the two neighbours are therefore stretched to about 1.6×
and 0.7×. That is worse than the rest of the new ladder and better than the
old set managed at idle, and it is in the part of the range the car passes
through quickly and at low load, with the idle bed mixed in over it.

Closing it needs a CC0 or CC-BY in-cabin recording of an ordinary car holding
~1000–1500rpm. A sweep through the whole range from one car — a dyno pull, or
any recording where the engine is not buried under road noise above 50mph —
would be better still and would let `LADDER_STRETCH` rise further.

Also unverified: **nobody has listened to this.** The measurements say the
formants now stay put through the driving range. Whether it sounds like the
"toned down, regular car" that was asked for is an ear judgement that has not
been made.

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

For the sample replacement (Cause 3) specifically:

5. **Idle, in gear, stationary.** Should sound like a car idling, not like a
   bus. The old set played its lowest loop at 0.66× here.
6. **Steady 2500–3500rpm.** This is where the new loops play at 1.00× and
   should sound most obviously like a real car recorded from inside one.
7. **Hold 1000–1500rpm.** The known weak spot — the gap between loop_0 and
   loop_1. If anything still sounds the wrong size, it will be here.
8. **Listen for a tick once per loop.** Measured seam discontinuity is
   0.79–1.08× the loops' own interior (the loops it replaced were up to
   2.12×, i.e. they audibly ticked), but ears beat metrics.
