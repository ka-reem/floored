/* Synthesised audio. The engine is a layered model rather than a couple of
   oscillators: three detuned band-limited pulse trains at the crank half-order
   (so the wave's 2nd partial lands on the firing frequency and the odd partials
   give the lumpy half-order rumble), pushed through a load-dependent waveshaper
   for growl, blended with intake and exhaust noise beds, then shaped by a
   throttle-opening lowpass and two fixed body resonances. On top of that:
   idle wobble, overrun crackle, a rev-limiter stutter LFO, shift chuffs and a
   gearbox whine.

   Tires are a second layered model, driven by an exponentially-smoothed
   slip envelope (see slipEnv in update()) rather than raw per-frame slip, so
   ABS/ESC pulsing at the tyre reads as sustained sliding rather than a
   chattering on/off screech. Three noise layers crossfade continuously with
   that envelope: a subtle speed-only rolling/contact-patch hum, a narrowband
   "singing" squeal that rises in pitch with slip, and a broadband,
   amplitude-modulated full screech for hard sustained sliding. A separate
   one-shot bark (reusing the crackle burst()) fires on sudden slip spikes —
   launch wheelspin, a harsh downshift, clipping the edge of the friction
   circle — independent of the sustained layers. Rain quiets the screech and
   shifts it broader/brighter (hissier) without changing pitch behaviour.
   Wind, road rumble, transmission whine and overrun burble are a fourth
   layer group, all tied to speed/load rather than rpm alone:
   wind is lowpassed noise whose cutoff and level open with speed (plus a
   slow two-LFO "flutter" depth so it doesn't sit dead-static), becoming the
   dominant sound at high speed the way a real cockpit does above ~140 km/h;
   road rumble is a separate, lower (~55-125Hz) noise bed tied to speed that
   reads as tyres-on-concrete rather than wind, and ducks slightly under the
   tyre screech layer so the two don't stack into mud; gearbox whine now
   tracks vehicle speed (i.e. output-shaft speed, which — for a fixed final
   drive — is the same at a given road speed no matter which gear is
   selected) rather than rpm, and is boosted on overrun/lift-off and damped
   under load, the classic sim-modder cue; overrun burble/backfire fires a
   short rate-limited volley of filtered bursts (reusing burst()) on a sudden
   throttle lift at high rpm, sharper single pops on sportier profiles
   (kaze/okami) and only a rare soft thump on the sedan/kei. Horn/crash duck
   and rain hiss are unchanged from before.

   The whole graph is built once in init(); update() only moves AudioParams. */

/** Per-car engine character. Chosen by setCar(); "generic" is the fallback. */
export interface EngineProfile {
  /** Cylinder count — sets firing frequency = rpm/60 * cyl/2. */
  cyl: number;
  /** 0..1 amount of half-order (odd partial) content: uneven, lumpy firing. */
  odd: number;
  /** Harmonic rolloff exponent; lower = brighter, harsher. */
  bright: number;
  /** Turbo spool whistle level. */
  turbo: number;
  /** Overall engine loudness trim. */
  level: number;
  revLimit: number;
  /** 0..1 overrun burble/backfire character: how often and how sharply it
      pops on a sudden high-rpm throttle lift. Low = rare soft thump. */
  burble: number;
}

const PROFILES: Record<string, EngineProfile> = {
  // Turbo straight-six coupe: smooth firing, strong spool.
  kaze: { cyl: 6, odd: 0.16, bright: 0.95, turbo: 1.0, level: 1.0, revLimit: 7400, burble: 0.85 },
  // Executive sedan: even, refined, muted.
  shirayuki: { cyl: 6, odd: 0.1, bright: 1.25, turbo: 0.15, level: 0.82, revLimit: 6700, burble: 0.08 },
  // 660cc kei triple: buzzy, uneven, screams at the top.
  tanuki: { cyl: 3, odd: 0.55, bright: 0.75, turbo: 0.35, level: 0.95, revLimit: 8000, burble: 0.2 },
  // AWD boxer four: the classic unequal-length-header warble.
  okami: { cyl: 4, odd: 0.62, bright: 0.9, turbo: 0.5, level: 1.0, revLimit: 6900, burble: 0.9 },
  generic: { cyl: 4, odd: 0.3, bright: 1.0, turbo: 0.4, level: 0.95, revLimit: 7200, burble: 0.4 },
};

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

