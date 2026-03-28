/**
 * Backfill logo_url_dark for all existing companies.
 *
 * For each company with a logo_url but no logo_url_dark:
 *   - Downloads the logo blob
 *   - Detects if it is monochrome on a transparent background
 *   - If yes: generates an inverted variant, uploads it, and assigns URLs
 *     so logo_url is visible on light bgs and logo_url_dark on dark bgs
 *   - If no: sets logo_url_dark = logo_url
 *
 * Usage:
 *   node scripts/migrate-logo-dark-variants.mjs            # dry-run
 *   node scripts/migrate-logo-dark-variants.mjs --apply    # write changes
 *
 * Optional:
 *   --max=<n>         stop after processing n matching documents
 *   --pageSize=<n>    query page size (default 50)
 */

import { CosmosClient } from "@azure/cosmos";
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";

const COSMOS_ENDPOINT = process.env.COSMOS_DB_ENDPOINT || process.env.COSMOS_ENDPOINT || "";
const COSMOS_KEY = process.env.COSMOS_DB_KEY || process.env.COSMOS_KEY || "";
const DATABASE_ID = process.env.COSMOS_DB_DATABASE || process.env.COSMOS_DB || "tabarnam-db";
const CONTAINER_ID = process.env.COSMOS_DB_COMPANIES_CONTAINER || process.env.COSMOS_CONTAINER || "companies";

const STORAGE_ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT_NAME || "tabarnamstor2356";
const STORAGE_KEY = process.env.AZURE_STORAGE_ACCOUNT_KEY || "";
const BLOB_CONTAINER = "company-logos";

// ── Args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { apply: false, max: null, pageSize: 50 };
  for (const raw of argv.slice(2)) {
    if (raw === "--apply") { out.apply = true; continue; }
    const [k, v] = raw.split("=", 2);
    if (k === "--max") {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out.max = Math.floor(n);
      continue;
    }
    if (k === "--pageSize") {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out.pageSize = Math.max(1, Math.min(500, Math.floor(n)));
      continue;
    }
    throw new Error(`Unknown argument: ${raw}`);
  }
  return out;
}

// ── Sharp (dynamic import) ───────────────────────────────────────────────────

let sharp;
async function loadSharp() {
  if (sharp) return;
  const mod = await import("sharp");
  sharp = mod.default || mod;
}

// ── Logo analysis (inline to avoid CJS/ESM issues) ──────────────────────────

async function isMonochromeTransparent(buffer) {
  const img = sharp(buffer).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (channels < 4 || width < 32 || height < 32) return { needsVariant: false };

  const totalPixels = width * height;
  let transparentCount = 0, opaqueCount = 0;
  let sumR = 0, sumG = 0, sumB = 0;

  for (let i = 0; i < totalPixels; i++) {
    const off = i * 4;
    if (data[off + 3] < 128) { transparentCount++; continue; }
    opaqueCount++;
    sumR += data[off];
    sumG += data[off + 1];
    sumB += data[off + 2];
  }

  if (transparentCount === 0 || opaqueCount < totalPixels * 0.01 || transparentCount < totalPixels * 0.10) {
    return { needsVariant: false };
  }

  const avgR = Math.round(sumR / opaqueCount);
  const avgG = Math.round(sumG / opaqueCount);
  const avgB = Math.round(sumB / opaqueCount);

  const TOLERANCE = 50;
  let matching = 0;
  for (let i = 0; i < totalPixels; i++) {
    const off = i * 4;
    if (data[off + 3] < 128) continue;
    if (Math.abs(data[off] - avgR) <= TOLERANCE &&
        Math.abs(data[off + 1] - avgG) <= TOLERANCE &&
        Math.abs(data[off + 2] - avgB) <= TOLERANCE) {
      matching++;
    }
  }

  if (matching / opaqueCount < 0.85) return { needsVariant: false };

  const luminance = 0.299 * avgR + 0.587 * avgG + 0.114 * avgB;
  return { needsVariant: true, isDark: luminance < 128, dominantColor: { r: avgR, g: avgG, b: avgB } };
}

