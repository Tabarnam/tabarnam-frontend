// src/components/ui/toast.jsx
// Minimal helper to call our local proxy. No direct xAI usage here.

export async function callXAI(
  query,
  { limit = 3, queryType = "product_keyword", center } = {}
) {
  const res = await fetch("/api/proxy-xai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queryType, query, limit, ...(center ? { center } : {}) }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Proxy error ${res.status}${text ? `: ${text}` : ""}`);
  }
  return res.json(); // -> { companies, meta }
}

// Keep a default export so existing imports don't break.
// Replace with your actual toast UI if you had one here previously.
export default function ToastPlaceholder() { return null; }
