import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Helmet } from "react-helmet-async";
import AdminHeader from "@/components/AdminHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";
import { API_BASE, apiFetch, getUserFacingConfigMessage, readJsonOrText } from "@/lib/api";
import { getAdminUser } from "@/lib/azureAuth";

function prettyJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeBuildIdString(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  const m = s.match(/[0-9a-f]{7,40}/i);
  return m ? m[0] : s;
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

  const [staticBuildId, setStaticBuildId] = useState("");

  const [debugLoading, setDebugLoading] = useState(false);
  const [debugBody, setDebugBody] = useState(null);

  const [companiesTestLoading, setCompaniesTestLoading] = useState(false);
  const [companiesTest, setCompaniesTest] = useState(null);

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

  }, []);

  useEffect(() => {
    refreshDiagnostic();
  }, [refreshDiagnostic]);

  useEffect(() => {
    let cancelled = false;

    fetch("/__build_id.txt")
      .then((res) => (res.ok ? res.text() : ""))
      .then((txt) => {
        if (cancelled) return;
        setStaticBuildId(normalizeBuildIdString(txt));
      })
      .catch(() => {
        if (cancelled) return;
        setStaticBuildId("");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const cosmosConfigured = Boolean(diagnostic?.cosmosConfigured);

  const apiBuildId = normalizeBuildIdString(diagnostic?.build_info?.build_id);
  const apiBuildSource = String(diagnostic?.build_info?.build_id_source || "").trim();

  const buildId = apiBuildId && apiBuildId !== "unknown" ? apiBuildId : staticBuildId;
  const buildSource = apiBuildId && apiBuildId !== "unknown" ? apiBuildSource : staticBuildId ? "STATIC_BUILD_ID_FILE" : apiBuildSource;

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

  const testCompaniesApi = useCallback(async () => {
    setCompaniesTestLoading(true);
    setCompaniesTest(null);

    try {
      const res = await apiFetch("/xadmin-api-companies?take=1");
      const body = await readJsonOrText(res);
      setCompaniesTest({ status: res.status, ok: res.ok, body });

      if (!res.ok) {
        const msg = (await getUserFacingConfigMessage(res)) || body?.error || `Companies API failed (${res.status})`;
        toast.error(msg);
      } else {
        toast.success("Companies API OK");
      }
    } catch (e) {
      const msg = e?.message || "Companies API failed";
      setCompaniesTest({ status: 0, ok: false, body: { error: msg } });
      toast.error(msg);
    } finally {
      setCompaniesTestLoading(false);
    }
  }, []);

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
              <StatusPill ok={true} label={`API base: ${API_BASE}`} />
              <StatusPill
                ok={Boolean(buildId && buildId !== "unknown")}
                label={buildId ? `Build ${buildId.slice(0, 8)}${buildSource ? ` (${buildSource})` : ""}` : "Build unknown"}
              />
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
                <h2 className="text-lg font-semibold text-slate-900">Companies API health</h2>
                <Button onClick={testCompaniesApi} disabled={companiesTestLoading}>
                  {companiesTestLoading ? "Testing…" : "Test Companies API"}
                </Button>
              </div>
              <p className="mt-2 text-sm text-slate-600">
                Calls <code>/api/xadmin-api-companies?take=1</code> and shows status + response body.
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-slate-700">Status:</span>
                <code className="rounded bg-slate-100 px-2 py-1 text-xs">
                  {companiesTest ? (companiesTest.status ? `${companiesTest.status}${companiesTest.ok ? " OK" : ""}` : "(network error)") : "(not run)"}
                </code>
              </div>

              <pre className="mt-4 max-h-[420px] overflow-auto rounded bg-slate-950 text-slate-100 p-3 text-xs">
                {prettyJson(companiesTest?.body)}
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
