/**
 * Logo variant detection & generation.
 *
 * Detects monochrome logos on transparent backgrounds and generates
 * inverted variants so every company has both a light-background-safe
 * and dark-background-safe logo URL.
 */

const { tryLoadSharp } = require("./_shared");

const { sharp } = tryLoadSharp();

// ── Detection ────────────────────────────────────────────────────────────────

/**
 * Analyse a logo buffer to determine whether it is a single-colour shape
 * on a transparent background.
 *
 * @param {Buffer} buffer  Raw image bytes (PNG, SVG rasterised to PNG, etc.)
 * @returns {Promise<{ needsVariant: boolean, isDark?: boolean, dominantColor?: {r,g,b} }>}
 *   - needsVariant: true when the logo is monochrome-on-transparent
 *   - isDark: true when the dominant colour is dark (visible on light bgs)
 *   - dominantColor: the average non-transparent pixel colour
 */
async function isMonochromeTransparent(buffer) {
  if (!sharp) return { needsVariant: false };

  try {
    const img = sharp(buffer).ensureAlpha();
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;

    // Must have alpha channel
    if (channels < 4) return { needsVariant: false };

    // Too small to analyse reliably
    if (width < 32 || height < 32) return { needsVariant: false };

    const totalPixels = width * height;
    let transparentCount = 0;
    let sumR = 0, sumG = 0, sumB = 0;
    let opaqueCount = 0;

    // First pass: compute dominant colour from opaque pixels
    for (let i = 0; i < totalPixels; i++) {
      const off = i * 4;
      const a = data[off + 3];
      if (a < 128) {
        transparentCount++;
        continue;
      }
      opaqueCount++;
      sumR += data[off];
      sumG += data[off + 1];
      sumB += data[off + 2];
    }

    // If there are no transparent pixels → has a solid background → no variant needed
    if (transparentCount === 0) return { needsVariant: false };

    // If image is mostly transparent with very few opaque pixels, skip
    if (opaqueCount < totalPixels * 0.01) return { needsVariant: false };

    // Need a meaningful amount of transparency to qualify (at least 10%)
    if (transparentCount < totalPixels * 0.10) return { needsVariant: false };

    const avgR = Math.round(sumR / opaqueCount);
    const avgG = Math.round(sumG / opaqueCount);
    const avgB = Math.round(sumB / opaqueCount);

    // Second pass: check colour uniformity (tolerance 50 per channel for anti-aliasing)
    const TOLERANCE = 50;
    let matchingPixels = 0;

    for (let i = 0; i < totalPixels; i++) {
      const off = i * 4;
      if (data[off + 3] < 128) continue; // skip transparent
      const dr = Math.abs(data[off] - avgR);
      const dg = Math.abs(data[off + 1] - avgG);
      const db = Math.abs(data[off + 2] - avgB);
      if (dr <= TOLERANCE && dg <= TOLERANCE && db <= TOLERANCE) {
        matchingPixels++;
      }
    }

    const uniformity = matchingPixels / opaqueCount;

    // 85%+ of opaque pixels must be near the dominant colour
    if (uniformity < 0.85) return { needsVariant: false };

    // Compute luminance to decide if logo is dark or light
    const luminance = 0.299 * avgR + 0.587 * avgG + 0.114 * avgB;

    return {
      needsVariant: true,
      isDark: luminance < 128,
      dominantColor: { r: avgR, g: avgG, b: avgB },
    };
  } catch (e) {
    // If analysis fails, don't block the pipeline
    return { needsVariant: false };
  }
}

// ── Generation ───────────────────────────────────────────────────────────────

/**
 * Invert the RGB channels of an image while preserving the alpha channel.
 *
 * @param {Buffer} buffer  Raw image bytes
 * @returns {Promise<Buffer>}  Inverted PNG buffer
 */
async function generateInvertedVariant(buffer) {
  if (!sharp) throw new Error("Sharp unavailable");
  return sharp(buffer)
    .ensureAlpha()
    .negate({ alpha: false })
    .png()
    .toBuffer();
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Process a logo buffer: detect if it needs a dark-mode variant, and if so
 * generate and upload both versions.
 *
 * For non-monochrome logos, both `logoUrl` and `logoUrlDark` will be the same.
 *
 * @param {object} opts
 * @param {Buffer}   opts.buffer       Processed logo image bytes
 * @param {boolean}  opts.isSvg        Whether the original was SVG
 * @param {string}   opts.companyId    Company identifier
 * @param {string}   opts.ext          File extension (png, svg, etc.)
 * @param {string}   opts.contentType  MIME type
 * @param {string}   opts.originalUrl  URL returned from uploading the original
 * @param {Function} opts.uploadFn     async (params, logger, opts) => url
 * @param {object}   [opts.logger]     Logger
 * @returns {Promise<{ logoUrl: string, logoUrlDark: string }>}
 */
async function processLogoVariants({
  buffer,
  isSvg,
  companyId,
  ext,
  contentType,
  originalUrl,
  uploadFn,
  logger = console,
}) {
  // For SVGs, rasterise first for pixel analysis
  let analysisBuffer = buffer;
  if (isSvg && sharp) {
    try {
      analysisBuffer = await sharp(buffer, { density: 200 })
        .resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true })
        .ensureAlpha()
        .png()
        .toBuffer();
    } catch {
      // Can't rasterise — skip variant generation
      return { logoUrl: originalUrl, logoUrlDark: originalUrl };
    }
  }

  const detection = await isMonochromeTransparent(analysisBuffer);

  if (!detection.needsVariant) {
    logger?.log?.(`[logoVariant] not monochrome-transparent for ${companyId}, using same URL for both`);
    return { logoUrl: originalUrl, logoUrlDark: originalUrl };
  }

  logger?.log?.(`[logoVariant] monochrome-transparent detected for ${companyId} (isDark=${detection.isDark}), generating variant`);

  try {
    // Generate the inverted version — always as PNG since negate can't produce SVG
    const invertedBuffer = await generateInvertedVariant(analysisBuffer);
    const darkVariantUrl = await uploadFn(
      { companyId, buffer: invertedBuffer, ext: "png", contentType: "image/png", variant: "dark" },
      logger,
      { force: true },
    );

    if (detection.isDark) {
      // Original is dark (visible on light bg) → original = logo_url, inverted = logo_url_dark
      return { logoUrl: originalUrl, logoUrlDark: darkVariantUrl };
    } else {
      // Original is light (visible on dark bg) → inverted = logo_url, original = logo_url_dark
      // Upload the inverted also as the primary blob
      const lightVariantUrl = await uploadFn(
        { companyId, buffer: invertedBuffer, ext: "png", contentType: "image/png" },
        logger,
        { force: true },
      );
      return { logoUrl: lightVariantUrl, logoUrlDark: originalUrl };
    }
  } catch (e) {
    logger?.warn?.(`[logoVariant] variant generation failed for ${companyId}: ${e?.message || e}`);
    // Fall back to same URL for both
    return { logoUrl: originalUrl, logoUrlDark: originalUrl };
  }
}

module.exports = {
  isMonochromeTransparent,
  generateInvertedVariant,
  processLogoVariants,
};
