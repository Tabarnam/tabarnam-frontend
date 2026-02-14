import { createRequire } from "module";
import { URL } from "url";

const require = createRequire(import.meta.url);

/**
 * A Vite middleware that simulates the Azure Functions runtime for local development.
 * This allows the API to work without needing the Azure Functions Core Tools (func).
 */
export function devApiMiddleware(server) {
  // Load the API app and register all routes
  // We do this inside the middleware to ensure environment variables are loaded
  let app;
  try {
    // Clear require cache for api files to ensure fresh registration
    Object.keys(require.cache).forEach(key => {
      if (key.includes("/api/")) {
        delete require.cache[key];
      }
    });

    const appMod = require("../api/_app");
    app = appMod.app;
    require("../api/index");
    console.log("✓ [devApiMiddleware] API routes registered locally");
  } catch (err) {
    console.error("✗ [devApiMiddleware] Failed to load API:", err);
    return;
  }

  server.middlewares.use(async (req, res, next) => {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    
    // Only handle /api/ and /xapi/ routes
    const isApi = urlObj.pathname.startsWith("/api/");
    const isXapi = urlObj.pathname.startsWith("/xapi/");
    
    if (!isApi && !isXapi) {
      return next();
    }

    // Strip prefix to get the route path
    const routePath = urlObj.pathname.replace(/^\/(api|xapi)\//, "");
    
    // Find the matching registration
    const registrations = app._test.listHttpRegistrations();
    
    // Try to match by route first, then by name
    let registration = registrations.find(r => String(r.route || "").toLowerCase() === routePath.toLowerCase());
    if (!registration) {
      registration = registrations.find(r => String(r.name || "").toLowerCase() === routePath.toLowerCase());
    }

    if (!registration || typeof registration.handler !== "function") {
      // If no local handler, let it fall through to the proxy (if configured) or 404
      return next();
    }

    try {
      // Mock Azure Functions request object
      const azReq = {
        method: req.method,
        url: urlObj.toString(),
        headers: req.headers,
        query: urlObj.searchParams,
        params: {}, // We don't support route parameters in this simple shim yet
        body: null,
        // Basic body reading
        async json() {
          if (this.body) return this.body;
          return new Promise((resolve, reject) => {
            let data = "";
            req.on("data", chunk => data += chunk);
            req.on("end", () => {
              try {
                this.body = JSON.parse(data);
                resolve(this.body);
              } catch (e) {
                reject(e);
              }
            });
            req.on("error", reject);
          });
        },
        async text() {
          return new Promise((resolve, reject) => {
            let data = "";
            req.on("data", chunk => data += chunk);
            req.on("end", () => resolve(data));
            req.on("error", reject);
          });
        }
      };

      // Mock Azure Functions context object
      const azContext = {
        log: (...args) => console.log(`[api:${registration.name}]`, ...args),
        error: (...args) => console.error(`[api:${registration.name}]`, ...args),
        invocationId: Math.random().toString(36).slice(2),
        functionName: registration.name,
      };

      // Call the handler
      const result = await registration.handler(azReq, azContext);

      // Handle the result
      const status = result.status || 200;
      const headers = result.headers || {};
      const body = result.body;

      res.statusCode = status;
      for (const [key, value] of Object.entries(headers)) {
        res.setHeader(key, value);
      }

      if (body !== undefined) {
        if (typeof body === "string") {
          res.end(body);
        } else {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(body));
        }
      } else {
        res.end();
      }
    } catch (err) {
      console.error(`[devApiMiddleware] Error in handler ${registration.name}:`, err);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        ok: false,
        error: err.message,
        stack: isDev() ? err.stack : undefined
      }));
    }
  });
}

function isDev() {
  return process.env.NODE_ENV === "development" || !process.env.NODE_ENV;
}

export const devApiMiddlewarePlugin = {
  name: "dev-api-middleware",
  apply: "serve",
  configureServer(server) {
    devApiMiddleware(server);
  }
};
