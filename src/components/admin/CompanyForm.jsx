import React, { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api";
import { toast } from "sonner";
import { getAdminUser } from "@/lib/azureAuth";
import { Plus, Trash2, Edit2, Image } from "lucide-react";
import IndustriesEditor from "./form-elements/IndustriesEditor";
import KeywordsEditor from "./form-elements/KeywordsEditor";
import HeadquartersLocationsEditor from "./form-elements/HeadquartersLocationsEditor";
import StarRatingEditor from "./form-elements/StarRatingEditor";
import LogoUploadDialog from "./LogoUploadDialog";
import { defaultRating } from "@/types/company";
import { getOrCalculateRating } from "@/lib/stars/calculateRating";

const CompanyForm = ({ company, onSaved, isOpen, onClose, onSuccess }) => {
  const user = getAdminUser();
  const [formData, setFormData] = useState({});
  const [isSaving, setIsSaving] = useState(false);
  const [additionalHQs, setAdditionalHQs] = useState([]);
  const [manufacturingLocationInput, setManufacturingLocationInput] = useState("");
  const [rating, setRating] = useState(defaultRating());
  const [ratingIconType, setRatingIconType] = useState("star");
  const [visibility, setVisibility] = useState({
    hq_public: true,
    manufacturing_public: true,
    admin_rating_public: false,
  });
  const [showLocationSourcesToUsers, setShowLocationSourcesToUsers] = useState(false);
  const [locationSources, setLocationSources] = useState([]);
  const [showLogoDialog, setShowLogoDialog] = useState(false);
  const [newSourceInput, setNewSourceInput] = useState({ url: "", type: "official_website", location: "" });

  // Normalize incoming company data from snake_case to form structure
  const normalizeCompany = (comp) => {
    if (!comp) return {};

    // Extract primary and additional HQs from headquarters_locations array
    let primaryHQ = "";
    let additionalHQsList = [];

    if (Array.isArray(comp.headquarters_locations) && comp.headquarters_locations.length > 0) {
      const primaryHQObj = comp.headquarters_locations.find(hq => hq.is_hq === true);
      if (primaryHQObj && primaryHQObj.address) {
        primaryHQ = primaryHQObj.address;
      }
      additionalHQsList = comp.headquarters_locations.filter(hq => hq.is_hq !== true);
    }

    // Fall back to headquarters_location string if no HQs array
    if (!primaryHQ && typeof comp.headquarters_location === 'string') {
      primaryHQ = comp.headquarters_location;
    }

    const normalized = {
      id: comp.id || comp.company_id,
      company_id: comp.company_id || comp.id,
      company_name: comp.company_name || comp.name || "",
      name: comp.name || comp.company_name || "",
      tagline: comp.tagline || "",
      website_url: comp.website_url || comp.domain || comp.url || "",
      domain: comp.domain || comp.website_url || comp.url || "",
      amazon_store_url: comp.amazon_store_url || comp.amazon_url || "",
      amazon_url: comp.amazon_url || comp.amazon_store_url || "",
      logo_url: comp.logo_url || "",
      industries: Array.isArray(comp.industries) ? comp.industries : [],
      product_keywords: Array.isArray(comp.product_keywords) ? comp.product_keywords : [],
      keywords: Array.isArray(comp.keywords) ? comp.keywords : (Array.isArray(comp.product_keywords) ? comp.product_keywords : []),
      normalized_domain: comp.normalized_domain || "",
      headquarters_location: primaryHQ,
      headquarters_locations: additionalHQsList,
      manufacturing_locations: Array.isArray(comp.manufacturing_locations) ? comp.manufacturing_locations.map(loc => typeof loc === 'string' ? loc : (loc?.address || "")) : [],
      red_flag: Boolean(comp.red_flag),
      red_flag_reason: comp.red_flag_reason || "",
      location_confidence: comp.location_confidence || "medium",
      star_rating: comp.star_rating || 0,
      admin_rating_notes: comp.admin_rating_notes || "",
    };
    return normalized;
  };

  useEffect(() => {
    if (company) {
      const normalized = normalizeCompany(company);

      // Handle invalid legacy blob URLs
      if (normalized.logo_url && normalized.logo_url.startsWith('blob:')) {
        console.warn('[CompanyForm] Detected invalid blob URL in logo_url, clearing it');
        normalized.logo_url = '';
        toast.warning("Invalid legacy logo URL detected—please re-upload a new image.");
      }

      setFormData(normalized);
      setAdditionalHQs(normalized.headquarters_locations || []);

      // Initialize rating from company data
      const companyRating = getOrCalculateRating(company);
      setRating(companyRating);
      setRatingIconType(company.rating_icon_type || "star");

      setVisibility(company.visibility || {
        hq_public: true,
        manufacturing_public: true,
        admin_rating_public: false,
      });
      setShowLocationSourcesToUsers(Boolean(company.show_location_sources_to_users));
      setLocationSources(Array.isArray(company.location_sources) ? company.location_sources : []);
      const isEditMode = !!(normalized.id || normalized.company_id);
      console.log('[CompanyForm] Rendering with company:', { isEditMode, id: normalized.id, company_id: normalized.company_id, company_name: normalized.company_name });
    } else {
      setFormData({});
      setAdditionalHQs([]);
      setRating(defaultRating());
      setRatingIconType("star");
      setVisibility({
        hq_public: true,
        manufacturing_public: true,
        admin_rating_public: false,
      });
      console.log('[CompanyForm] Rendering as new company form');
    }
  }, [company]);


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

    // Build headquarters_locations array from primary and additional HQs
    const headquarters_locations = [];

    if (formData.headquarters_location && formData.headquarters_location.trim()) {
      headquarters_locations.push({
        address: formData.headquarters_location.trim(),
        is_hq: true,
      });
    }

    if (Array.isArray(additionalHQs) && additionalHQs.length > 0) {
      headquarters_locations.push(
        ...additionalHQs.map(hq => ({
          address: hq.address || '',
          city: hq.city,
          country: hq.country,
          lat: hq.lat,
          lng: hq.lng,
          is_hq: false,
        }))
      );
    }

    const payload = {
      id: companyId,
      company_id: companyId,
      company_name: formData.company_name || "",
      name: formData.name || formData.company_name || "",
      tagline: formData.tagline || "",
      website_url: formData.website_url || formData.domain || "",
      domain: formData.domain || formData.website_url || "",
      amazon_store_url: formData.amazon_store_url || formData.amazon_url || "",
      amazon_url: formData.amazon_url || formData.amazon_store_url || "",
      logo_url: formData.logo_url || "",
      industries: Array.isArray(formData.industries) ? formData.industries : [],
      product_keywords: Array.isArray(formData.product_keywords) ? formData.product_keywords : [],
      keywords: Array.isArray(formData.keywords) ? formData.keywords : [],
      normalized_domain,
      headquarters_location: formData.headquarters_location || "",
      headquarters_locations: headquarters_locations.length > 0 ? headquarters_locations : undefined,
      manufacturing_locations: Array.isArray(formData.manufacturing_locations) ? formData.manufacturing_locations : [],
      red_flag: Boolean(formData.red_flag),
      red_flag_reason: formData.red_flag_reason || "",
      location_confidence: formData.location_confidence || "medium",
      show_location_sources_to_users: showLocationSourcesToUsers,
      location_sources: locationSources.length > 0 ? locationSources : undefined,
      rating_icon_type: ratingIconType,
      rating: rating,
      visibility: visibility,
    };

    console.log('[CompanyForm] Submitting:', { method, isEditMode: !!companyId, id: payload.id, company_id: payload.company_id, company_name: payload.company_name });
    console.log('[CompanyForm] Full payload being sent:', JSON.stringify({ company: payload }).substring(0, 500));

    try {
      const response = await apiFetch("/companies-list", {
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

        console.log('[CompanyForm] Save succeeded with response:', { ok: data?.ok, company_id: data?.company?.company_id });
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

        console.log("[CompanyForm] Save failed with status:", response.status, "error:", errorData?.error || response.statusText);

        // Check if error is related to blob URL
        const errorMessage = errorData?.error || response.statusText;
        if (errorMessage && errorMessage.includes('blob:')) {
          toast.error("Logo upload issue: " + errorMessage);
        } else {
          toast.error("Failed to save company: " + errorMessage);
        }
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
      <DialogContent className="w-[95vw] sm:w-[92vw] md:w-[90vw] max-w-none h-[90vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>{isEditMode ? "Edit Company" : "Add Company"}</DialogTitle>
          <DialogDescription>
            {isEditMode ? "Update company information and settings" : "Add a new company to the system"}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 overflow-y-auto flex-1 pr-4">
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

          {/* Logo Section */}
          <div className="border rounded-lg p-4 bg-slate-50">
            <div className="flex items-center justify-between mb-3">
              <Label className="text-base font-semibold">Company Logo</Label>
              {!company?.logo_url && (
                <span className="text-amber-600 text-xs font-medium">⚠️ Missing</span>
              )}
            </div>

            {company?.logo_url && (
              <div className="mb-4 p-3 bg-white rounded border border-slate-200">
                <p className="text-xs text-slate-600 mb-2">Current Logo:</p>
                <img
                  src={company.logo_url}
                  alt="Company logo"
                  className="max-h-32 max-w-32 object-contain bg-slate-100 p-2 rounded"
                />
              </div>
            )}

            <div className="space-y-2 mb-3">
              <p className="text-xs text-slate-600">
                Supported formats: PNG, JPG, SVG, GIF (max 5MB, will be optimized to 500x500px)
              </p>
            </div>

            <Button
              type="button"
              onClick={() => setShowLogoDialog(true)}
              variant="outline"
              className="w-full flex items-center justify-center gap-2"
            >
              <Image size={16} />
              {company?.logo_url ? "Replace or Edit Logo" : "Add Logo"}
            </Button>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <Label htmlFor="tagline">
                Company Tagline
                {!formData.tagline && <span className="text-amber-600 text-xs ml-2">ℹ️ Optional but recommended</span>}
              </Label>
              <span className="text-xs text-slate-500">
                {(formData.tagline || "").length}/200
              </span>
            </div>
            <Input
              id="tagline"
              name="tagline"
              value={formData.tagline || ""}
              onChange={(e) => {
                if (e.target.value.length <= 200) {
                  handleChange(e);
                }
              }}
              placeholder="e.g., 'Leading innovators in sustainable technology'"
              maxLength="200"
            />
            <p className="text-xs text-slate-600 mt-1">Short, catchy description for better user engagement</p>
          </div>
          <div>
            <Label htmlFor="website_url">
              Website URL
              {isEditMode && !company?.logo_url && <span className="text-orange-500 text-xs ml-2">ℹ️ No logo</span>}
            </Label>
            <Input
              id="website_url"
              name="website_url"
              value={formData.website_url || ""}
              onChange={handleChange}
              placeholder="https://example.com"
            />
            {isEditMode && (
              <p className="text-xs text-slate-600 mt-1">
                {company?.logo_url ? '✅ Logo present' : '⚠️ Logo will be auto-imported on next import or can be manually added'}
              </p>
            )}
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

            {/* Location Sources */}
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-semibold text-sm text-slate-900">Location Sources</h4>
                <input
                  id="show_location_sources"
                  type="checkbox"
                  checked={showLocationSourcesToUsers}
                  onChange={(e) => setShowLocationSourcesToUsers(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 cursor-pointer"
                />
              </div>
              <Label htmlFor="show_location_sources" className="text-sm text-slate-700 cursor-pointer mb-3 block">
                Show Location Sources to Users
              </Label>
              <p className="text-xs text-slate-600 mb-4">
                When enabled, source links will appear on the public company page under a "Sources" section
              </p>

              {/* Add New Source */}
              <div className="bg-white p-3 rounded border border-blue-200 mb-4 space-y-2">
                <Input
                  placeholder="Location (e.g., San Francisco, CA, USA)"
                  value={newSourceInput.location}
                  onChange={(e) =>
                    setNewSourceInput({ ...newSourceInput, location: e.target.value })
                  }
                  className="text-sm"
                />
                <Input
                  placeholder="Source URL (e.g., https://example.com)"
                  value={newSourceInput.url}
                  onChange={(e) =>
                    setNewSourceInput({ ...newSourceInput, url: e.target.value })
                  }
                  className="text-sm"
                />
                <select
                  value={newSourceInput.type}
                  onChange={(e) =>
                    setNewSourceInput({ ...newSourceInput, type: e.target.value })
                  }
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="official_website">Official Website</option>
                  <option value="government_guide">Government Guide</option>
                  <option value="b2b_directory">B2B Directory</option>
                  <option value="trade_data">Trade Data</option>
                  <option value="packaging">Packaging</option>
                  <option value="media">Media</option>
                  <option value="other">Other</option>
                </select>
                <Button
                  type="button"
                  onClick={() => {
                    if (newSourceInput.location.trim() && newSourceInput.url.trim()) {
                      setLocationSources([
                        ...locationSources,
                        {
                          location: newSourceInput.location,
                          source_url: newSourceInput.url,
                          source_type: newSourceInput.type,
                        },
                      ]);
                      setNewSourceInput({ url: "", type: "official_website", location: "" });
                      toast.success("Source added");
                    } else {
                      toast.error("Please fill in location and URL");
                    }
                  }}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white flex items-center justify-center gap-2"
                >
                  <Plus size={14} />
                  Add Source
                </Button>
              </div>

              {/* Existing Sources */}
              {locationSources.length > 0 && (
                <div className="space-y-2">
                  {locationSources.map((source, idx) => (
                    <div
                      key={idx}
                      className="bg-white p-3 rounded border border-slate-200 flex items-start justify-between gap-2"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-900 break-words">{source.location}</p>
                        <p className="text-xs text-slate-600 truncate">
                          {source.source_type} | {source.source_url}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setLocationSources(locationSources.filter((_, i) => i !== idx));
                          toast.success("Source removed");
                        }}
                        className="text-red-600 hover:text-red-800 flex-shrink-0"
                        title="Remove source"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="border-t pt-4 mt-4">
              <h3 className="font-semibold text-sm mb-4">Headquarters Locations</h3>
              <HeadquartersLocationsEditor
                primaryHQ={formData.headquarters_location || ""}
                additionalHQs={additionalHQs}
                onPrimaryChange={(value) => setFormData((prev) => ({ ...prev, headquarters_location: value }))}
                onAdditionalsChange={setAdditionalHQs}
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
          <StarRatingEditor
            rating={rating}
            iconType={ratingIconType}
            onRatingChange={setRating}
            onIconTypeChange={setRatingIconType}
          />

          <div className="border-t pt-4 mt-4">
            <h3 className="font-semibold text-sm mb-4">Field Visibility</h3>
            <p className="text-xs text-slate-600 mb-4">Control which fields are visible to users on the public results page</p>

            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <input
                  id="hq_public"
                  type="checkbox"
                  checked={visibility.hq_public}
                  onChange={(e) => setVisibility((prev) => ({ ...prev, hq_public: e.target.checked }))}
                  className="w-4 h-4 rounded border-slate-300"
                />
                <Label htmlFor="hq_public" className="text-sm font-medium text-slate-700 cursor-pointer mb-0">
                  Show Headquarters Location to users
                </Label>
              </div>

              <div className="flex items-center gap-3">
                <input
                  id="manufacturing_public"
                  type="checkbox"
                  checked={visibility.manufacturing_public}
                  onChange={(e) => setVisibility((prev) => ({ ...prev, manufacturing_public: e.target.checked }))}
                  className="w-4 h-4 rounded border-slate-300"
                />
                <Label htmlFor="manufacturing_public" className="text-sm font-medium text-slate-700 cursor-pointer mb-0">
                  Show Manufacturing Locations to users
                </Label>
              </div>

              <div className="flex items-center gap-3">
                <input
                  id="admin_rating_public"
                  type="checkbox"
                  checked={visibility.admin_rating_public}
                  onChange={(e) => setVisibility((prev) => ({ ...prev, admin_rating_public: e.target.checked }))}
                  className="w-4 h-4 rounded border-slate-300"
                />
                <Label htmlFor="admin_rating_public" className="text-sm font-medium text-slate-700 cursor-pointer mb-0">
                  Show Star Rating to users
                </Label>
              </div>
            </div>
          </div>

          <div className="border-t pt-4 mt-4">
            <h3 className="font-semibold text-sm mb-4">Industries & Keywords</h3>

            <div className="mb-4">
              <IndustriesEditor
                industries={formData.industries || []}
                onChange={(newIndustries) => setFormData((prev) => ({ ...prev, industries: newIndustries }))}
                label="Industries"
                placeholder="Add an industry (e.g., Technology, Manufacturing) and press Enter"
              />
            </div>

            <div>
              <KeywordsEditor
                keywords={formData.keywords || []}
                onChange={(newKeywords) => setFormData((prev) => ({ ...prev, keywords: newKeywords }))}
                label="Keywords"
                placeholder="Search and select keywords..."
              />
            </div>
          </div>

          <Button type="submit" disabled={isSaving}>
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </form>
      </DialogContent>

      {/* Logo Upload Dialog */}
      <Dialog open={showLogoDialog} onOpenChange={setShowLogoDialog}>
        <DialogContent className="max-w-md">
          <LogoUploadDialog
            companyId={formData.id || formData.company_id}
            onClose={() => setShowLogoDialog(false)}
            onSaved={(logoUrl) => {
              if (!logoUrl || logoUrl.startsWith('blob:')) {
                toast.error("Logo upload failed: invalid URL returned. Please try again.");
                return;
              }
              setFormData((prev) => ({ ...prev, logo_url: logoUrl }));
              setShowLogoDialog(false);
              toast.success("Logo uploaded successfully! Don't forget to save the company.");
            }}
            onError={(error) => {
              toast.error(`Logo upload failed: ${error}`);
            }}
          />
        </DialogContent>
      </Dialog>
    </Dialog>
  );
};

export default CompanyForm;
