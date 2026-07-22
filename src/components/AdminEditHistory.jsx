// Launcher for a company's edit history.
//
// This used to be an inline collapsible feed inside the edit dialog, which meant
// the history competed for space with the form and rendered raw field diffs. It
// now opens /admin/companies/:id/history in a new tab, so the reviewer keeps the
// editor open alongside a full-width, readable timeline.

import React from "react";
import { ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";

function asString(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function buildCompanyHistoryPath(companyId, companyName) {
  const id = asString(companyId).trim();
  if (!id) return "";
  const name = asString(companyName).trim();
  const qs = name ? `?name=${encodeURIComponent(name)}` : "";
  return `/admin/companies/${encodeURIComponent(id)}/history${qs}`;
}

export default function AdminEditHistory({ companyId, companyName }) {
  const href = buildCompanyHistoryPath(companyId, companyName);
  if (!href) return null;

  return (
    <section className="rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-900 dark:text-foreground">Edit history</div>
          <div className="text-xs text-slate-600 dark:text-muted-foreground">
            Who changed what, in plain English — opens in a new tab.
          </div>
        </div>

        <Button asChild size="sm" variant="outline">
          <a href={href} target="_blank" rel="noopener noreferrer">
            Open edit history
            <ExternalLink className="ml-2 h-3.5 w-3.5" />
          </a>
        </Button>
      </div>
    </section>
  );
}
