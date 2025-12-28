export function toStableLogoUrl(input) {
  const url = typeof input === "string" ? input.trim() : "";
  if (!url) return "";

  // If the logo URL includes Azure SAS parameters, we must preserve the query string
  // or the asset will 403 (private container / signed URL access).
  if (hasSasParams(url)) return url;

  const qIndex = url.indexOf("?");
  return qIndex === -1 ? url : url.slice(0, qIndex);
}

export function hasSasParams(input) {
  const url = typeof input === "string" ? input : "";
  return /[?&](sv|sig|se)=/i.test(url);
}
