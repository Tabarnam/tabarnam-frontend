import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { API_BASE, FUNCTIONS_BASE, apiFetch, ensureBuildId, join, readJsonOrText } from "@/lib/api";
import { cn } from "@/lib/utils";

const navLinkClass = ({ isActive }) =>
  cn(
    "inline-flex items-center rounded-md px-3 py-2 text-sm font-medium transition",
    isActive ? "bg-slate-800 text-white" : "text-slate-200 hover:bg-slate-800 hover:text-white"
  );

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

  useEffect(() => {
    ensureBuildId();
  }, []);

  const handleLogout = () => {
    const postLogout = encodeURIComponent("/login");
    window.location.href = `/.auth/logout?post_logout_redirect_uri=${postLogout}`;
    navigate("/login");
  };

  return (
    <div className="bg-slate-900 border-b border-slate-800">
      <div className="p-4 flex items-end justify-between gap-4">
        <div className="flex items-end gap-4">
          <Link to="/" className="flex items-end" aria-label="Tabarnam home">
            <img src="/tabarnam.png" alt="Tabarnam" className="h-[5rem] w-auto" />
          </Link>
          <div className="flex flex-col gap-2">
            <span className="text-2xl font-bold text-white">Admin</span>
            <nav className="flex flex-wrap items-center gap-1">
              <NavLink to="/admin" end className={navLinkClass}>
                Companies
              </NavLink>
              <NavLink to="/admin/import" className={navLinkClass}>
                Import
              </NavLink>
              <NavLink to="/admin/diagnostics" className={navLinkClass}>
                Diagnostics
              </NavLink>
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
