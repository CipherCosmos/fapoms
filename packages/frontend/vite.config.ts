import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';

/**
 * Lets the shared package's own `./enums.js`-style imports resolve to the `.ts` files.
 *
 * `packages/shared` is compiled with NodeNext, so its sources import siblings with an explicit
 * `.js` extension even though the file on disk is `.ts`. esbuild tolerates that during dev,
 * but Rollup does not, so a production build failed with
 * `"ProjectBranchStatus" is not exported by "../shared/src/enums.js"`.
 *
 * Scoped to importers inside shared/src so it cannot affect any other dependency.
 */
const sharedTsSource = {
  name: 'shared-ts-source-resolver',
  enforce: 'pre' as const,
  resolveId(source: string, importer?: string) {
    if (!importer || !importer.includes(`${path.sep}shared${path.sep}src${path.sep}`)) return null;
    if (!source.startsWith('.') || !source.endsWith('.js')) return null;
    const candidate = path.resolve(path.dirname(importer), source.replace(/\.js$/, '.ts'));
    return fs.existsSync(candidate) ? candidate : null;
  },
};

// In Docker, the backend service is reachable at http://backend:3000
// Locally, it's http://localhost:3000
const API_TARGET = process.env.VITE_API_URL || 'http://localhost:3000';

// https://vite.dev/config/
export default defineConfig({
  plugins: [sharedTsSource, react()],
  build: {
    rollupOptions: {
      output: {
        /**
         * Split the heavy vendor libraries into their own chunks.
         *
         * Route pages are already code-split via React.lazy in App.tsx, but their bulky
         * dependencies (the pdf.js renderer, the Leaflet map, react-query, the realtime client)
         * would otherwise be duplicated or dragged into whichever page-chunk touched them first.
         * Pinning each to a named chunk keeps them cacheable and out of the entry bundle.
         */
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('pdfjs-dist')) return 'pdf';
          if (id.includes('leaflet')) return 'map';
          if (id.includes('@tanstack')) return 'query';
          if (id.includes('socket.io') || id.includes('engine.io')) return 'realtime';
          if (id.includes('react-router')) return 'router';
          if (id.includes('/react-dom/') || id.includes('/react/') || id.includes('/scheduler/')) return 'react';
          return 'vendor';
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      /**
       * Resolve the shared workspace package to its TypeScript source, not its build output.
       *
       * `@fapoms/shared` used to resolve to `dist/`, and was additionally listed in
       * `optimizeDeps.include`, so Vite pre-bundled it into a fixed chunk under
       * `node_modules/.vite/deps`. Every time a new export was added to shared, that chunk
       * kept serving the previous copy and the browser threw
       * "does not provide an export named X" until the cache was deleted by hand — which had
       * to be done inside the container, since that is where the dev server's node_modules
       * lives. It also meant shared had to be rebuilt before the frontend could see any edit.
       *
       * Pointing at source removes the build step and the cache from the loop entirely: Vite
       * treats shared as ordinary project code, so an edit hot-reloads like any other file.
       */
      '@fapoms/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    host: '0.0.0.0', // Allow access from outside (Docker)
    hmr: {
      // When running in Docker, the client connects from the host browser
      // on localhost:5173, so we need clientPort to match the exposed port
      clientPort: 5173,
    },
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
      '/socket.io': {
        target: API_TARGET,
        ws: true,
        changeOrigin: true,
      },
      // LiveKit signaling rides the backend's /livekit proxy; the browser only ever
      // connects to this dev server's origin.
      '/livekit': {
        target: API_TARGET,
        ws: true,
        changeOrigin: true,
      },
    },
    watch: {
      // Use polling for reliable file watching inside Docker (bind mounts)
      usePolling: true,
      interval: 1000,
    },
    fs: {
      // Shared now resolves outside this package's root, so the dev server has to be allowed
      // to serve it. Without this, importing it 403s instead of loading.
      allow: [path.resolve(__dirname, '..')],
    },
  },
  optimizeDeps: {
    include: ['pdfjs-dist'],
    // Never pre-bundle the workspace package — that is what made its exports go stale. It is
    // source now, so it belongs in the module graph with the rest of the app.
    exclude: ['@fapoms/shared'],
    esbuildOptions: {
      // The shared package ships .d.ts next to .js in dist/ (and src/). esbuild prefers .d.ts
      // over .js when resolving, which silently drops re-exported named exports. Kept for any
      // other dependency with the same layout.
      resolveExtensions: ['.js', '.mjs', '.jsx', '.cjs', '.ts', '.tsx', '.json'],
    },
  },
});
