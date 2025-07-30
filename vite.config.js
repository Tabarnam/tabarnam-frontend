// vite.config.js
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const aliases = {
    '@': resolve(__dirname, 'src'),
    '@pages': resolve(__dirname, 'src/pages'),
    '@components': resolve(__dirname, 'src/components'),
    '@contexts': resolve(__dirname, 'src/contexts'),
    '@lib': resolve(__dirname, 'src/lib'),
  };
  console.log('Resolved aliases:', aliases);
  return {
    plugins: [react()],
    resolve: {
      alias: aliases,
      extensions: ['.js', '.jsx', '.ts', '.tsx'],
    },
    build: {
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('/react/') || id.includes('/react-dom/')) return 'vendor-react';
              if (id.includes('/@tanstack/')) return 'vendor-tanstack';
              if (id.includes('/@radix-ui/')) return 'vendor-radix';
              if (id.includes('/framer-motion/')) return 'vendor-framer';
              if (id.includes('/sonner/')) return 'vendor-sonner';
              return 'vendor-other';
            }
          },
        },
      },
    },
    server: {
      proxy: {
        '/api': {
          target: env.VITE_VERCEL_URL || 'http://localhost:3000',
          changeOrigin: true,
          secure: false,
          rewrite: (path) => path.replace(/^\/api/, '/api'),
          configure: (proxy, _options) => {
            proxy.on('proxyReq', (proxyReq, req) => {
              console.log('Proxy Request Headers:', req.headers);
              proxyReq.setHeader('Origin', req.headers.origin || '*');
            });
            proxy.on('proxyRes', (proxyRes, req, res) => {
              console.log('Proxy Response Headers:', proxyRes.headers);
              proxyRes.headers['Access-Control-Allow-Origin'] = req.headers.origin || '*';
              proxyRes.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
              proxyRes.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
            });
          },
        },
      },
    },
  };
});