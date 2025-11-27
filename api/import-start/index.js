const { app } = require("@azure/functions");
const axios = require("axios");
const { CosmosClient } = require("@azure/cosmos");
const { getXAIEndpoint, getXAIKey, getProxyBase } = require("../_shared");

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

// Helper: enrich company data with location fields
function enrichCompany(company, center) {
  const c = { ...(company || {}) };
  c.industries = normalizeIndustries(c.industries);
  c.product_keywords = normalizeKeywords(c.product_keywords, c.industries);
  const urlForDomain = c.canonical_url || c.url || "";
  c.normalized_domain = toNormalizedDomain(urlForDomain);

  // Ensure location fields are present
  c.headquarters_location = String(c.headquarters_location || "").trim();
  c.manufacturing_locations = Array.isArray(c.manufacturing_locations)
    ? c.manufacturing_locations.filter(l => String(l).trim()).map(l => String(l).trim())
    : [];
  c.red_flag = Boolean(c.red_flag);
  c.red_flag_reason = String(c.red_flag_reason || "").trim();
  c.location_confidence = (c.location_confidence || "medium").toString().toLowerCase();

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
          headquarters_location: company.headquarters_location || "",
          manufacturing_locations: company.manufacturing_locations || [],
          red_flag: Boolean(company.red_flag),
          red_flag_reason: company.red_flag_reason || "",
          location_confidence: company.location_confidence || "medium",
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

        // Build XAI request message with PRIORITY on HQ and manufacturing locations
        const xaiMessage = {
          role: "user",
          content: `You are a business research assistant. Find and return information about ${xaiPayload.limit} DIFFERENT companies or products based on this search.

Search query: "${xaiPayload.query}"
Search type: ${xaiPayload.queryType}

CRITICAL PRIORITY #1: HEADQUARTERS & MANUFACTURING LOCATIONS (THIS IS THE TOP VALUE PROP)
These location fields are FIRST-CLASS and non-negotiable:

1. HEADQUARTERS LOCATION (Required, high priority):
   - Extract the company's headquarters location at minimum: city, state/region, country.
   - If no street address is available, that is acceptable - city + state/region + country is the minimum acceptable.
   - Use the company's official "Headquarters", "Head Office", or primary corporate address.
   - Check: Official website's About/Contact pages, LinkedIn company profile, Crunchbase, business directories.
   - Acceptable formats: "San Francisco, CA, USA" or "London, UK" or "Tokyo, Japan"

2. MANUFACTURING LOCATIONS (Array, strongly encouraged):
   - Gather ALL identifiable manufacturing, production, factory, and plant locations.
   - Return as an array of strings, each string being a location.
   - Acceptable detail per entry: Full address OR City + state/region + country OR country only.
   - Examples: ["Charlotte, NC, USA", "Shanghai, China", "Germany", "Made in USA and Canada"]
   - Check sources: official "Facilities", "Plants", "Manufacturing", "Where We Make" pages; product pages with "Made in..." claims; FAQs about production.
   - If specific factories are named, extract them as separate entries.

3. RED FLAG LOGIC:
   - If NO HQ location can be found from any reliable source → red_flag: true, reason: "No verifiable HQ location from official or trusted sources."
   - If HQ is found but manufacturing locations are unclear/vague → red_flag: true, reason: "Manufacturing locations vague or unverifiable."
   - If HQ is clear AND manufacturing locations are reasonably documented (countries/cities/sites) → red_flag: false, reason: ""
   - Only set red_flag: false when BOTH HQ and manufacturing info are reasonably supported.

4. SOURCE PRIORITY (check in this order):
   a) Official website: About, Contact, Locations, Our Facilities, Plants, Manufacturing, Where We Make sections
   b) Footer or "Corporate Office" section
   c) LinkedIn company profile (for HQ city + country)
   d) Crunchbase / public business directories (for HQ)
   e) Product pages / packaging with "Made in..." claims
   f) FAQs or press releases mentioning facilities
   - If sources conflict, favor official site and LinkedIn.
   - If still unclear, pick the most recent/authoritative source and set red_flag: true with explanation.

SECONDARY: DIVERSITY & COVERAGE
- Prioritize smaller, regional, and lesser-known companies (40% small/regional/emerging, 35% mid-market, 25% major brands)
- Return DIVERSE companies - independent manufacturers, local producers, regional specialists, family-owned businesses, emerging/niche players
- Include regional and international companies
- Verify each company URL is valid

FORMAT YOUR RESPONSE AS A VALID JSON ARRAY. EACH OBJECT MUST HAVE:
- company_name (string): Exact company name
- website_url (string): Valid company website URL (must work)
- industries (array): Industry categories
- product_keywords (string): Comma-separated product keywords
- headquarters_location (string, REQUIRED): "City, State/Region, Country" format (or empty string if truly unknown)
- manufacturing_locations (array, REQUIRED): Array of location strings (can be empty if unknown)
- red_flag (boolean, REQUIRED): true if HQ missing or manufacturing unclear
- red_flag_reason (string, REQUIRED): Explanation if red_flag=true, empty string if false
- hq_lat (number, optional): Headquarters latitude
- hq_lng (number, optional): Headquarters longitude
- amazon_url (string, optional): Amazon storefront URL
- social (object, optional): Social media URLs {linkedin, instagram, x, twitter, facebook, tiktok, youtube}
- location_confidence (string, optional): "high", "medium", or "low" based on data quality

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

          // Check if any companies have missing or weak location data
          const companiesNeedingLocationRefinement = enriched.filter(c =>
            !c.headquarters_location || c.headquarters_location === "" ||
            !c.manufacturing_locations || c.manufacturing_locations.length === 0
          );

          // Location refinement pass: if too many companies have missing locations, run a refinement
          if (companiesNeedingLocationRefinement.length > 0 && enriched.length > 0) {
            console.log(`[import-start] ${companiesNeedingLocationRefinement.length} companies need location refinement`);

            try {
              // Build refinement prompt focusing only on HQ + manufacturing locations
              const refinementMessage = {
                role: "user",
                content: `You are a research assistant specializing in company location data.
For the following companies, you previously found some information but HQ and/or manufacturing locations were missing or unclear.
Re-check ONLY for headquarters location and manufacturing locations using official sources, LinkedIn, Crunchbase, product pages, and facility FAQs.

Companies needing refinement:
${companiesNeedingLocationRefinement.map(c => `- ${c.company_name} (${c.url || 'N/A'})`).join('\n')}

For EACH company, return ONLY:
{
  "company_name": "exact name",
  "headquarters_location": "City, State/Region, Country OR empty string if not found",
  "manufacturing_locations": ["location1", "location2", ...],
  "red_flag": true/false,
  "red_flag_reason": "explanation if red_flag true, empty string if false",
  "location_confidence": "high|medium|low"
}

Focus ONLY on location accuracy. Return a JSON array with these objects.
Return ONLY the JSON array, no other text.`,
              };

              const refinementPayload = {
                messages: [refinementMessage],
                model: "grok-4-latest",
                temperature: 0.1,
                stream: false,
              };

              console.log(`[import-start] Running location refinement pass for ${companiesNeedingLocationRefinement.length} companies`);
              const refinementResponse = await axios.post(xaiUrl, refinementPayload, {
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${xaiKey}`,
                },
                timeout: Math.max(1000, Number(process.env.XAI_TIMEOUT_MS) || 60000),
              });

              if (refinementResponse.status >= 200 && refinementResponse.status < 300) {
                const refinementText = refinementResponse.data?.choices?.[0]?.message?.content || "";
                console.log(`[import-start] Refinement response preview: ${refinementText.substring(0, 100)}...`);

                let refinedLocations = [];
                try {
                  const jsonMatch = refinementText.match(/\[[\s\S]*\]/);
                  if (jsonMatch) {
                    refinedLocations = JSON.parse(jsonMatch[0]);
                    if (!Array.isArray(refinedLocations)) refinedLocations = [];
                  }
                } catch (parseErr) {
                  console.warn(`[import-start] Failed to parse refinement response: ${parseErr.message}`);
                }

                console.log(`[import-start] Refinement returned ${refinedLocations.length} location updates`);

                // Merge refinement results back into enriched companies
                if (refinedLocations.length > 0) {
                  const refinementMap = new Map();
                  refinedLocations.forEach(rl => {
                    const name = (rl.company_name || "").toLowerCase();
                    if (name) refinementMap.set(name, rl);
                  });

                  enriched = enriched.map(company => {
                    const companyName = (company.company_name || "").toLowerCase();
                    const refinement = refinementMap.get(companyName);
                    if (refinement) {
                      return {
                        ...company,
                        headquarters_location: refinement.headquarters_location || company.headquarters_location || "",
                        manufacturing_locations: refinement.manufacturing_locations || company.manufacturing_locations || [],
                        red_flag: refinement.red_flag !== undefined ? refinement.red_flag : company.red_flag,
                        red_flag_reason: refinement.red_flag_reason !== undefined ? refinement.red_flag_reason : company.red_flag_reason || "",
                        location_confidence: refinement.location_confidence || company.location_confidence || "medium",
                      };
                    }
                    return company;
                  });

                  console.log(`[import-start] Merged refinement data back into companies`);
                }
              }
            } catch (refinementErr) {
              console.warn(`[import-start] Location refinement pass failed: ${refinementErr.message}`);
              // Continue with original data if refinement fails
            }
          }

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
