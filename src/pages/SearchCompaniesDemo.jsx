import React from "react";

// If you created src/lib/searchCompanies.ts with a named export:
import { searchCompanies } from "../lib/searchCompanies";

// Optional (nice inputs/buttons if you want them)
// If these imports 404, just remove them and use plain <input>/<button>.
import { Input } from "../components/ui/input.jsx";
import { Button } from "../components/ui/button.jsx";
import { withAmazonAffiliate } from "@/lib/amazonAffiliate";

export default function SearchCompaniesDemo() {
  const [q, setQ] = React.useState("candle");
  const [limit, setLimit] = React.useState(5);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [results, setResults] = React.useState([]);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const data = await searchCompanies({ query: q, limit });
      setResults(Array.isArray(data?.companies) ? data.companies : []);
    } catch (e) {
      setError(e?.message || "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => { run(); }, []); // first render

  return (
    <div style={{ maxWidth: 900, margin: "24px auto", padding: "0 16px", fontFamily: "system-ui" }}>
      <h1 style={{ marginBottom: 12 }}>Search Companies (Demo)</h1>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        {Input ? (
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search (e.g., candle, wax, 'alpha')"
            onKeyDown={(e) => e.key === "Enter" && run()}
          />
        ) : (
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search (e.g., candle, wax, 'alpha')"
            onKeyDown={(e) => e.key === "Enter" && run()}
            style={{ flex: 1, padding: 8, border: "1px solid #ccc", borderRadius: 6 }}
          />
        )}

        <input
          type="number"
          min={1}
          max={100}
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value || 10))}
          style={{ width: 90, padding: 8, border: "1px solid #ccc", borderRadius: 6 }}
          title="Limit"
        />

        {Button ? (
          <Button onClick={run} disabled={loading}>{loading ? "Searching..." : "Search"}</Button>
        ) : (
          <button onClick={run} disabled={loading} style={{ padding: "8px 14px" }}>
            {loading ? "Searching..." : "Search"}
          </button>
        )}
      </div>

      {error && <div style={{ color: "crimson", marginBottom: 12 }}>{error}</div>}

      <div style={{ border: "1px solid #eee", borderRadius: 8, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead style={{ background: "#fafafa" }}>
            <tr>
              <th style={th}>Name</th>
              <th style={th}>Tagline</th>
              <th style={th}>Industries</th>
              <th style={th}>Website</th>
            </tr>
          </thead>
          <tbody>
            {results.map((c) => (
              <tr key={c.id} style={{ borderTop: "1px solid #eee" }}>
                <td style={td}>{c.company_name || "(no name)"}{c.red_flag ? " ⚠️" : ""}</td>
                <td style={td}>{c.company_tagline || ""}</td>
                <td style={td}>{Array.isArray(c.industries) ? c.industries.join(", ") : ""}</td>
                <td style={td}>
                  {c.url ? <a href={withAmazonAffiliate(c.url)} target="_blank" rel="noreferrer">{c.url}</a> : "—"}
                </td>
              </tr>
            ))}
            {!loading && results.length === 0 && (
              <tr><td style={td} colSpan={4}>No results.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const th = { textAlign: "left", padding: "10px 12px", fontWeight: 600, borderBottom: "1px solid #eee" };
const td = { textAlign: "left", padding: "10px 12px", verticalAlign: "top" };
