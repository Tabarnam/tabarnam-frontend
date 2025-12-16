import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Helmet } from "react-helmet-async";
import AdminHeader from "@/components/AdminHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";
import { apiFetch, getUserFacingConfigMessage } from "@/lib/api";
import { getAdminUser } from "@/lib/azureAuth";

function prettyJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function readJsonOrText(res) {
  let cloned;
  try {
    cloned = res.clone();
  } catch {
    cloned = res;
  }

  const contentType = cloned.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return await cloned.json();
    } catch {
      return { error: "Invalid JSON" };
    }
  }

  const text = await cloned.text().catch(() => "");
  return text ? { text } : {};
}

function StatusPill({ ok, label }) {
  const cls = ok
    ? "bg-emerald-50 text-emerald-800 border-emerald-200"
    : "bg-amber-50 text-amber-900 border-amber-200";
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${cls}`}>{label}</span>;
}

export default function AdminPanel() {
  const user = getAdminUser();

  const [diagnostic, setDiagnostic] = useState(null);
  const [diagnosticLoading, setDiagnosticLoading] = useState(false);

  const [debugLoading, setDebugLoading] = useState(false);
  const [debugBody, setDebugBody] = useState(null);

  const [companiesLoading, setCompaniesLoading] = useState(false);
  const [companiesBody, setCompaniesBody] = useState(null);

  const [recalcLoading, setRecalcLoading] = useState(false);
  const [recalcResult, setRecalcResult] = useState(null);
  const [recalcCompanyId, setRecalcCompanyId] = useState("");
  const [recalcCompanyName, setRecalcCompanyName] = useState("");

  const refreshDiagnostic = useCallback(async () => {
    setDiagnosticLoading(true);
    try {
      const res = await apiFetch("/xadmin-api-save-diagnostic");
      const body = await readJsonOrText(res);
      setDiagnostic(body);

      if (!res.ok) {
        const msg = (await getUserFacingConfigMessage(res)) || body?.error || `Diagnostic failed (${res.status})`;
        toast.error(msg);
      }
    } catch (e) {
      toast.error(e?.message || "Failed to load diagnostics");
    } finally {
      setDiagnosticLoading(false);
    }

    setDiagnosticStatus("error");
  }, []);

  useEffect(() => {
    refreshDiagnostic();
  }, [refreshDiagnostic]);

  const cosmosConfigured = Boolean(diagnostic?.cosmosConfigured);

  const configBanner = useMemo(() => {
    if (diagnosticLoading && !diagnostic) return null;
    if (cosmosConfigured) return null;

    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
        <div className="text-amber-900 font-semibold">Backend configuration incomplete</div>
        <div className="mt-1 text-sm text-amber-900/80">
          Cosmos DB environment variables are missing or incomplete. This is expected in local development.
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" onClick={refreshDiagnostic} disabled={diagnosticLoading}>
            {diagnosticLoading ? "Checking…" : "Re-check configuration"}
          </Button>
        </div>
      </div>
    );
  }, [cosmosConfigured, diagnostic, diagnosticLoading, refreshDiagnostic]);

  const runDebug = useCallback(async () => {
    setDebugLoading(true);
    setDebugBody(null);
    try {
      const res = await apiFetch("/xadmin-api-debug");
      const body = await readJsonOrText(res);
      setDebugBody(body);
      if (!res.ok) {
        const msg = (await getUserFacingConfigMessage(res)) || body?.error || `Debug failed (${res.status})`;
        toast.error(msg);
      } else {
        toast.success("Debug endpoint OK");
      }
    } catch (e) {
      toast.error(e?.message || "Debug failed");
    } finally {
      setDebugLoading(false);
    }
  }, []);

  const loadCompanies = useCallback(async () => {
    if (!cosmosConfigured) {
      toast.warning("Cosmos DB is not configured yet.");
      return;
    }

    setCompaniesLoading(true);
    setCompaniesBody(null);
    try {
      const res = await apiFetch("/xadmin-api-companies?take=200");
      const body = await readJsonOrText(res);
      setCompaniesBody(body);

      if (!res.ok) {
        const msg = (await getUserFacingConfigMessage(res)) || body?.error || `Failed to load companies (${res.status})`;
        toast.error(msg);
      }
    } catch (e) {
      toast.error(e?.message || "Failed to load companies");
    } finally {
      setCompaniesLoading(false);
    }
  }, [cosmosConfigured]);

  const runRecalc = useCallback(async () => {
    const company_id = String(recalcCompanyId || "").trim();
    const company_name = String(recalcCompanyName || "").trim();

    if (!company_id && !company_name) {
      toast.error("Enter a company_id or company_name.");
      return;
    }

    setRecalcLoading(true);
    setRecalcResult(null);

    try {
      const res = await apiFetch("/xadmin-api-recalc-review-counts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: company_id || undefined, company_name: company_name || undefined }),
      });

      const body = await readJsonOrText(res);
      setRecalcResult(body);

      if (!res.ok || body?.ok !== true) {
        const msg = (await getUserFacingConfigMessage(res)) || body?.error || `Recalc failed (${res.status})`;
        toast.error(msg);
      } else {
        toast.success("Review counts recalculated");
      }
    } catch (e) {
      toast.error(e?.message || "Recalc failed");
    } finally {
      setRecalcLoading(false);
    }
  }, [recalcCompanyId, recalcCompanyName]);

  return (
    <>
      <Helmet>
        <title>Tabarnam Admin</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      <div className="min-h-screen bg-slate-50">
        <AdminHeader user={user} />

        <main className="container mx-auto py-6 px-4 space-y-6">
          <header className="flex flex-col gap-2">
            <h1 className="text-3xl font-bold text-slate-900">Admin Dashboard</h1>
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill ok={cosmosConfigured} label={cosmosConfigured ? "Cosmos configured" : "Cosmos not configured"} />
              <StatusPill ok={true} label="Using /api + xadmin-api-*" />
            </div>
          </header>

          {configBanner}

          <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-lg border border-slate-200 bg-white p-5">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-slate-900">Configuration diagnostics</h2>
                <Button variant="outline" onClick={refreshDiagnostic} disabled={diagnosticLoading}>
                  {diagnosticLoading ? "Loading…" : "Refresh"}
                </Button>
              </div>
              <p className="mt-2 text-sm text-slate-600">
                Reads <code>/api/xadmin-api-save-diagnostic</code> and reports environment status.
              </p>
              <pre className="mt-4 max-h-[420px] overflow-auto rounded bg-slate-950 text-slate-100 p-3 text-xs">
                {prettyJson(diagnostic)}
              </pre>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-5">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-slate-900">Debug endpoint</h2>
                <Button onClick={runDebug} disabled={debugLoading}>
                  {debugLoading ? "Pinging…" : "Ping /xadmin-api-debug"}
                </Button>
              </div>
              <p className="mt-2 text-sm text-slate-600">
                Calls <code>/api/xadmin-api-debug</code>.
              </p>
              <pre className="mt-4 max-h-[420px] overflow-auto rounded bg-slate-950 text-slate-100 p-3 text-xs">
                {prettyJson(debugBody)}
              </pre>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-5">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-slate-900">Companies (read-only)</h2>
                <Button onClick={loadCompanies} disabled={companiesLoading || !cosmosConfigured}>
                  {companiesLoading ? "Loading…" : "Load /xadmin-api-companies"}
                </Button>
              </div>
              <p className="mt-2 text-sm text-slate-600">
                Calls <code>/api/xadmin-api-companies</code>. Disabled until Cosmos is configured.
              </p>
              <pre className="mt-4 max-h-[420px] overflow-auto rounded bg-slate-950 text-slate-100 p-3 text-xs">
                {prettyJson(companiesBody)}
              </pre>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-5">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-slate-900">Recalc review counts</h2>
                <Button onClick={runRecalc} disabled={recalcLoading || !cosmosConfigured}>
                  {recalcLoading ? "Running…" : "Run"}
                </Button>
              </div>
              <p className="mt-2 text-sm text-slate-600">
                Calls <code>/api/xadmin-api-recalc-review-counts</code>. Disabled until Cosmos is configured.
              </p>

              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-slate-700">company_id</label>
                  <Input value={recalcCompanyId} onChange={(e) => setRecalcCompanyId(e.target.value)} placeholder="company_123" />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-700">company_name (optional)</label>
                  <Input
                    value={recalcCompanyName}
                    onChange={(e) => setRecalcCompanyName(e.target.value)}
                    placeholder="Acme Corp"
                  />
                </div>
              </div>

              <pre className="mt-4 max-h-[320px] overflow-auto rounded bg-slate-950 text-slate-100 p-3 text-xs">
                {prettyJson(recalcResult)}
              </pre>
            </div>
          </section>
        </main>
      </div>
    </>
  );
}
