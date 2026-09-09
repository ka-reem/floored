/* The Blue Route sign kit — the React half of app/ui-system.css.

   Everything here is a thin wrapper over the .sign-* classes so a screen can
   be assembled from the same handful of parts the home screen uses: a Gantry
   spanning the top, a SignPlate (the blue board) with a SignHead, a SignRule,
   and SignRows for each choice. The styling lives entirely in the CSS; these
   components only fix the markup so every screen gets the same DOM shape
   (and the same tap targets, focus rings and font switches) for free.

   The second half — SignToggle / SignSeg / SignSelect / SignSlider / SignBtn
   / SignShead / SignSrow — are the System sheet's §05 controls, used by the
   settings, garage, controls, stats, pause, credits and loading screens.
   Each keeps a REAL form element underneath (a checkbox, a range input, a
   <select>, a <button>) so keyboard focus, screen readers and the headless
   test harnesses see ordinary controls; the sign look is painted around it.

   Keep these presentational: no game imports, no state. */

import type { ButtonHTMLAttributes, CSSProperties, ReactNode, SelectHTMLAttributes } from "react";

/* ---------- glyphs ---------- */

export type ArrowDir = "up" | "ne" | "nw" | "left" | "right" | "down";

const ARROW_ROT: Record<ArrowDir, number> = {
  up: 0,
  ne: 45,
  right: 90,
  down: 180,
  left: -90,
  nw: -45,
};

/** A guide-sign arrow: heavy shaft, wide head, drawn in currentColor so the
    primary row's sodium colour and glow apply to it like text. The SVG is
    used instead of ↑↗↖ because the arrow glyphs those code points resolve
    to differ per platform font and none of them match Highway Gothic. */
export function SignArrow({ dir = "up" }: { dir?: ArrowDir }) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" style={{ transform: `rotate(${ARROW_ROT[dir]}deg)` }}>
      <path d="M50 6 L86 46 L64 46 L64 94 L36 94 L36 46 L14 46 Z" />
    </svg>
  );
}

/** The white P-in-a-square that marks a parking area (used by GARAGE). */
export function SignP({ big = false }: { big?: boolean }) {
  return (
    <span className={big ? "sign-p big" : "sign-p"} aria-hidden="true">
      P
    </span>
  );
}

/** Route shield: the JP road name over the route code (首都高 / C1). */
export function SignShield({ jp = "首都高", code = "C1" }: { jp?: string; code?: string }) {
  return (
    <div className="sign-shield" aria-hidden="true">
      <div className="sign-shield-jp" lang="ja">
        {jp}
      </div>
      <div className="sign-shield-code">{code}</div>
    </div>
  );
}

/* ---------- board ---------- */

/** The blue board itself. `hangers` adds the bracket-and-fixture stubs that
    visually tie it to a Gantry above. `screen` makes it a sub-screen board:
    a flex column whose SignBody scrolls inside a viewport-bounded height. */
export function SignPlate({
  hangers = false,
  screen = false,
  className,
  children,
}: {
  hangers?: boolean;
  screen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const cls = ["sign", screen ? "screen" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <div className="sign-sheet" aria-hidden="true" />
      {hangers && (
        <>
          <div className="sign-hang h1" aria-hidden="true" />
          <div className="sign-hang h2" aria-hidden="true" />
          <div className="sign-hang h3" aria-hidden="true" />
        </>
      )}
      {children}
    </div>
  );
}

/** JP-over-EN title pair. `as` picks the EN element (h1 on the home screen,
    h2 on sub-screens) so heading order stays sensible for screen readers. */
export function SignTitle({ jp, en, as: Tag = "h1" }: { jp: string; en: string; as?: "h1" | "h2" }) {
  return (
    <div className="sign-titles">
      <div className="sign-title-jp" lang="ja">
        {jp}
      </div>
      <Tag className="sign-title">{en}</Tag>
    </div>
  );
}

/** A sub-screen header: glyph (shield by default) · JP-over-EN title · an
    optional supplementary plate beside the title · a two-line corner caption.
    The board's own header row, sized for the 1320-wide screens (System sheet:
    56/22 title, 72×66 shield).

    `mark` is the build-mark slot: a small outline chip, the way a real guide
    sign carries a 試験 / 工事中 panel. Presentational only — the caller decides
    what it says (GameApp's BetaMark is the one user today). It sits INSIDE the
    corner group, above the caption lines, rather than beside the title: hung
    off the title it took the strongest position on the board and out-shouted
    the primary row. The caption lines are their own span so a phone can drop
    them and keep the chip. */
export function SignHead({
  jp, en, corner, glyph, mark,
}: {
  jp: string;
  en: string;
  corner?: ReactNode;
  glyph?: ReactNode;
  mark?: ReactNode;
}) {
  return (
    <header className="sign-head sub">
      {glyph ?? <SignShield />}
      <SignTitle jp={jp} en={en} as="h2" />
      {(mark !== undefined || corner !== undefined) && (
        <div className="sign-corner sign-cap" aria-hidden="true">
          {mark}
          {corner !== undefined && <span className="sign-corner-lines">{corner}</span>}
        </div>
      )}
    </header>
  );
}

export function SignRule() {
  return <div className="sign-rule" aria-hidden="true" />;
}

export function SignSep() {
  return <div className="sign-sep" aria-hidden="true" />;
}

/** The scrolling middle of a sub-screen board. */
export function SignBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={className ? `sign-body ${className}` : "sign-body"}>{children}</div>;
}

