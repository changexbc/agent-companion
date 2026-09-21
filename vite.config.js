import { defineConfig } from 'vite';
export default defineConfig({
  // Browser previews are UI-only; native development uses the shared Rust service.
  build: { rollupOptions: { input: { desktop: 'desktop.html', settings: 'desktop-settings.html' } } },
});
