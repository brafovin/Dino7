import { defineConfig } from 'vite';

const SERVER_PORT = Number(process.env.SERVER_PORT ?? 3000);

export default defineConfig({
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/socket.io': { target: `http://localhost:${SERVER_PORT}`, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
