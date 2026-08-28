"use client";

import dynamic from "next/dynamic";

const GameApp = dynamic(() => import("@/components/GameApp"), {
  ssr: false,
  loading: () => (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#05060c",
        color: "#a6b3d6",
        fontFamily: "var(--font-display), \"Segoe UI\", system-ui, sans-serif",
        letterSpacing: "0.2em",
        fontSize: 14,
      }}
    >
      LOADING 首都高 …
    </div>
  ),
});

export default function Page() {
  return <GameApp />;
}
