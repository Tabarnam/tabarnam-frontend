import React, { useState, useEffect, useCallback } from 'react';
import { Helmet } from 'react-helmet-async';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import AdminHeader from '@/components/AdminHeader';
import { getAdminUser } from '@/lib/azureAuth';
import { apiFetch } from '@/lib/api';
import CompaniesTableTab from '@/components/admin/tabs/CompaniesTableTab';
import StarRatingDashboard from '@/components/admin/tabs/StarRatingDashboard';
import UserManagementTab from '@/components/admin/tabs/UserManagementTab';
import ImportToolsTab from '@/components/admin/tabs/ImportToolsTab';
import KeywordEditorTab from '@/components/admin/tabs/KeywordEditorTab';
import UndoHistoryTab from '@/components/admin/tabs/UndoHistoryTab';
import AnalyticsViewerTab from '@/components/admin/tabs/AnalyticsViewerTab';
import ManagementConsoleTab from '@/components/admin/tabs/ManagementConsoleTab';

const AdminPanel = () => {
  const user = getAdminUser();
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('companies');

  const fetchCompanies = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('companies-list');
      if (!res.ok) throw new Error('Failed to load companies');
      const data = await res.json();
      setCompanies(data.items || []);
    } catch (error) {
      toast.error(error?.message || 'Failed to load companies');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCompanies();
  }, [fetchCompanies]);

  const handleCompaniesUpdate = () => {
    fetchCompanies();
  };

  return (
    <>
      <Helmet>
        <title>Tabarnam Admin Panel</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>
      <div className="min-h-screen bg-slate-50">
        <AdminHeader user={user} />
        <main className="container mx-auto py-6 px-4">
          <div className="mb-6">
            <h1 className="text-3xl font-bold text-slate-900">Admin Dashboard</h1>
            <p className="text-slate-600 mt-1">Manage companies, configurations, and system data</p>
          </div>

          <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
            <TabsList className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-1 bg-white border border-slate-200 p-1 rounded-lg">
              <TabsTrigger value="companies" className="text-xs md:text-sm">Companies</TabsTrigger>
              <TabsTrigger value="stars" className="text-xs md:text-sm">Star Rating</TabsTrigger>
              <TabsTrigger value="users" className="text-xs md:text-sm">Users</TabsTrigger>
              <TabsTrigger value="imports" className="text-xs md:text-sm">Imports</TabsTrigger>
              <TabsTrigger value="keywords" className="text-xs md:text-sm">Keywords</TabsTrigger>
              <TabsTrigger value="undo" className="text-xs md:text-sm">Undo</TabsTrigger>
              <TabsTrigger value="analytics" className="text-xs md:text-sm">Analytics</TabsTrigger>
              <TabsTrigger value="console" className="text-xs md:text-sm">Console</TabsTrigger>
            </TabsList>

            <div className="bg-white rounded-lg border border-slate-200 p-6">
              <TabsContent value="companies" className="space-y-4">
                <CompaniesTableTab companies={companies} loading={loading} onUpdate={handleCompaniesUpdate} />
              </TabsContent>

              <TabsContent value="stars" className="space-y-4">
                <StarRatingDashboard companies={companies} onUpdate={handleCompaniesUpdate} />
              </TabsContent>

              <TabsContent value="users" className="space-y-4">
                <UserManagementTab />
              </TabsContent>

              <TabsContent value="imports" className="space-y-4">
                <ImportToolsTab />
              </TabsContent>

              <TabsContent value="keywords" className="space-y-4">
                <KeywordEditorTab />
              </TabsContent>

              <TabsContent value="undo" className="space-y-4">
                <UndoHistoryTab />
              </TabsContent>

              <TabsContent value="analytics" className="space-y-4">
                <AnalyticsViewerTab />
              </TabsContent>

              <TabsContent value="console" className="space-y-4">
                <ManagementConsoleTab companies={companies} onUpdate={handleCompaniesUpdate} />
              </TabsContent>
            </div>
          </Tabs>
        </main>
      </div>
    </>
  );
};

export default AdminPanel;
