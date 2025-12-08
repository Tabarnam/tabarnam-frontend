const { app } = require("@azure/functions");

function cors(req) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(obj, status = 200, req) {
  return {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

app.http("admin-storage-config", {
  route: "admin-storage-config",
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, ctx) => {
    if (req.method === "OPTIONS") return { status: 204, headers: cors(req) };

    try {
      // Check direct environment variables
      const directAccountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
      const directAccountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;

      // Check connection string fallback
      const connectionString = process.env.AzureWebJobsStorage;
      let fallbackAccountName = null;
      let fallbackAccountKey = null;

      if (connectionString) {
        const nameMatch = connectionString.match(/AccountName=([^;]+)/);
        const keyMatch = connectionString.match(/AccountKey=([^;=]+)/);
        fallbackAccountName = nameMatch ? nameMatch[1] : null;
        fallbackAccountKey = keyMatch ? keyMatch[1] : null;
      }

      // List all environment variables for debugging
      const storageEnvVars = {};
      const azureEnvVars = {};
      
      Object.keys(process.env).forEach(key => {
        if (key.includes('STORAGE') || key.includes('BLOB') || key.includes('ACCOUNT')) {
          storageEnvVars[key] = process.env[key] ? "SET" : "NOT SET";
        }
        if (key.includes('AZURE') && !key.includes('CRED') && !key.includes('PASS')) {
          azureEnvVars[key] = process.env[key] ? "SET" : "NOT SET";
        }
      });

      const response = {
        timestamp: new Date().toISOString(),
        directVariables: {
          AZURE_STORAGE_ACCOUNT_NAME: directAccountName ? "✓ SET" : "✗ NOT SET",
          AZURE_STORAGE_ACCOUNT_KEY: directAccountKey ? "✓ SET (hidden)" : "✗ NOT SET",
        },
        fallbackVariables: {
          AzureWebJobsStorage: connectionString ? "✓ SET" : "✗ NOT SET",
          parsedAccountName: fallbackAccountName ? "✓ EXTRACTED" : "✗ NOT EXTRACTED",
          parsedAccountKey: fallbackAccountKey ? "✓ EXTRACTED (hidden)" : "✗ NOT EXTRACTED",
        },
        finalCredentials: {
          accountName: (directAccountName || fallbackAccountName) ? "✓ AVAILABLE" : "✗ MISSING",
          accountKey: (directAccountKey || fallbackAccountKey) ? "✓ AVAILABLE" : "✗ MISSING",
        },
        allStorageEnvVars: storageEnvVars,
        allAzureEnvVars: azureEnvVars,
        diagnosis: {
          canUpload: (directAccountName || fallbackAccountName) && (directAccountKey || fallbackAccountKey),
          recommendation: (() => {
            if (directAccountName && directAccountKey) {
              return "✓ Direct variables are properly set. Uploads should work.";
            } else if (fallbackAccountName && fallbackAccountKey) {
              return "⚠ Using fallback from AzureWebJobsStorage. Consider setting direct variables for consistency.";
            } else if (connectionString) {
              return "⚠ AzureWebJobsStorage is set but credentials couldn't be parsed. Check format.";
            } else {
              return "✗ No storage credentials found. Set AZURE_STORAGE_ACCOUNT_NAME and AZURE_STORAGE_ACCOUNT_KEY in Function App Configuration.";
            }
          })(),
        },
      };

      return json(response, 200, req);
    } catch (error) {
      return json(
        {
          ok: false,
          error: error.message || "Diagnostic check failed",
          timestamp: new Date().toISOString(),
        },
        500,
        req
      );
    }
  },
});
