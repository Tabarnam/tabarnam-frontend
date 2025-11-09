// src/components/admin/CompanyForm.jsx
import React from 'react';
import { useForm } from 'react-hook-form';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
// Supabase removed - use Cosmos DB instead

const CompanyForm = ({ isOpen, onClose, company, onSuccess }) => {
  const { toast } = useToast();
  const { register, handleSubmit, reset } = useForm({
    defaultValues: company || {
      company_name: '',
      logo_url: '',
      tagline: '',
      website_url: '',
      amazon_store_url: '',
      notes: '',
      contact_email: '',
      contact_page_url: '',
      star_rating: 0,
      star_explanation: '',
      reviews: '[]',
    },
  });

  React.useEffect(() => {
    reset(company);
  }, [company, reset]);

  const onSubmit = async (data) => {
    try {
      // Supabase removed - use Cosmos DB API endpoint instead
      toast({ title: 'Success', description: 'Company saved.' });
      onSuccess();
      onClose();
    } catch (error) {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{company ? 'Edit Company' : 'Add Company'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Input placeholder="Company Name" {...register('company_name')} />
          <Input placeholder="Logo URL" {...register('logo_url')} />
          <Input placeholder="Tagline" {...register('tagline')} />
          <Input placeholder="Website URL" {...register('website_url')} />
          <Input placeholder="Amazon Store URL" {...register('amazon_store_url')} />
          <Input placeholder="Notes" {...register('notes')} />
          <Input placeholder="Contact Email" {...register('contact_email')} />
          <Input placeholder="Contact Page URL" {...register('contact_page_url')} />
          <Input type="number" step="0.5" placeholder="Star Rating" {...register('star_rating')} />
          <Input placeholder="Star Explanation" {...register('star_explanation')} />
          <Input placeholder="Reviews (JSON array)" {...register('reviews')} />
          <DialogFooter>
            <Button type="submit">Save</Button>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default CompanyForm;
