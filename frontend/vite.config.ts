import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// ---------------------------------------------------------------------------
// Vite configuration for the LILA Tic-Tac-Toe React frontend.
//
// In dev mode we proxy /v2/* (Nakama HTTP API) and /ws (Nakama WebSocket) to
// the running Nakama server. This avoids CORS entirely — from the browser's
// perspective the SDK is talking to the same origin as the page, while Vite
// transparently forwards the requests upstream. In production builds the
// frontend talks to Nakama directly via the configured VITE_NAKAMA_HOST.
//
// The upstream target is configurable via VITE_NAKAMA_PROXY_TARGET so a
// developer running Nakama on a non-default host/port (e.g. WSL on a custom
// IP) can override it without editing this file.
// ---------------------------------------------------------------------------
export default defineConfig(({ mode }) => {
  // loadEnv reads .env / .env.local / .env.<mode> and returns a plain object.
  // We don't apply Vite's `VITE_` prefix filter here because we want to read
  // the proxy target which is *not* exposed to client code.
  const env = loadEnv(mode, process.cwd(), "");
  const nakamaUpstream = env.VITE_NAKAMA_PROXY_TARGET || "http://127.0.0.1:7350";

  return {
    plugins: [react()],
    server: {
      // 0.0.0.0 so the dev server is reachable from other devices on the LAN
      // (handy when testing the mobile UI on a real phone via Vite's QR code).
      host: true,
      port: 5173,
      strictPort: false,
      proxy: {
        // REST + RPC endpoints
        "/v2": {
          target: nakamaUpstream,
          changeOrigin: true,
        },
        // WebSocket — needed for the Nakama realtime socket. The `ws: true`
        // flag tells Vite to upgrade the connection.
        "/ws": {
          target: nakamaUpstream,
          changeOrigin: true,
          ws: true,
        },
      },
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
  };
});
