import { apiFetch } from "@/lib/api";

export interface BlobUploadResponse {
  ok: boolean;
  logo_url?: string;
  error?: string;
  message?: string;
}

/**
 * Upload a logo file to Azure Blob Storage.
 */
export async function uploadLogoBlobFile(file: File, companyId: string): Promise<string> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("company_id", companyId);
  formData.append("companyId", companyId);

  const response = await apiFetch("/upload-logo-blob", {
    method: "POST",
    body: formData,
  });

  const data: BlobUploadResponse = await response.json().catch(() => ({ ok: false, error: "Invalid JSON" }));

  if (!response.ok || !data.ok) {
    throw new Error(data.error || data.message || `Logo upload failed (${response.status})`);
  }

  const url = typeof data.logo_url === "string" ? data.logo_url.trim() : "";
  if (!url) {
    throw new Error("Logo upload succeeded but no logo_url was returned.");
  }

  return url;
}

/**
 * Delete a logo from Azure Blob Storage.
 */
export async function deleteLogoBlob(blobUrl: string): Promise<void> {
  const response = await apiFetch("/delete-logo-blob", {
    method: "POST",
    body: { blob_url: blobUrl },
  });

  const data = await response.json().catch(() => ({ ok: false, error: "Invalid JSON" }));

  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || data?.message || `Logo deletion failed (${response.status})`);
  }
}
