/* Synthesised audio: layered engine (saw fundamental + octave + sub square
   through a body filter), intake hiss, tire screech, wind/road, rain bed,
   horn, indicator ticks. Ported from v2 with a master volume control. */

export class GameAudio {
  ok = false;
  private ctx!: AudioContext;
  private master!: GainNode;
  private o1!: OscillatorNode; private o2!: OscillatorNode; private o3!: OscillatorNode;
  private g1!: GainNode; private g2!: GainNode; private g3!: GainNode;
  private engF!: BiquadFilterNode; private engG!: GainNode;
  private inF!: BiquadFilterNode; private inG!: GainNode;
  private scrF!: BiquadFilterNode; private scrG!: GainNode;
  private wF!: BiquadFilterNode; private wG!: GainNode;
  private rF!: BiquadFilterNode; private rG!: GainNode;
  private hornOsc: { o1: OscillatorNode; o2: OscillatorNode; g: GainNode } | null = null;
  private crashGain: GainNode | null = null;
  vol = 1;
  duck = 1;

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
      const noiseNode = () => {
        const n = ctx.createBufferSource();
        n.buffer = buf;
        n.loop = true;
        n.start();
        return n;
      };
      this.o1 = ctx.createOscillator();
      this.o1.type = "sawtooth";
      this.o2 = ctx.createOscillator();
      this.o2.type = "sawtooth";
      this.o2.detune.value = 9;
      this.o3 = ctx.createOscillator();
      this.o3.type = "square";
      this.g1 = ctx.createGain();
      this.g2 = ctx.createGain();
      this.g3 = ctx.createGain();
      this.engF = ctx.createBiquadFilter();
      this.engF.type = "lowpass";
      this.engF.frequency.value = 900;
      this.engF.Q.value = 1.4;
      this.o1.connect(this.g1).connect(this.engF);
      this.o2.connect(this.g2).connect(this.engF);
      this.o3.connect(this.g3).connect(this.engF);
      this.engG = ctx.createGain();
      this.engG.gain.value = 0;
      this.engF.connect(this.engG).connect(this.master);
      this.o1.start();
      this.o2.start();
      this.o3.start();
      this.inF = ctx.createBiquadFilter();
      this.inF.type = "bandpass";
      this.inF.frequency.value = 1400;
      this.inF.Q.value = 0.8;
      this.inG = ctx.createGain();
      this.inG.gain.value = 0;
      noiseNode().connect(this.inF).connect(this.inG).connect(this.master);
      this.scrF = ctx.createBiquadFilter();
      this.scrF.type = "bandpass";
      this.scrF.frequency.value = 980;
      this.scrF.Q.value = 7;
      this.scrG = ctx.createGain();
      this.scrG.gain.value = 0;
      noiseNode().connect(this.scrF).connect(this.scrG).connect(this.master);
      this.wF = ctx.createBiquadFilter();
      this.wF.type = "lowpass";
      this.wF.frequency.value = 350;
      this.wG = ctx.createGain();
      this.wG.gain.value = 0;
      noiseNode().connect(this.wF).connect(this.wG).connect(this.master);
      this.rF = ctx.createBiquadFilter();
      this.rF.type = "highpass";
      this.rF.frequency.value = 2600;
      this.rG = ctx.createGain();
      this.rG.gain.value = 0;
      noiseNode().connect(this.rF).connect(this.rG).connect(this.master);
      this.ok = true;
    } catch {
      this.ok = false;
    }
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
    this.inG.gain.value = 0;
    this.g1.gain.value = 0.08;
    this.g2.gain.value = 0.03;
    this.g3.gain.value = 0.05;
    this.wG.gain.value = 0;
  }

  dispose() {
    if (!this.ok) return;
    this.hornSet(false);
    try {
      this.ctx.close();
    } catch {}
    this.ok = false;
  }

  update(rpm: number, thr: number, slip: number, speed: number, now: number, cut: boolean, raining: boolean, horn: boolean) {
    if (!this.ok) return;
    const f = (rpm / 60) * 2;
    this.o1.frequency.value = f;
    this.o2.frequency.value = f * 2.01;
    this.o3.frequency.value = f * 0.5;
    const load = 0.16 + thr * 0.8;
    const cutMul = cut ? 0.25 : 1;
    this.g1.gain.value = 0.5 * load * cutMul;
    this.g2.gain.value = 0.22 * load * cutMul;
    this.g3.gain.value = 0.34 * load * cutMul;
    this.engF.frequency.value = 520 + rpm * 0.34 + thr * 900;
    this.engG.gain.value = 0.16 + thr * 0.1;
    this.inG.gain.value = thr * 0.05 * (rpm / 7000);
    this.scrG.gain.value = Math.max(0, Math.min(1, slip - 0.28)) * 0.16 * Math.min(1, speed / 8);
    this.scrF.frequency.value = 880 + Math.sin(now * 23) * 140 + slip * 180;
    this.wG.gain.value = Math.min(1, speed / 58) * 0.16 + (raining ? 0.02 : 0);
    this.wF.frequency.value = 280 + speed * 16;
    this.rG.gain.value = raining ? 0.05 : 0;
    this.hornSet(horn);
  }
}
