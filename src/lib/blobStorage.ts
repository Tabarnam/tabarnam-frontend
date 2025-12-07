import { API_BASE } from "./api";

export interface BlobUploadResponse {
  ok: boolean;
  logo_url?: string;
  error?: string;
  message?: string;
}

/**
 * Upload a logo file to Azure Blob Storage
 * @param file - The image file to upload
 * @param companyId - The company ID for organizing the blob
 * @returns The blob URL or null if upload fails
 */
export async function uploadLogoBlobFile(
  file: File,
  companyId: string
): Promise<string | null> {
  try {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("companyId", companyId);

    const response = await fetch(`${API_BASE}/upload-logo-blob`, {
      method: "POST",
      body: formData,
    });

    const data: BlobUploadResponse = await response.json();

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
 * Delete a logo from Azure Blob Storage
 * @param blobUrl - The full blob URL to delete
 * @returns true if deletion was successful
 */
export async function deleteLogoBlob(blobUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/delete-logo-blob`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blob_url: blobUrl }),
    });

    if (!response.ok) {
      console.error("Logo deletion failed");
      return false;
    }

    return true;
  } catch (error) {
    console.error("Logo deletion error:", error);
    return false;
  }
}

/**
 * Generate a presigned URL for blob upload (not implemented yet, for future use)
 */
export async function generatePresignedUploadUrl(
  companyId: string,
  fileName: string
): Promise<string | null> {
  try {
    const response = await fetch(`${API_BASE}/presigned-logo-upload-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyId, fileName }),
    });

    if (!response.ok) {
      console.error("Failed to generate presigned URL");
      return null;
    }

    const data = await response.json();
    return data.presigned_url || null;
  } catch (error) {
    console.error("Presigned URL error:", error);
    return null;
  }
}
