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
        color: "#93a3cc",
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
