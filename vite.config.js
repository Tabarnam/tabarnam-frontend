// vite.config.js
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const API_TARGET =
    (env.VITE_FUNCTIONS_URL && env.VITE_FUNCTIONS_URL.trim()) ||
    (env.VITE_API_BASE && env.VITE_API_BASE.trim()) ||
    (env.VITE_API_URL && env.VITE_API_URL.trim()) ||
    "http://127.0.0.1:7071"; // Azure Functions Core Tools default

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
        "@pages": resolve(__dirname, "src/pages"),
        "@components": resolve(__dirname, "src/components"),
        "@contexts": resolve(__dirname, "src/contexts"),
        "@lib": resolve(__dirname, "src/lib"),
      },
      extensions: [".js", ".jsx", ".ts", ".tsx"],
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target: API_TARGET,
          changeOrigin: true,
          secure: false,
          ws: true,
          // keep /api prefix (Functions expects it)
          // raise timeouts for long POSTs (10 minutes)
          timeout: 600000,
          proxyTimeout: 600000,
          // no rewrite; preserve /api
          rewrite: (p) => p,
        },
      },
    },
    build: {
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("node_modules")) {
              if (id.includes("/react/") || id.includes("/react-dom/")) return "vendor-react";
              if (id.includes("/@tanstack/")) return "vendor-tanstack";
              if (id.includes("/@radix-ui/")) return "vendor-radix";
              if (id.includes("/framer-motion/")) return "vendor-framer";
              if (id.includes("/sonner/")) return "vendor-sonner";
              return "vendor-other";
            }
          },
        },
      },
    },
  };
});
