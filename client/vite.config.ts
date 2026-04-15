import { defineConfig } from "vite";

export default defineConfig({
  plugins: [],
  build: {
    outDir: "dist",
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/ws": {
        target: "http://localhost:8080",
        ws: true,
      },
      "/health": {
        target: "http://localhost:8080",
      },
    },
  },
});
