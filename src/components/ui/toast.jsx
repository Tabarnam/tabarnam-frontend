// src/components/ui/toast.jsx

const API_BASE =
  (typeof window !== "undefined" && window.location.port === "5173")
    ? "http://localhost:7071"  // dev: talk to Functions directly
    : "";                       // prod: same-origin

export async function callXAI(
  query,
  { limit = 20, queryType = "product_keyword", center } = {}
) {
  const res = await fetch(`${API_BASE}/api/proxy-xai`, {
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

export default function ToastPlaceholder(){ return null; }
