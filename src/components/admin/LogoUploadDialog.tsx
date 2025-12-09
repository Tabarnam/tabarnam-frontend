import React, { useRef, useState } from "react";
import { setLogoUrl, uploadLogoFile } from "@/lib/api/adminLogos";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { X, ZoomIn, ZoomOut, RotateCw, Sun } from "lucide-react";

interface LogoEditState {
  originalFile: File | null;
  preview: string;
  crop: { x: number; y: number; width: number; height: number; rotation: number };
  brightness: number;
  contrast: number;
  scale: number;
}

export function LogoUploadDialog({
  companyId,
  onClose,
  onSaved,
  onError,
}: {
  companyId: string;
  onClose?: () => void;
  onSaved?: (url: string) => void;
  onError?: (error: string) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [logoUrl, setLogoUrlState] = useState("");
  const [editState, setEditState] = useState<LogoEditState | null>(null);
  const [activeTab, setActiveTab] = useState<"url" | "upload" | "edit">("url");
  const [isBusy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const resetEditState = () => {
    setEditState(null);
    setActiveTab("upload");
  };

  const handleFileSelect = async (f: File) => {
    if (!f.type.startsWith("image/")) {
      setError("Please select a valid image file");
      return;
    }

    if (f.size > 5 * 1024 * 1024) {
      setError("File size must be under 5MB");
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const preview = e.target?.result as string;
      setEditState({
        originalFile: f,
        preview,
        crop: { x: 0, y: 0, width: 500, height: 500, rotation: 0 },
        brightness: 100,
        contrast: 100,
        scale: 1,
      });
      setError("");
      setActiveTab("edit");
    };
    reader.readAsDataURL(f);
  };

  const saveUrl = async () => {
    setError("");
    if (!logoUrl.trim()) {
      setError("Enter a URL");
      return;
    }
    if (logoUrl.startsWith('blob:')) {
      const errorMessage = "Invalid blob URL—use a permanent link from Azure Blob Storage or another CDN.";
      setError(errorMessage);
      onError?.(errorMessage);
      return;
    }
    try {
      setBusy(true);
      const r = await setLogoUrl(companyId, logoUrl.trim());

      // Validate returned URL is not a blob URL
      if (!r.logo_url || r.logo_url.startsWith('blob:')) {
        const errorMessage = "Server returned invalid URL—please try uploading a file instead.";
        setError(errorMessage);
        onError?.(errorMessage);
        return;
      }

      onSaved?.(r.logo_url);
      onClose?.();
    } catch (e: any) {
      const errorMessage = e?.message || "Failed to save logo URL";
      setError(errorMessage);
      onError?.(errorMessage);
    } finally {
      setBusy(false);
    }
  };

  const resizeAndUploadImage = async (canvas: HTMLCanvasElement) => {
    try {
      setBusy(true);
      setError("");

      // Convert canvas to blob
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => {
          if (b) resolve(b);
          else reject(new Error("Failed to convert canvas to blob"));
        }, "image/png", 0.95);
      });

      // Create file from blob
      const file = new File([blob], "logo.png", { type: "image/png" });

      // Upload using existing function
      const r = await uploadLogoFile(companyId, file);

      // Validate returned URL is not a blob URL
      if (!r.logo_url || r.logo_url.startsWith('blob:')) {
        const errorMessage = "Server returned invalid URL—upload may have failed. Please try again.";
        setError(errorMessage);
        onError?.(errorMessage);
        return;
      }

      onSaved?.(r.logo_url);
      onClose?.();
    } catch (e: any) {
      const errorMessage = e?.message || "Upload failed";
      setError(errorMessage);
      onError?.(errorMessage);
    } finally {
      setBusy(false);
    }
  };

  const handleApplyEdit = async () => {
    if (!editState || !editState.originalFile) return;

    const img = new Image();
    img.onload = async () => {
      const canvas = document.createElement("canvas");
      const maxSize = 500;

      // Calculate dimensions to maintain aspect ratio within 500x500
      let width = img.naturalWidth;
      let height = img.naturalHeight;
      if (width > maxSize || height > maxSize) {
        if (width > height) {
          height = Math.round((height * maxSize) / width);
          width = maxSize;
        } else {
          width = Math.round((width * maxSize) / height);
          height = maxSize;
        }
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Apply transformations
      ctx.filter = `brightness(${editState.brightness}%) contrast(${editState.contrast}%)`;
      ctx.translate(width / 2, height / 2);
      ctx.rotate((editState.crop.rotation * Math.PI) / 180);
      ctx.drawImage(img, -width / 2, -height / 2, width, height);

      await resizeAndUploadImage(canvas);
    };
    img.src = editState.preview;
  };

  return (
    <div className="w-full max-w-md mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-lg">Update Company Logo</h3>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
          <X size={20} />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-4 border-b">
        <button
          onClick={() => setActiveTab("url")}
          className={`px-4 py-2 font-medium text-sm ${
            activeTab === "url"
              ? "border-b-2 border-[#B1DDE3] text-slate-900"
              : "text-slate-600 hover:text-slate-900"
          }`}
        >
          From URL
        </button>
        <button
          onClick={() => setActiveTab("upload")}
          className={`px-4 py-2 font-medium text-sm ${
            activeTab === "upload"
              ? "border-b-2 border-[#B1DDE3] text-slate-900"
              : "text-slate-600 hover:text-slate-900"
          }`}
        >
          Upload File
        </button>
      </div>

      {/* URL Tab */}
      {activeTab === "url" && (
        <div className="space-y-3">
          <div>
            <Label htmlFor="logo-url" className="text-sm">
              Logo URL
            </Label>
            <Input
              id="logo-url"
              placeholder="https://example.com/logo.png"
              value={logoUrl}
              onChange={(e) => setLogoUrlState(e.target.value)}
              className="mt-1"
            />
          </div>
          {error && <div className="text-sm text-red-600">❌ {error}</div>}
          <div className="flex gap-2">
            <Button
              onClick={saveUrl}
              disabled={isBusy || !logoUrl.trim()}
              className="flex-1 bg-[#B1DDE3] text-slate-900 hover:bg-[#A0C8D0]"
            >
              {isBusy ? "Saving…" : "Save URL"}
            </Button>
            <Button onClick={onClose} variant="outline" className="flex-1">
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Upload Tab */}
      {activeTab === "upload" && !editState && (
        <div className="space-y-3">
          <div className="border-2 border-dashed border-slate-300 rounded-lg p-6 text-center cursor-pointer hover:border-slate-400">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/svg+xml"
              onChange={(e) => {
                setError("");
                const f = e.target.files?.[0];
                if (f) {
                  if (f.size > 5 * 1024 * 1024) {
                    setError("File size must be under 5MB");
                    return;
                  }
                  handleFileSelect(f);
                }
              }}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full"
            >
              <div className="text-slate-600">
                <div className="text-sm font-medium mb-1">Drop file here or click to select</div>
                <div className="text-xs text-slate-500">PNG, JPG, SVG, GIF (max 5MB)</div>
              </div>
            </button>
          </div>
          {error && <div className="text-sm text-red-600">❌ {error}</div>}
          <Button onClick={onClose} variant="outline" className="w-full">
            Cancel
          </Button>
        </div>
      )}

      {/* Edit Tab */}
      {editState && activeTab === "edit" && (
        <div className="space-y-4">
          <div className="bg-slate-50 rounded-lg p-4">
            <div className="mb-4">
              <img
                src={editState.preview}
                alt="Logo preview"
                className="max-w-full max-h-64 mx-auto"
              />
            </div>

            {/* Rotation */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <RotateCw size={16} className="text-slate-600" />
                <Label className="text-sm font-medium">Rotation</Label>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min="0"
                  max="360"
                  step="15"
                  value={editState.crop.rotation}
                  onChange={(e) =>
                    setEditState({
                      ...editState,
                      crop: { ...editState.crop, rotation: parseInt(e.target.value) },
                    })
                  }
                  className="flex-1 h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-[#B1DDE3]"
                />
                <span className="text-sm text-slate-600 min-w-[3rem]">{editState.crop.rotation}°</span>
              </div>
            </div>

            {/* Brightness */}
            <div className="space-y-2 mt-4">
              <div className="flex items-center gap-2">
                <Sun size={16} className="text-slate-600" />
                <Label className="text-sm font-medium">Brightness</Label>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min="50"
                  max="150"
                  step="5"
                  value={editState.brightness}
                  onChange={(e) =>
                    setEditState({ ...editState, brightness: parseInt(e.target.value) })
                  }
                  className="flex-1 h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-[#B1DDE3]"
                />
                <span className="text-sm text-slate-600 min-w-[3rem]">{editState.brightness}%</span>
              </div>
            </div>

            {/* Contrast */}
            <div className="space-y-2 mt-4">
              <div className="flex items-center gap-2">
                <ZoomIn size={16} className="text-slate-600" />
                <Label className="text-sm font-medium">Contrast</Label>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min="50"
                  max="150"
                  step="5"
                  value={editState.contrast}
                  onChange={(e) =>
                    setEditState({ ...editState, contrast: parseInt(e.target.value) })
                  }
                  className="flex-1 h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-[#B1DDE3]"
                />
                <span className="text-sm text-slate-600 min-w-[3rem]">{editState.contrast}%</span>
              </div>
            </div>

            <div className="mt-1 text-xs text-slate-600">
              Will be optimized to 500x500px max for storage
            </div>
          </div>

          {error && <div className="text-sm text-red-600">❌ {error}</div>}

          <div className="flex gap-2">
            <Button
              onClick={handleApplyEdit}
              disabled={isBusy}
              className="flex-1 bg-[#B1DDE3] text-slate-900 hover:bg-[#A0C8D0]"
            >
              {isBusy ? "Uploading…" : "Apply & Upload"}
            </Button>
            <Button onClick={resetEditState} variant="outline" className="flex-1">
              Back
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default LogoUploadDialog;
