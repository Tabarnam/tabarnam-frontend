import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { supabase } from '@/lib/customSupabaseClient';
import { useAuth } from '@/contexts/SupabaseAuthContext';
import { useToast } from '@/components/ui/use-toast';
import { Loader2 } from 'lucide-react';
import DashboardHeader from '@/components/DashboardHeader';
import CompanyCard from '@/components/CompanyCard';
import LoginForm from '@/components/LoginForm';

const CompanyDashboard = () => {
    const { user, loading: authLoading } = useAuth();
    const [companies, setCompanies] = useState([]);
    const [loading, setLoading] = useState(true);
    const { toast } = useToast();

    useEffect(() => {
        const fetchCompanies = async () => {
            if (!user) return;
            setLoading(true);
            try {
                const { data, error } = await supabase
                    .from('companies')
                    .select('id, name, about, website_url, industries, rating')
                    .limit(12);

                if (error) {
                    throw error;
                }
                setCompanies(data);
            } catch (error) {
                toast({
                    variant: "destructive",
                    title: "Failed to fetch companies",
                    description: error.message,
                });
            } finally {
                setLoading(false);
            }
        };
        fetchCompanies();
    }, [user, toast]);

    if (authLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <Loader2 className="w-12 h-12 text-white animate-spin" />
            </div>
        );
    }
    
    if (!user) {
        return <div className="p-6"><LoginForm /></div>;
    }

    return (
        <div className="min-h-screen p-6">
            <div className="max-w-7xl mx-auto">
                <DashboardHeader />

                {loading ? (
                    <div className="flex items-center justify-center min-h-[50vh]">
                        <Loader2 className="w-12 h-12 text-white animate-spin" />
                    </div>
                ) : (
                    <AnimatePresence>
                        <motion.div 
                            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6"
                            initial="hidden"
                            animate="visible"
                        >
                            {companies.map((company, index) => (
                                <CompanyCard key={company.id} company={company} index={index} />
                            ))}
                        </motion.div>
                    </AnimatePresence>
                )}
                 { !loading && companies.length === 0 && (
                     <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="text-center py-20 bg-white/5 rounded-2xl"
                    >
                        <h2 className="text-2xl font-bold text-white mb-2">No Companies Found</h2>
                        <p className="text-gray-400">Your database seems to be empty. Add some companies to see them here!</p>
                    </motion.div>
                )}
            </div>
        </div>
    );
};

export default CompanyDashboard;