/** The bar along the bottom of a sub-screen board: a faint caption on the
    left, the DONE / BACK buttons on the right. */
export function SignFootbar({
  caption, keep, children,
}: {
  caption?: ReactNode;
  /** phones drop the caption to save height; `keep` holds it (the version) */
  keep?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="sign-footbar">
      <div className={keep ? "sign-cap faint sign-footcap keep" : "sign-cap faint sign-footcap"}>{caption}</div>
      <div className="sign-footbtns">{children}</div>
    </div>
  );
}

/* ---------- rows ---------- */

export interface SignRowProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** glyph cell: an arrow direction, "p" for the parking square, or a node */
  glyph?: ArrowDir | "p" | ReactNode;
  jp: string;
  en: string;
  /** small bordered chip after the EN label (RIVAL's ON/OFF) */
  badge?: string;
  /** whether the chip is lit (sodium fill) */
  badgeOn?: boolean;
  /** distance figure; the "km" unit is added (hidden on phones) */
  dist?: string;
  /** right-hand caption (the pause screen's NEAREST ROAD / ENDS THE DRIVE) */
  note?: string;
  /** the ONE sodium-lit row on the screen: primary action or selected item
      (System sheet: orange lane-edge rule + tint + glow + slow hum) */
  selected?: boolean;
  /** paint the JP label from a data attribute instead of a text node, so the
      button's textContent is exactly the EN label (the pause screen: the
      harnesses look for a button whose text is exactly "RESUME") */
  jpAttr?: boolean;
}

/** One destination row — a real <button>, so Tab/Enter/Space and the test
    harness's textContent lookups all keep working. Text order inside is
    JP, EN, badge, distance; the glyph is aria-hidden SVG. */
export function SignRow({
  glyph = "up", jp, en, badge, badgeOn, dist, note, selected, jpAttr, className, ...rest
}: SignRowProps) {
  const cls = ["sign-row", selected ? "sel" : "", className ?? ""].filter(Boolean).join(" ");
  let glyphNode: ReactNode;
  if (glyph === "p") glyphNode = <SignP />;
  else if (typeof glyph === "string") glyphNode = <SignArrow dir={glyph as ArrowDir} />;
  else glyphNode = <span className="sign-glyph">{glyph}</span>;
  return (
    <button type="button" className={cls} aria-label={jpAttr ? `${en} (${jp})` : undefined} {...rest}>
      <span className="sign-arrow">{glyphNode}</span>
      {jpAttr ? (
        <span className="sign-jp" lang="ja" data-jp={jp} aria-hidden="true" />
      ) : (
        <span className="sign-jp" lang="ja">
          {jp}
        </span>
      )}
      <span className="sign-en">{en}</span>
      {badge !== undefined && <span className={badgeOn ? "sign-chip on" : "sign-chip"}>{badge}</span>}
      {dist !== undefined && (
        <span className="sign-dist" aria-hidden="true">
          {dist}
          <span>km</span>
        </span>
      )}
      {note !== undefined && <span className="sign-note sign-cap">{note}</span>}
    </button>
  );
}

/* ---------- controls (System sheet §05) ---------- */

/** A bordered sign button. `variant` primary is the one sodium button on a
    screen; ghost is the quiet BACK. `back` prefixes the ↩ glyph via CSS so
    the button's text stays exactly its label. */
