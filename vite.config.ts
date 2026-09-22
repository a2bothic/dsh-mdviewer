import { defineConfig } from 'vite';

// Tauri expects a fixed port and does not want Vite clearing the terminal.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'es2021',
    minify: 'esbuild',
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
  },
});
