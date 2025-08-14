// C:\Users\jatlas\OneDrive\Tabarnam Inc\MVP Do It Yourself\tabarnam-frontend\vite.config.js
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig(async ({ mode }) => {
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
          target: mode === 'development' ? 'http://localhost:3000' : `https://tabarnam-xai-dedicated-b4a0gdchamaeb8cp.canadacentral-01.azurewebsites.net`,
          changeOrigin: true,
          secure: mode !== 'development',
          rewrite: (path) => path.replace(/^\/api/, '/xai'),
          configure: (proxy, _options) => {
            proxy.on('error', (err, req, res) => {
              console.error('Proxy Error:', err.message);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Proxy error' }));
            });
            proxy.on('proxyReq', (proxyReq, req) => {
              console.log('Proxy Request Headers:', req.headers);
              proxyReq.setHeader('Origin', req.headers.origin || 'http://localhost:5173');
            });
            proxy.on('proxyRes', (proxyRes, req, res) => {
              console.log('Proxy Response Headers:', proxyRes.headers);
              proxyRes.headers['Access-Control-Allow-Origin'] = req.headers.origin || 'http://localhost:5173';
              proxyRes.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
              proxyRes.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
            });
          },
        },
      },
    },
  };
});