async function generateInvertedVariant(buffer) {
  return sharp(buffer).ensureAlpha().negate({ alpha: false }).png().toBuffer();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toNormalizedDomain(input = "") {
  try {
    const u = String(input || "").trim();
    if (!u) return "unknown";
    const parsed = u.startsWith("http") ? new URL(u) : new URL(`https://${u}`);
    let h = parsed.hostname.toLowerCase();
    if (h.startsWith("www.")) h = h.slice(4);
    return h || "unknown";
  } catch { return "unknown"; }
}

/** Extract the blob path from a logo_url (handles various formats). */
function extractBlobPath(logoUrl) {
  const s = String(logoUrl || "").trim();

  // Proxy URL: /api/company-logo?src=<encoded azure url>
  if (s.startsWith("/api/company-logo?")) {
    try {
      const u = new URL(s, "https://dummy");
      const src = u.searchParams.get("src") || "";
      return extractBlobPath(src);
    } catch { return null; }
  }

  // Azure blob URL
  const blobMatch = s.match(/\.blob\.core\.windows\.net\/company-logos\/(.+?)(?:\?|$)/i);
  if (blobMatch) return blobMatch[1];

  // Relative path like company-logos/companyId/logo.png
  if (s.startsWith("company-logos/")) return s.slice("company-logos/".length).split("?")[0];

  return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { apply, max, pageSize } = parseArgs(process.argv);

  if (!COSMOS_ENDPOINT || !COSMOS_KEY) {
    throw new Error("Missing COSMOS_DB_ENDPOINT/COSMOS_DB_KEY environment variables.");
  }
  if (!STORAGE_KEY) {
    throw new Error("Missing AZURE_STORAGE_ACCOUNT_KEY environment variable.");
  }

  await loadSharp();

  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  if (max) console.log(`Max: ${max}`);

  const cosmosClient = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
  const container = cosmosClient.database(DATABASE_ID).container(CONTAINER_ID);

  const credentials = new StorageSharedKeyCredential(STORAGE_ACCOUNT, STORAGE_KEY);
  const blobServiceClient = new BlobServiceClient(`https://${STORAGE_ACCOUNT}.blob.core.windows.net`, credentials);
  const containerClient = blobServiceClient.getContainerClient(BLOB_CONTAINER);

  const query = `
    SELECT c.id, c.company_id, c.company_name, c.logo_url, c.logo_url_dark,
           c.normalized_domain, c.website_url, c.url, c.domain
    FROM c
    WHERE IS_DEFINED(c.logo_url)
      AND c.logo_url != null
      AND c.logo_url != ""
      AND (NOT IS_DEFINED(c.logo_url_dark) OR c.logo_url_dark = null OR c.logo_url_dark = "")
  `;

  const counters = { scanned: 0, variant_generated: 0, same_url: 0, skipped: 0, failed: 0 };

  const iterator = container.items.query(query, {
    enableCrossPartitionQuery: true,
    maxItemCount: pageSize,
  }).getAsyncIterator();

  for await (const { resources } of iterator) {
    for (const doc of resources) {
      if (max && counters.scanned >= max) break;
      counters.scanned++;

      const companyId = doc.company_id || doc.id;
      const logoUrl = String(doc.logo_url || "").trim();

      if (!logoUrl) { counters.skipped++; continue; }

      const blobPath = extractBlobPath(logoUrl);
      if (!blobPath) {
        console.log(`  [skip] ${companyId}: cannot extract blob path from ${logoUrl}`);
        counters.skipped++;
        continue;
      }

      try {
        // Download the logo
        const blobClient = containerClient.getBlockBlobClient(blobPath);
        const downloadRes = await blobClient.download(0);
        const chunks = [];
        for await (const chunk of downloadRes.readableStreamBody) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);

        // Rasterise SVGs for analysis
        let analysisBuf = buffer;
        const isSvg = blobPath.toLowerCase().endsWith(".svg");
        if (isSvg) {
          try {
            analysisBuf = await sharp(buffer, { density: 200 })
              .resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true })
              .ensureAlpha()
              .png()
              .toBuffer();
          } catch {
            console.log(`  [skip] ${companyId}: failed to rasterise SVG`);
            counters.skipped++;
            continue;
          }
        }

        const detection = await isMonochromeTransparent(analysisBuf);

        if (!detection.needsVariant) {
          // Same URL for both
          console.log(`  [same] ${companyId}: not monochrome-transparent`);
          if (apply) {
            let pk = doc.normalized_domain;
            if (!pk || String(pk).trim() === "") {
              pk = toNormalizedDomain(doc.website_url || doc.url || doc.domain || "");
            }
            // PATCH: only set logo_url_dark, never touch other fields
            await container.item(doc.id, pk).patch([
              { op: "set", path: "/logo_url_dark", value: logoUrl },
              { op: "set", path: "/updated_at", value: new Date().toISOString() },
            ]);
          }
          counters.same_url++;
          continue;
        }

        // Generate inverted variant
        const invertedBuffer = await generateInvertedVariant(analysisBuf);

        // Determine blob name for the dark variant
        const darkBlobPath = blobPath.replace(/\.(png|svg|jpg|jpeg)$/i, "-dark.png");
        let finalLogoUrl = logoUrl;
        let finalLogoUrlDark = logoUrl;

        if (apply) {
          const darkBlobClient = containerClient.getBlockBlobClient(darkBlobPath);
          await darkBlobClient.upload(invertedBuffer, invertedBuffer.length, {
            blobHTTPHeaders: { blobContentType: "image/png" },
          });
          const darkUrl = darkBlobClient.url;

          if (detection.isDark) {
            // Original is dark (for light bg), inverted is light (for dark bg)
            finalLogoUrl = logoUrl;
            finalLogoUrlDark = darkUrl;
          } else {
            // Original is light (for dark bg), inverted is dark (for light bg)
            // Upload inverted as the primary logo too
            const primaryBlobPath = blobPath.replace(/\.(png|svg|jpg|jpeg)$/i, ".png");
            const primaryBlobClient = containerClient.getBlockBlobClient(primaryBlobPath);
            await primaryBlobClient.upload(invertedBuffer, invertedBuffer.length, {
              blobHTTPHeaders: { blobContentType: "image/png" },
            });
            finalLogoUrl = primaryBlobClient.url;
            finalLogoUrlDark = logoUrl;
          }

          let pk = doc.normalized_domain;
          if (!pk || String(pk).trim() === "") {
            pk = toNormalizedDomain(doc.website_url || doc.url || doc.domain || "");
          }
          // PATCH: only set logo_url and logo_url_dark, never touch other fields
          await container.item(doc.id, pk).patch([
            { op: "set", path: "/logo_url", value: finalLogoUrl },
            { op: "set", path: "/logo_url_dark", value: finalLogoUrlDark },
            { op: "set", path: "/updated_at", value: new Date().toISOString() },
          ]);
        }

        console.log(`  [variant] ${companyId}: isDark=${detection.isDark}, dominantColor=rgb(${detection.dominantColor.r},${detection.dominantColor.g},${detection.dominantColor.b})`);
        counters.variant_generated++;
      } catch (e) {
        console.error(`  [error] ${companyId}: ${e?.message || e}`);
        counters.failed++;
      }
    }
    if (max && counters.scanned >= max) break;
  }

  console.log("\n=== Summary ===");
  console.log(`  Scanned:           ${counters.scanned}`);
  console.log(`  Variant generated: ${counters.variant_generated}`);
  console.log(`  Same URL (no var): ${counters.same_url}`);
  console.log(`  Skipped:           ${counters.skipped}`);
  console.log(`  Failed:            ${counters.failed}`);
  if (!apply) console.log("\n  (dry-run — no changes written. Use --apply to persist.)");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
