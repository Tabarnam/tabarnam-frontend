const { app } = require("@azure/functions");
const axios = require("axios");
const { CosmosClient } = require("@azure/cosmos");
const { getXAIEndpoint, getXAIKey, getProxyBase } = require("./_shared");

function json(obj, status = 200) {
  return {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,x-functions-key",
    },
    body: JSON.stringify(obj),
  };
}

// Helper: normalize industries array
function normalizeIndustries(input) {
  if (Array.isArray(input))
    return [...new Set(input.map((s) => String(s).trim()).filter(Boolean))];
  if (typeof input === "string")
    return [
      ...new Set(
        input
          .split(/[,;|]/)
          .map((s) => s.trim())
          .filter(Boolean)
      ),
    ];
  return [];
}

// Helper: normalize keywords
function normalizeKeywords(value, industries) {
  let kws = [];
  if (Array.isArray(value)) for (const v of value) kws.push(...String(v).split(","));
  else if (typeof value === "string") kws.push(...value.split(","));
  kws = kws.map((s) => s.trim()).filter(Boolean);
  const merged = [...new Set([...(kws || []), ...(industries || [])])].filter(Boolean);
  while (merged.length && merged.length < 5) merged.push(merged[merged.length - 1]);
  return merged.join(", ");
}

// Helper: get safe number
const safeNum = (n) => (Number.isFinite(Number(n)) ? Number(n) : undefined);

// Helper: parse center coordinates
function safeCenter(c) {
  const lat = safeNum(c?.lat),
    lng = safeNum(c?.lng);
  return lat !== undefined && lng !== undefined ? { lat, lng } : undefined;
}

// Helper: get normalized domain
const toNormalizedDomain = (s = "") => {
  try {
    const u = s.startsWith("http") ? new URL(s) : new URL(`https://${s}`);
    let h = u.hostname.toLowerCase();
    if (h.startsWith("www.")) h = h.slice(4);
    return h || "unknown";
  } catch {
    return "unknown";
  }
};

// Helper: enrich company data
function enrichCompany(company, center) {
  const c = { ...(company || {}) };
  c.industries = normalizeIndustries(c.industries);
  c.product_keywords = normalizeKeywords(c.product_keywords, c.industries);
  const urlForDomain = c.canonical_url || c.url || "";
  c.normalized_domain = toNormalizedDomain(urlForDomain);
  return c;
}

// Check if company already exists by normalized domain
async function findExistingCompany(container, normalizedDomain, companyName) {
  if (!container) return null;
  try {
    const query = {
      query: "SELECT c.id FROM c WHERE c.normalized_domain = @domain OR LOWER(c.company_name) = @name",
      parameters: [
        { name: "@domain", value: normalizedDomain },
        { name: "@name", value: (companyName || "").toLowerCase() },
      ],
    };
    const { resources } = await container.items
      .query(query, { enableCrossPartitionQuery: true })
      .fetchAll();
    return resources && resources.length > 0 ? resources[0] : null;
  } catch (e) {
    console.warn(`[import-start] Error checking for existing company: ${e.message}`);
    return null;
  }
}

// Helper: fetch logo for a company domain
async function fetchLogo(domain) {
  if (!domain || domain === "unknown") return null;

  try {
    const proxyBase = (process.env.XAI_EXTERNAL_BASE || process.env.XAI_PROXY_BASE || "").trim();
    if (!proxyBase) {
      // Fallback to Clearbit API
      return `https://logo.clearbit.com/${encodeURIComponent(domain)}`;
    }

    // Use logo-scrape API if available
    const xaiKey = (process.env.XAI_EXTERNAL_KEY || process.env.FUNCTION_KEY || "").trim();
    const logoUrl = `${proxyBase}/logo-scrape`;

    const response = await axios.post(logoUrl, { domain }, {
      timeout: 5000,
      headers: xaiKey ? { "Authorization": `Bearer ${xaiKey}` } : {}
    });

    if (response.data && response.data.logo_url) {
      console.log(`[import-start] Fetched logo for ${domain}`);
      return response.data.logo_url;
    }
  } catch (e) {
    console.log(`[import-start] Could not fetch logo for ${domain}: ${e.message}`);
  }

  // Fallback to Clearbit
  return `https://logo.clearbit.com/${encodeURIComponent(domain)}`;
}

