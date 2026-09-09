/* Classical music player for the in-dash screen.

   ---------------------------------------------------------------------------
   Why the music is SYNTHESIZED rather than streamed from files
   ---------------------------------------------------------------------------
   `test/size-budget.mjs` guards the shipped asset weight, and the critical
   path is already over budget before this feature existed. A single 3-minute
   MP3 at a listenable bitrate is ~3 MB; four or five pieces would be 15-30 MB
   and would roughly double the game's download. There is no room.

   The compositions here are all long out of copyright, so instead of shipping
   recordings we ship the *score* — a few hundred numbers per piece, which
   costs nothing in the asset budget because it lives in this .ts file — and
   render it live with Web Audio. This is also how the rest of the game's
   sound works: `game/audio.ts` is a hand-built synthesis model, not a sample
   library. Nothing here imports from it (the two graphs are independent), but
   the house idiom is borrowed: build the fixed part of the graph once, then
   only move AudioParams.

   ---------------------------------------------------------------------------
   PLANNED: swapping in real recordings later
   ---------------------------------------------------------------------------
   Synthesis is this pass only. The intent is to replace it with real
   public-domain recordings (Musopen CC0) once the asset budget is sorted, and
   the seam for that is meant to fall in ONE place: everything below the
   `spawn()` / `tick()` scheduler pair is the audio *source*, and everything
   above it — the playlist, the transport (play/pause/next/prev/stop), the
   pause-with-the-game gating, the autoplay unlock and the MusicTrack state the
   dash screen reads — is source-agnostic and already knows nothing about
   notes.

   To add a recorded backend: give Piece an alternative to `build()` (a URL),
   add a BufferSourceTrack that decodes it and answers the same four questions
   the scheduler answers — start at a given ctx time, stop, where am I, how
   long am I — and route `sync()` to it. `duration`/`elapsed`/`progress` are
   already plain seconds for exactly this reason, and `unit`/`units` are the
   only two public-ish fields that assume a score.

   NOTE: that interface is NOT extracted yet — this pass ran out of time. The
   seam is where the comment says it is, and the note data is confined to the
   "score" region below so deleting it later is a clean cut, but someone will
   still have to do the extraction. Do not assume it is already done.

   ---------------------------------------------------------------------------
   Honesty about the transcriptions
   ---------------------------------------------------------------------------
   Every piece below is written out as readable pitch names precisely so a
   human can audit it against a score. A famous piece rendered with wrong
   notes is worse than no piece at all, so the rule applied here was: encode
   only what can be written down with confidence, and prefer a short excerpt
   that loops cleanly over a long half-remembered transcription. Several
   obvious candidates (Gymnopedie No. 1, Clair de Lune, Eine kleine
   Nachtmusik, Rondo alla Turca) were deliberately CUT for exactly that
   reason — the melodies were not recallable at note-level confidence.

   Each PIECE below carries a `provenance` note saying what is transcribed and
   what is a realisation (i.e. an accompaniment written to be idiomatic rather
   than copied from the composer's own texture). Read it before assuming a
   line is Beethoven's.

   ---------------------------------------------------------------------------
   Desktop only
   ---------------------------------------------------------------------------
   `enabled` is false on touch devices, using the same probe the rest of the
   codebase uses (engine.ts / settings.ts / cockpit.ts all spell it the same
   way). When false every method is a no-op, no AudioContext is ever created,
   and the dash panel should draw nothing at all. Phones do not have the
   headroom or the keyboard for this.                                        */

import { clamp, lerp } from "./util";

/* ---------------------------------------------------------------- pitch --- */

const SEMI: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** "E5" / "D#5" / "Bb3" -> MIDI number. Scores are written as pitch names
    rather than raw numbers so they can be proof-read against a real score;
    the conversion cost is paid once, at prime(). */
