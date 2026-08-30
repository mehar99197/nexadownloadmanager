import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * One bundle, two mount points: /admin for staff and /root for the creator.
 *
 * `base` stays /admin/ so every asset resolves to one absolute, cacheable path
 * from either mount. In production nginx aliases /root/ to the same dist; the
 * dev server only understands `base`, so this plugin serves the same SPA shell
 * for /root navigations. The browser URL is left untouched, and the app reads
 * it (src/realm.js) to decide which panel to render.
 *
 * This is presentation only. /api/root is gated server-side by its own token
 * family, so reaching the creator HTML grants nothing without a root session.
 */
function dualMountDev() {
  return {
    name: 'ndm-dual-mount-dev',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const [pathname] = (req.url || '').split('?');
        const isRootMount = pathname === '/root' || pathname.startsWith('/root/');
        // Navigations only. Asset requests are already absolute under /admin/
        // because that is the configured base, so they never land here.
        if (isRootMount && !/\.[a-z0-9]+$/i.test(pathname)) req.url = '/admin/index.html';
        next();
      });
    },
  };
}

// Admin panel — served under /admin (staff) and /root (creator) in production.
export default defineConfig({
  plugins: [react(), tailwindcss(), dualMountDev()],
  base: '/admin/',
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
