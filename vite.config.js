// vite.config.js
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { createServer } from 'http';

// Function to find an available port asynchronously
async function getAvailablePort(startPort = 3000) {
  const testServer = createServer();
  for (let port = startPort; port < startPort + 100; port++) {
    try {
      await new Promise((resolve, reject) => {
        testServer.listen(port, '0.0.0.0', () => resolve());
        testServer.on('error', (e) => {
          testServer.close();
          reject(e);
        });
      });
      testServer.close();
      return port;
    } catch (e) {
      continue;
    }
  }
  throw new Error('No available port found');
}

// Mock server with dynamic port
async function setupMockServer() {
  const port = await getAvailablePort(3000);
  const server = createServer((req, res) => {
    if (req.url === '/api/xai' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        console.log('Mock Server Received Body:', body);
        res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173'); // Match dev server port
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ companies: [{ company_name: 'Mock Co', url: 'http://mock.com' }] }));
      });
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });
  server.listen(port, () => console.log(`Mock API server running on http://localhost:${port}`));
  return port; // Return the port for proxy configuration
}

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
  console.log('VITE_VERCEL_URL:', env.VITE_VERCEL_URL);

  let mockPort;
  if (mode === 'development') {
    mockPort = await setupMockServer(); // Start mock server and get the port
  }

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
          target: mode === 'development' ? `http://localhost:${mockPort || 3000}` : env.VITE_VERCEL_URL || 'http://localhost:3000',
          changeOrigin: true,
          secure: env.VITE_VERCEL_URL ? true : false,
          rewrite: (path) => path.replace(/^\/api/, '/api'),
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