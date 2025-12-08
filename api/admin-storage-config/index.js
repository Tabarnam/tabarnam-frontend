const { app } = require("@azure/functions");

app.http("adminStorageConfig", {
  route: "xadmin-api-storage-config",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    try {
      // Collect all environment variables for diagnostic purposes
      const envKeys = Object.keys(process.env).sort();
      
      // Extract storage-related variables
      const storageVars = {};
      envKeys.forEach(key => {
        if (
          key.includes("AZURE_STORAGE") ||
          key.includes("AzureWebJobs") ||
          key.includes("STORAGE_ACCOUNT")
        ) {
          // Mask sensitive values for security
          const value = process.env[key];
          const isSensitive =
            key.includes("KEY") || key.includes("PASSWORD") || key.includes("SECRET");
          storageVars[key] = isSensitive ? `[${value ? "SET" : "NOT SET"}]` : value;
        }
      });

      // Check for the specific variables we need
      const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
      const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
      const azureWebJobsStorage = process.env.AzureWebJobsStorage;

      // Try to parse connection string
      let connectionStringAnalysis = null;
      if (azureWebJobsStorage) {
        const match = azureWebJobsStorage.match(/AccountName=([^;]+)/);
        connectionStringAnalysis = {
          hasAccountName: !!match,
          extractedAccountName: match ? match[1] : null,
          hasAccountKey: azureWebJobsStorage.includes("AccountKey="),
        };
      }

      const diagnostics = {
        timestamp: new Date().toISOString(),
        environmentStatus: {
          AZURE_STORAGE_ACCOUNT_NAME: accountName ? "SET" : "NOT SET",
          AZURE_STORAGE_ACCOUNT_KEY: accountKey ? "SET" : "NOT SET",
          AzureWebJobsStorage: azureWebJobsStorage ? "SET" : "NOT SET",
        },
        detectedVariables: storageVars,
        connectionStringAnalysis,
        nodeVersion: process.version,
        allEnvKeysCount: envKeys.length,
        recommendations: generateRecommendations(
          accountName,
          accountKey,
          azureWebJobsStorage
        ),
      };

      context.log("[adminStorageConfig] Diagnostics:", JSON.stringify(diagnostics, null, 2));

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(diagnostics),
      };
    } catch (error) {
      context.error("[adminStorageConfig] Error:", error.message);
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ok: false,
          error: error.message,
        }),
      };
    }
  },
});

function generateRecommendations(accountName, accountKey, azureWebJobsStorage) {
  const recommendations = [];

  if (!accountName) {
    recommendations.push(
      "AZURE_STORAGE_ACCOUNT_NAME is not set. Add it to Function App > Configuration > Application settings."
    );
  }

  if (!accountKey) {
    recommendations.push(
      "AZURE_STORAGE_ACCOUNT_KEY is not set. Add it to Function App > Configuration > Application settings."
    );
  }

  if (!accountName && !accountKey && !azureWebJobsStorage) {
    recommendations.push(
      "No storage credentials found. Either set AZURE_STORAGE_ACCOUNT_NAME + AZURE_STORAGE_ACCOUNT_KEY, or ensure AzureWebJobsStorage is configured."
    );
  }

  if (azureWebJobsStorage && !accountName && !accountKey) {
    recommendations.push(
      "AzureWebJobsStorage is set but individual variables are not. The upload-logo-blob API will try to parse the connection string."
    );
  }

  if (accountName && !accountKey) {
    recommendations.push(
      "AZURE_STORAGE_ACCOUNT_NAME is set but KEY is missing. Both are required."
    );
  }

  if (!accountName && accountKey) {
    recommendations.push(
      "AZURE_STORAGE_ACCOUNT_KEY is set but NAME is missing. Both are required."
    );
  }

  if (recommendations.length === 0) {
    recommendations.push("✅ Storage configuration appears correct!");
  }

  return recommendations;
}
