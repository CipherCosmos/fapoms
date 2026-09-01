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

/**
 * Host names this dev server will answer to, beyond the localhost set Vite always permits.
 *
 * Vite refuses any request whose Host header it does not recognise — a DNS-rebinding defence —
 * and says so with "Blocked request. This host is not allowed", which reads like a bug in the app
 * rather than a setting. Serving the stack behind a real domain therefore fails with a blank page
 * until that domain is listed.
 *
 * Read from the environment rather than written here, because the deployment already states its
 * own address: APP_PUBLIC_URL and FRONTEND_URL are what the app builds its links from, and
 * CORS_ORIGINS is the same list from the API's side. Deriving from those keeps one source of
 * truth in .env.docker, and means a new domain, a staging host or a second deployment needs no
 * code change. VITE_ALLOWED_HOSTS is the explicit override for anything those three miss.
 *
 * A bare hostname is accepted as well as a URL, and a leading dot ('.example.com') covers every
 * subdomain — Vite's own wildcard form. Ports are dropped: the check is on host only.
 */
function allowedHostsFromEnv(): string[] {
  const hosts = new Set<string>();

  const add = (raw?: string | null) => {
    const value = raw?.trim();
    if (!value) return;
    // Wildcard entries pass through untouched; URL parsing would reject them.
    if (value.startsWith('.')) {
      hosts.add(value);
      return;
    }
    try {
      hosts.add(new URL(value.includes('://') ? value : `http://${value}`).hostname);
    } catch {
      // Not parseable as a host — ignore it rather than crash the dev server on a typo.
    }
  };

  const addList = (raw?: string) => (raw ?? '').split(',').forEach(add);

  addList(process.env.VITE_ALLOWED_HOSTS);
  add(process.env.APP_PUBLIC_URL);
  add(process.env.FRONTEND_URL);
  addList(process.env.CORS_ORIGINS);

  // Localhost and bare IPs are allowed by Vite already; listing them again only adds noise.
  return [...hosts].filter((host) => host !== 'localhost' && host !== '127.0.0.1');
}

/**
 * Where the browser should open the hot-reload socket back to.
 *
 * This was a flat `clientPort: 5173`, which is only true when the browser talks to the dev
 * server directly. Behind a reverse proxy terminating TLS on 443, the page loads fine and then
 * the HMR client dials `wss://<host>:5173` — a port that is not published publicly — so every
 * load ends in "WebSocket closed without opened" in the console and edits stop hot-reloading.
 *
 * Derived from the same public URL as the allowed hosts, so there is one place to say where this
 * deployment lives. Direct/localhost access keeps the port it is actually served on.
 */
function hmrFromEnv() {
  const publicUrl = process.env.APP_PUBLIC_URL || process.env.FRONTEND_URL;
  if (!publicUrl) return { clientPort: 5173 };

  try {
    const url = new URL(publicUrl.includes('://') ? publicUrl : `http://${publicUrl}`);

    // Docker on a laptop: the browser reaches the published port directly, no proxy in between.
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return { clientPort: Number(url.port) || 5173 };
    }

    const secure = url.protocol === 'https:';
    return {
      // A page served over https cannot open a plain ws:// socket — the browser blocks it as
      // mixed content, which looks identical to the proxy refusing the connection.
      protocol: secure ? ('wss' as const) : ('ws' as const),
      host: url.hostname,
      clientPort: url.port ? Number(url.port) : secure ? 443 : 80,
    };
  } catch {
    return { clientPort: 5173 };
  }
}

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
          /**
           * The spreadsheet writer, alone, and never on the critical path.
           *
           * `vendor` is the catch-all for anything that matches no rule below, and `vendor` is
           * reachable from the entry, so `index.html` modulepreloads it. SheetJS is ~333 kB raw
           * (~100 kB gzip) and was landing there, which meant the LOGIN page downloaded the entire
           * Excel engine before anyone had signed in — for a library used by exactly one export
           * button on one screen. Pairing this rule with the dynamic `import('xlsx')` in
           * PlanningWorkspace's export handler means the chunk is fetched when somebody actually
           * asks for a spreadsheet, and never otherwise.
           */
          if (id.includes('/xlsx/') || id.includes('xlsx.mjs')) return 'xlsx';
          if (id.includes('pdfjs-dist')) return 'pdf';
          if (id.includes('leaflet')) return 'map';
          if (id.includes('@tanstack')) return 'query';
          if (id.includes('socket.io') || id.includes('engine.io')) return 'realtime';
          // Its own chunk, fetched only when a call starts (call.service imports it dynamically),
          // so livekit's transitive deps don't get pulled back into the initial vendor bundle.
          if (id.includes('livekit')) return 'livekit';
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
    // Public domains this deployment answers to, from the environment. Never `true`: that turns
    // the DNS-rebinding protection off entirely for anyone who can point a name at this host.
    allowedHosts: allowedHostsFromEnv(),
    // Where the browser dials back for hot reload: the published port when it reaches this
    // server directly, or the public host/443 when a proxy sits in front. See hmrFromEnv().
    hmr: hmrFromEnv(),
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
