import React, { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api";
import { toast } from "sonner";
import TagInputWithSuggestions from "./form-elements/TagInputWithSuggestions";

const CompanyForm = ({ company, onSaved, isOpen, onClose, onSuccess }) => {
  const [formData, setFormData] = useState(company || {});
  const [isSaving, setIsSaving] = useState(false);
  const [keywords, setKeywords] = useState([]);

  useEffect(() => {
    if (company) {
      setFormData(company);
    } else {
      setFormData({});
    }
  }, [company, isOpen]);

  useEffect(() => {
    const fetchKeywords = async () => {
      const res = await apiFetch("/admin-keywords");
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data?.items) setKeywords(data.items);
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
      const response = await apiFetch(request.endpoint, {
        method: request.method,
        headers: { "Content-Type": "application/json" },
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
        handleSave(data?.company || request);
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

  return (
    <Dialog open={isOpen} onOpenChange={handleDialogClose}>
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
    </Dialog>
  );
};

export default CompanyForm;
