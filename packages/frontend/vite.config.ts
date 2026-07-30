import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// In Docker, the backend service is reachable at http://backend:3000
// Locally, it's http://localhost:3000
const API_TARGET = process.env.VITE_API_URL || 'http://localhost:3000';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
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
    },
    watch: {
      // Use polling for reliable file watching inside Docker (bind mounts)
      usePolling: true,
      interval: 1000,
    },
  },
  optimizeDeps: {
    include: ['@fapoms/shared'],
  },
});
