import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { pdfAssetsPlugin } from "./scripts/pdf-assets.mjs";

export default defineConfig({
  plugins: [react(), pdfAssetsPlugin()],
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      output: { codeSplitting: { groups: [
        { name: "pdf-runtime", test: /node_modules[\\/]pdfjs-dist[\\/]/, priority: 30 },
        { name: "math-renderer", test: /node_modules[\\/]katex[\\/]/, priority: 20 },
        { name: "react-runtime", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 20 },
      ] } },
    },
  },
});
