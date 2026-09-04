"use client";

import { NAME_LABEL } from "@/lib/build";

/* Last-resort error boundary: replaces the ROOT layout when it (or anything
   under it that no nearer boundary caught) throws during render, so it must
   render its own <html>/<body> and cannot rely on globals.css or the font
   variable being present (node_modules/next/dist/docs/.../error-handling.md,
   "Global errors"). Every colour here is therefore a literal — the same
   values as the tokens in app/globals.css, not references to them.

   The primary action is a full reload rather than the boundary's retry: the
   game engine owns a WebGL context and audio graph outside React, and a
   re-render of the tree does not rebuild those. */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  retry?: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          boxSizing: "border-box",
          background: "radial-gradient(120% 90% at 50% 110%, #141b3a 0%, #080a16 55%, #05060c 100%)",
          color: "#eef3ff",
          fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
          textAlign: "center",
        }}
      >
        <div style={{ maxWidth: 460 }}>
          <div
            style={{
              fontWeight: 700,
              letterSpacing: "0.28em",
              fontSize: 14,
              color: "#7fd8ff",
              textShadow: "0 0 12px rgba(95,141,255,0.4)",
            }}
          >
            {NAME_LABEL}
          </div>
          <div style={{ marginTop: 6, fontSize: 12, letterSpacing: "0.4em", color: "#ff6f9c" }}>首都高</div>
          <h1 style={{ margin: "28px 0 12px", fontSize: 22, fontWeight: 600, letterSpacing: "0.04em" }}>
            Something went wrong
          </h1>
          <p style={{ margin: "0 0 26px", fontSize: 14, lineHeight: 1.55, color: "#a6b3d6" }}>
            The page hit an error it couldn&apos;t drive through. Reloading starts the game fresh;
            your garage and stats are saved in this browser.
            {error?.digest ? (
              <span style={{ display: "block", marginTop: 10, fontSize: 11, color: "#7b87ab" }}>
                ref {error.digest}
              </span>
            ) : null}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              appearance: "none",
              cursor: "pointer",
              minHeight: 44,
              padding: "12px 28px",
              borderRadius: 999,
              fontWeight: 600,
              letterSpacing: "0.18em",
              fontSize: 13,
              color: "#eef3ff",
              background: "rgba(95,141,255,0.16)",
              border: "1px solid rgba(140,178,255,0.5)",
              boxShadow: "0 0 22px rgba(95,141,255,0.4)",
            }}
          >
            RELOAD
          </button>
        </div>
      </body>
    </html>
  );
}
