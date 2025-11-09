import React, { useEffect, useState } from 'react';
import Head from 'next/head';
import { AnimatePresence, motion } from 'framer-motion';
import { useToast } from '@/components/ui/use-toast';
import { Loader2 } from 'lucide-react';
// Supabase removed - use Cosmos DB instead

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

        if (error) throw error;
        setCompanies(data);
      } catch (error) {
        toast({
          title: 'Error loading companies',
          description: error.message,
          variant: 'destructive',
        });
      } finally {
        setLoading(false);
      }
    };

    fetchCompanies();
  }, [user, toast]);

  if (authLoading) {
    return (
      <div className="flex justify-center items-center h-screen">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <LoginForm />;
  }

  return (
    <>
      <Head>
        <title>Company Dashboard - Tabarnam</title>
        <meta name="description" content="View and manage companies in the Tabarnam dashboard." />
      </Head>

      <div className="p-6">
        <DashboardHeader />
        {loading ? (
          <div className="flex justify-center items-center h-64">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : (
          <AnimatePresence>
            <motion.div
              layout
              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 mt-4"
            >
              {companies.map((company) => (
                <CompanyCard key={company.id} company={company} />
              ))}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </>
  );
};

export default CompanyDashboard;