export class GameAudio {
  ok = false;
  private ctx!: AudioContext;
  private master!: GainNode;
  private noiseBuf!: AudioBuffer;

  /* engine */
  private prof: EngineProfile = PROFILES.generic;
  private oscs: OscillatorNode[] = [];
  private oscGains: GainNode[] = [];
  private wobbleDepth!: GainNode;
  private drivePre!: GainNode;
  private driveTrim!: GainNode;
  private engLP!: BiquadFilterNode;
  private engG!: GainNode;
  private limDepth!: GainNode;
  private inF!: BiquadFilterNode; private inG!: GainNode;
  private exF!: BiquadFilterNode; private exG!: GainNode;
  private turboOsc!: OscillatorNode; private turboG!: GainNode;
  private whineOsc!: OscillatorNode; private whineG!: GainNode;
  private engBus!: GainNode;
  private crackleBus!: GainNode;
  private prevCut = false;
  private prevGear = 1;
  private lastCrackle = 0;
  private peakRpm = 6800;
  private prevThr = 0;
  private lastBurbleTrigger = -10;
  private burbleCount = 0;
  private burbleNext = 0;

  /* tires */
  private tireRoadF!: BiquadFilterNode; private tireRoadG!: GainNode;
  private singF!: BiquadFilterNode; private singG!: GainNode; private singLfoDepth!: GainNode;
  private screechF!: BiquadFilterNode; private screechG!: GainNode; private screechAmDepth!: GainNode;
  private slipEnv = 0;
  private lastTireT = 0;
  private prevSlipRaw = 0;
  private lastChirp = -1;

  /* environment */
  private wF!: BiquadFilterNode; private wG!: GainNode;
  private windFlutterDepth!: GainNode;
  private roadRumbleF!: BiquadFilterNode; private roadRumbleG!: GainNode;
  private rF!: BiquadFilterNode; private rG!: GainNode;
  private hornOsc: { o1: OscillatorNode; o2: OscillatorNode; g: GainNode } | null = null;
  private crashGain: GainNode | null = null;
  vol = 1;
  duck = 1;

  private noiseNode() {
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuf;
    n.loop = true;
    n.start();
    return n;
  }

  /** Band-limited pulse train at the crank half-order. Partial k sits at
      k * rpm*cyl/240 Hz, so k=2 is the firing frequency and the odd partials
      are the half-orders that make an engine sound lumpy rather than buzzy. */
  private engineWave(p: EngineProfile) {
    const N = 28;
    const re = new Float32Array(N + 1), im = new Float32Array(N + 1);
    for (let k = 1; k <= N; k++) {
      const order = k / 2;
      const even = k % 2 === 0;
      const a = (even ? 1 : p.odd) / Math.pow(order, p.bright);
      // alternate the phase a little so the partials don't all peak together
      im[k] = a * Math.cos(k * 1.7);
      re[k] = a * Math.sin(k * 1.7) * 0.5;
    }
    return this.ctx.createPeriodicWave(re, im, { disableNormalization: false });
  }

