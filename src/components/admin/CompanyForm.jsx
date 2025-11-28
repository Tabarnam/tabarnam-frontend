import React, { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api";
import { toast } from "sonner";
import { getAdminUser } from "@/lib/azureAuth";
import TagInputWithSuggestions from "./form-elements/TagInputWithSuggestions";
import StarNotesEditor from "./form-elements/StarNotesEditor";

const CompanyForm = ({ company, onSaved, isOpen, onClose, onSuccess }) => {
  const user = getAdminUser();
  const [formData, setFormData] = useState({});
  const [isSaving, setIsSaving] = useState(false);
  const [keywords, setKeywords] = useState([]);
  const [manufacturingLocationInput, setManufacturingLocationInput] = useState("");
  const [starRating, setStarRating] = useState(0);

  // Normalize incoming company data from snake_case to form structure
  const normalizeCompany = (comp) => {
    if (!comp) return {};
    return {
      id: comp.id || comp.company_id,
      company_id: comp.company_id || comp.id,
      company_name: comp.company_name || comp.name || "",
      name: comp.name || comp.company_name || "",
      tagline: comp.tagline || "",
      website_url: comp.website_url || comp.domain || comp.url || "",
      domain: comp.domain || comp.website_url || comp.url || "",
      amazon_store_url: comp.amazon_store_url || comp.amazon_url || "",
      amazon_url: comp.amazon_url || comp.amazon_store_url || "",
      industries: Array.isArray(comp.industries) ? comp.industries : [],
      product_keywords: Array.isArray(comp.product_keywords) ? comp.product_keywords : [],
      keywords: Array.isArray(comp.keywords) ? comp.keywords : (Array.isArray(comp.product_keywords) ? comp.product_keywords : []),
      normalized_domain: comp.normalized_domain || "",
      headquarters_location: comp.headquarters_location || "",
      manufacturing_locations: Array.isArray(comp.manufacturing_locations) ? comp.manufacturing_locations : [],
      red_flag: Boolean(comp.red_flag),
      red_flag_reason: comp.red_flag_reason || "",
      location_confidence: comp.location_confidence || "medium",
      star_rating: comp.star_rating || 0,
    };
  };

  useEffect(() => {
    if (company) {
      const normalized = normalizeCompany(company);
      setFormData(normalized);
      const isEditMode = !!(normalized.id || normalized.company_id);
      console.log('[CompanyForm] Rendering with company:', { isEditMode, id: normalized.id, company_id: normalized.company_id, company_name: normalized.company_name });
    } else {
      setFormData({});
      console.log('[CompanyForm] Rendering as new company form');
    }
  }, [company]);

  useEffect(() => {
    const fetchKeywords = async () => {
      try {
        const res = await apiFetch("/admin-keywords");
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          const fetchedKeywords = data?.keywords || data?.items || [];
          setKeywords(fetchedKeywords);
          console.log('[CompanyForm] Keywords fetched:', fetchedKeywords.length, 'items');
        } else {
          console.log('[CompanyForm] Failed to fetch keywords, status:', res.status);
        }
      } catch (error) {
        console.log('[CompanyForm] Error fetching keywords:', error?.message);
      }
    };
    fetchKeywords();
  }, []);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSaving(true);

    const companyId = formData.id || formData.company_id;
    const method = companyId ? "PUT" : "POST";

    const normalized_domain = formData.normalized_domain ||
      (formData.domain || formData.website_url || "")
        .replace(/^(https?:\/\/)?(www\.)?/, "")
        .replace(/\/$/, "")
        .toLowerCase() || "";

    const payload = {
      id: companyId || undefined,
      company_id: companyId || undefined,
      company_name: formData.company_name || "",
      name: formData.name || formData.company_name || "",
      tagline: formData.tagline || "",
      website_url: formData.website_url || formData.domain || "",
      domain: formData.domain || formData.website_url || "",
      amazon_store_url: formData.amazon_store_url || formData.amazon_url || "",
      amazon_url: formData.amazon_url || formData.amazon_store_url || "",
      industries: Array.isArray(formData.industries) ? formData.industries : [],
      product_keywords: Array.isArray(formData.product_keywords) ? formData.product_keywords : [],
      keywords: Array.isArray(formData.keywords) ? formData.keywords : [],
      normalized_domain,
      headquarters_location: formData.headquarters_location || "",
      manufacturing_locations: Array.isArray(formData.manufacturing_locations) ? formData.manufacturing_locations : [],
      red_flag: Boolean(formData.red_flag),
      red_flag_reason: formData.red_flag_reason || "",
      location_confidence: formData.location_confidence || "medium",
    };

    console.log('[CompanyForm] Submitting:', { method, isEditMode: !!companyId, id: payload.id, company_id: payload.company_id, company_name: payload.company_name });

    try {
      const response = await apiFetch("/admin-companies", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company: payload }),
      });

      console.log('[CompanyForm] Response status:', response.status, response.ok);

      if (response.ok) {
        let data;
        try {
          data = await response.json();
        } catch (parseError) {
          console.log("[CompanyForm] Response is not JSON, treating as success");
          data = { company: payload };
        }

        toast.success("Company saved successfully!");
        handleSave(data?.company || payload);
      } else {
        let errorData;
        try {
          errorData = await response.json();
        } catch (parseError) {
          console.log("[CompanyForm] Error response is not JSON:", response.statusText);
          errorData = { error: response.statusText };
        }

        console.log("[CompanyForm] Save failed with status:", response.status, errorData?.error || response.statusText);
        toast.error("Failed to save company");
      }
    } catch (error) {
      console.log("[CompanyForm] Error:", error?.message);
      toast.error("Error saving company");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDialogClose = () => {
    if (onClose) {
      onClose();
    }
  };

  const handleSave = (savedCompany) => {
    if (onSaved) {
      onSaved(savedCompany);
    }
    if (onSuccess) {
      onSuccess(savedCompany);
    }
    handleDialogClose();
  };

  const isEditMode = !!(formData?.id || formData?.company_id);

  return (
    <Dialog open={isOpen} onOpenChange={handleDialogClose}>
      <DialogContent className="sm:max-w-[625px] max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{isEditMode ? "Edit Company" : "Add Company"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 overflow-y-auto pr-4 flex-1">
          <div>
            <Label htmlFor="company_name">Company Name</Label>
            <Input
              id="company_name"
              name="company_name"
              value={formData.company_name || ""}
              onChange={handleChange}
              required
            />
          </div>
          <div>
            <Label htmlFor="tagline">Tagline</Label>
            <Input
              id="tagline"
              name="tagline"
              value={formData.tagline || ""}
              onChange={handleChange}
            />
          </div>
          <div>
            <Label htmlFor="website_url">Website URL</Label>
            <Input
              id="website_url"
              name="website_url"
              value={formData.website_url || ""}
              onChange={handleChange}
              placeholder="https://example.com"
            />
          </div>
          <div>
            <Label htmlFor="amazon_store_url">Amazon Store URL</Label>
            <Input
              id="amazon_store_url"
              name="amazon_store_url"
              value={formData.amazon_store_url || ""}
              onChange={handleChange}
              placeholder="https://amazon.com/..."
            />
          </div>
          <div className="border-t pt-4 mt-4">
            <h3 className="font-semibold text-sm mb-4">Location Information</h3>
            <div>
              <Label htmlFor="headquarters_location">Headquarters Location</Label>
              <Input
                id="headquarters_location"
                name="headquarters_location"
                value={formData.headquarters_location || ""}
                onChange={handleChange}
                placeholder="City, State/Region, Country (e.g., San Francisco, CA, USA)"
              />
            </div>
            <div className="mt-4">
              <Label htmlFor="manufacturing_locations">Manufacturing Locations</Label>
              <div className="flex gap-2 mb-2">
                <Input
                  id="manufacturing_locations_input"
                  value={manufacturingLocationInput}
                  onChange={(e) => setManufacturingLocationInput(e.target.value)}
                  placeholder="Add location (e.g., Shanghai, China) and press Add"
                  onKeyPress={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (manufacturingLocationInput.trim()) {
                        setFormData((prev) => ({
                          ...prev,
                          manufacturing_locations: [...(prev.manufacturing_locations || []), manufacturingLocationInput.trim()]
                        }));
                        setManufacturingLocationInput("");
                      }
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    if (manufacturingLocationInput.trim()) {
                      setFormData((prev) => ({
                        ...prev,
                        manufacturing_locations: [...(prev.manufacturing_locations || []), manufacturingLocationInput.trim()]
                      }));
                      setManufacturingLocationInput("");
                    }
                  }}
                  className="px-3 py-2 bg-[#B1DDE3] text-slate-900 rounded hover:bg-[#A0C8D0] text-sm font-medium"
                >
                  Add
                </button>
              </div>
              {Array.isArray(formData.manufacturing_locations) && formData.manufacturing_locations.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {formData.manufacturing_locations.map((loc, idx) => (
                    <div key={idx} className="bg-slate-100 text-slate-700 px-3 py-1 rounded text-sm flex items-center gap-2">
                      {loc}
                      <button
                        type="button"
                        onClick={() => {
                          setFormData((prev) => ({
                            ...prev,
                            manufacturing_locations: prev.manufacturing_locations.filter((_, i) => i !== idx)
                          }));
                        }}
                        className="text-red-500 hover:text-red-700 font-bold"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="mt-4">
              <Label htmlFor="red_flag">Red Flag</Label>
              <div className="flex items-center gap-2">
                <input
                  id="red_flag"
                  type="checkbox"
                  checked={Boolean(formData.red_flag)}
                  onChange={(e) => setFormData((prev) => ({ ...prev, red_flag: e.target.checked }))}
                  className="w-4 h-4"
                />
                <span className="text-sm text-slate-600">Mark for manual review</span>
              </div>
            </div>
            {formData.red_flag && (
              <div className="mt-4">
                <Label htmlFor="red_flag_reason">Red Flag Reason</Label>
                <textarea
                  id="red_flag_reason"
                  value={formData.red_flag_reason || ""}
                  onChange={(e) => setFormData((prev) => ({ ...prev, red_flag_reason: e.target.value }))}
                  placeholder="Reason for flagging this company..."
                  rows="3"
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[#B1DDE3]"
                />
              </div>
            )}
            <div className="mt-4">
              <Label htmlFor="location_confidence">Location Confidence</Label>
              <select
                id="location_confidence"
                value={formData.location_confidence || "medium"}
                onChange={(e) => setFormData((prev) => ({ ...prev, location_confidence: e.target.value }))}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[#B1DDE3]"
              >
                <option value="high">High - Well documented locations</option>
                <option value="medium">Medium - Reasonable location data</option>
                <option value="low">Low - Vague or unverifiable locations</option>
              </select>
            </div>
          </div>
          <div>
            <Label htmlFor="keywords">Keywords</Label>
            <TagInputWithSuggestions
              suggestions={keywords}
              value={formData.keywords || []}
              onChange={(newKeywords) => setFormData((prev) => ({ ...prev, keywords: newKeywords }))}
            />
          </div>
          <Button type="submit" disabled={isSaving}>
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default CompanyForm;
