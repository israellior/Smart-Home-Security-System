import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/*
 * PORCHLIGHT_API_PROXY=https://api.porchl.stream npm run dev
 *
 * runs this checkout against a real server, through the dev server: the
 * browser sees one origin, so the server's CORS rule - which names the
 * deployed app and nothing else - never comes into it. It is how the face
 * scan is tried on a laptop's camera before it is deployed: a camera needs
 * a secure page, and http://localhost is one.
 *
 * The app's API address is set here rather than alongside it, because Git
 * Bash turns VITE_API_URL=/api into a path under C:/Program Files/Git.
 */
const apiProxy = process.env.PORCHLIGHT_API_PROXY;
if (apiProxy) process.env.VITE_API_URL = '/api';
const proxy = apiProxy
  ? {
      '/api': { target: apiProxy, changeOrigin: true },
      '/signal': { target: apiProxy, changeOrigin: true, ws: true }
    }
  : undefined;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy
  }
});
