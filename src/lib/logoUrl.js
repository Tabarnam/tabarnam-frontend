export function toStableLogoUrl(input) {
  const url = typeof input === "string" ? input.trim() : "";
  if (!url) return "";

  const qIndex = url.indexOf("?");
  return qIndex === -1 ? url : url.slice(0, qIndex);
}

export function hasSasParams(input) {
  const url = typeof input === "string" ? input : "";
  return /[?&](sv|sig|se)=/i.test(url);
}
