import React, { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { toast } from "sonner";
import TagInputWithSuggestions from "./form-elements/TagInputWithSuggestions";

const CompanyForm = ({ company, onSaved }) => {
  const [formData, setFormData] = useState(company || {});
  const [isSaving, setIsSaving] = useState(false);
  const [keywords, setKeywords] = useState([]);

  useEffect(() => {
    const fetchKeywords = async () => {
      const { data } = await api.get("/admin-keywords");
      if (data?.items) setKeywords(data.items);
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

    console.log("[CompanyForm] Submitting:", formData);

    const method = formData.id ? "PUT" : "POST";

    const request = {
      method,
      endpoint: "/admin-companies",
      ...formData,
      company_id: formData.id || formData.company_id,
      normalized_domain: formData.normalized_domain || formData.domain?.replace(/^(www\.)?/, "").toLowerCase() || "",
      product_keywords: formData.product_keywords || [],
      keywords: formData.keywords || [],
    };

    console.log("[CompanyForm] Submitting request:", request);

    try {
      const response = await api.fetch(request.endpoint, {
        method: request.method,
        body: JSON.stringify({ company: request }),
      });

      console.log("[CompanyForm] Response:", response);

      if (response.ok) {
        let data;
        try {
          data = await response.json();
        } catch (parseError) {
          console.log("[CompanyForm] Response is not JSON, treating as success");
          data = { company: request };
        }

        toast.success("Company saved successfully!");
        onSaved(data?.company || request);
      } else {
        let errorData;
        try {
          errorData = await response.json();
        } catch (parseError) {
          console.log("[CompanyForm] Error response is not JSON:", response.statusText);
          errorData = { error: response.statusText };
        }

        console.log("[CompanyForm] Error response:", errorData?.error || response.statusText);
        toast.error("Failed to save company");
      }
    } catch (error) {
      console.log("[CompanyForm] Error:", error);
      toast.error("Error saving company");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <DialogContent className="sm:max-w-[625px]">
      <DialogHeader>
        <DialogTitle>{formData.id ? "Edit Company" : "New Company"}</DialogTitle>
      </DialogHeader>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <Label htmlFor="companyName">Company Name</Label>
          <Input
            id="companyName"
            name="companyName"
            value={formData.companyName || ""}
            onChange={handleChange}
            required
          />
        </div>
        <div>
          <Label htmlFor="domain">Domain</Label>
          <Input
            id="domain"
            name="domain"
            value={formData.domain || ""}
            onChange={handleChange}
            required
          />
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
  );
};

export default CompanyForm;
