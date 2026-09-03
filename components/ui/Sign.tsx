/* The Blue Route sign kit — the React half of app/ui-system.css.

   Everything here is a thin wrapper over the .sign-* classes so a screen can
   be assembled from the same handful of parts the home screen uses: a Gantry
   spanning the top, a SignPlate (the blue board) with a SignHead, a SignRule,
   and SignRows for each choice. The styling lives entirely in the CSS; these
   components only fix the markup so every screen gets the same DOM shape
   (and the same tap targets, focus rings and font switches) for free.

   Keep these presentational: no game imports, no state. */

import type { ButtonHTMLAttributes, ReactNode } from "react";

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
export function SignP() {
  return (
    <span className="sign-p" aria-hidden="true">
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

/** The blue board itself. `hangers` adds the three bracket-and-fixture
    stubs that visually tie it to a Gantry above. */
export function SignPlate({
  hangers = false,
  className,
  children,
}: {
  hangers?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className ? `sign ${className}` : "sign"}>
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

export function SignRule() {
  return <div className="sign-rule" aria-hidden="true" />;
}

export function SignSep() {
  return <div className="sign-sep" aria-hidden="true" />;
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
  /** the ONE sodium-lit row on the screen: primary action or selected item
      (System sheet: orange lane-edge rule + tint + glow + slow hum) */
  selected?: boolean;
}

/** One destination row — a real <button>, so Tab/Enter/Space and the test
    harness's textContent lookups all keep working. Text order inside is
    JP, EN, badge, distance; the glyph is aria-hidden SVG. */
export function SignRow({ glyph = "up", jp, en, badge, badgeOn, dist, selected, className, ...rest }: SignRowProps) {
  const cls = ["sign-row", selected ? "sel" : "", className ?? ""].filter(Boolean).join(" ");
  let glyphNode: ReactNode;
  if (glyph === "p") glyphNode = <SignP />;
  else if (typeof glyph === "string") glyphNode = <SignArrow dir={glyph as ArrowDir} />;
  else glyphNode = glyph;
  return (
    <button type="button" className={cls} {...rest}>
      <span className="sign-arrow">{glyphNode}</span>
      <span className="sign-jp" lang="ja">
        {jp}
      </span>
      <span className="sign-en">{en}</span>
      {badge !== undefined && <span className={badgeOn ? "sign-chip on" : "sign-chip"}>{badge}</span>}
      {dist !== undefined && (
        <span className="sign-dist" aria-hidden="true">
          {dist}
          <span>km</span>
        </span>
      )}
    </button>
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
