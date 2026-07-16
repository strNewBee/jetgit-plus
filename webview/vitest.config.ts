import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import Icons from 'unplugin-icons/vite';

export default defineConfig({
  // Match vite.config.ts: register the Icons plugin so the `~icons/...` virtual
  // modules resolve under vitest (operation panels import codicon icons).
  plugins: [react(), Icons({ compiler: 'jsx', jsx: 'react' })],
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
