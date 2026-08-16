import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  server: {
    port: 8901,
    proxy: {
      "/api": { target: "http://127.0.0.1:8900" },
      "/ws": { target: "http://127.0.0.1:8900", ws: true },
    },
  },
});
