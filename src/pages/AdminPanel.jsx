import React, { useEffect, useState, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { supabase } from '@/lib/customSupabaseClient';
import { useAuth } from '@/contexts/SupabaseAuthContext';
import { useToast } from '@/components/ui/use-toast';
import { Loader2, PlusCircle, Wand2, Database, AlertTriangle, ShieldCheck, History, Eye, UserCog, RefreshCw, UploadCloud, Copy, KeySquare, Combine, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import AdminCompanyTable from '@/components/admin/AdminCompanyTable';
import CompanyForm from '@/components/admin/CompanyForm';
import XAIImportModal from '@/components/admin/XAIImportModal';
import BulkEditModal from '@/components/admin/BulkEditModal';
import ErrorsDashboard from '@/components/admin/ErrorsDashboard';
import UndoHistoryDashboard from '@/components/admin/UndoHistoryDashboard';
import { Link, useNavigate } from 'react-router-dom';
import KeywordsDashboard from '@/components/admin/KeywordsDashboard';
import DuplicatesDashboard from '@/components/admin/DuplicatesDashboard';
import { useUserRole } from '@/contexts/UserRoleContext';

const AdminPanel = () => {
    const { user, signOut } = useAuth();
    const { userRole } = useUserRole();
    const navigate = useNavigate();
    const [companies, setCompanies] = useState([]);
    const [loading, setLoading] = useState(true);
    const [isFormOpen, setFormOpen] = useState(false);
    const [isImportModalOpen, setImportModalOpen] = useState(false);
    const [isBulkEditModalOpen, setBulkEditModalOpen] = useState(false);
    const [editingCompany, setEditingCompany] = useState(null);
    const [companiesForBulkEdit, setCompaniesForBulkEdit] = useState([]);
    const [errorCount, setErrorCount] = useState(0);
    const [isMigrating, setIsMigrating] = useState(false);
    const { toast } = useToast();
    const isAdmin = userRole === 'admin';

    const handleSignOut = async () => {
        await signOut();
        navigate('/');
    };

    const fetchCompanies = useCallback(async () => {
        if (!user) return;
        setLoading(true);
        try {
            const { data, error } = await supabase
                .from('companies')
                .select(`
                    *,
                    industries:company_industries(industry:industries(id, name)),
                    keywords:company_keywords(keyword:product_keywords(id, keyword)),
                    headquarters:company_headquarters(*),
                    manufacturing_locations:company_manufacturing_sites(*)
                `)
                .order('created_at', { ascending: false });

            if (error) throw error;

            const formattedData = data.map(c => ({
                ...c,
                industries: c.industries.map(i => i.industry).filter(Boolean) || [],
                keywords: c.keywords.map(k => k.keyword).filter(Boolean) || [],
            }));

            setCompanies(formattedData);
        } catch (error) {
            toast({ variant: "destructive", title: "Failed to fetch companies", description: error.message });
        } finally {
            setLoading(false);
        }
    }, [user, toast]);

    const fetchErrorCount = useCallback(async () => {
        if (!isAdmin) return;
        try {
            const { count, error } = await supabase
                .from('errors')
                .select('*', { count: 'exact', head: true })
                .eq('resolved', false);
            
            if (error) throw error;
            setErrorCount(count || 0);
        } catch (error) {
            console.error("Failed to fetch error count:", error.message);
        }
    }, [isAdmin]);

    const handleMigration = async () => {
        if (!isAdmin) return;
        setIsMigrating(true);
        toast({
            title: "🚀 Starting Legacy Migration",
            description: "Normalizing old company data. This may take a moment...",
        });

        try {
            const { data, error } = await supabase.rpc('migrate_legacy_companies');

            if (error) throw error;
            
            toast({
                title: "✅ Migration Complete!",
                description: data.message || "Legacy data has been normalized.",
            });
            fetchCompanies(); // Refresh the data view
        } catch (error) {
            toast({
                variant: "destructive",
                title: "Migration Failed",
                description: error.message,
            });
        } finally {
            setIsMigrating(false);
        }
    };

    useEffect(() => {
        if(user) {
            fetchCompanies();
            fetchErrorCount();
        }
    }, [user, fetchCompanies, fetchErrorCount]);

    const handleEdit = (company) => {
        if (!isAdmin) {
            toast({ variant: "destructive", title: "Permission Denied" });
            return;
        }
        // Need to fetch full related data for the form
        const fullCompanyData = companies.find(c => c.id === company.id);
        setEditingCompany(fullCompanyData);
        setFormOpen(true);
    };
    
    const handleDelete = async (companyId) => {
        if (!isAdmin) {
             toast({ variant: "destructive", title: "Permission Denied" });
             return;
        }
        try {
            const { error } = await supabase.from('companies').delete().eq('id', companyId);
            if (error) throw error;
            toast({ title: "Success", description: "Company deleted." });
            fetchCompanies();
        } catch (error) {
            toast({ variant: "destructive", title: "Error", description: error.message });
        }
    };

    const handleBulkEdit = (selectedCompanies) => {
        if (!isAdmin) return;
        setCompaniesForBulkEdit(selectedCompanies);
        setBulkEditModalOpen(true);
    }

    const handleFormClose = () => {
        setFormOpen(false);
        setEditingCompany(null);
    };

    const handleSuccess = () => {
        handleFormClose();
        setImportModalOpen(false);
        setBulkEditModalOpen(false);
        fetchCompanies();
    };

    return (
        <div className="min-h-screen bg-slate-900 text-white p-4 sm:p-6 lg:p-8">
            <div className="max-w-screen-2xl mx-auto">
                <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 gap-4">
                    <div>
                        <h1 className="text-4xl font-bold tracking-tight">Admin Dashboard</h1>
                        <p className="text-gray-400 mt-1 flex items-center gap-2">
                           <UserCog className="h-5 w-5 text-purple-400"/>
                           Logged in as <span className="text-purple-400 font-semibold">{userRole}</span>
                        </p>
                    </div>
                     <div className="flex items-center gap-3 flex-wrap">
                        <Button onClick={handleMigration} variant="outline" className="border-yellow-500 text-yellow-400 hover:bg-yellow-500/10 hover:text-yellow-300" disabled={isMigrating}>
                            {isMigrating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                            Normalize Legacy Data
                        </Button>
                        <Button onClick={() => setImportModalOpen(true)} className="bg-gradient-to-r from-blue-500 to-cyan-500 hover:opacity-90 transition-opacity">
                            <Wand2 className="mr-2 h-4 w-4" /> Import from xAI
                        </Button>
                        <Button onClick={() => { setEditingCompany(null); setFormOpen(true); }} className="bg-gradient-to-r from-green-500 to-emerald-500 hover:opacity-90 transition-opacity">
                            <PlusCircle className="mr-2 h-4 w-4" /> Add Company
                        </Button>
                        <Button onClick={handleSignOut} variant="destructive">
                            <LogOut className="mr-2 h-4 w-4" /> Sign Out
                        </Button>
                    </div>
                </header>

                <AnimatePresence>
                    {isFormOpen && <CompanyForm isOpen={isFormOpen} onClose={handleFormClose} onSuccess={handleSuccess} company={editingCompany} />}
                    {isImportModalOpen && <XAIImportModal isOpen={isImportModalOpen} onClose={() => setImportModalOpen(false)} onSuccess={handleSuccess} />}
                    {isBulkEditModalOpen && <BulkEditModal isOpen={isBulkEditModalOpen} onClose={() => setBulkEditModalOpen(false)} onSuccess={handleSuccess} companies={companiesForBulkEdit} />}
                </AnimatePresence>

                <Tabs defaultValue="companies" className="w-full">
                    <TabsList className="grid w-full grid-cols-2 sm:grid-cols-3 md:grid-cols-6 mb-4">
                        <TabsTrigger value="companies"><Database className="mr-2 h-4 w-4" /> Companies DB</TabsTrigger>
                        <TabsTrigger value="keywords"><KeySquare className="mr-2 h-4 w-4" />Keywords</TabsTrigger>
                        <TabsTrigger value="duplicates"><Combine className="mr-2 h-4 w-4" />Duplicates</TabsTrigger>
                        <TabsTrigger asChild>
                          <Link to="/admin/xai-bulk-import" className="inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm">
                            <UploadCloud className="mr-2 h-4 w-4" /> xAI Bulk Scraper
                          </Link>
                        </TabsTrigger>
                        <TabsTrigger value="errors" className="relative">
                            <AlertTriangle className="mr-2 h-4 w-4" /> Health
                            {errorCount > 0 && (
                                <span className="absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs text-white">
                                    {errorCount}
                                </span>
                            )}
                        </TabsTrigger>
                        <TabsTrigger value="history"><History className="mr-2 h-4 w-4" /> Management</TabsTrigger>
                    </TabsList>

                    <TabsContent value="companies">
                        {loading ? (
                            <div className="flex items-center justify-center min-h-[50vh]"><Loader2 className="w-12 h-12 text-white animate-spin" /></div>
                        ) : (
                             companies.length > 0 
                             ? <AdminCompanyTable companies={companies} onEdit={handleEdit} onDelete={handleDelete} onBulkEdit={handleBulkEdit} userRole={userRole} />
                             : (
                                <div className="text-center py-20 bg-white/5 rounded-2xl">
                                    <ShieldCheck className="mx-auto h-16 w-16 text-green-400" />
                                    <h2 className="mt-4 text-2xl font-bold text-white">All Clear!</h2>
                                    <p className="text-gray-400 mt-2 mb-6">No companies in the database yet.</p>
                                    <Button onClick={() => { setEditingCompany(null); setFormOpen(true); }} className="bg-gradient-to-r from-green-500 to-emerald-500 hover:opacity-90 transition-opacity">
                                        <PlusCircle className="mr-2 h-4 w-4" /> Add First Company
                                    </Button>
                                </div>
                            )
                        )}
                    </TabsContent>

                    <TabsContent value="keywords">
                        <KeywordsDashboard />
                    </TabsContent>
                    <TabsContent value="duplicates">
                        <DuplicatesDashboard />
                    </TabsContent>
                    <TabsContent value="errors">
                        <ErrorsDashboard />
                    </TabsContent>
                    <TabsContent value="history">
                        <UndoHistoryDashboard />
                    </TabsContent>
                </Tabs>
            </div>
        </div>
    );
};

export default AdminPanel;