import React, { useRef, useState } from "react";
import { setLogoUrl, uploadLogoFile } from "@/lib/api/adminLogos";

export function LogoUploadDialog({
  companyId,
  onClose,
  onSaved,
}: {
  companyId: string;
  onClose: () => void;
  onSaved: (newUrl: string) => void;
}) {
  const [tab, setTab] = useState<"file" | "url">("file");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  async function handleSave() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      if (tab === "url") {
        const url = urlInputRef.current?.value?.trim() || "";
        if (!url) throw new Error("Please paste a logo URL.");
        const { logo_url } = await setLogoUrl(companyId, url);
        onSaved(logo_url);
        onClose();
      } else {
        const f = fileInputRef.current?.files?.[0];
        if (!f) throw new Error("Please choose an image file.");
        const { logo_url } = await uploadLogoFile(companyId, f);
        onSaved(logo_url);
        onClose();
      }
    } catch (e: any) {
      setError(e?.message || "Failed to save logo.");
    } finally {
      setBusy(false);
    }
  }

  function onFileChange() {
    const f = fileInputRef.current?.files?.[0];
    if (f) setPreview(URL.createObjectURL(f));
    else setPreview(null);
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-2xl bg-white p-4 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Add Company Logo</h3>
          <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-800" disabled={busy}>Close</button>
        </div>

        <div className="mt-3 flex gap-2">
          <button
            className={`px-3 py-1.5 rounded-lg border ${tab === "file" ? "bg-slate-100 border-slate-300" : "border-slate-200"}`}
            onClick={() => setTab("file")}
            disabled={busy}
          >
            Upload file
          </button>
          <button
            className={`px-3 py-1.5 rounded-lg border ${tab === "url" ? "bg-slate-100 border-slate-300" : "border-slate-200"}`}
            onClick={() => setTab("url")}
            disabled={busy}
          >
            Paste URL
          </button>
        </div>

        {tab === "file" ? (
          <div className="mt-4 space-y-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={onFileChange}
              disabled={busy}
              className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:text-slate-700 hover:file:bg-slate-50"
            />
            {preview && (
              <div className="rounded-md border border-slate-200 p-2">
                <img src={preview} alt="Logo preview" className="h-20 w-20 object-contain" />
              </div>
            )}
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            <input
              ref={urlInputRef}
              type="url"
              placeholder="https://example.com/logo.png"
              disabled={busy}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-300"
            />
            <p className="text-xs text-slate-500">Paste a direct image URL (PNG/JPG/SVG).</p>
          </div>
        )}

        {error && <div className="mt-3 text-sm text-red-600">{error}</div>}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm">Cancel</button>
          <button onClick={handleSave} disabled={busy} className="rounded-md bg-[rgb(177,221,227)] px-3 py-1.5 text-sm text-slate-800 border border-[rgb(101,188,200)]">
            {busy ? "Saving…" : "Save logo"}
          </button>
        </div>
      </div>
    </div>
  );
}
