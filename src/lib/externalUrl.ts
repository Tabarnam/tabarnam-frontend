function stripTrailingPunctuation(value: string) {
  let s = value;
  while (s) {
    const last = s[s.length - 1];
    if (last === "." || last === "," || last === ";" || last === ":" || last === "!" || last === "?" || last === ")" || last === "]" || last === "}" || last === '"' || last === "'") {
      s = s.slice(0, -1);
      continue;
    }
    break;
  }
  return s;
}

export function sanitizeExternalUrlInput(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const match = raw.match(/https?:\/\/[^\s<>"']+/i);
  if (match && match[0]) {
    return stripTrailingPunctuation(match[0].trim());
  }

  let s = raw;

  if (s.startsWith("<") && s.endsWith(">")) {
    s = s.slice(1, -1).trim();
  }

  if (s.startsWith("(") && s.endsWith(")")) {
    s = s.slice(1, -1).trim();
  }

  s = stripTrailingPunctuation(s);

  return s;
}

export function normalizeExternalUrl(value: string) {
  const sanitized = sanitizeExternalUrlInput(value);
  if (!sanitized) return "";

  const withScheme = sanitized.includes("://") ? sanitized : `https://${sanitized}`;

  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    u.hash = "";
    return u.toString();
  } catch {
    return "";
  }
}
