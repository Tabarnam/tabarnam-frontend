import React from "react";
import { Helmet } from "react-helmet-async";

import AdminHeader from "@/components/AdminHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetch } from "@/lib/api";
import { toast } from "@/lib/toast";

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readJsonBody(res) {
  const text = await res.text().catch(() => "");
  return safeJsonParse(text);
}

function isCosmosNotConfigured(res, body) {
  return res.status === 503 && body && typeof body === "object" && body.error === "Cosmos DB not configured";
}

export default function AdminPanel() {
  const [diagnosticStatus, setDiagnosticStatus] = React.useState("loading"); // loading | configured | missing_config | error
  const [diagnosticBody, setDiagnosticBody] = React.useState(null);
  const [lastDiagnosticAt, setLastDiagnosticAt] = React.useState(null);

  const [runningAction, setRunningAction] = React.useState(null); // companies | recalc | debug | null
  const [actionResult, setActionResult] = React.useState(null);

  const runSaveDiagnostic = React.useCallback(async () => {
    setDiagnosticStatus("loading");
    setActionResult(null);

    const res = await apiFetch("/xadmin-api-save-diagnostic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "admin-ui",
        path: window.location.pathname,
        userAgent: navigator.userAgent,
        ts: new Date().toISOString(),
      }),
    });

    const body = await readJsonBody(res);
    setDiagnosticBody(body);
    setLastDiagnosticAt(new Date());

    if (res.ok) {
      setDiagnosticStatus("configured");
      return;
    }

    if (isCosmosNotConfigured(res, body)) {
      setDiagnosticStatus("missing_config");
      return;
    }

    setDiagnosticStatus("error");
  }, []);

  React.useEffect(() => {
    runSaveDiagnostic();
  }, [runSaveDiagnostic]);

  const configured = diagnosticStatus === "configured";
  const missingConfig = diagnosticStatus === "missing_config";

  const runAction = React.useCallback(
    async (key, path, init) => {
      setRunningAction(key);
      setActionResult(null);

      try {
        const res = await apiFetch(path, init);
        const body = await readJsonBody(res);

        setActionResult({
          ok: res.ok,
          status: res.status,
          body,
        });

        if (!res.ok) {
          if (isCosmosNotConfigured(res, body)) {
            setDiagnosticStatus("missing_config");
            return;
          }

          toast.error({
            title: `Request failed (${res.status})`,
            description: body?.error || body?.message || res.statusText || "Unexpected error",
          });
          return;
        }

        toast.success({ title: "Success" });
      } finally {
        setRunningAction(null);
      }
    },
    []
  );

  return (
    <>
      <Helmet>
        <title>Tabarnam Admin</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      <div className="min-h-screen bg-slate-50">
        <AdminHeader />

        <main className="container mx-auto py-6 px-4">
          <div className="mb-6">
            <h1 className="text-3xl font-bold text-slate-900">Admin Diagnostics</h1>
            <p className="text-slate-600 mt-1">
              This page is a safe diagnostics surface. It will not auto-fetch data beyond the canonical admin contract.
            </p>
          </div>

          {missingConfig ? (
            <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900">
              <div className="font-semibold">Configuration required</div>
              <div className="mt-1 text-sm">
                Backend responded with <span className="font-mono">503</span> / <span className="font-mono">Cosmos DB not configured</span>.
                This is expected when Cosmos environment variables are missing.
              </div>
            </div>
          ) : null}

          {diagnosticStatus === "error" ? (
            <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-red-900">
              <div className="font-semibold">Diagnostic failed</div>
              <div className="mt-1 text-sm">The backend did not return the expected diagnostic response.</div>
            </div>
          ) : null}

          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Diagnostic status</CardTitle>
                <CardDescription>Runs once on page load (no retries or loops).</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="text-sm">
                  <span className="font-semibold">State:</span> {diagnosticStatus}
                </div>
                <div className="text-sm">
                  <span className="font-semibold">Last run:</span> {lastDiagnosticAt ? lastDiagnosticAt.toLocaleString() : "—"}
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => runSaveDiagnostic()}
                    disabled={diagnosticStatus === "loading"}
                  >
                    Re-run diagnostic
                  </Button>
                </div>

                <details className="rounded-md border bg-white p-3">
                  <summary className="cursor-pointer text-sm font-medium">View diagnostic response</summary>
                  <pre className="mt-2 max-h-72 overflow-auto rounded bg-slate-50 p-3 text-xs text-slate-800">
                    {JSON.stringify(diagnosticBody, null, 2)}
                  </pre>
                </details>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Canonical admin actions</CardTitle>
                <CardDescription>Disabled until Cosmos DB is configured.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-col gap-2">
                  <Button
                    type="button"
                    onClick={() =>
                      runAction("companies", "/xadmin-api-companies", {
                        method: "GET",
                      })
                    }
                    disabled={!configured || runningAction !== null}
                  >
                    Load companies
                  </Button>

                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      runAction("recalc", "/xadmin-api-recalc-review-counts", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ source: "admin-ui", ts: new Date().toISOString() }),
                      })
                    }
                    disabled={!configured || runningAction !== null}
                  >
                    Recalculate review counts
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      runAction("debug", "/xadmin-api-debug", {
                        method: "GET",
                      })
                    }
                    disabled={!configured || runningAction !== null}
                  >
                    Debug
                  </Button>
                </div>

                {!configured ? (
                  <div className="text-sm text-slate-600">Actions are disabled until diagnostics confirm configuration.</div>
                ) : null}

                {actionResult ? (
                  <details className="rounded-md border bg-white p-3">
                    <summary className="cursor-pointer text-sm font-medium">Last action response</summary>
                    <div className="mt-2 text-xs text-slate-700">Status: {actionResult.status}</div>
                    <pre className="mt-2 max-h-72 overflow-auto rounded bg-slate-50 p-3 text-xs text-slate-800">
                      {JSON.stringify(actionResult.body, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </main>
      </div>
    </>
  );
}
