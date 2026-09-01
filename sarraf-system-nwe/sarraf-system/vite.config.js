import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The build's own name, written into the bundle and into a file the running app can ask for.
//
// Every fix shipped this morning was invisible on the owner's phone: the code was on the server,
// the screen kept showing sentences that no longer exist in the source, and neither of us could
// tell. A build nobody can name is a build nobody can confirm.
const BUILD_ID = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);

// Written into dist/ so the running app can compare it against its own, with no cache in the way.
const buildStamp = () => ({
  name: "zeman-build-stamp",
  generateBundle() {
    this.emitFile({
      type: "asset",
      fileName: "version.json",
      source: JSON.stringify({ build: BUILD_ID }),
    });
  },
});

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [react(), buildStamp()],
  build: {
    // esbuild left the application chunk just over the 500 kB production budget that
    // scripts/verify-production-readiness.mjs enforces. Terser compresses meaningfully
    // harder; console/debugger stripping also keeps operational detail out of a build
    // that handles customer financial data.
    minify: "terser",
    terserOptions: {
      compress: { passes: 2, drop_debugger: true, pure_funcs: ["console.debug", "console.info"] },
      format: { comments: false },
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/src/i18n/")) return "i18n";
          // The shared layer, in its own chunk rather than inside one feature's.
          //
          // Without this line rollup put the services wherever it first needed them, which was
          // portal-ui — and receipts-ui then imported portal-ui to reach them, while portal-ui
          // already imported receipts-ui for CanonicalBatchSummary (one component used by both
          // the reviewer and the sender, deliberately, so the totals cannot differ between them).
          // Two chunks importing each other is a cycle rollup warns about and a browser has to
          // fetch both of before either can run.
          if (id.includes("/src/services/")) return "app-services";
          if (id.includes("/src/components/operations/")) return "operations-ui";
          if (id.includes("/src/components/receipts/")) return "receipts-ui";
          if (id.includes("/src/components/portal/")) return "portal-ui";
          if (id.includes("/src/components/market/")) return "market-ui";
          // The shell's own pieces — the error boundary and the update banner — are small and
          // are not part of the screen anybody is looking at. Keeping them out of the main
          // chunk keeps it under the production budget verify:production enforces.
          if (id.includes("/src/components/system/")) return "system-ui";
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@supabase") || id.includes("iceberg-js")) return "supabase-vendor";
          if (id.includes("lucide-react")) return "icons-vendor";
          if (id.includes("react") || id.includes("scheduler")) return "react-vendor";
          return "vendor";
        },
      },
    },
  },
});