export function SignBtn({
  variant, back, sm, className, children, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost"; back?: boolean; sm?: boolean }) {
  const cls = ["sign-btn", variant ?? "", back ? "back" : "", sm ? "sm" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <button type="button" className={cls} {...rest}>
      {children}
    </button>
  );
}

/** The 64×32 pill switch: a real checkbox under a painted pill. */
export function SignToggle({
  checked, onChange, label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <label className={checked ? "sign-toggle on" : "sign-toggle"}>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <i aria-hidden="true" />
    </label>
  );
}

/** A segmented control: a radiogroup of buttons, the chosen one sodium. */
export function SignSeg<T extends string>({
  value, options, onChange, label,
}: {
  value: T;
  options: { v: T; t: string }[];
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div className="sign-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={o.v === value}
          className={o.v === value ? "on" : undefined}
          onClick={() => onChange(o.v)}
        >
          {o.t}
        </button>
      ))}
    </div>
  );
}

/** A native <select> wearing the sign's bordered chip. */
export function SignSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className, ...rest } = props;
  return <select className={className ? `sign-select ${className}` : "sign-select"} {...rest} />;
}

/** The sodium slider: a range input over a painted track, fill and thumb.
    `text` is the formatted value shown to the right. */
export function SignSlider({
  min, max, step, value, onChange, label, text,
}: {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
  label?: string;
  text: string;
}) {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  /* --pct (a plain 0..100 number) is all the CSS needs: ui-system.css turns it
     into --sign-thumb-pos, the thumb-centre offset with the travel inset by
     half a thumb at each end, and paints both the fill's width and the thumb's
     left from that one expression. A raw `left: pct%` hung half the thumb off
     the track at both ends. */
  return (
    <div className="sign-sval">
      <div className="sign-slider" style={{ "--pct": pct } as CSSProperties}>
        <u aria-hidden="true" />
        <b aria-hidden="true" />
        <i aria-hidden="true" />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={label}
          onChange={(e) => onChange(+e.target.value)}
        />
      </div>
      <span className="sign-value">{text}</span>
    </div>
  );
}

/** A settings section head: EN in sodium, JP beside it. */
export function SignShead({ en, jp }: { en: string; jp?: string }) {
  return (
    <div className="sign-shead">
      {en}
      {jp && (
        <span className="ui-jp" lang="ja">
          {jp}
        </span>
      )}
    </div>
  );
}

/** One settings row: a name (with an optional faint aside) and its control.
    `stack` puts the control on its own line (sliders). `lit` is the sodium
    lane-edge rule on the row whose value just changed. */
export function SignSrow({
  name, aside, stack, lit, sub, last, children,
}: {
  name: ReactNode;
  aside?: ReactNode;
  stack?: boolean;
  lit?: boolean;
  sub?: boolean;
  last?: boolean;
  children: ReactNode;
}) {
  const cls = ["sign-srow", stack ? "stack" : "", lit ? "lit" : "", sub ? "sub" : "", last ? "last" : ""].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <div className="name">
        {name}
        {aside !== undefined && <span className="sign-cap faint aside">{aside}</span>}
      </div>
      {stack ? children : <div className="ctl">{children}</div>}
    </div>
  );
}

/* ---------- furniture ---------- */

/** The steel truss and its two posts, spanning the top of the screen. */
export function Gantry() {
  return (
    <div className="gantry" aria-hidden="true">
      <div className="gantry-truss" />
      <div className="gantry-lattice" />
      <div className="gantry-post l" />
      <div className="gantry-post r" />
    </div>
  );
}

/** The kilometre post at the bottom right: a number and a unit on a stub. */
export function SignKP({ value, unit = "KP" }: { value: string; unit?: string }) {
  return (
    <>
      <div className="sign-kp" aria-hidden="true">
        <div className="sign-kp-num">{value}</div>
        <div className="sign-kp-unit">{unit}</div>
      </div>
      <div className="sign-kp-post" aria-hidden="true" />
    </>
  );
}

/** CSS night road for screens shown before any world exists (the engine
    builds nothing until DRIVE — see Game.load). Unmount it once a world is
    loaded so the live dashcam shows through instead. */
export function NightRoad() {
  return (
    <div className="sign-night" aria-hidden="true">
      <div className="sign-night-deck" />
      <div className="sign-night-parapet l" />
      <div className="sign-night-parapet r" />
      <div className="sign-night-dash d1" />
      <div className="sign-night-dash d2" />
      <div className="sign-night-dash d3" />
      <div className="sign-night-haze" />
    </div>
  );
}
