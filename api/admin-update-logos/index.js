const { app } = require("@azure/functions");
const { CosmosClient } = require("@azure/cosmos");

const COSMOS_ENDPOINT = process.env.COSMOS_DB_ENDPOINT || "";
const COSMOS_KEY = process.env.COSMOS_DB_KEY || "";
const DATABASE_ID = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
const CONTAINER_ID = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";

const logoMapping = {
  "apple-inc": "/logos/apple.svg",
  "samsung-electronics": "/logos/samsung.svg",
  "sony-corporation": "/logos/sony.svg",
  "nike-inc": "/logos/nike.svg",
  "amazon-com": "/logos/amazon.svg",
  "microsoft-corp": "/logos/microsoft.svg",
  "google-llc": "/logos/google.svg",
  "intel-corp": "/logos/intel.svg",
  "tesla-inc": "/logos/tesla.svg",
};

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
}

async function updateLogos() {
  try {
    if (!COSMOS_KEY) {
      return { success: false, error: "Missing COSMOS_DB_KEY" };
    }

    const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
    const database = client.database(DATABASE_ID);
    const container = database.container(CONTAINER_ID);

    let updated = 0;
    let total = 0;

    for (const [companyId, logoUrl] of Object.entries(logoMapping)) {
      try {
        const partitionKeyValue = String(companyId).trim();
        const { resource: company } = await container.item(companyId, partitionKeyValue).read();
        if (company) {
          const updatedCompany = { ...company, logo_url: logoUrl };
          const normalizedDomain = String(company.normalized_domain || "unknown").trim();
          await container.item(companyId, normalizedDomain).replace(updatedCompany);
          updated++;
        }
        total++;
      } catch (e) {
        total++;
        console.error(`Error updating ${companyId}:`, e.message);
      }
    }

    return { success: true, updated, total, message: `Updated ${updated}/${total} companies` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

app.http("admin-update-logos", {
  route: "admin-update-logos",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    const method = String(req.method || "").toUpperCase();

    if (method === "OPTIONS") {
      return {
        status: 204,
        headers: getCorsHeaders(),
      };
    }

    try {
      const result = await updateLogos();
      return {
        status: result.success ? 200 : 400,
        body: JSON.stringify(result),
        headers: getCorsHeaders(),
      };
    } catch (e) {
      return {
        status: 500,
        body: JSON.stringify({ error: e.message }),
        headers: getCorsHeaders(),
      };
    }
  },
});
