"use client";

import { useEffect } from "react";
import { initAnalytics } from "@/lib/analytics";

/* Client-side PostHog bootstrap, mounted once in app/layout.tsx around the
   page. A component rather than a bare import so init runs in a mount
   effect — strictly client-side, after hydration, never during the server
   render — and so the client boundary stays confined to this file plus
   lib/analytics.ts instead of leaking "use client" into the layout.

   It renders its children untouched (no context is needed: game code talks
   to lib/analytics directly, which no-ops until this has run). Coexists
   with <Analytics /> from @vercel/analytics — that one is cookieless
   visitor counting for the Vercel dashboard, this one is product
   analytics; neither replaces the other. */
export default function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    initAnalytics();
  }, []);
  return <>{children}</>;
}
