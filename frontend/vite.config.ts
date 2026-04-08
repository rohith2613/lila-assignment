import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// ---------------------------------------------------------------------------
// Vite configuration for the LILA Tic-Tac-Toe React frontend.
//
// We keep this lean: just the React plugin, a sane dev-server host binding
// (so it works in WSL / Docker / phone-on-LAN testing), and an alias for
// `@/` pointing at /src to keep imports tidy.
// ---------------------------------------------------------------------------
export default defineConfig({
  plugins: [react()],
  server: {
    // 0.0.0.0 so the dev server is reachable from other devices on the LAN
    // (handy when testing the mobile UI on a real phone via Vite's QR code).
    host: true,
    port: 5173,
    strictPort: false,
  },
  preview: {
    host: true,
    port: 4173,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2020",
  },
});
