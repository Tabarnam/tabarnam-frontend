import { apiFetch } from "@/lib/api";

export interface BlobUploadResponse {
  ok: boolean;
  logo_url?: string;
  error?: string;
  message?: string;
}

export interface HomepageUploadResponse {
  ok: boolean;
  homepage_image_url?: string;
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

/**
 * Upload a homepage image (above-the-fold website screenshot) to Azure Blob Storage.
 * The server re-encodes to webp and stores under the company-homepages container.
 */
export async function uploadHomepageBlobFile(file: File, companyId: string): Promise<string> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("company_id", companyId);
  formData.append("companyId", companyId);

  const response = await apiFetch("/upload-homepage-blob", {
    method: "POST",
    body: formData,
  });

  const data: HomepageUploadResponse = await response.json().catch(() => ({ ok: false, error: "Invalid JSON" }));

  if (!response.ok || !data.ok) {
    throw new Error(data.error || data.message || `Homepage upload failed (${response.status})`);
  }

  const url = typeof data.homepage_image_url === "string" ? data.homepage_image_url.trim() : "";
  if (!url) {
    throw new Error("Homepage upload succeeded but no homepage_image_url was returned.");
  }

  return url;
}

/**
 * Delete a homepage image from Azure Blob Storage.
 */
export async function deleteHomepageBlob(blobUrl: string): Promise<void> {
  const response = await apiFetch("/delete-homepage-blob", {
    method: "POST",
    body: { blob_url: blobUrl },
  });

  const data = await response.json().catch(() => ({ ok: false, error: "Invalid JSON" }));

  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || data?.message || `Homepage deletion failed (${response.status})`);
  }
}
