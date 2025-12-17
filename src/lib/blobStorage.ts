import { API_BASE } from "@/lib/api";

export interface BlobUploadResponse {
  ok: boolean;
  logo_url?: string;
  error?: string;
  message?: string;
}

/**
 * Upload a logo file to Azure Blob Storage.
 */
export async function uploadLogoBlobFile(file: File, companyId: string): Promise<string | null> {
  try {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("companyId", companyId);

    const response = await fetch(`${API_BASE}/upload-logo-blob`, {
      method: "POST",
      body: formData,
    });

    const data: BlobUploadResponse = await response.json().catch(() => ({ ok: false, error: "Invalid JSON" }));

    if (!response.ok || !data.ok) {
      console.error("Logo upload failed:", data.error || "Unknown error");
      return null;
    }

    return data.logo_url || null;
  } catch (error) {
    console.error("Logo upload error:", error);
    return null;
  }
}

/**
 * Delete a logo from Azure Blob Storage.
 */
export async function deleteLogoBlob(blobUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/delete-logo-blob`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blob_url: blobUrl }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      console.error("Logo deletion failed", body);
      return false;
    }

    const data = await response.json().catch(() => null);
    return Boolean(data?.ok ?? true);
  } catch (error) {
    console.error("Logo deletion error:", error);
    return false;
  }
}
