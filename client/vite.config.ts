import { defineConfig } from "vite";

export default defineConfig({
  // Build the crypto worker as an ES module so it can use import.meta.url
  // and the browser can apply strict origin checks on it.
  worker: {
    format: "es",
  },

  build: {
    // Target browsers that natively support Web Crypto X25519 (Chrome 113+,
    // Firefox 130+, Safari 17+).
    target: "es2022",
    // Disable minification of worker code so CSP violations are legible
    // in development; re-enable for production if desired.
    rollupOptions: {
      output: {
        // Keep worker files identifiable in the bundle.
        entryFileNames: "[name]-[hash].js",
      },
    },
  },

  // Development server: emit the security headers required for SharedArrayBuffer
  // and strict worker isolation (COOP + COEP).
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },

  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
