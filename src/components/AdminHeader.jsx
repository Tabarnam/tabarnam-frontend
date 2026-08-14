import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { API_BASE, FUNCTIONS_BASE, apiFetch, ensureBuildId, join, readJsonOrText } from "@/lib/api";
import { cn } from "@/lib/utils";
import { isContributor } from "@/lib/azureAuth";

const navLinkClass = ({ isActive }) =>
  cn(
    "inline-flex items-center rounded-md px-3 py-2 text-sm font-medium transition",
    isActive ? "bg-slate-800 text-white" : "text-slate-200 hover:bg-slate-800 hover:text-white"
  );

// `contributor: true` means the page's endpoints are open to the scoped role.
// Anything else is hidden from them — not as a security measure (the server
// rejects them regardless) but so they get a workspace instead of a row of tabs
// that answer 403.
//
// Keep this list honest: a tab marked contributor-visible whose page calls an
// admin-only endpoint is worse than a hidden one, because it looks available
// and then breaks halfway through a task.
const NAV_ITEMS = [
  { to: "/admin", label: "Companies", end: true, contributor: true },
  { to: "/admin/import", label: "Import" },
  { to: "/admin/images", label: "Images" },
  { to: "/admin/logos", label: "Logos" },
  { to: "/admin/search-edit", label: "Search & Edit" },
  { to: "/admin/backfill-scores", label: "Scores" },
  { to: "/admin/review-queue", label: "Reviews" },
  { to: "/admin/backfill-homepages", label: "Backfill Pages" },
  { to: "/admin/backfill-logos", label: "Backfill Logos" },
  { to: "/admin/extract-companies", label: "Extract Companies" },
  { to: "/admin/audit-log", label: "Activity" },
  { to: "/admin/diagnostics", label: "Diagnostics" },
];

function ApiStatusIndicator() {
  const [status, setStatus] = useState("checking");
  const [httpStatus, setHttpStatus] = useState(null);
  const [detail, setDetail] = useState("");
  const [lastCheckedAt, setLastCheckedAt] = useState(null);
  const [probePath, setProbePath] = useState(null);

  const title = useMemo(() => {
    const baseLabel = FUNCTIONS_BASE ? FUNCTIONS_BASE : "(same-origin)";
    const resolved = probePath ? join(API_BASE, probePath) : "";
    const displayUrl = resolved
      ? resolved.startsWith("/")
        ? `${window.location.origin}${resolved}`
        : resolved
      : "";

    const parts = [`Base: ${baseLabel}`, `API_BASE: ${API_BASE}`];
    if (displayUrl) parts.push(`Probe: GET ${displayUrl}`);
    if (httpStatus != null) parts.push(`HTTP: ${httpStatus}`);
    if (detail) parts.push(detail);
    return parts.join("\n");
  }, [detail, httpStatus, probePath]);

  const check = useCallback(async () => {
    setStatus("checking");
    setDetail("");

    const candidates = ["/ping", "/health"];

    try {
      let lastBody = null;
      let lastStatus = null;

      for (const candidate of candidates) {
        setProbePath(candidate);
        const res = await apiFetch(candidate, { method: "GET", headers: { accept: "application/json" } });
        lastStatus = res.status;
        setHttpStatus(res.status);

        const body = await readJsonOrText(res);
        lastBody = body;

        if (res.ok && body && typeof body === "object" && body.ok === true) {
          setStatus("ok");
          setDetail(String(body.name || candidate.replace("/", "")));
          return;
        }

        // If the endpoint doesn't exist on this backend, try the fallback.
        if (res.status === 404) continue;

        setStatus("error");
        setDetail(typeof body === "string" ? body : body?.error ? String(body.error) : "Unhealthy response");
        return;
      }

      setStatus("error");
      setDetail(
        typeof lastBody === "string"
          ? lastBody
          : lastBody?.error
            ? String(lastBody.error)
            : `Health probe not found (last HTTP: ${lastStatus ?? ""})`
      );
    } catch (e) {
      setHttpStatus(null);
      setStatus("error");
      setDetail(e?.message ? String(e.message) : "Request failed");
    } finally {
      setLastCheckedAt(Date.now());
    }
  }, []);

  useEffect(() => {
    check();
    const intervalId = setInterval(check, 30_000);
    return () => clearInterval(intervalId);
  }, [check]);

  const pillClass =
    status === "ok"
      ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-100"
      : status === "error"
        ? "border-red-500/40 bg-red-500/15 text-red-100"
        : "border-slate-500/40 bg-slate-500/15 text-slate-100";

  const dotClass =
    status === "ok" ? "bg-emerald-400" : status === "error" ? "bg-red-400" : "bg-slate-300";

  const label =
    status === "ok" ? "API: OK" : status === "error" ? "API: down" : "API: checking…";

  const subLabel = lastCheckedAt ? new Date(lastCheckedAt).toLocaleTimeString() : "";

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={check}
      className={cn("border text-xs", pillClass)}
      title={title}
      aria-label="API health status"
    >
      <span className={cn("mr-2 inline-block h-2 w-2 rounded-full", dotClass)} />
      <span className="whitespace-nowrap">{label}</span>
      {subLabel ? <span className="ml-2 hidden text-[11px] text-white/70 sm:inline">{subLabel}</span> : null}
    </Button>
  );
}

export default function AdminHeader() {
  const navigate = useNavigate();

  // AdminRoute resolves the roster before it renders children, so the role is
  // normally cached by the time this mounts. Re-read on mount anyway so a slow
  // first fetch collapses the nav rather than flashing tabs that 403.
  const [scoped, setScoped] = useState(() => isContributor());

  useEffect(() => {
    ensureBuildId();
    setScoped(isContributor());
  }, []);

  const handleLogout = () => {
    const postLogout = encodeURIComponent("/login");
    window.location.href = `/.auth/logout?post_logout_redirect_uri=${postLogout}`;
    navigate("/login");
  };

  return (
    <div className="bg-slate-900 border-b border-slate-800">
      <div className="px-4 py-2 flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link to="/" className="flex items-center" aria-label="Tabarnam home">
            <img src="/tabarnam.png" alt="Tabarnam" className="h-9 w-auto" />
          </Link>
          <div className="flex flex-col">
            <nav className="flex flex-wrap items-center gap-1">
              {NAV_ITEMS.filter((item) => !scoped || item.contributor).map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={navLinkClass}
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <ApiStatusIndicator />
          <Button
            onClick={handleLogout}
            variant="outline"
            className="border-red-600 text-red-600 hover:bg-red-600 hover:text-white"
          >
            <LogOut className="w-4 h-4 mr-2" />
            Logout
          </Button>
        </div>
      </div>
    </div>
  );
}