function midiOf(name: string): number {
  const m = /^([a-gA-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error("music: bad pitch " + name);
  const acc = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
  return (+m[3] + 1) * 12 + SEMI[m[1].toLowerCase()] + acc;
}

const hzOf = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/* ---------------------------------------------------------------- score --- */

/** One scheduled note. `t` and `d` are in SCORE UNITS, not seconds — a piece's
    `unit` converts them. Keeping the score in units means the tempo is one
    number per piece and the note data is tempo-independent. */
interface Note {
  t: number;
  midi: number;
  d: number;
  /** 0..1. Drives level AND timbre (see voice()) — a piano struck harder is
      brighter, not just louder, so velocity must not collapse to a gain. */
  v: number;
}

const nt = (pitch: string, t: number, d: number, v = 0.78): Note => ({
  t,
  midi: midiOf(pitch),
  d,
  v,
});

type Voice = "piano" | "strings";

interface Piece {
  title: string;
  /** Catalogue / movement line, e.g. "Bagatelle No. 25 in A minor". */
  subtitle: string;
  composer: string;
  year: string;
  voice: Voice;
  /** seconds per score unit — the tempo */
  unit: number;
  /** total length of one pass, in score units; the piece loops at this point */
  units: number;
  /** Album-art tile: two hex colours, a glyph and the composer's initials, so
      the dash panel can draw a recognisable tile with no image asset. `motif`
      indexes the shape vocabulary carscreen.ts already draws — carried here
      so the panel picks a cover per track without this file knowing how a
      cover is drawn. */
  art: { a: string; b: string; glyph: string; initials: string; motif: number };
  /** What is transcription and what is realisation. Surfaced in the public
      track metadata so it never drifts out of sync with the notes. */
  provenance: string;
  build: () => Note[];
}

/* -- 1. Beethoven, Fur Elise (Bagatelle WoO 59) — the A section ------------

   The A section only, played three times. That is the part everybody can hum
   and it is the part that can be written down without guessing; the B and C
   sections are not encoded because they could not be recalled reliably.

   Eight bars of 3/8 is barely nine seconds, which is too short to loop on its
   own, so one pass through the piece is three statements of it — which is
   also how often the A section comes round in the real Bagatelle.

   Grid: one unit = one sixteenth. A bar is 6 units. The two sixteenths at
   t=0 are the upbeat, so bar 1 proper starts at t=2.                       */
const FUR_RH: [string, number, number][] = [
  // upbeat
  ["E5", 0, 1], ["D#5", 1, 1],
  // bar 1: E D# E B D C
  ["E5", 2, 1], ["D#5", 3, 1], ["E5", 4, 1], ["B4", 5, 1], ["D5", 6, 1], ["C5", 7, 1],
  // bar 2: A, then the rising C-E-A into the next bar
  ["A4", 8, 3], ["C4", 11, 1], ["E4", 12, 1], ["A4", 13, 1],
  // bar 3: B, then E-G#-B
  ["B4", 14, 3], ["E4", 17, 1], ["G#4", 18, 1], ["B4", 19, 1],
  // bar 4: C, E, then the upbeat to the repeat
  ["C5", 20, 3], ["E4", 23, 1], ["E5", 24, 1], ["D#5", 25, 1],
  // bar 5: the opening figure again
  ["E5", 26, 1], ["D#5", 27, 1], ["E5", 28, 1], ["B4", 29, 1], ["D5", 30, 1], ["C5", 31, 1],
  // bar 6
  ["A4", 32, 3], ["C4", 35, 1], ["E4", 36, 1], ["A4", 37, 1],
  // bar 7: the second time the figure resolves E-C-B instead of E-G#-B
  ["B4", 38, 3], ["E4", 41, 1], ["C5", 42, 1], ["B4", 43, 1],
  // bar 8
  ["A4", 44, 6],
];
/* Left hand: one broken chord per bar (A minor / E major), each note left to
   ring to the bar line — the piece is played with the pedal down through the
   bar, so writing the durations out to the bar end reproduces that without
   needing a pedal model. Bars 1 and 5 are right hand alone. */
const FUR_LH: [string, number, number][] = [
  ["A2", 8, 6], ["E3", 10, 4], ["A3", 12, 4],
  ["E2", 14, 6], ["E3", 16, 4], ["G#3", 18, 4],
  ["A2", 20, 6], ["E3", 22, 4], ["A3", 24, 4],
  ["A2", 32, 6], ["E3", 34, 4], ["A3", 36, 4],
  ["E2", 38, 6], ["E3", 40, 4], ["G#3", 42, 4],
  ["A2", 44, 6], ["E3", 46, 4], ["A3", 48, 4],
];
const FUR_BLOCK = 50; // units in one statement of the A section

/* -- 2. Bach, Prelude in C, WTC I, BWV 846 — bars 1-11 --------------------

   The prelude is one figuration repeated over a changing five-note chord, so
   the whole thing reduces to a list of chords: bar N is its five pitches
   arpeggiated p1 p2 p3 p4 p5 p3 p4 p5, twice, in sixteenths.

   It stops at bar 8: that is as far as the chords could be written out with
   no reservation at all. Bar 8 is C major over a B bass, so the loop back to
   bar 1 resolves the leading tone up to the tonic and the seam is musical
   rather than a splice. Bars 9 onward are not encoded — see the note below
   the chord table.                                                          */
const BACH_BARS: string[][] = [
  ["C4", "E4", "G4", "C5", "E5"], // 1  C
  ["C4", "D4", "A4", "D5", "F5"], // 2  Dm7/C
  ["B3", "D4", "G4", "D5", "F5"], // 3  G7/B
  ["C4", "E4", "G4", "C5", "E5"], // 4  C
  ["C4", "E4", "A4", "E5", "A5"], // 5  Am7/C   (the high A5 — the first peak)
  ["C4", "D4", "F#4", "A4", "D5"], // 6  D7/C
  ["B3", "D4", "G4", "D5", "G5"], // 7  G/B
  ["B3", "C4", "E4", "G4", "C5"], // 8  C/B
];
/* Bars 9-11 (Am7, D7, G) were WRITTEN AND THEN CUT. They are probably right,
   but "probably" is not the bar for shipping a piece this well known, and the
   confidence fell off exactly there. Bar 8 is C major over a B bass, so the
   loop back to bar 1 resolves a leading tone up to the tonic — a better seam
   than the one bars 9-11 were bought with. */
/** The figure, as indices into a bar's five pitches. Eight sixteenths, played
    twice per bar of 4/4. */
const BACH_FIG = [0, 1, 2, 3, 4, 2, 3, 4];

/* -- 3. Pachelbel, Canon in D — ground bass + first violin variation -------

   The ground bass (D A B F# G D G A) and its harmonisation are the piece's
   skeleton and are not in doubt. The melodic line encoded here is the FIRST
   violin variation — the stepwise descent F# E D C# B A B C# — one note per
   ground note. The later variations are not encoded: their figuration could
   not be written out accurately, and inventing them would be dishonest.

   One unit = one ground note. A pass is three cycles: the bass alone (the
   familiar opening), then two with the melody, the second doubled an octave
   lower to imitate a second voice entering. That doubling is a realisation
   choice, not Pachelbel's part-writing.                                     */
const CANON_BASS = ["D3", "A2", "B2", "F#2", "G2", "D2", "G2", "A2"];
const CANON_CHORDS: string[][] = [
  ["F#4", "A4", "D5"], // D
  ["E4", "A4", "C#5"], // A
  ["D4", "F#4", "B4"], // Bm
  ["C#4", "F#4", "A4"], // F#m
  ["D4", "G4", "B4"], // G
  ["D4", "F#4", "A4"], // D
  ["D4", "G4", "B4"], // G
  ["C#4", "E4", "A4"], // A
];
const CANON_MELODY = ["F#5", "E5", "D5", "C#5", "B4", "A4", "B4", "C#5"];

/* -- 4. Beethoven, Ode to Joy (Symphony No. 9, 4th mvt) -------------------

   The full sixteen-bar theme in D major. The melody is certain — it is one of
   the most-printed tunes in existence and every note of it is written out
   below to be checked.

   The accompaniment is NOT Beethoven's. In the symphony the theme first
   arrives as a bare unison line in the low strings; what is written here
   under it is a conventional I-V realisation in root position, voiced
   entirely below the melody with the thirds kept low so nothing collides with
   the tune. Idiomatic, but mine.

   One unit = one quarter note.                                              */
const ODE_MELODY: [string, number, number][] = [
  // phrase 1
  ["F#4", 0, 1], ["F#4", 1, 1], ["G4", 2, 1], ["A4", 3, 1],
  ["A4", 4, 1], ["G4", 5, 1], ["F#4", 6, 1], ["E4", 7, 1],
  ["D4", 8, 1], ["D4", 9, 1], ["E4", 10, 1], ["F#4", 11, 1],
  ["F#4", 12, 1.5], ["E4", 13.5, 0.5], ["E4", 14, 2],
  // phrase 2 — same opening, closes on the tonic instead
  ["F#4", 16, 1], ["F#4", 17, 1], ["G4", 18, 1], ["A4", 19, 1],
  ["A4", 20, 1], ["G4", 21, 1], ["F#4", 22, 1], ["E4", 23, 1],
  ["D4", 24, 1], ["D4", 25, 1], ["E4", 26, 1], ["F#4", 27, 1],
  ["E4", 28, 1.5], ["D4", 29.5, 0.5], ["D4", 30, 2],
  // phrase 3 — the contrasting middle, dropping to the low A
  ["E4", 32, 1], ["E4", 33, 1], ["F#4", 34, 1], ["D4", 35, 1],
  ["E4", 36, 1], ["F#4", 37, 0.5], ["G4", 37.5, 0.5], ["F#4", 38, 1], ["D4", 39, 1],
  ["E4", 40, 1], ["F#4", 41, 0.5], ["G4", 41.5, 0.5], ["F#4", 42, 1], ["E4", 43, 1],
  ["D4", 44, 1], ["E4", 45, 1], ["A3", 46, 2],
  // phrase 4 — phrase 2 again
  ["F#4", 48, 1], ["F#4", 49, 1], ["G4", 50, 1], ["A4", 51, 1],
  ["A4", 52, 1], ["G4", 53, 1], ["F#4", 54, 1], ["E4", 55, 1],
  ["D4", 56, 1], ["D4", 57, 1], ["E4", 58, 1], ["F#4", 59, 1],
  ["E4", 60, 1.5], ["D4", 61.5, 0.5], ["D4", 62, 2],
];
/** One chord per half bar (32 of them), as "D" or "A". Root-position triads
    voiced low; see the provenance note above. */
const ODE_CHORDS =
  "DD DA DD DA DD DA DD AD AD DD DA DA DD DA DD AD".replace(/ /g, "").split("");
const ODE_VOICING: Record<string, string[]> = {
  D: ["D2", "D3", "F#3", "A3"],
  A: ["A1", "A2", "C#3", "E3"],
};

/* ------------------------------------------------------------ the pieces -- */

const PIECES: Piece[] = [
  {
    title: "Für Elise",
    subtitle: "Bagatelle No. 25 in A minor",
    composer: "Ludwig van Beethoven",
    year: "1810",
    voice: "piano",
    unit: 0.175, // sixteenth; a 3/8 bar lands at ~1.05 s — Beethoven's "poco moto"
    units: FUR_BLOCK * 3,
    art: { a: "#241a33", b: "#8a6fbf", glyph: "♪", initials: "LvB", motif: 6 },
    provenance: "A section only, transcribed; played three times. B/C sections omitted.",
    build() {
      const out: Note[] = [];
      for (let pass = 0; pass < 3; pass++) {
        const o = pass * FUR_BLOCK;
        // Each restatement a touch softer then louder again — a flat dynamic
        // over three identical passes reads as a loop, which is what it is.
        const dyn = [1, 0.9, 0.98][pass];
        for (const [p, t, d] of FUR_RH) out.push(nt(p, t + o, d, 0.8 * dyn));
        for (const [p, t, d] of FUR_LH) out.push(nt(p, t + o, d, 0.5 * dyn));
      }
      return out;
    },
  },
  {
    title: "Prelude in C",
    subtitle: "The Well-Tempered Clavier I, BWV 846",
    composer: "Johann Sebastian Bach",
    year: "1722",
    voice: "piano",
    unit: 0.205, // sixteenth; a 4/4 bar lands at ~3.3 s
    units: BACH_BARS.length * 16,
    art: { a: "#10262b", b: "#4f9d8c", glyph: "♫", initials: "JSB", motif: 1 },
    provenance: "Bars 1-8, transcribed; loops from the bar-8 leading tone back to bar 1.",
    build() {
      const out: Note[] = [];
      BACH_BARS.forEach((bar, b) => {
        const t0 = b * 16;
        for (let half = 0; half < 2; half++) {
          for (let i = 0; i < 8; i++) {
            const t = t0 + half * 8 + i;
            // The prelude is played under the pedal, so every note of the bar
            // rings until the bar line rather than stopping at its own
            // sixteenth. Writing the duration out to the bar end is the same
            // sound with no pedal model to maintain.
            const d = t0 + 16 - t;
            // The two bass notes carry the harmony and are voiced a shade
            // firmer; within the figure the downbeat of each half is stressed.
            const bass = i < 2;
            const v = bass ? 0.72 : i === 2 ? 0.62 : 0.52;
            out.push(nt(bar[BACH_FIG[i]], t, d, v));
          }
        }
      });
      return out;
    },
  },
  {
    title: "Canon in D",
    subtitle: "Canon and Gigue in D major",
    composer: "Johann Pachelbel",
    year: "c. 1680",
    voice: "strings",
    unit: 1.15, // one ground-bass note
    units: 24, // three eight-note cycles
    art: { a: "#2b1c14", b: "#b3823f", glyph: "♬", initials: "JP", motif: 5 },
    provenance:
      "Ground bass, harmony and the first violin variation transcribed; later variations omitted.",
    build() {
      const out: Note[] = [];
      for (let cycle = 0; cycle < 3; cycle++) {
        for (let i = 0; i < 8; i++) {
          const t = cycle * 8 + i;
          out.push(nt(CANON_BASS[i], t, 1, 0.62));
          for (const p of CANON_CHORDS[i]) out.push(nt(p, t, 1, 0.34));
          if (cycle === 0) continue; // first cycle is the bass alone
          out.push(nt(CANON_MELODY[i], t, 1, 0.8));
          // Second melodic cycle: the line doubled an octave down, standing in
          // for the canon's second voice entering. A realisation, not the score.
          if (cycle === 2) out.push(lowOctave(CANON_MELODY[i], t));
        }
      }
      return out;
    },
  },
  {
    title: "Ode to Joy",
    subtitle: "Symphony No. 9, Fourth Movement",
    composer: "Ludwig van Beethoven",
    year: "1824",
    voice: "strings",
    unit: 0.517, // quarter note at ~116 bpm
    units: 64,
    art: { a: "#1b1f36", b: "#6e7fc4", glyph: "♩", initials: "LvB", motif: 0 },
    provenance:
      "Melody transcribed (all 16 bars). Accompaniment is a conventional I-V realisation, not Beethoven's scoring.",
    build() {
      const out: Note[] = [];
      for (const [p, t, d] of ODE_MELODY) out.push(nt(p, t, d, 0.82));
      ODE_CHORDS.forEach((c, i) => {
        for (const p of ODE_VOICING[c]) out.push(nt(p, i * 2, 2, 0.3));
      });
      return out;
    },
  },
];

/** Same pitch an octave down. Split out because the Canon's doubled voice is
    the only place that needs it and inlining it obscured the score. */
function lowOctave(pitch: string, t: number): Note {
  return { t, midi: midiOf(pitch) - 12, d: 1, v: 0.46 };
}

/* ------------------------------------------------------------ public API -- */

export type MusicState = "stopped" | "playing" | "paused";

/** What the dash screen reads. Deliberately flat and value-only: the panel
    should never have to reach into the player's audio graph. */
export interface MusicTrack {
  title: string;
  subtitle: string;
  composer: string;
  year: string;
  art: { a: string; b: string; glyph: string; initials: string };
  provenance: string;
}

/* -------------------------------------------------------------- tuning --- */

/** Master level for the whole music bus, before the user's volume setting.
    game/audio.ts runs its master at 0.9 * vol with the engine peaking near
    0.8 into it; at 0.16 the music peaks roughly 14 dB below that, which is
    where it belongs — this is something playing in the car, not the mix. */
const MUSIC_LEVEL = 0.16;

/** Scheduler: a timer wakes every SCHED_MS and posts every note starting
    within LOOKAHEAD seconds. Notes must be scheduled against
    AudioContext.currentTime and NOT per animation frame — frame-timed note
    starts jitter audibly, and this game's frame rate is not stable. The
    lookahead is generous enough to survive a stalled timer during a heavy
    world-chunk build; the cost of that is that a pause takes up to
    LOOKAHEAD to fall silent, which is why pause fades the bus rather than
    just stopping the scheduler. */
const SCHED_MS = 50;
const LOOKAHEAD = 0.4;

/** Hard ceiling on simultaneously ringing notes. The Bach lets a whole bar
    ring at once, so the natural peak is ~16 voices; the cap only exists so a
    pathological case cannot pile up oscillators behind the game's own audio.
    Desktop-only, so this is comfortable rather than tight. */
const MAX_VOICES = 28;

interface LiveVoice {
  srcs: AudioScheduledSourceNode[];
  env: GainNode;
  /** ctx time this voice is fully done and can be dropped from the list */
  off: number;
}

export class MusicPlayer {
  /** False on touch devices. Every method no-ops and no AudioContext is ever
      created; the dash panel should draw nothing when this is false. */
  readonly enabled: boolean;

  /** Fired whenever the panel would need to repaint: track change, or a
      play/pause/stop transition. NOT called per frame — poll `progress`
      yourself if you want a moving bar. */
  onChange: (() => void) | null = null;

  private ctx: AudioContext | null = null;
  private ready = false;

  /* fixed graph, built once in prime() */
  private busIn!: GainNode; // every voice lands here
  private master!: GainNode; // level * user volume
  private vibrato!: OscillatorNode; // one shared LFO for all string voices
  private vibDepth!: GainNode;
  private noiseBuf!: AudioBuffer;
  private waves: Record<Voice, PeriodicWave> = {} as any;

  private scores: Note[][] = [];
  private ix = 0;
  private live: LiveVoice[] = [];

  /* transport */
  private wanted = false; // the driver asked for music
  /* Two independent reasons to be silent while still "playing". They are kept
     apart rather than folded into one flag because they are cleared by
     different events, and collapsing them means a tab regaining focus while
     the pause menu is open would start the music behind the menu. */
  private gameRunning = true;
  private visible = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** ctx time at which score unit 0 of the current pass sounded */
  private pieceStart = 0;
  /** index of the next note to schedule */
  private cursor = 0;
  /** seconds into the piece, held across a pause */
  private offset = 0;
  /** whether the graph was actually sounding as of the last sync(); the
      playhead is only meaningful (and only worth banking) when it was */
  private soundOn = false;
  private vol = 1;
  /** In-cabin volume knob, on top of `vol` — the head unit's own level, not
      the settings menu's. Session-only by design: a real stereo forgets where
      its knob sat between drives too, and persisting it would tangle this
      module with the settings profile it otherwise has nothing to do with.
      Stepped by cockpit.ts's volume buttons; see stepVolume(). */
  private cabinVol = 1;

  constructor() {
    this.enabled =
      typeof window !== "undefined" &&
      typeof matchMedia !== "undefined" &&
      !("ontouchstart" in window && matchMedia("(pointer:coarse)").matches);
    if (this.enabled) document.addEventListener("visibilitychange", this.onVisibility);
  }

  /* ------------------------------------------------------------- state -- */

  get state(): MusicState {
    if (!this.wanted) return this.offset > 0 ? "paused" : "stopped";
    return "playing";
  }
  get playing() {
    return this.wanted;
  }
  get trackIndex() {
    return this.ix;
  }
  get trackCount() {
    return PIECES.length;
  }
  get track(): MusicTrack {
    const p = PIECES[this.ix];
    return {
      title: p.title,
      subtitle: p.subtitle,
      composer: p.composer,
      year: p.year,
      art: p.art,
      provenance: p.provenance,
    };
  }
  /** Length of one pass through the excerpt, in seconds. Every piece loops at
      this point rather than advancing — the excerpts are short by design and
      auto-advancing every twenty seconds would churn. Skipping is manual. */
  get duration() {
    const p = PIECES[this.ix];
    return p.units * p.unit;
  }
  get elapsed() {
    if (!this.ctx || !this.soundOn) return this.offset;
    return clamp(this.ctx.currentTime - this.pieceStart, 0, this.duration);
  }
  get progress() {
    const d = this.duration;
    return d > 0 ? this.elapsed / d : 0;
  }

  /** Actually producing sound right now: the driver wants it AND the game is
      running AND the graph exists. Distinct from `playing`, which is only the
      driver's intent — the dash keeps showing "playing" across a pause menu. */
  private get running() {
    return this.ready && this.wanted && this.gameRunning && this.visible;
  }

  /* --------------------------------------------------------- lifecycle -- */

  /** Create and unlock the AudioContext. MUST be called from inside a user
      gesture: browsers only let a context leave "suspended" when it is
      created (or resumed) in one. engine.primeAudio() already exists for
      exactly this reason and is called from the Drive tap, so this rides
      along with it. Idempotent.

      This is a SECOND AudioContext, separate from game/audio.ts's. That file
      keeps its context and master bus private and exposes no output node to
      connect to, and it is not this feature's place to edit it — so the music
      gets its own context and its own master gain, and respects the user's
      volume setting through setLevels() instead of through audio.ts's master. */
  prime() {
    if (!this.enabled || this.ready) return;
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.ctx = ctx;

      /* --- fixed graph ---
         voices -> busIn ─┬─> (dry) ──────────────┐
                          └─> send -> conv -> wet ┴─> cabin LP -> comp -> master */
      this.busIn = ctx.createGain();
      const dry = ctx.createGain();
      dry.gain.value = 1;
      const send = ctx.createGain();
      send.gain.value = 0.3;
      const wet = ctx.createGain();
      wet.gain.value = 0.85;
      const conv = ctx.createConvolver();
      conv.normalize = true;
      conv.buffer = this.makeIR(ctx, 1.9);

      // A car cabin is not a concert hall and the speakers are not full range;
      // rolling the top off keeps the synthesised piano from sounding like it
      // is sitting on top of the windscreen.
      const cabin = ctx.createBiquadFilter();
      cabin.type = "lowpass";
      cabin.frequency.value = 7200;
      cabin.Q.value = 0.7;

      // Gentle, slow compression. Not for loudness — it is there so a dense
      // Bach bar cannot briefly poke above the engine and pull the ear off
      // the road.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -20;
      comp.knee.value = 14;
      comp.ratio.value = 3;
      comp.attack.value = 0.012;
      comp.release.value = 0.3;

      this.master = ctx.createGain();
      this.master.gain.value = 0; // silent until play(); music is off by default

      this.busIn.connect(dry).connect(cabin);
      this.busIn.connect(send).connect(conv).connect(wet).connect(cabin);
      cabin.connect(comp).connect(this.master).connect(ctx.destination);

      /* One vibrato LFO for the whole string section, connected into each
         note's detune as it is created — the house idiom: build the moving
         part once, wire new voices to it, never spin up an LFO per note. */
      this.vibrato = ctx.createOscillator();
      this.vibrato.type = "sine";
      this.vibrato.frequency.value = 5.1;
      this.vibDepth = ctx.createGain();
      this.vibDepth.gain.value = 5.5; // cents
      this.vibrato.connect(this.vibDepth);
      this.vibrato.start();

      // Shared noise, for the piano's hammer transient.
      const n = Math.floor(ctx.sampleRate * 0.5);
      this.noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
      const nd = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < n; i++) nd[i] = Math.random() * 2 - 1;

      this.waves.piano = this.makeWave(ctx, "piano");
      this.waves.strings = this.makeWave(ctx, "strings");

      this.scores = PIECES.map((p) => p.build().sort((a, b) => a.t - b.t));
      this.ready = true;
      // Created inside the gesture, but Chrome can still hand back a
      // suspended context if the page was loaded in the background.
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
    } catch {
      // No Web Audio, or the context was refused. The feature simply does not
      // exist for this session; nothing else in the game depends on it.
      this.ctx = null;
      this.ready = false;
    }
  }

  /** Same pair as GameAudio's, for the same reason and with the same
      contract — see game/audio.ts. Null when music is disabled (touch) or
      before the Drive tap primed the graph, which is not an error: this
      player simply does not exist for that session. */
  get contextState(): AudioContextState | null {
    return this.ctx ? this.ctx.state : null;
  }

  async resumeContext(): Promise<AudioContextState | null> {
    const ctx = this.ctx;
    if (!ctx) return null;
    try {
      if (ctx.state !== "running") await ctx.resume();
    } catch {}
    return ctx.state;
  }

  dispose() {
    if (!this.enabled) return;
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.stopTimer();
    if (this.ctx) {
      this.killVoices(0.02);
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.ready = false;
    this.onChange = null;
  }

  /* ---------------------------------------------------------- transport -- */

  play() {
    if (!this.enabled) return;
    this.prime(); // harmless if already primed; covers a first press that is itself the gesture
    if (!this.ready || this.wanted) return;
    this.wanted = true;
    this.sync();
    this.onChange?.();
  }

  pause() {
    if (!this.enabled || !this.wanted) return;
    this.wanted = false;
    this.sync();
    this.onChange?.();
  }

  toggle() {
    if (this.wanted) this.pause();
    else this.play();
  }

  /** Back to the top of the current piece and silent. Distinct from pause():
      pause() keeps the position so play() resumes mid-phrase. */
  stop() {
    if (!this.enabled) return;
    this.wanted = false;
    this.sync(); // banks the playhead on the way down...
    this.offset = 0; // ...which stop() then throws away. Rewinding is the whole difference from pause().
    this.onChange?.();
  }

  next() {
    this.skip(1);
  }
  prev() {
    /* Standard transport behaviour: if you are well into a piece, "previous"
       restarts it; press it again and you actually go back a track. */
    if (this.enabled && this.elapsed > 3) {
      this.offset = 0;
      this.sync();
      this.onChange?.();
      return;
    }
    this.skip(-1);
  }

  /** One transport action from a click on the in-dash screen. Routed through
      here rather than having the caller pick a method so the click path and
      the key path cannot drift apart — and because a click IS a user gesture,
      which is exactly what an AudioContext needs to unlock, so this primes on
      the way in. Returns what it did, for the caller's toast. */
  click(action: "prev" | "toggle" | "next"): string | null {
    if (!this.enabled) return null;
    this.prime();
    if (!this.ready) return null;
    if (action === "toggle") {
      this.toggle();
      return this.playing ? "\u266a " + this.track.title : "MUSIC PAUSED";
    }
    if (action === "next") this.next();
    else this.prev();
    return "\u266a " + this.track.title;
  }

  private skip(dir: number) {
    if (!this.enabled) return;
    this.ix = (this.ix + dir + PIECES.length) % PIECES.length;
    this.offset = 0;
    this.sync();
    this.onChange?.();
  }

  /* -------------------------------------------------------- game hooks -- */

  /** Follow the game's pause. Called from Game.setRunning(). The driver's
      intent (`wanted`) is untouched, so unpausing back into the world picks
      the piece up where the menu interrupted it. */
  setRunning(run: boolean) {
    if (!this.enabled || this.gameRunning === run) return;
    this.gameRunning = run;
    this.sync();
  }

  /** The user's master volume, from GameSettings.vol — the same number
      game/audio.ts gets through setLevels(). */
  setLevels(vol: number) {
    this.vol = vol;
    if (this.ready && this.running) this.rampMaster(MUSIC_LEVEL * vol * this.cabinVol, 0.08);
  }

  /** Step the in-cabin volume knob, from a click on the head-unit's own
      +/- (cockpit.ts). Quarter steps: 0, .25, .5, .75, 1 — coarse enough that
      each click is an audible move, which is the whole point of a knob you
      can see the effect of. Returns the toast text; null off the rails
      (disabled, or before the click that unlocks the AudioContext primes it —
      same "no audio yet" case click() already returns null for). */
  stepVolume(dir: 1 | -1): string | null {
    if (!this.enabled) return null;
    this.prime();
    if (!this.ready) return null;
    this.cabinVol = clamp(Math.round((this.cabinVol + dir * 0.25) * 4) / 4, 0, 1);
    if (this.running) this.rampMaster(MUSIC_LEVEL * this.vol * this.cabinVol, 0.06);
    return "VOLUME " + Math.round(this.cabinVol * 100) + "%";
  }

  private onVisibility = () => {
    /* A hidden tab throttles setInterval to roughly 1 Hz, which would shred a
       0.4 s lookahead into audible gaps. Nothing should be playing to an
       unwatched tab anyway, so gate on it and rebuild the schedule on return.
       The position is preserved, so coming back resumes mid-phrase rather
       than restarting. */
    const vis = !document.hidden;
    if (this.visible === vis) return;
    this.visible = vis;
    this.sync();
  };

  /* ---------------------------------------------------------- internals -- */

  /** Bring the audio graph in line with `running`. Every transport method and
      every game hook funnels through here so there is exactly one place that
      knows how to start and stop sound. */
  private sync() {
    if (!this.ready || !this.ctx) return;
    const on = this.running;
    /* Bank the playhead BEFORE tearing the schedule down — once pieceStart is
       re-anchored the position is gone. A skip stays "running" through this
       call and so never reaches the capture; stop() does reach it and throws
       the captured value away afterwards. */
    if (this.soundOn && !on)
      this.offset = clamp(this.ctx.currentTime - this.pieceStart, 0, this.duration);
    this.soundOn = on;

    if (on) {
      if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
      // A track change arrives here still "running"; the outgoing piece's
      // notes are already scheduled and have to go.
      this.killVoices(0.1);
      // Anchor a little into the future so the first notes are scheduled
      // rather than fired late.
      this.pieceStart = this.ctx.currentTime + 0.06 - this.offset;
      this.syncCursor();
      this.rampMaster(MUSIC_LEVEL * this.vol * this.cabinVol, 0.12);
      this.startTimer();
      this.tick();
    } else {
      this.stopTimer();
      this.rampMaster(0, 0.12);
      // The bus fade covers the audible transition; killing the voices behind
      // it stops up to LOOKAHEAD seconds of already-scheduled notes from
      // ringing on into the pause menu.
      this.killVoices(0.14);
    }
  }

  /** Point `cursor` at the first note at or after the resume position. */
  private syncCursor() {
    const notes = this.scores[this.ix];
    const u = PIECES[this.ix].unit;
    this.cursor = 0;
    while (this.cursor < notes.length && notes[this.cursor].t * u < this.offset - 1e-4)
      this.cursor++;
  }

  private startTimer() {
    if (this.timer === null) this.timer = setInterval(this.tick, SCHED_MS);
  }
  private stopTimer() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Lookahead scheduler. Posts every note that starts before the horizon,
      wrapping to the top of the piece when it runs off the end. */
  private tick = () => {
    const ctx = this.ctx;
    if (!ctx || !this.running) return;
    const now = ctx.currentTime;
    const horizon = now + LOOKAHEAD;
    const piece = PIECES[this.ix];
    const notes = this.scores[this.ix];
    const dur = this.duration;

    // Bounded so a wildly stale pieceStart (a tab resumed after minutes of
    // throttling, say) cannot spin here posting thousands of notes.
    for (let guard = 0; guard < 400; guard++) {
      if (this.cursor >= notes.length) {
        this.pieceStart += dur;
        this.cursor = 0;
        // If the clock has run so far ahead that a whole pass fits before the
        // horizon, snap rather than render the missed pass into the past.
        if (this.pieceStart + dur < now) this.pieceStart = now;
        continue;
      }
      const n = notes[this.cursor];
      const at = this.pieceStart + n.t * piece.unit;
      if (at >= horizon) break;
      this.cursor++;
      if (at < now - 0.05) continue; // missed it; do not fire late notes on top of each other
      this.spawn(n, Math.max(at, now), piece);
    }

    // Retire finished voices. Nothing else frees them — Web Audio drops the
    // nodes once they have stopped, this list is only so pause can reach them.
    const live = this.live;
    let w = 0;
    for (let i = 0; i < live.length; i++) if (live[i].off > now) live[w++] = live[i];
    live.length = w;
  };

  /* ------------------------------------------------------------ voices -- */

  /** Harmonic content per instrument, as a PeriodicWave. Putting the partials
      in the wave rather than in a stack of oscillators is what makes the
      polyphony affordable: one oscillator carries eight partials, and the
      per-note lowpass below is what makes the upper ones die faster than the
      fundamental — which is the single most important thing about a piano
      note and the thing a bare sawtooth gets wrong. */
  private makeWave(ctx: AudioContext, v: Voice): PeriodicWave {
    const amps =
      v === "piano"
        ? [0, 1, 0.42, 0.28, 0.15, 0.1, 0.065, 0.04, 0.028, 0.02]
        : // strings: slower rolloff, keeps the bite that survives the cabin LP
          [0, 1, 0.55, 0.38, 0.27, 0.2, 0.15, 0.11, 0.085, 0.065, 0.05, 0.04];
    const real = new Float32Array(amps.length);
    const imag = new Float32Array(amps);
    return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  }

  /** Procedural reverb impulse: decaying noise, progressively darkened by a
      one-pole so the tail loses its top before its level — which is what
      makes a synthetic IR read as a room rather than as noise. Generated
      rather than fetched because an IR file is an asset, and there is no
      asset budget left. */
  private makeIR(ctx: AudioContext, seconds: number): AudioBuffer {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        // coefficient falls with time -> the tail gets duller as it decays
        const k = lerp(0.55, 0.12, t);
        lp += k * ((Math.random() * 2 - 1) - lp);
        d[i] = lp * Math.pow(1 - t, 2.4);
      }
    }
    return buf;
  }

  /** Build and schedule one note. Every node here is created per note and
      dropped when it stops — unavoidable for note events, and the reason the
      *fixed* half of the graph above is built exactly once. */
  private spawn(n: Note, at: number, piece: Piece) {
    const ctx = this.ctx!;
    if (this.live.length >= MAX_VOICES) {
      // Steal the oldest rather than refuse the new note: a dropped attack is
      // far more noticeable than a truncated tail.
      const v = this.live.shift()!;
      this.fadeOut(v, 0.05);
    }

    const f = hzOf(n.midi);
    const isPiano = piece.voice === "piano";
    const env = ctx.createGain();
    const filt = ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.Q.value = 0.6;
    filt.connect(env).connect(this.busIn);

    /* Unison detune. A real piano has two or three strings per note tuned a
       cent or two apart, and that mistuning is what produces the shimmer and
       the slow beating of a held chord — it is not a chorus effect bolted on.
       Strings get a wider spread because a section is many players. */
    const spread = isPiano ? [0, 2.4, -3.1] : [0, 6, -7];
    const lvl = isPiano ? [1, 0.55, 0.5] : [1, 0.7, 0.65];
    const count = isPiano ? 2 : 3;
    const srcs: AudioScheduledSourceNode[] = [];
    for (let i = 0; i < count; i++) {
      const o = ctx.createOscillator();
      o.setPeriodicWave(this.waves[piece.voice]);
      o.frequency.value = f;
      o.detune.value = spread[i];
      if (!isPiano) this.vibDepth.connect(o.detune);
      const g = ctx.createGain();
      g.gain.value = lvl[i] / count;
      o.connect(g).connect(filt);
      o.start(at);
      srcs.push(o);
    }

    const dur = n.d * piece.unit;
    let off: number;

    if (isPiano) {
      /* Piano: struck, then it decays on its own; `dur` only says when the
         damper falls. Bass strings ring far longer than treble, so the decay
         constant tracks pitch — a flat decay is the single most synthetic
         thing a fake piano can do. */
      const tau = lerp(2.3, 0.34, clamp((n.midi - 36) / 48, 0, 1));
      const peak = 0.3 * n.v * n.v; // squared: velocity curve, not a linear fader
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(peak, at + 0.004);
      env.gain.setTargetAtTime(0, at + 0.004, tau);

      /* Velocity as timbre: a harder strike opens the filter, so the note is
         brighter as well as louder. The cutoff then falls back toward the
         fundamental, which is how the upper partials come to die faster than
         the fundamental without modelling each partial separately. */
      const open = clamp(f * (4 + 14 * n.v), 400, 11000);
      filt.frequency.setValueAtTime(open, at);
      filt.frequency.setTargetAtTime(clamp(f * 2.4, 260, 4200), at + 0.005, 0.32);

      // Hammer noise: a few milliseconds of band-passed noise at onset. Tiny,
      // but it is most of what tells the ear "this was hit" rather than
      // "this faded in".
      if (n.v > 0.28) {
        const src = ctx.createBufferSource();
        src.buffer = this.noiseBuf;
        src.playbackRate.value = 1 + Math.random() * 0.4;
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = clamp(f * 3.5, 700, 6500);
        bp.Q.value = 0.8;
        const hg = ctx.createGain();
        hg.gain.setValueAtTime(0.0001, at);
        hg.gain.linearRampToValueAtTime(0.05 * n.v, at + 0.0012);
        hg.gain.exponentialRampToValueAtTime(0.0001, at + 0.016);
        src.connect(bp).connect(hg).connect(this.busIn);
        src.start(at, Math.random() * 0.4, 0.03);
        srcs.push(src);
      }

      /* Damper. The note has decayed by exp(-t/tau) when it lands, and that
         value is computed here rather than read back with
         cancelAndHoldAtTime(), which Safari spells differently — a closed
         form needs no feature detection and gives the same curve. */
      const held = Math.max(dur, 0.12);
      const damp = 0.14;
      const atOff = at + held;
      env.gain.setValueAtTime(peak * Math.exp(-held / tau), atOff);
      env.gain.linearRampToValueAtTime(0, atOff + damp);
      off = atOff + damp;
    } else {
      /* Strings: bowed, so it swells in and holds, and the release is the bow
         leaving rather than a damper. */
      const peak = 0.24 * n.v * n.v;
      const atk = 0.085;
      const rel = 0.34;
      const sag = 0.5; // time constant of the post-attack settle
      const held = Math.max(dur, atk + 0.05);
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(peak, at + atk);
      // A slight decay off the attack peak keeps a held chord from sounding
      // like an organ.
      env.gain.setTargetAtTime(peak * 0.82, at + atk, sag);
      /* Where that settle has actually reached by the release, in closed form.
         Hardcoding an approximation here puts a step in the envelope on short
         notes — where the settle has barely started — and short notes are
         exactly where a step clicks. */
      env.gain.setValueAtTime(
        peak * (0.82 + 0.18 * Math.exp(-(held - atk) / sag)),
        at + held
      );
      env.gain.linearRampToValueAtTime(0, at + held + rel);

      filt.frequency.setValueAtTime(clamp(f * (3 + 5 * n.v), 500, 5200), at);
      off = at + held + rel;
    }

    for (const s of srcs) s.stop(off + 0.03);
    this.live.push({ srcs, env, off });
  }

  private fadeOut(v: LiveVoice, fade: number) {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const g = v.env.gain;
    const cur = g.value;
    g.cancelScheduledValues(now);
    g.setValueAtTime(cur, now);
    g.linearRampToValueAtTime(0, now + fade);
    for (const s of v.srcs) {
      try {
        s.stop(now + fade + 0.02);
      } catch {
        /* already stopped, or never started — either way nothing to do */
      }
    }
  }

  private killVoices(fade: number) {
    if (!this.ctx) return;
    for (const v of this.live) this.fadeOut(v, fade);
    this.live.length = 0;
  }

  private rampMaster(to: number, time: number) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const g = this.master.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(to, now + time);
  }
}

/* ---------------------------------------------------- transport actions --- */

/* The hit rects used to live here: a hand-kept copy of carscreen.ts's transport
   row, with a comment saying the two had to be edited together and that the
   right fix was for that file to export them. It does now — carscreen.ts's
   hitScreen() is the single hit test, reading the same constants its painter
   draws from — so the copy is gone and this file is out of the geometry
   business. Only the action names stay, because they are what click() takes. */
export type Transport = "prev" | "toggle" | "next";
