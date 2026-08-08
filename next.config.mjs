import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // the game engine manages its own WebGL lifecycle
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
