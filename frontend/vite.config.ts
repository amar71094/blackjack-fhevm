import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import fs from "fs";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const wasmMimePlugin = (): import("vite").Plugin => ({
  name: "wasm-mime",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = req.url?.split("?")[0];
      const wasmEntry =
        url &&
        Object.entries({
          "tfhe_bg.wasm": path.resolve(__dirname, "node_modules/@zama-fhe/relayer-sdk/lib/tfhe_bg.wasm"),
          "kms_lib_bg.wasm": path.resolve(__dirname, "node_modules/@zama-fhe/relayer-sdk/lib/kms_lib_bg.wasm"),
        }).find(([name]) => url.endsWith(name));

      if (wasmEntry) {
        const [, filePath] = wasmEntry;
        res.setHeader("Content-Type", "application/wasm");
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        if (fs.existsSync(filePath)) {
          fs.createReadStream(filePath).pipe(res);
          return;
        }
      }
      next();
    });
  },
});

const envValidationPlugin = (mode: string): import("vite").Plugin => ({
  name: "env-validation",
  buildStart() {
    if (mode !== "production") return;
    const env = loadEnv(mode, process.cwd(), "VITE_");
    if (!env.VITE_BLACKJACK_CONTRACT) {
      throw new Error("VITE_BLACKJACK_CONTRACT is required for production builds.");
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(env.VITE_BLACKJACK_CONTRACT)) {
      throw new Error("VITE_BLACKJACK_CONTRACT must be a valid 0x-prefixed address.");
    }
  },
});

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  plugins: [
    envValidationPlugin(mode),
    react(),
    nodePolyfills(),
    wasmMimePlugin(),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      util: "util",
      stream: "stream-browserify",
      process: "process/browser",
      buffer: "buffer",
    },
  },
  define: {
    global: "globalThis",
    "process.env": {},
  },
  assetsInclude: ["**/*.wasm"],
  optimizeDeps: {
    include: ["util", "buffer", "process", "stream-browserify"],
    esbuildOptions: {
      loader: {
        ".wasm": "binary",
      },
      define: {
        global: "globalThis",
      },
    },
  },
  build: {
    sourcemap: mode !== "production",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("@zama-fhe/relayer-sdk")) return "relayer-sdk";
          if (
            id.includes("/react-dom/") ||
            id.includes("/react-router-dom/") ||
            /\/node_modules\/react\//.test(id)
          ) {
            return "vendor-react";
          }
          if (id.includes("/wagmi/") || id.includes("/viem/")) return "vendor-wagmi";
        },
      },
    },
  },
}));
