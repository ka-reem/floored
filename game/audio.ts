/* Synthesised audio. The engine is a layered model rather than a couple of
   oscillators: three detuned band-limited pulse trains at the crank half-order
   (so the wave's 2nd partial lands on the firing frequency and the odd partials
   give the lumpy half-order rumble), pushed through a load-dependent waveshaper
   for growl, blended with intake and exhaust noise beds, then shaped by a
   throttle-opening lowpass and two fixed body resonances. On top of that:
   idle wobble, overrun crackle, a rev-limiter stutter LFO, shift chuffs and a
   gearbox whine. Everything else (tire screech, wind/road, rain, horn, crash,
   indicator ticks) is unchanged from before.

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
}

const PROFILES: Record<string, EngineProfile> = {
  // Turbo straight-six coupe: smooth firing, strong spool.
  kaze: { cyl: 6, odd: 0.16, bright: 0.95, turbo: 1.0, level: 1.0, revLimit: 7400 },
  // Executive sedan: even, refined, muted.
  shirayuki: { cyl: 6, odd: 0.1, bright: 1.25, turbo: 0.15, level: 0.82, revLimit: 6700 },
  // 660cc kei triple: buzzy, uneven, screams at the top.
  tanuki: { cyl: 3, odd: 0.55, bright: 0.75, turbo: 0.35, level: 0.95, revLimit: 8000 },
  // AWD boxer four: the classic unequal-length-header warble.
  okami: { cyl: 4, odd: 0.62, bright: 0.9, turbo: 0.5, level: 1.0, revLimit: 6900 },
  generic: { cyl: 4, odd: 0.3, bright: 1.0, turbo: 0.4, level: 0.95, revLimit: 7200 },
};

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

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

  /* environment */
  private scrF!: BiquadFilterNode; private scrG!: GainNode;
  private wF!: BiquadFilterNode; private wG!: GainNode;
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

      /* ---- environment ---- */
      this.scrF = ctx.createBiquadFilter();
      this.scrF.type = "bandpass";
      this.scrF.frequency.value = 980;
      this.scrF.Q.value = 7;
      this.scrG = ctx.createGain();
      this.scrG.gain.value = 0;
      this.noiseNode().connect(this.scrF).connect(this.scrG).connect(this.master);
      this.wF = ctx.createBiquadFilter();
      this.wF.type = "lowpass";
      this.wF.frequency.value = 350;
      this.wG = ctx.createGain();
      this.wG.gain.value = 0;
      this.noiseNode().connect(this.wF).connect(this.wG).connect(this.master);
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
    this.scrG.gain.value = 0;
    this.wG.gain.value = 0;
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

    // Gearbox whine: loud in reverse, faint in 1st, absent above that.
    const g = gear ?? 2;
    const whine = g < 0 ? 0.02 : g === 1 ? 0.006 : 0;
    this.sp(this.whineOsc.frequency, 320 + rn * 1500, 0.03);
    this.sp(this.whineG.gain, whine * (0.25 + rn), 0.06);

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

    /* ---- environment ---- */
    this.scrG.gain.value = Math.max(0, Math.min(1, slip - 0.28)) * 0.16 * Math.min(1, speed / 8);
    this.scrF.frequency.value = 880 + Math.sin(now * 23) * 140 + slip * 180;
    this.wG.gain.value = Math.min(1, speed / 58) * 0.16 + (raining ? 0.02 : 0);
    this.wF.frequency.value = 280 + speed * 16;
    this.rG.gain.value = raining ? 0.05 : 0;
    this.hornSet(horn);
  }
}
