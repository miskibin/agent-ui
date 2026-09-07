import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  // Isolate verification builds from the server used by the desktop app.
  distDir: process.env.AGENT_UI_BUILD_DIR || ".next",
  // Self-contained production server (`node .next/standalone/server.js`):
  // fast cold start, no node_modules install on the target machine.
  output: "standalone",
  // Nothing in this app renders through `next/image` — every image is a plain
  // `<img>` pointed at a `data:` URL, a remote host, or `/api/files`. Turning
  // the optimizer off is what makes the exclusion below safe: with it on,
  // `/_next/image` exists and would reach for sharp at runtime.
  images: { unoptimized: true },
  outputFileTracingExcludes: {
    // sharp and its libvips prebuilds are ~46 MB of the standalone bundle and
    // are traced into every Next server build whether or not the image
    // optimizer is reachable. This app ships that bundle inside a desktop
    // installer, so those megabytes are paid for by every download.
    "*": [
      "node_modules/@img/**",
      "node_modules/sharp/**",
      // Repo files the trace pulls in that the server never reads. `src-tauri`
      // matters twice: a local rebuild would otherwise fold the previous
      // build's `src-tauri/resources/app` back into the new bundle.
      "tests/**",
      "website/**",
      "docs/**",
      "src-tauri/**",
      "package-lock.json",
      "app-icon.png",
    ],
  },
  experimental: {
    // The project runs TypeScript 7 (`tsc`, via the `@typescript/native` alias)
    // side by side with the TypeScript 6 JS API (the `typescript` package),
    // which typescript-eslint still requires. The TS 6 package only ships a
    // `tsc6` binary, so `next build` has to type check through the API rather
    // than shelling out to `typescript/bin/tsc`.
    useTypeScriptCli: false,
  },
  transpilePackages: [
    "streamdown",
    "@streamdown/code",
    "@streamdown/mermaid",
    "@streamdown/math",
    "mermaid",
  ],
};

export default nextConfig;
