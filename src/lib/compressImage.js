// src/lib/compressImage.js
//
// Downscale + re-encode an image File to a compact data URL on the client, so
// review submissions carry small payloads (server re-encodes again for safety).

const DEFAULTS = { maxDim: 1600, quality: 0.8 };

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("decode failed"));
    img.src = src;
  });
}

/**
 * Compress an image File to a data URL (webp, falling back to jpeg).
 * Returns null if the file isn't a decodable image.
 */
export async function compressImageToDataUrl(file, opts = {}) {
  const { maxDim, quality } = { ...DEFAULTS, ...opts };
  if (!file || !String(file.type || "").startsWith("image/")) return null;

  let img;
  try {
    img = await loadImage(await readAsDataUrl(file));
  } catch {
    return null;
  }

  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  if (!w || !h) return null;
  if (w > maxDim || h > maxDim) {
    const scale = Math.min(maxDim / w, maxDim / h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);

  let out = "";
  try {
    out = canvas.toDataURL("image/webp", quality);
  } catch {
    out = "";
  }
  if (!out.startsWith("data:image/webp")) {
    out = canvas.toDataURL("image/jpeg", quality);
  }
  return out && out.startsWith("data:image/") ? out : null;
}
