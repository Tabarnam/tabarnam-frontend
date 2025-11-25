import React from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { apiFetch } from '@/lib/api';
import { getAdminUser } from '@/lib/azureAuth';
import TagInputWithSuggestions from './form-elements/TagInputWithSuggestions';

const getInitialValues = (company) => {
  const affiliateLinks = Array.isArray(company?.affiliate_links) ? company.affiliate_links : [];
  const starExplanation = Array.isArray(company?.star_explanation) ? company.star_explanation : [];

  return {
    company_name: company?.company_name || company?.name || '',
    logo_url: company?.logo_url || '',
    tagline: company?.tagline || '',
    website_url: company?.website_url || company?.url || '',
    amazon_store_url: company?.amazon_store_url || company?.amazon_url || '',
    notes: company?.notes || '',
    contact_email: company?.contact_email || '',
    contact_page_url: company?.contact_page_url || '',
    star_rating: company?.star_rating ?? 0,
    affiliate_links: affiliateLinks.length
      ? affiliateLinks
      : [],
    star_explanation: starExplanation.length
      ? starExplanation
      : [],
  };
};

const CompanyForm = ({ isOpen, onClose, company, onSuccess }) => {
  const { toast } = useToast();
  const adminUser = getAdminUser();
  const [iconStates, setIconStates] = React.useState({});

  const {
    register,
    handleSubmit,
    control,
    reset,
    setValue,
    watch,
    formState: { isSubmitting },
  } = useForm({
    defaultValues: getInitialValues(company),
  });

  React.useEffect(() => {
    if (company && Array.isArray(company.star_explanation)) {
      const states = {};
      company.star_explanation.forEach((exp, idx) => {
        states[idx] = exp.icon || 'star';
      });
      setIconStates(states);
    }
  }, [company]);

  const {
    fields: affiliateFields,
    append: appendAffiliate,
    remove: removeAffiliate,
  } = useFieldArray({ control, name: 'affiliate_links' });

  const {
    fields: starFields,
    append: appendStar,
    remove: removeStar,
  } = useFieldArray({ control, name: 'star_explanation' });

  React.useEffect(() => {
    reset(getInitialValues(company));
  }, [company, reset]);

  const onSubmit = async (values) => {
    try {
      const payload = {
        ...(company || {}),
        company_name: values.company_name?.trim() || '',
        name: values.company_name?.trim() || company?.name || '',
        logo_url: values.logo_url?.trim() || '',
        tagline: values.tagline?.trim() || '',
        website_url: values.website_url?.trim() || '',
        amazon_store_url: values.amazon_store_url?.trim() || '',
        amazon_url: values.amazon_store_url?.trim() || company?.amazon_url || '',
        notes: values.notes || '',
        contact_email: values.contact_email?.trim() || '',
        contact_page_url: values.contact_page_url?.trim() || '',
        star_rating:
          values.star_rating === '' || values.star_rating === null || values.star_rating === undefined
            ? 0
            : Number(values.star_rating),
        affiliate_links: (values.affiliate_links || [])
          .slice(0, 5)
          .map((link) => ({
            url: (link.url || '').trim(),
            name: (link.name || '').trim(),
            description: (link.description || '').trim(),
            notes: (link.notes || '').trim(),
            is_public: Boolean(link.is_public ?? true),
          }))
          .filter((link) => link.url || link.name || link.description || link.notes),
        star_explanation: (values.star_explanation || [])
          .map((entry, index) => ({
            star_level:
              entry.star_level === '' || entry.star_level === null || entry.star_level === undefined
                ? index + 1
                : Number(entry.star_level),
            note: (entry.note || '').trim(),
            is_public: Boolean(entry.is_public ?? true),
            icon: (entry.icon || 'star').toLowerCase() === 'heart' ? 'heart' : 'star',
          }))
          .filter((entry) => entry.note),
      };

      const method = company && company.id ? 'PUT' : 'POST';
      const res = await apiFetch('/companies-list', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company: payload, actor: adminUser?.email }),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok || data?.error) {
        throw new Error(data?.error || 'Failed to save company');
      }

      toast({ title: 'Company saved', description: 'Changes have been applied.' });
      if (onSuccess) onSuccess();
      onClose();
    } catch (error) {
      toast({ variant: 'destructive', title: 'Error', description: error?.message || 'Failed to save company' });
    }
  };

  const handleAddAffiliate = () => {
    if (affiliateFields.length >= 5) return;
    appendAffiliate({ url: '', name: '', description: '', notes: '', is_public: true });
  };

  const handleAddStarNote = () => {
    const newIndex = starFields.length;
    appendStar({ star_level: '', note: '', is_public: true, icon: 'star' });
    setIconStates({ ...iconStates, [newIndex]: 'star' });
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent aria-label={company ? 'Edit company' : 'Add company'} className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">
            {company ? 'Edit Company' : 'Add Company'}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6" aria-describedby="company-form-description">
          <div id="company-form-description" className="sr-only">
            Use this form to edit company details, affiliate links, and per-star notes.
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label htmlFor="company_name" className="block text-sm font-medium text-slate-800">
                Company Name
              </label>
              <Input id="company_name" {...register('company_name')} autoFocus />
            </div>
            <div className="space-y-2">
              <label htmlFor="logo_url" className="block text-sm font-medium text-slate-800">
                Logo URL
              </label>
              <Input id="logo_url" {...register('logo_url')} />
            </div>
            <div className="space-y-2">
              <label htmlFor="tagline" className="block text-sm font-medium text-slate-800">
                Tagline
              </label>
              <Input id="tagline" {...register('tagline')} />
            </div>
            <div className="space-y-2">
              <label htmlFor="website_url" className="block text-sm font-medium text-slate-800">
                Website URL
              </label>
              <Input id="website_url" {...register('website_url')} />
            </div>
            <div className="space-y-2">
              <label htmlFor="amazon_store_url" className="block text-sm font-medium text-slate-800">
                Amazon Store URL
              </label>
              <Input id="amazon_store_url" {...register('amazon_store_url')} />
            </div>
            <div className="space-y-2">
              <label htmlFor="contact_email" className="block text-sm font-medium text-slate-800">
                Contact Email
              </label>
              <Input id="contact_email" type="email" {...register('contact_email')} />
            </div>
            <div className="space-y-2">
              <label htmlFor="contact_page_url" className="block text-sm font-medium text-slate-800">
                Contact Page URL
              </label>
              <Input id="contact_page_url" {...register('contact_page_url')} />
            </div>
            <div className="space-y-2">
              <label htmlFor="star_rating" className="block text-sm font-medium text-slate-800">
                Star Rating
              </label>
              <Input id="star_rating" type="number" step="0.5" {...register('star_rating')} />
            </div>
          </div>

          <div className="space-y-2">
            <label htmlFor="notes" className="block text-sm font-medium text-slate-800">
              Internal Notes
            </label>
            <Input id="notes" {...register('notes')} />
          </div>

          <section aria-label="Affiliate links" className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">Affiliate Links</h3>
              <Button
                type="button"
                variant="outline"
                onClick={handleAddAffiliate}
                disabled={affiliateFields.length >= 5}
                className="border-[#B1DDE3] text-slate-900 hover:bg-[#B1DDE3]/40"
              >
                Add Affiliate Link
              </Button>
            </div>
            {affiliateFields.length === 0 && (
              <p className="text-xs text-slate-600">No affiliate links added yet.</p>
            )}
            <div className="space-y-4">
              {affiliateFields.map((field, index) => (
                <div
                  key={field.id}
                  className="rounded-md border border-slate-200 p-3 space-y-2 bg-white"
                  aria-label={`Affiliate link ${index + 1}`}
                >
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="block text-xs font-medium text-slate-700">URL</label>
                      <Input
                        {...register(`affiliate_links.${index}.url`)}
                        placeholder="https://example.com"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-xs font-medium text-slate-700">Name</label>
                      <Input {...register(`affiliate_links.${index}.name`)} placeholder="Store name" />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-xs font-medium text-slate-700">Description</label>
                      <Input
                        {...register(`affiliate_links.${index}.description`)}
                        placeholder="Short description"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-xs font-medium text-slate-700">Notes</label>
                      <Input
                        {...register(`affiliate_links.${index}.notes`)}
                        placeholder="Admin notes"
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-2">
                    <label className="inline-flex items-center gap-2 text-xs text-slate-700">
                      <input
                        type="checkbox"
                        {...register(`affiliate_links.${index}.is_public`)}
                        className="h-3 w-3 rounded border-slate-400"
                      />
                      <span>Users see this link (uncheck for admin-only)</span>
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => removeAffiliate(index)}
                      className="text-red-600 hover:bg-red-50"
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section aria-label="Star notes" className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">Per-Star Notes</h3>
              <Button
                type="button"
                variant="outline"
                onClick={handleAddStarNote}
                className="border-[#B1DDE3] text-slate-900 hover:bg-[#B1DDE3]/40"
              >
                Add Star Note
              </Button>
            </div>
            {starFields.length === 0 && (
              <p className="text-xs text-slate-600">No star notes added yet.</p>
            )}
            <div className="space-y-4">
              {starFields.map((field, index) => (
                <div
                  key={field.id}
                  className="rounded-md border border-slate-200 p-3 space-y-2 bg-white"
                  aria-label={`Star note ${index + 1}`}
                >
                  <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-center">
                    <div className="space-y-1">
                      <label className="block text-xs font-medium text-slate-700">Star Level</label>
                      <Input
                        type="number"
                        min={1}
                        max={5}
                        {...register(`star_explanation.${index}.star_level`)}
                      />
                    </div>
                    <div className="md:col-span-2 space-y-1">
                      <label className="block text-xs font-medium text-slate-700">Note</label>
                      <Input
                        {...register(`star_explanation.${index}.note`)}
                        placeholder="Explanation for this star"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-xs font-medium text-slate-700">Icon</label>
                      <div className="flex gap-1">
                        <Button
                          type="button"
                          variant={(iconStates[index] || 'star') !== 'heart' ? 'default' : 'outline'}
                          onClick={() => {
                            const newIcon = 'star';
                            setIconStates({ ...iconStates, [index]: newIcon });
                            setValue(`star_explanation.${index}.icon`, newIcon);
                          }}
                          className={(iconStates[index] || 'star') !== 'heart' ? "bg-[#B1DDE3] text-slate-900 hover:bg-[#A0C8D0]" : "border-slate-200 text-slate-900 hover:bg-slate-100"}
                          title="Star icon"
                        >
                          ★
                        </Button>
                        <Button
                          type="button"
                          variant={(iconStates[index] || 'star') === 'heart' ? 'default' : 'outline'}
                          onClick={() => {
                            const newIcon = 'heart';
                            setIconStates({ ...iconStates, [index]: newIcon });
                            setValue(`star_explanation.${index}.icon`, newIcon);
                          }}
                          className={(iconStates[index] || 'star') === 'heart' ? "bg-[#B1DDE3] text-slate-900 hover:bg-[#A0C8D0]" : "border-slate-200 text-slate-900 hover:bg-slate-100"}
                          title="Heart icon"
                        >
                          ♥
                        </Button>
                      </div>
                      <input
                        type="hidden"
                        {...register(`star_explanation.${index}.icon`)}
                      />
                    </div>
                    <div className="flex flex-col items-start gap-2">
                      <label className="inline-flex items-center gap-2 text-xs text-slate-700">
                        <input
                          type="checkbox"
                          {...register(`star_explanation.${index}.is_public`)}
                          className="h-3 w-3 rounded border-slate-400"
                        />
                        <span>Users see this note</span>
                      </label>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => removeStar(index)}
                        className="text-red-600 hover:bg-red-50"
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <DialogFooter className="flex flex-col sm:flex-row sm:justify-end gap-3 pt-4">
            <Button
              type="submit"
              disabled={isSubmitting}
              className="bg-[#B1DDE3] text-slate-900 hover:bg-[#A0C8D0]"
            >
              {isSubmitting ? 'Saving…' : 'Save'}
            </Button>
            <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default CompanyForm;
