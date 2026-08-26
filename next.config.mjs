import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // the game engine manages its own WebGL lifecycle
  outputFileTracingRoot: __dirname,
  /* Phone testing over the LAN. Next 16 refuses to serve /_next/* dev
     resources to an origin it does not recognise, so a phone hitting
     http://<mac-lan-ip>:3000 gets the HTML and then has every JS chunk and the
     HMR socket blocked — the game sits on its loading screen forever with
     nothing in the page to say why. The reason only appears in the SERVER log.

     DEV ONLY: `next build` ignores this, so it cannot widen anything in
     production. Private-range hosts only. The 192.168.4.x entry is this Mac's
     current DHCP lease and will rot when the router hands out a different one
     — if the phone starts hanging on the loading screen again, re-check with
     `ipconfig getifaddr en0` and update this list. */
  allowedDevOrigins: ["192.168.4.34", "192.168.4.*"],
};

export default nextConfig;
