import React, { useState, useEffect } from 'react';
import { AnimatePresence } from 'framer-motion';
import { supabase } from '@/lib/customSupabaseClient';
import { useToast } from '@/components/ui/use-toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Loader2, UploadCloud } from 'lucide-react';
import FormInput from './form-elements/FormInput';
import FormTextarea from './form-elements/FormTextarea';
import MultiSelectChip from './form-elements/MultiSelectChip';
import KeywordInput from './form-elements/KeywordInput';
import LocationInput from './form-elements/LocationInput';
import { useAuth } from '@/contexts/SupabaseAuthContext';

const CompanyForm = ({ isOpen, onClose, onSuccess, company }) => {
    const { toast } = useToast();
    const { user, userRole } = useAuth();
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [formData, setFormData] = useState({
        name: '',
        tagline: '',
        about: '',
        website_url: '',
        contact_email: '',
        contact_phone: '',
        notes: '',
        star_rating: 0,
        star_explanation: '',
    });
    const [logoFile, setLogoFile] = useState(null);
    const [logoPreview, setLogoPreview] = useState(null);
    const [industries, setIndustries] = useState([]);
    const [selectedIndustries, setSelectedIndustries] = useState([]);
    const [keywords, setKeywords] = useState([]);
    const [selectedKeywords, setSelectedKeywords] = useState([]);
    const [newKeyword, setNewKeyword] = useState('');
    const [hqLocations, setHqLocations] = useState([{ full_address: '' }]);
    const [mfgLocations, setMfgLocations] = useState([{ full_address: '' }]);
    const isAdmin = userRole === 'admin';
    
    useEffect(() => {
        const fetchDropdownData = async () => {
            const { data: industriesData, error: industriesError } = await supabase.from('industries').select('id, name');
            if (industriesError) toast({ variant: "destructive", title: "Error fetching industries", description: industriesError.message });
            else setIndustries(industriesData || []);

            const { data: keywordsData, error: keywordsError } = await supabase.from('product_keywords').select('id, keyword');
            if (keywordsError) toast({ variant: "destructive", title: "Error fetching keywords", description: keywordsError.message });
            else setKeywords(keywordsData || []);
        };
        fetchDropdownData();
    }, [toast]);

    useEffect(() => {
        if (company) {
            setFormData({
                name: company.name || '',
                tagline: company.tagline || '',
                about: company.about || '',
                website_url: company.website_url || '',
                contact_email: company.contact_email || '',
                contact_phone: company.contact_phone || '',
                notes: company.notes || '',
                star_rating: company.star_rating || 0,
                star_explanation: company.star_explanation || '',
            });
            setLogoPreview(company.logo_url);
            setSelectedIndustries(company.industries?.map(i => i.id).filter(Boolean) || []);
            setSelectedKeywords(company.keywords?.map(k => k.id).filter(Boolean) || []);
            setHqLocations(company.headquarters?.length > 0 ? company.headquarters.map(l => ({...l})) : [{ full_address: '' }]);
            setMfgLocations(company.manufacturing_locations?.length > 0 ? company.manufacturing_locations.map(l => ({...l})) : [{ full_address: '' }]);
        } else {
            // Reset form for new company
            setFormData({ name: '', tagline: '', about: '', website_url: '', contact_email: '', contact_phone: '', notes: '', star_rating: 0, star_explanation: '' });
            setLogoFile(null);
            setLogoPreview(null);
            setSelectedIndustries([]);
            setSelectedKeywords([]);
            setHqLocations([{ full_address: '' }]);
            setMfgLocations([{ full_address: '' }]);
        }
    }, [company]);
    
    const handleInputChange = (e) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    };

    const handleRatingChange = (e) => {
        setFormData(prev => ({ ...prev, star_rating: parseFloat(e.target.value) }));
    };

    const handleLocationChange = (index, value, type) => {
        const setter = type === 'hq' ? setHqLocations : setMfgLocations;
        setter(prev => {
            const newLocations = [...prev];
            newLocations[index].full_address = value;
            return newLocations;
        });
    };
    
    const addLocation = (type) => {
        const setter = type === 'hq' ? setHqLocations : setMfgLocations;
        setter(prev => [...prev, { full_address: '' }]);
    };
    
    const removeLocation = (index, type) => {
        const setter = type === 'hq' ? setHqLocations : setMfgLocations;
        setter(prev => prev.filter((_, i) => i !== index));
    };

    const handleLogoChange = (e) => {
        const file = e.target.files[0];
        if (file) {
            setLogoFile(file);
            const reader = new FileReader();
            reader.onloadend = () => {
                setLogoPreview(reader.result);
            };
            reader.readAsDataURL(file);
        }
    };

    const handleKeywordAdd = async () => {
        if (newKeyword.trim() === '') return;
        const newKeywordLower = newKeyword.trim().toLowerCase();
        
        let existingKeyword = keywords.find(k => k.keyword.toLowerCase() === newKeywordLower);
        
        if (!existingKeyword) {
            const { data, error } = await supabase.from('product_keywords').insert({ keyword: newKeyword.trim() }).select().single();
            if (error) {
                toast({ variant: "destructive", title: "Error adding keyword", description: error.message });
                return;
            }
            existingKeyword = data;
            setKeywords(prev => [...prev, existingKeyword]);
        }
        
        if (!selectedKeywords.includes(existingKeyword.id)) {
            setSelectedKeywords(prev => [...prev, existingKeyword.id]);
        }
        setNewKeyword('');
    };
    
    const handleSubmit = async (e) => {
        e.preventDefault();
        
        if (!isAdmin) {
            toast({ variant: "destructive", title: "Permission Denied", description: "You do not have permission to perform this action." });
            return;
        }

        setIsSubmitting(true);
        const originalCompanyData = company ? await getCompanyState(company.id) : null;
        
        let logoUrl = company?.logo_url || null;
        if (logoFile) {
            const fileName = `${Date.now()}_${logoFile.name}`;
            const { data: uploadData, error: uploadError } = await supabase.storage
                .from('company-logos')
                .upload(fileName, logoFile, {
                    cacheControl: '3600',
                    upsert: !!company?.logo_url,
                });

            if (uploadError) {
                toast({ variant: 'destructive', title: 'Logo Upload Failed', description: uploadError.message });
                setIsSubmitting(false);
                return;
            }
            const { data: urlData } = supabase.storage.from('company-logos').getPublicUrl(uploadData.path);
            logoUrl = urlData.publicUrl;
        }
        
        const companyData = { ...formData, logo_url: logoUrl };
        
        let companyResult;
        let actionType = '';
        let description = '';

        if (company) { // Update
            actionType = 'UPDATE';
            description = `Updated company: ${formData.name}`;
            const { data, error } = await supabase.from('companies').update(companyData).eq('id', company.id).select().single();
            if (error) { toast({ variant: "destructive", title: "Error updating company", description: error.message }); setIsSubmitting(false); return; }
            companyResult = data;
        } else { // Create
            actionType = 'CREATE';
            description = `Created new company: ${formData.name}`;
            const { data, error } = await supabase.from('companies').insert(companyData).select().single();
            if (error) { toast({ variant: "destructive", title: "Error creating company", description: error.message }); setIsSubmitting(false); return; }
            companyResult = data;
        }
        const companyId = companyResult.id;
        const finalCompanyData = await getCompanyState(companyId);

        // Logging is now handled by database triggers, but we keep this for manual logging if needed.
        // await logAction({
        //     action_type: actionType,
        //     entity_type: 'companies',
        //     entity_id: companyId,
        //     before_state: originalCompanyData,
        //     after_state: finalCompanyData,
        //     description: description,
        // });

        // Handle Junction Tables
        await supabase.from('company_industries').delete().eq('company_id', companyId);
        if (selectedIndustries.length > 0) {
            await supabase.from('company_industries').insert(selectedIndustries.map(indId => ({ company_id: companyId, industry_id: indId })));
        }

        await supabase.from('company_keywords').delete().eq('company_id', companyId);
        if (selectedKeywords.length > 0) {
            await supabase.from('company_keywords').insert(selectedKeywords.map(keyId => ({ company_id: companyId, keyword_id: keyId })));
        }
        
        // Geocoding and saving locations
        const geocodeAndSaveLocation = async (locations, table) => {
            await supabase.from(table).delete().eq('company_id', companyId);
            const locationsToSave = await Promise.all(locations
                .filter(loc => loc.full_address?.trim())
                .map(async (loc) => {
                    const { data, error } = await supabase.functions.invoke('geocode-address', { body: { address: loc.full_address } });
                    if (error || !data.latitude) {
                        await supabase.from('errors').insert({ type: 'Geolocation', company_id: companyId, field_name: table, message: `Failed to geocode: ${loc.full_address}.` });
                        toast({ variant: 'destructive', title: 'Geocoding Error', description: `Could not find coordinates for ${loc.full_address}.` });
                        return { ...loc, company_id: companyId };
                    }
                    return { ...loc, company_id: companyId, latitude: data.latitude, longitude: data.longitude };
                })
            );
            const validLocations = locationsToSave.filter(Boolean).map(l => { delete l.id; return l; });
            if (validLocations.length > 0) await supabase.from(table).insert(validLocations);
        };

        await geocodeAndSaveLocation(hqLocations, 'company_headquarters');
        await geocodeAndSaveLocation(mfgLocations, 'company_manufacturing_sites');

        toast({ title: "Success!", description: `Company ${company ? 'updated' : 'created'} successfully.` });
        setIsSubmitting(false);
        onSuccess();
    };

    const getCompanyState = async (companyId) => {
        const { data, error } = await supabase.from('companies').select('*').eq('id', companyId).single();
        if (error) return null;
        return data;
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <Dialog open={isOpen} onOpenChange={onClose}>
                    <DialogContent className="bg-slate-900 border-purple-500 text-white sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
                        <DialogHeader>
                            <DialogTitle className="text-2xl text-purple-400">{company ? 'Edit Company' : 'Create New Company'}</DialogTitle>
                            <DialogDescription className="text-gray-400">
                                Fill in the details below. Required fields are marked with an asterisk.
                            </DialogDescription>
                        </DialogHeader>
                        
                        <form onSubmit={handleSubmit} className="space-y-4 pr-2">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <FormInput name="name" label="Company Name*" value={formData.name} onChange={handleInputChange} required />
                                <FormInput name="website_url" label="Website URL" value={formData.website_url} onChange={handleInputChange} type="url" />
                            </div>
                            <FormTextarea name="tagline" label="Tagline" value={formData.tagline} onChange={handleInputChange} />
                            <FormTextarea name="about" label="About" value={formData.about} onChange={handleInputChange} />
                           
                            <div>
                                <label className="form-label">Logo</label>
                                <div className="mt-1 flex items-center gap-4">
                                    {logoPreview && <img-replace src={logoPreview} alt="Logo preview" className="w-20 h-20 rounded-lg object-cover bg-gray-700" />}
                                    <div className="flex-grow">
                                        <label htmlFor="logo-upload" className="cursor-pointer bg-white/10 p-4 rounded-lg flex flex-col items-center justify-center border-2 border-dashed border-gray-600 hover:border-purple-500 transition-colors">
                                            <UploadCloud className="w-8 h-8 text-gray-400 mb-2"/>
                                            <span className="text-sm text-gray-400">{logoFile ? logoFile.name : 'Click to upload'}</span>
                                            <span className="text-xs text-gray-500">PNG, JPG, SVG (MAX. 5MB)</span>
                                        </label>
                                        <input id="logo-upload" type="file" className="sr-only" onChange={handleLogoChange} accept="image/*"/>
                                    </div>
                                </div>
                            </div>
                           
                             <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <MultiSelectChip label="Industries" options={industries} selected={selectedIndustries} setSelected={setSelectedIndustries} displayField="name" />
                                <KeywordInput label="Product Keywords" options={keywords} selected={selectedKeywords} setSelected={setSelectedKeywords} newKeyword={newKeyword} setNewKeyword={setNewKeyword} onAdd={handleKeywordAdd} />
                             </div>
                             
                            <div>
                                <label className="form-label">Star Rating: {formData.star_rating} / 5</label>
                                <input type="range" min="0" max="5" step="0.5" value={formData.star_rating} onChange={handleRatingChange} className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-purple-500" />
                            </div>
                            <FormTextarea name="star_explanation" label="Star Explanation" value={formData.star_explanation} onChange={handleInputChange} />
                            
                            <LocationInput title="Headquarters" locations={hqLocations} onChange={handleLocationChange} onAdd={() => addLocation('hq')} onRemove={(i) => removeLocation(i, 'hq')} type="hq" />
                            <LocationInput title="Manufacturing Locations" locations={mfgLocations} onChange={handleLocationChange} onAdd={() => addLocation('mfg')} onRemove={(i) => removeLocation(i, 'mfg')} type="mfg" />

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <FormInput name="contact_email" label="Contact Email" value={formData.contact_email} onChange={handleInputChange} type="email" />
                                <FormInput name="contact_phone" label="Contact Phone" value={formData.contact_phone} onChange={handleInputChange} type="tel" />
                            </div>
                            <FormTextarea name="notes" label="Internal Notes" value={formData.notes} onChange={handleInputChange} />

                            <DialogFooter>
                                <Button type="button" variant="outline" onClick={onClose} className="text-white border-white/20 hover:bg-white/10">Cancel</Button>
                                {isAdmin && (
                                <Button type="submit" disabled={isSubmitting} className="bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white">
                                    {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                    {company ? 'Update Company' : 'Create Company'}
                                </Button>
                                )}
                            </DialogFooter>
                        </form>
                    </DialogContent>
                </Dialog>
            )}
        </AnimatePresence>
    );
};

export default CompanyForm;