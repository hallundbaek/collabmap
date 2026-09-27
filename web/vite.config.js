import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:4321",
        changeOrigin: true,
      },
      // Only proxy the data endpoint /a/<token>; do NOT match the SPA route
      // /area/<token> (which must fall through to index.html).
      "^/a/": {
        target: "http://localhost:4321",
        changeOrigin: true,
      },
    },
  },
});