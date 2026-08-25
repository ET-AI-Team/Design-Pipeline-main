import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  // Reads the root .env directly via Vite's own loader rather than
  // ambient process.env - relying on ambient env meant this only
  // worked if whoever ran `bun run dev` happened to have already
  // sourced .env in that exact shell first. A plain `bun run dev`
  // (the documented way to start this app) silently fell back to the
  // wrong default port and every proxied request failed with
  // ECONNREFUSED - confirmed by reproducing it directly. loadEnv reads
  // the .env file itself, independent of how the process was launched.
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), '');
  const apiTarget = `http://localhost:${env.PORT ?? 4000}`;

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      proxy: {
        '/api': apiTarget,
        '/socket.io': { target: apiTarget, ws: true },
      },
    },
  };
});
