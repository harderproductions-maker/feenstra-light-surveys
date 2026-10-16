import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'www',
    emptyOutDir: false,
    rollupOptions: {
      input: 'www/app.js',
      output: {
        entryFileNames: 'app.bundle.js'
      }
    }
  }
});