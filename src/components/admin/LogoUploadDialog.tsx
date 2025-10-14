// src/components/admin/LogoUploadDialog.tsx
import React, { useRef, useState } from "react";
import { setLogoUrl, uploadLogoFile } from "@/lib/api/adminLogos";

export function LogoUploadDialog({
  companyId,
  onClose,
  onSaved,
}: {
  companyId: string;
  onClose?: () => void;
  onSaved?: (url: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [logoUrl, setLogoUrlState] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const saveUrl = async () => {
    setErr("");
    if (!logoUrl.trim()) { setErr("Enter a URL"); return; }
    try {
      setBusy(true);
      const r = await setLogoUrl(companyId, logoUrl.trim());
      onSaved?.(r.logo_url);
      onClose?.();
    } catch (e: any) {
      setErr(e?.message || "Failed to save logo URL");
    } finally {
      setBusy(false);
    }
  };

  const uploadFile = async (f: File) => {
    setErr("");
    try {
      setBusy(true);
      const r = await uploadLogoFile(companyId, f);
      onSaved?.(r.logo_url);
      onClose?.();
    } catch (e: any) {
      setErr(e?.message || "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4">
      <h3 className="font-semibold mb-2">Update Logo</h3>

      <label className="block text-sm text-gray-700 mb-1">Logo URL</label>
      <div className="flex gap-2 mb-3">
        <input
          className="flex-1 border rounded px-3 py-2"
          placeholder="https://example.com/logo.png"
          value={logoUrl}
          onChange={(e) => setLogoUrlState(e.target.value)}
        />
        <button
          onClick={saveUrl}
          disabled={busy}
          className={`px-4 py-2 rounded text-white ${busy ? "bg-gray-400" : "bg-emerald-600 hover:bg-emerald-700"}`}
        >
          {busy ? "Saving…" : "Save URL"}
        </button>
      </div>

      <div className="text-xs text-gray-500 mb-2">— or —</div>

      <label className="block text-sm text-gray-700 mb-1">Upload file</label>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); }}
      />

      {err && <div className="mt-3 text-sm text-red-600">❌ {err}</div>}

      <div className="mt-4 flex gap-2">
        <button onClick={onClose} className="px-3 py-2 border rounded">Close</button>
      </div>
    </div>
  );
}

export default LogoUploadDialog;