// Save companies to Cosmos DB (skip duplicates)
async function saveCompaniesToCosmos(companies, sessionId) {
  try {
    const endpoint = (process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_DB_DB_ENDPOINT || "").trim();
    const key = (process.env.COSMOS_DB_KEY || process.env.COSMOS_DB_DB_KEY || "").trim();
    const databaseId = (process.env.COSMOS_DB_DATABASE || "tabarnam-db").trim();
    const containerId = (process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies").trim();

    if (!endpoint || !key) {
      console.warn("[import-start] Cosmos DB not configured, skipping save");
      return { saved: 0, failed: 0, skipped: 0 };
    }

    const client = new CosmosClient({ endpoint, key });
    const database = client.database(databaseId);
    const container = database.container(containerId);

    let saved = 0;
    let failed = 0;
    let skipped = 0;

    for (const company of companies) {
      try {
        const companyName = company.company_name || company.name || "";
        const normalizedDomain = company.normalized_domain || "unknown";

        // Check if company already exists
        const existing = await findExistingCompany(container, normalizedDomain, companyName);
        if (existing) {
          console.log(`[import-start] Skipping duplicate company: ${companyName} (${normalizedDomain})`);
          skipped++;
          continue;
        }

        // Fetch logo for the company
        let logoUrl = company.logo_url || null;
        if (!logoUrl && normalizedDomain !== "unknown") {
          logoUrl = await fetchLogo(normalizedDomain);
        }

        const doc = {
          id: `company_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          company_name: companyName,
          name: company.name || companyName,
          url: company.url || company.website_url || company.canonical_url || "",
          website_url: company.website_url || company.canonical_url || company.url || "",
          industries: company.industries || [],
          product_keywords: company.product_keywords || "",
          normalized_domain: normalizedDomain,
          logo_url: logoUrl || null,
          hq_lat: company.hq_lat,
          hq_lng: company.hq_lng,
          social: company.social || {},
          amazon_url: company.amazon_url || "",
          source: "xai_import",
          session_id: sessionId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        if (!doc.company_name && !doc.url) {
          failed++;
          continue;
        }

        await container.items.create(doc);
        saved++;
      } catch (e) {
        failed++;
        console.warn(`[import-start] Failed to save company: ${e.message}`);
      }
    }

    return { saved, failed, skipped };
  } catch (e) {
    console.error("[import-start] Error in saveCompaniesToCosmos:", e.message);
    return { saved: 0, failed: companies?.length || 0, skipped: 0 };
  }
}

app.http("importStart", {
  route: "import/start",
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  handler: async (req, context) => {
    console.log("[import-start] Function handler invoked");

    try {
      const method = String(req.method || "").toUpperCase();
      if (method === "OPTIONS") {
        return {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
            "Access-Control-Allow-Headers": "content-type,x-functions-key",
          },
        };
      }

      const bodyObj = await req.json().catch(() => ({}));
      const sessionId = bodyObj.session_id || `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      console.log(`[import-start] Received request with session_id: ${sessionId}`);
      console.log(`[import-start] Request body:`, JSON.stringify(bodyObj));

      const startTime = Date.now();

      try {
        const center = safeCenter(bodyObj.center);
        const xaiPayload = {
          queryType: bodyObj.queryType || "product_keyword",
          query: bodyObj.query || "",
          limit: Math.max(1, Math.min(Number(bodyObj.limit) || 10, 25)),
          expand_if_few: bodyObj.expand_if_few ?? true,
          session_id: sessionId,
          ...(center ? { center } : {}),
        };

        console.log(`[import-start] XAI Payload:`, JSON.stringify(xaiPayload));

        const timeout = Math.max(1000, Number(bodyObj.timeout_ms) || 600000);
        console.log(`[import-start] Request timeout: ${timeout}ms`);

        // Get XAI configuration (consolidated to use XAI_EXTERNAL_BASE primarily)
        const xaiUrl = getXAIEndpoint();
        const xaiKey = getXAIKey();

        console.log(`[import-start] XAI Endpoint: ${xaiUrl ? "configured" : "NOT SET"}`);
        console.log(`[import-start] XAI Key: ${xaiKey ? "configured" : "NOT SET"}`);
        console.log(`[import-start] Config source: ${process.env.XAI_EXTERNAL_BASE ? "XAI_EXTERNAL_BASE" : process.env.FUNCTION_URL ? "FUNCTION_URL (legacy)" : "none"}`);

        if (!xaiUrl || !xaiKey) {
          return json({
            ok: false,
            error: "XAI not configured",
            message: "Please set XAI_EXTERNAL_BASE and XAI_EXTERNAL_KEY environment variables",
            session_id: sessionId,
          }, 500);
        }

        // Build XAI request message
        const xaiMessage = {
          role: "user",
          content: `You are a business research assistant. Find and return information about ${xaiPayload.limit} DIFFERENT companies or products based on this search.

Search query: "${xaiPayload.query}"
Search type: ${xaiPayload.queryType}

CRITICAL INSTRUCTIONS:
1. PRIORITIZE SMALLER, REGIONAL, AND LESSER-KNOWN COMPANIES - these should be the majority of results
2. Include a diversity of company sizes: 40% small/regional/emerging, 35% mid-market, 25% major brands
3. Return DIVERSE companies - include independent manufacturers, local producers, regional specialists, family-owned businesses, and emerging/niche players
4. Do NOT just return major dominant brands - if searching "chocolate", prioritize smaller producers like Lake Champlain, Endangered Species Chocolate, Godiva, before returning Hershey's or Barry Callebaut
5. Prioritize finding DIFFERENT companies over finding more of the same type
6. Include regional and international companies, not just US-based ones
7. Look for specialty manufacturers, craft producers, and companies with unique positioning
8. Verify each company URL is valid and returns a real website

Format your response as a valid JSON array of company objects. Each object must have:
- company_name (string): The exact name of the company
- url (string): The valid company website URL (must be a working website)
- industries (array): List of industry categories
- product_keywords (string): Comma-separated product keywords specific to this company
- hq_lat (number, optional): Headquarters latitude
- hq_lng (number, optional): Headquarters longitude
- amazon_url (string, optional): Amazon storefront URL if applicable
- social (object, optional): Social media URLs {linkedin, instagram, x, twitter, facebook, tiktok, youtube}

Return ONLY the JSON array, no other text. Return at least ${Math.max(1, xaiPayload.limit)} diverse results if possible.`,
        };

        const xaiRequestPayload = {
          messages: [xaiMessage],
          model: "grok-4-latest",
          temperature: 0.1,
          stream: false,
        };

        try {
          console.log(`[import-start] Calling XAI API at: ${xaiUrl}`);
          const xaiResponse = await axios.post(xaiUrl, xaiRequestPayload, {
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${xaiKey}`,
          },
          timeout: Math.max(1000, Number(process.env.XAI_TIMEOUT_MS) || 60000),
        });

        const elapsed = Date.now() - startTime;
        console.log(`[import-start] XAI response received after ${elapsed}ms, status: ${xaiResponse.status}`);

        if (xaiResponse.status >= 200 && xaiResponse.status < 300) {
          // Extract the response content
          const responseText = xaiResponse.data?.choices?.[0]?.message?.content || JSON.stringify(xaiResponse.data);
          console.log(`[import-start] XAI response preview: ${responseText.substring(0, 100)}...`);

          // Parse the JSON array from the response
          let companies = [];
          try {
            const jsonMatch = responseText.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              companies = JSON.parse(jsonMatch[0]);
              if (!Array.isArray(companies)) companies = [];
            }
          } catch (parseErr) {
            console.warn(`[import-start] Failed to parse companies from response: ${parseErr.message}`);
            companies = [];
          }

          console.log(`[import-start] Found ${companies.length} companies in XAI response`);

          const center = safeCenter(bodyObj.center);
          let enriched = companies.map((c) => enrichCompany(c, center));

          let saveResult = { saved: 0, failed: 0, skipped: 0 };
          if (enriched.length > 0) {
            saveResult = await saveCompaniesToCosmos(enriched, sessionId);
            console.log(`[import-start] Saved ${saveResult.saved} companies, skipped: ${saveResult.skipped}, failed: ${saveResult.failed}`);
          }

          // If expand_if_few is enabled and we got very few results (or all were skipped), try alternative search
          const minThreshold = Math.max(1, Math.ceil(xaiPayload.limit * 0.6));
          if (xaiPayload.expand_if_few && (saveResult.saved + saveResult.failed) < minThreshold && companies.length > 0) {
            console.log(`[import-start] Few results found (${saveResult.saved} saved, ${saveResult.skipped} skipped). Attempting expansion search.`);

            try {
              // Create a more general search prompt for related companies
              const expansionMessage = {
                role: "user",
                content: `You previously found companies for "${xaiPayload.query}" (${xaiPayload.queryType}).
Find ${xaiPayload.limit} MORE DIFFERENT companies that are related to "${xaiPayload.query}" but were not in the previous results.
PRIORITIZE finding smaller, regional, and lesser-known companies that are alternatives to major brands.
Focus on independent manufacturers, craft producers, specialty companies, and regional players that serve the same market.

Format your response as a valid JSON array with the same structure:
- company_name (string)
- url (string)
- industries (array)
- product_keywords (string)
- hq_lat, hq_lng, amazon_url, social (optional)

Return ONLY the JSON array, no other text.`,
              };

              const expansionPayload = {
                messages: [expansionMessage],
                model: "grok-4-latest",
                temperature: 0.3,
                stream: false,
              };

              console.log(`[import-start] Making expansion search for "${xaiPayload.query}"`);
              const expansionResponse = await axios.post(xaiUrl, expansionPayload, {
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${xaiKey}`,
                },
                timeout: Math.max(1000, Number(process.env.XAI_TIMEOUT_MS) || 60000),
              });

              if (expansionResponse.status >= 200 && expansionResponse.status < 300) {
                const expansionText = expansionResponse.data?.choices?.[0]?.message?.content || "";
                console.log(`[import-start] Expansion response preview: ${expansionText.substring(0, 100)}...`);

                let expansionCompanies = [];
                try {
                  const jsonMatch = expansionText.match(/\[[\s\S]*\]/);
                  if (jsonMatch) {
                    expansionCompanies = JSON.parse(jsonMatch[0]);
                    if (!Array.isArray(expansionCompanies)) expansionCompanies = [];
                  }
                } catch (parseErr) {
                  console.warn(`[import-start] Failed to parse expansion companies: ${parseErr.message}`);
                }

                console.log(`[import-start] Found ${expansionCompanies.length} companies in expansion search`);

                if (expansionCompanies.length > 0) {
                  const enrichedExpansion = expansionCompanies.map((c) => enrichCompany(c, center));
                  enriched = enriched.concat(enrichedExpansion);

                  // Re-save with expansion results
                  const expansionResult = await saveCompaniesToCosmos(enrichedExpansion, sessionId);
                  saveResult.saved += expansionResult.saved;
                  saveResult.skipped += expansionResult.skipped;
                  saveResult.failed += expansionResult.failed;
                  console.log(`[import-start] Expansion: saved ${expansionResult.saved}, skipped ${expansionResult.skipped}, failed ${expansionResult.failed}`);
                }
              }
            } catch (expansionErr) {
              console.warn(`[import-start] Expansion search failed: ${expansionErr.message}`);
              // Continue without expansion results
            }
          }

          return json({
            ok: true,
            session_id: sessionId,
            companies: enriched,
            meta: { mode: "direct", expanded: xaiPayload.expand_if_few && (saveResult.saved + saveResult.failed) < minThreshold },
            saved: saveResult.saved,
            skipped: saveResult.skipped,
            failed: saveResult.failed,
          }, 200);
        } else {
          console.error(`[import-start] XAI error status: ${xaiResponse.status}`);
          return json(
            {
              ok: false,
              error: `XAI returned ${xaiResponse.status}`,
              session_id: sessionId,
            },
            502
          );
        }
      } catch (xaiError) {
        const elapsed = Date.now() - startTime;
        console.error(`[import-start] XAI call failed after ${elapsed}ms:`, xaiError.message);
        console.error(`[import-start] Error code: ${xaiError.code}`);
        if (xaiError.response) {
          console.error(`[import-start] XAI error status: ${xaiError.response.status}`);
          console.error(`[import-start] XAI error data:`, JSON.stringify(xaiError.response.data).substring(0, 200));
        }

        return json(
          {
            ok: false,
            error: `XAI call failed: ${xaiError.message}`,
            session_id: sessionId,
          },
          502
        );
      }
      } catch (e) {
        console.error(`[import-start] Unexpected error:`, e.message);
        console.error(`[import-start] Full error:`, e);
        return json(
          {
            ok: false,
            error: `Server error: ${e.message}`,
            session_id: sessionId,
          },
          500
        );
      }
    } catch (e) {
      console.error("[import-start] Top-level error:", e.message || e);
      return json(
        {
          ok: false,
          error: `Fatal error: ${e?.message || 'Unknown error'}`,
        },
        500
      );
    }
  },
});