  /** Soft tanh saturation — the growl when the throttle is open. */
  private shaperCurve() {
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(2.6 * x) / Math.tanh(2.6);
    }
    return c;
  }

  /** Pick the per-car engine character. Safe to call before or after init(). */
  setCar(id: string) {
    const p = PROFILES[id] || PROFILES.generic;
    if (p === this.prof) return;
    this.prof = p;
    this.peakRpm = p.revLimit;
    if (!this.ok) return;
    const w = this.engineWave(p);
    for (const o of this.oscs) o.setPeriodicWave(w);
  }

  init() {
    if (this.ok) return;
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(ctx.destination);
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;

      /* ---- engine ---- */
      this.engBus = ctx.createGain();
      const wave = this.engineWave(this.prof);
      // Detunes are cents; the beating between them reads as cylinder-to-
      // cylinder variation rather than as a chorus effect.
      const spread = [0, -8, 11];
      const lvl = [0.5, 0.3, 0.26];
      this.wobbleDepth = ctx.createGain();
      this.wobbleDepth.gain.value = 0;
      const lfoA = ctx.createOscillator(); lfoA.type = "sine"; lfoA.frequency.value = 5.7;
      const lfoB = ctx.createOscillator(); lfoB.type = "sine"; lfoB.frequency.value = 1.31;
      const lfoMix = ctx.createGain();
      const lfoBTrim = ctx.createGain(); lfoBTrim.gain.value = 0.6;
      lfoA.connect(lfoMix);
      lfoB.connect(lfoBTrim).connect(lfoMix);
      lfoMix.connect(this.wobbleDepth);
      lfoA.start(); lfoB.start();
      for (let i = 0; i < 3; i++) {
        const o = ctx.createOscillator();
        o.setPeriodicWave(wave);
        o.detune.value = spread[i];
        const g = ctx.createGain();
        g.gain.value = lvl[i];
        o.connect(g).connect(this.engBus);
        this.wobbleDepth.connect(o.detune);
        o.start();
        this.oscs.push(o);
        this.oscGains.push(g);
      }
      this.drivePre = ctx.createGain();
      this.drivePre.gain.value = 1;
      const shaper = ctx.createWaveShaper();
      shaper.curve = this.shaperCurve();
      shaper.oversample = "2x";
      this.driveTrim = ctx.createGain();
      this.driveTrim.gain.value = 1;
      this.engBus.connect(this.drivePre).connect(shaper).connect(this.driveTrim);

      // intake roar (bandpassed, rises with throttle) and exhaust body
      this.inF = ctx.createBiquadFilter();
      this.inF.type = "bandpass";
      this.inF.frequency.value = 1400;
      this.inF.Q.value = 0.7;
      this.inG = ctx.createGain();
      this.inG.gain.value = 0;
      this.noiseNode().connect(this.inF).connect(this.inG);
      this.exF = ctx.createBiquadFilter();
      this.exF.type = "lowpass";
      this.exF.frequency.value = 400;
      this.exF.Q.value = 1.1;
      this.exG = ctx.createGain();
      this.exG.gain.value = 0;
      this.noiseNode().connect(this.exF).connect(this.exG);

      // shared tone shaping: airbox lowpass + two fixed body resonances
      this.engLP = ctx.createBiquadFilter();
      this.engLP.type = "lowpass";
      this.engLP.frequency.value = 900;
      this.engLP.Q.value = 0.9;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 48;
      const body1 = ctx.createBiquadFilter();
      body1.type = "peaking";
      body1.frequency.value = 165;
      body1.Q.value = 1.1;
      body1.gain.value = 6;
      const body2 = ctx.createBiquadFilter();
      body2.type = "peaking";
      body2.frequency.value = 720;
      body2.Q.value = 1.4;
      body2.gain.value = 4;
      this.engG = ctx.createGain();
      this.engG.gain.value = 0;
      this.driveTrim.connect(this.engLP);
      this.inG.connect(this.engLP);
      this.exG.connect(this.engLP);
      this.engLP.connect(hp).connect(body1).connect(body2).connect(this.engG);
      this.engG.connect(this.master);

      // rev-limiter stutter: a square LFO added into the engine gain param
      const limLfo = ctx.createOscillator();
      limLfo.type = "square";
      limLfo.frequency.value = 23;
      this.limDepth = ctx.createGain();
      this.limDepth.gain.value = 0;
      limLfo.connect(this.limDepth).connect(this.engG.gain);
      limLfo.start();

      // one-shot bus for crackles / shift chuffs / limiter bangs
      this.crackleBus = ctx.createGain();
      this.crackleBus.gain.value = 1;
      this.crackleBus.connect(this.master);

      // turbo spool
      this.turboOsc = ctx.createOscillator();
      this.turboOsc.type = "sine";
      this.turboOsc.frequency.value = 3000;
      this.turboG = ctx.createGain();
      this.turboG.gain.value = 0;
      this.turboOsc.connect(this.turboG).connect(this.master);
      this.turboOsc.start();

      // gearbox whine (reverse and 1st)
      this.whineOsc = ctx.createOscillator();
      this.whineOsc.type = "sawtooth";
      this.whineOsc.frequency.value = 600;
      const whineF = ctx.createBiquadFilter();
      whineF.type = "bandpass";
      whineF.frequency.value = 1800;
      whineF.Q.value = 3;
      this.whineG = ctx.createGain();
      this.whineG.gain.value = 0;
      this.whineOsc.connect(this.whineG).connect(whineF).connect(this.master);
      this.whineOsc.start();

      /* ---- tires ---- */
      // Layer 1: rolling contact-patch hum. Subtle, purely speed-driven, no
      // slip dependence — this is what tires sound like even when gripping.
      this.tireRoadF = ctx.createBiquadFilter();
      this.tireRoadF.type = "bandpass";
      this.tireRoadF.frequency.value = 220;
      this.tireRoadF.Q.value = 0.6;
      this.tireRoadG = ctx.createGain();
      this.tireRoadG.gain.value = 0;
      this.noiseNode().connect(this.tireRoadF).connect(this.tireRoadG).connect(this.master);

      // Layer 2: grip "singing" — narrowband squeal, pitch rises with slip.
      // A little chaotic vibrato keeps it from sounding like a pure test tone.
      this.singF = ctx.createBiquadFilter();
      this.singF.type = "bandpass";
      this.singF.frequency.value = 1400;
      this.singF.Q.value = 10;
      this.singG = ctx.createGain();
      this.singG.gain.value = 0;
      this.noiseNode().connect(this.singF).connect(this.singG).connect(this.master);
      const singLfo = ctx.createOscillator();
      singLfo.type = "sine";
      singLfo.frequency.value = 5.3;
      this.singLfoDepth = ctx.createGain();
      this.singLfoDepth.gain.value = 0;
      singLfo.connect(this.singLfoDepth).connect(this.singF.frequency);
      singLfo.start();

      // Layer 3: full screech — broadband noise, amplitude-modulated by two
      // detuned LFOs (same beating trick as the engine wobble) for a chaotic,
      // never-quite-periodic edge instead of a clean tremolo.
      this.screechF = ctx.createBiquadFilter();
      this.screechF.type = "bandpass";
      this.screechF.frequency.value = 1100;
      this.screechF.Q.value = 1.8;
      this.screechG = ctx.createGain();
      this.screechG.gain.value = 0;
      this.noiseNode().connect(this.screechF).connect(this.screechG).connect(this.master);
      const amA = ctx.createOscillator(); amA.type = "sine"; amA.frequency.value = 6.5;
      const amB = ctx.createOscillator(); amB.type = "sine"; amB.frequency.value = 11.3;
      const amMix = ctx.createGain();
      const amBTrim = ctx.createGain(); amBTrim.gain.value = 0.6;
      amA.connect(amMix);
      amB.connect(amBTrim).connect(amMix);
      this.screechAmDepth = ctx.createGain();
      this.screechAmDepth.gain.value = 0;
      amMix.connect(this.screechAmDepth).connect(this.screechG.gain);
      amA.start(); amB.start();

      /* ---- environment ---- */
      // Wind roar: lowpassed noise whose cutoff and level open with speed,
      // becoming the dominant sound at high speed. A slow two-LFO "flutter"
      // is summed additively into the gain param (same trick as limDepth on
      // engG.gain) so the roar breathes with a bit of turbulence instead of
      // sitting dead-static.
      this.wF = ctx.createBiquadFilter();
      this.wF.type = "lowpass";
      this.wF.frequency.value = 350;
      this.wG = ctx.createGain();
      this.wG.gain.value = 0;
      this.noiseNode().connect(this.wF).connect(this.wG).connect(this.master);
      const windFlutA = ctx.createOscillator(); windFlutA.type = "sine"; windFlutA.frequency.value = 0.6;
      const windFlutB = ctx.createOscillator(); windFlutB.type = "sine"; windFlutB.frequency.value = 1.7;
      const windFlutMix = ctx.createGain();
      const windFlutBTrim = ctx.createGain(); windFlutBTrim.gain.value = 0.55;
      windFlutA.connect(windFlutMix);
      windFlutB.connect(windFlutBTrim).connect(windFlutMix);
      this.windFlutterDepth = ctx.createGain();
      this.windFlutterDepth.gain.value = 0;
      windFlutMix.connect(this.windFlutterDepth).connect(this.wG.gain);
      windFlutA.start(); windFlutB.start();

      // Road texture bed: low (~55-125Hz) rumble tied to speed, distinct
      // from the (higher, broadband) wind and from the tyre contact-patch
      // hum — this is the tyres-on-concrete layer. Ducked slightly under the
      // tyre screech so the two don't stack into mud (see update()).
      this.roadRumbleF = ctx.createBiquadFilter();
      this.roadRumbleF.type = "lowpass";
      this.roadRumbleF.frequency.value = 90;
      this.roadRumbleF.Q.value = 0.7;
      this.roadRumbleG = ctx.createGain();
      this.roadRumbleG.gain.value = 0;
      this.noiseNode().connect(this.roadRumbleF).connect(this.roadRumbleG).connect(this.master);

      this.rF = ctx.createBiquadFilter();
      this.rF.type = "highpass";
      this.rF.frequency.value = 2600;
      this.rG = ctx.createGain();
      this.rG.gain.value = 0;
      this.noiseNode().connect(this.rF).connect(this.rG).connect(this.master);
      this.ok = true;
    } catch {
      this.ok = false;
    }
  }

  /** Smoothed param write — per-frame .value writes zipper badly on filters. */
  private sp(p: AudioParam, v: number, tau = 0.03) {
    p.setTargetAtTime(v, this.ctx.currentTime, tau);
  }

  /** Short filtered noise burst: exhaust crackle, shift chuff, limiter bang. */
  private burst(level: number, freq: number, decay: number, q = 1.2) {
    const c = this.ctx, t = c.currentTime;
    const n = Math.max(64, Math.floor(c.sampleRate * decay * 3));
    const buf = c.createBuffer(1, n, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++)
      d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (c.sampleRate * decay));
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = freq;
    f.Q.value = q;
    const g = c.createGain();
    g.gain.value = level;
    src.connect(f).connect(g).connect(this.crackleBus);
    src.start(t);
    src.stop(t + decay * 3 + 0.02);
  }

  tick() {
    if (!this.ok) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = "square";
    o.frequency.value = 1650;
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.035);
  }

  crash(intensity: number) {
    if (!this.ok) return;
    const c = this.ctx, t = c.currentTime;
    if (this.crashGain) return; // avoid stacking
    const buf = c.createBuffer(1, c.sampleRate * 0.4, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++)
      d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (c.sampleRate * 0.07));
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 1400;
    const g = c.createGain();
    g.gain.value = Math.min(0.5, 0.1 + intensity * 0.05);
    src.connect(f).connect(g).connect(this.master);
    this.crashGain = g;
    src.start(t);
    src.stop(t + 0.4);
    src.onended = () => {
      this.crashGain = null;
    };
  }

  hornSet(on: boolean) {
    if (!this.ok) return;
    const c = this.ctx;
    if (on && !this.hornOsc) {
      const o1 = c.createOscillator(), o2 = c.createOscillator(), g = c.createGain();
      o1.type = "square";
      o2.type = "square";
      o1.frequency.value = 420;
      o2.frequency.value = 530;
      g.gain.value = 0.06;
      o1.connect(g);
      o2.connect(g);
      g.connect(this.master);
      o1.start();
      o2.start();
      this.hornOsc = { o1, o2, g };
    } else if (!on && this.hornOsc) {
      this.hornOsc.o1.stop();
      this.hornOsc.o2.stop();
      this.hornOsc = null;
    }
  }

  setLevels(vol: number, duck: number) {
    this.vol = vol;
    this.duck = duck;
    if (this.ok) this.master.gain.value = 0.9 * vol * duck;
  }

  /** Silence latched sources (horn, screech, engine) — used when pausing. */
  quiesce() {
    if (!this.ok) return;
    this.hornSet(false);
    this.tireRoadG.gain.value = 0;
    this.singG.gain.value = 0;
    this.screechG.gain.value = 0;
    this.screechAmDepth.gain.value = 0;
    this.wG.gain.value = 0;
    this.windFlutterDepth.gain.value = 0;
    this.roadRumbleG.gain.value = 0;
    this.inG.gain.value = 0;
    this.exG.gain.value = 0;
    this.turboG.gain.value = 0;
    this.whineG.gain.value = 0;
    this.limDepth.gain.value = 0;
    this.engG.gain.cancelScheduledValues(this.ctx.currentTime);
    this.engG.gain.value = 0;
  }

  dispose() {
    if (!this.ok) return;
    this.hornSet(false);
    try {
      this.ctx.close();
    } catch {}
    this.ok = false;
  }

  /**
   * @param cut    true while the ECU is cutting fuel (shift or traction cut)
   * @param gear   optional: 1..top, -1 reverse. Drives the gearbox whine.
   * @param onLimiter optional: physics rev-limiter flag; without it the
   *                  limiter is inferred from rpm against the observed peak.
   */
  update(
    rpm: number, thr: number, slip: number, speed: number, now: number,
    cut: boolean, raining: boolean, horn: boolean,
    gear?: number, onLimiter?: boolean
  ) {
    if (!this.ok) return;
    const p = this.prof;
    // Track the highest rpm seen so redline-relative shaping still works when
    // setCar() was never called for this car.
    if (rpm > this.peakRpm) this.peakRpm = rpm;
    const redline = Math.max(p.revLimit, this.peakRpm);
    const rn = clamp01((rpm - 800) / (redline - 800));
    const lim = onLimiter ?? rpm > redline * 0.985;

    /* Firing frequency = rpm/60 * cyl/2. The oscillators run at half that,
       because partial 2 of the wave is the firing order. */
    const base = (rpm * p.cyl) / 240;
    for (const o of this.oscs) this.sp(o.frequency, base, 0.018);

    // Idle wobble: the uneven, hunting quality of an engine at rest.
    const idleness = clamp01(1 - (rpm - 850) / 1100) * (1 - thr * 0.8);
    this.sp(this.wobbleDepth.gain, 6 + idleness * 26, 0.08);

    /* Load model. Overrun (closed throttle, still spinning) is quieter and
       darker; on throttle the waveshaper drive comes up for growl. */
    const overrun = thr < 0.06 && rn > 0.25 ? clamp01((rn - 0.25) * 2.5) : 0;
    const load = 0.18 + thr * 0.82;
    const cutMul = cut ? 0.3 : 1;

    this.sp(this.drivePre.gain, 0.9 + load * 2.6 + (lim ? 1.4 : 0), 0.04);
    this.sp(this.driveTrim.gain, 1 / (0.9 + load * 1.2), 0.04);

    const bodyLevel =
      (0.055 + thr * 0.075 + rn * 0.05) *
      (1 - overrun * 0.45) * cutMul * p.level * (lim ? 0.62 : 1);
    this.sp(this.engG.gain, bodyLevel, 0.02);
    this.sp(this.limDepth.gain, lim ? -bodyLevel * 0.85 : 0, 0.005);

    // Airbox / cabin lowpass: opens with throttle and revs, closes on overrun.
    this.sp(
      this.engLP.frequency,
      Math.min(9000, 380 + rpm * 0.42 + thr * 2600 - overrun * 900),
      0.03
    );

    // Intake sits above the tone; exhaust noise fattens the bottom.
    this.sp(this.inF.frequency, 900 + rn * 2700, 0.04);
    this.sp(this.inG.gain, thr * (0.012 + rn * 0.05), 0.04);
    this.sp(this.exF.frequency, 220 + rn * 900, 0.04);
    this.sp(this.exG.gain, (0.008 + load * 0.03) * (0.3 + rn), 0.04);

    // Turbo spool follows boost, i.e. throttle held at revs.
    this.sp(this.turboOsc.frequency, 2200 + rn * 4400, 0.08);
    this.sp(this.turboG.gain, p.turbo * thr * rn * rn * 0.01, 0.12);

    // Gearbox whine: constant-mesh gears spin at output-shaft speed, which
    // for a fixed final drive is set by road speed alone — the same at a
    // given speed no matter which gear is selected — so pitch tracks speed,
    // not rpm/gear. Level is quiet under load (loaded gear teeth are damped
    // by torque) and boosted on overrun/lift-off, the classic immersion cue;
    // reverse/1st still carry a bit more base whine (shorter, whinier gearsets).
    const g = gear ?? 2;
    const whineBase = g < 0 ? 0.026 : g === 1 ? 0.013 : 0.009;
    const whineLoad = 1 - thr * 0.65;
    const whineOverrun = 1 + overrun * 2.4;
    const whineSpeedGate = clamp01(speed / 3);
    this.sp(this.whineOsc.frequency, 260 + Math.min(1, speed / 55) * 1900, 0.04);
    this.sp(this.whineG.gain, whineBase * whineLoad * whineOverrun * whineSpeedGate, 0.06);

    /* Transients. A shift is the rising edge of the fuel cut: a gain dip (via
       cutMul above) plus a chuff out of the pipe. Reverse/1st engagement gets
       a softer clunk. */
    if (cut && !this.prevCut) this.burst(0.05 + thr * 0.06, 520 + rn * 700, 0.035, 0.8);
    this.prevCut = cut;
    if (gear !== undefined && gear !== this.prevGear) {
      if (gear < 0 || this.prevGear < 0) this.burst(0.03, 260, 0.03, 1.5);
      this.prevGear = gear;
    }

    // Overrun crackle and limiter bangs — rate-limited one-shots.
    const minGap = lim ? 0.045 : 0.09;
    if (now - this.lastCrackle > minGap) {
      if (lim && Math.random() < 0.7) {
        this.lastCrackle = now;
        this.burst(0.05, 900 + Math.random() * 1400, 0.02, 0.7);
      } else if (overrun > 0.3 && Math.random() < 0.25 * overrun) {
        this.lastCrackle = now;
        this.burst(0.02 + Math.random() * 0.03, 1200 + Math.random() * 2200, 0.012, 1.6);
      }
    }

    /* Overrun burble/backfire: a sudden throttle lift at high rpm queues a
       short volley of 1-4 rate-limited bursts (spread across the next few
       frames, not all in one tick) — soft low thumps for a burble, or a
       sharp high-Q crack for a backfire pop. p.burble sets both how often a
       lift queues a volley at all and how many/how sharp the pops are, so
       kaze/okami crackle readily while shirayuki/tanuki stay mostly quiet. */
    const dThr = thr - this.prevThr;
    if (
      dThr < -0.35 && rn > 0.35 && now - this.lastBurbleTrigger > 0.5 &&
      Math.random() < 0.25 + p.burble * 0.75
    ) {
      this.lastBurbleTrigger = now;
      this.burbleCount = 1 + Math.round(Math.random() * (1 + p.burble * 3));
      this.burbleNext = now;
    }
    this.prevThr = thr;
    if (this.burbleCount > 0 && now >= this.burbleNext) {
      this.burbleCount--;
      this.burbleNext = now + 0.05 + Math.random() * 0.09;
      if (Math.random() < p.burble * 0.55) {
        this.burst(0.045 + p.burble * 0.05, 1300 + Math.random() * 1900, 0.013, 2.4); // sharp pop
      } else {
        this.burst(0.035 + p.burble * 0.03, 200 + Math.random() * 180, 0.05, 0.9); // soft burble
      }
    }

    /* ---- tires ----
       Smooth raw slip into an envelope with a ~140ms time constant. ABS/ESC
       modulate wheel lockup at well above that rate, so a pulsing lockup
       averages down into a moderate sustained value instead of re-triggering
       full screech every pulse; a genuinely sustained slide (mid-corner
       drift, a long ABS stop) still rides the envelope up to its true level. */
    const dt = this.lastTireT ? Math.min(0.1, Math.max(0, now - this.lastTireT)) : 0.016;
    this.lastTireT = now;
    const envK = 1 - Math.exp(-dt / 0.14);
    this.slipEnv += (clamp01(slip) - this.slipEnv) * envK;

    // Wheelspin off the line happens at near-zero car speed, so the sustained
    // layers only fade partway with speed rather than muting entirely.
    const speedGate = 0.3 + 0.7 * Math.min(1, speed / 6);
    const wetLevel = raining ? 0.55 : 1;
    const wetQ = raining ? 0.6 : 1; // lower Q = broader/hissier, not just quieter

    // Layer 1: rolling hum, speed only, gently damped while sliding hard.
    this.sp(this.tireRoadF.frequency, 150 + Math.min(1, speed / 50) * 220, 0.06);
    this.sp(
      this.tireRoadG.gain,
      Math.min(1, speed / 45) * 0.045 * (1 - this.slipEnv * 0.3) + (raining ? 0.015 : 0),
      0.06
    );

    // Layer 2: grip singing crossfades in first, and partially back out as
    // the screech takes over so the two never just sum linearly.
    const singMix =
      smoothstep(0.12, 0.45, this.slipEnv) * (1 - smoothstep(0.55, 0.92, this.slipEnv) * 0.7);
    this.sp(this.singF.frequency, 1200 + this.slipEnv * 1500, 0.05);
    this.sp(this.singF.Q, (9 + this.slipEnv * 4) * wetQ, 0.08);
    this.sp(this.singLfoDepth.gain, 15 + this.slipEnv * 40, 0.1);
    this.sp(this.singG.gain, singMix * 0.09 * speedGate * wetLevel, 0.05);

    // Layer 3: full screech, broadband and amplitude-modulated, only once
    // slip is sustained and severe.
    const screechMix = smoothstep(0.4, 0.85, this.slipEnv);
    const screechBase = screechMix * 0.15 * speedGate * wetLevel;
    this.sp(this.screechF.frequency, 900 + this.slipEnv * 500, 0.06);
    this.sp(this.screechF.Q, 2.2 * (raining ? 0.5 : 1), 0.08);
    this.sp(this.screechG.gain, screechBase, 0.04);
    this.sp(this.screechAmDepth.gain, screechBase * 0.5, 0.06);

    // Skid chirp: a short bark on a sudden slip spike out of low sustained
    // slip — launch wheelspin, a harsh downshift, clipping the grip limit —
    // rather than the sustained slide itself.
    const dSlip = slip - this.prevSlipRaw;
    if (dSlip > 0.32 && this.slipEnv < 0.35 && now - this.lastChirp > 0.15) {
      this.lastChirp = now;
      const freq = raining ? 2600 + Math.random() * 800 : 1700 + Math.random() * 900;
      const lvl = (raining ? 0.05 : 0.09) * speedGate;
      this.burst(lvl, freq, 0.045, raining ? 2.2 : 1.4);
    }
    this.prevSlipRaw = slip;

    // Road texture bed: low rumble tied to speed, distinct from wind/tyre-hum.
    // Ducked while the tyre screech layer is active so the two low-mid
    // layers don't stack into mud.
    const roadRise = Math.min(1, speed / 40);
    this.sp(this.roadRumbleF.frequency, 55 + roadRise * 70, 0.1);
    this.sp(this.roadRumbleG.gain, roadRise * 0.05 * (1 - screechMix * 0.45), 0.1);

    /* ---- environment ----
       Wind roar opens (cutoff + level) with speed and is deliberately mixed
       under the engine at low speed but past it by ~140 km/h (~39 m/s),
       matching a real cockpit where wind becomes the dominant sound well
       before the engine is at high load. The flutter depth scales with the
       wind level itself so a stationary car has a dead-still cabin. */
    const windRise = smoothstep(15, 60, speed);
    const windLevel = windRise * 0.32 + (raining ? 0.02 : 0);
    this.sp(this.wF.frequency, 300 + speed * 26, 0.15);
    this.sp(this.wG.gain, windLevel, 0.12);
    this.sp(this.windFlutterDepth.gain, windRise * 0.045, 0.15);

    this.rG.gain.value = raining ? 0.05 : 0;
    this.hornSet(horn);
  }
}
