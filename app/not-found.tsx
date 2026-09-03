import Link from "next/link";

/* 404 for the whole app (app/not-found.tsx is the root fallback per
   node_modules/next/dist/docs/.../file-conventions/not-found.md). The game is
   one route; anything else is a typo or a stale link, so this only has to
   look like the game and point back at it. Inline styles against the tokens
   in app/globals.css, same treatment as the loading placeholder in
   app/page.tsx. */
export default function NotFound() {
  return (
    <main
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "var(--scrim-load, #05060c)",
        color: "var(--ink, #eef3ff)",
        fontFamily: "var(--font-body, 'Segoe UI', system-ui, sans-serif)",
        textAlign: "center",
      }}
    >
      <div style={{ maxWidth: 440 }}>
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            letterSpacing: "0.28em",
            fontSize: 14,
            color: "var(--accent-2, #7fd8ff)",
            textShadow: "0 0 12px var(--accent-glow)",
          }}
        >
          NEON EXPRESSWAY
        </div>
        <div style={{ marginTop: 6, fontSize: 12, letterSpacing: "0.4em", color: "var(--jp, #ff6f9c)" }}>
          首都高
        </div>
        <h1
          style={{
            margin: "28px 0 12px",
            fontFamily: "var(--font-display)",
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: "0.04em",
          }}
        >
          404 — no exit here
        </h1>
        <p style={{ margin: "0 0 26px", fontSize: 14, lineHeight: 1.55, color: "var(--ink-dim, #a6b3d6)" }}>
          That address isn&apos;t on the expressway. The game lives at the root.
        </p>
        <Link
          href="/"
          style={{
            display: "inline-block",
            minHeight: 44,
            boxSizing: "border-box",
            padding: "12px 28px",
            borderRadius: 999,
            fontFamily: "var(--font-display)",
            fontWeight: 600,
            letterSpacing: "0.18em",
            fontSize: 13,
            color: "var(--ink, #eef3ff)",
            textDecoration: "none",
            background: "var(--accent-soft, rgba(95,141,255,0.16))",
            border: "1px solid var(--accent-line, rgba(140,178,255,0.5))",
            boxShadow: "0 0 22px var(--accent-glow, rgba(95,141,255,0.4))",
          }}
        >
          BACK TO THE ROAD
        </Link>
      </div>
    </main>
  );
}
