import React, { useState, useEffect } from 'react';
import { Helmet } from 'react-helmet';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { supabase } from '@/lib/customSupabaseClient';
import { useAuth } from '@/contexts/SupabaseAuthContext';
import { useUserRole } from '@/contexts/UserRoleContext';
import { useToast } from '@/components/ui/use-toast';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import ReactTable from 'react-table'; // Install if needed: npm install react-table
import CompanyForm from '@/components/admin/CompanyForm'; // Assume this exists for editing

const AdminPanel = () => {
  const { user } = useAuth();
  const { userRole } = useUserRole();
  const { toast } = useToast();
  const [companies, setCompanies] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newAdminEmail, setNewAdminEmail] = useState('');
  const [lastImportCount, setLastImportCount] = useState(0);
  const [starConfig, setStarConfig] = useState({ hq_weight: 1, manufacturing_weight: 1, review_threshold: 4, min_reviews: 3 });
  const [editingCompany, setEditingCompany] = useState(null);
  const [isFormOpen, setIsFormOpen] = useState(false);

  const isSuperAdmin = user?.email === 'jon@tabarnam.com';

  useEffect(() => {
    fetchData();
    const savedImport = localStorage.getItem('lastImportCount');
    if (savedImport) setLastImportCount(parseInt(savedImport));
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      // Fetch companies
      const { data: companyData, error: companyError } = await supabase.from('companies').select('*');
      if (companyError) throw companyError;
      setCompanies(companyData || []);

      // Fetch users
      const { data: userData, error: userError } = await supabase.from('profiles').select('id, email, role');
      if (userError) throw userError;
      setUsers(userData || []);

      // Fetch star config
      const { data: configData, error: configError } = await supabase.from('star_config').select('*').single();
      if (configError) throw configError;
      if (configData) setStarConfig(configData);
    } catch (error) {
      toast({ variant: 'destructive', title: 'Fetch Error', description: error.message });
    } finally {
      setLoading(false);
    }
  };

  const handleAddAdmin = async () => {
    if (!isSuperAdmin) {
      toast({ variant: 'destructive', title: 'Permission Denied', description: 'Only jon@tabarnam.com can manage users.' });
      return;
    }
    if (!newAdminEmail) {
      toast({ variant: 'destructive', title: 'Invalid Email', description: 'Enter a valid email.' });
      return;
    }
    try {
      const { error } = await supabase.from('profiles').upsert({ email: newAdminEmail, role: 'admin' });
      if (error) throw error;
      toast({ title: 'Success', description: 'Admin added.' });
      setNewAdminEmail('');
      fetchData();
    } catch (error) {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
    }
  };

  const handleDeleteUser = async (userId) => {
    if (!isSuperAdmin) return;
    try {
      const { error } = await supabase.from('profiles').delete().eq('id', userId);
      if (error) throw error;
      toast({ title: 'Success', description: 'User deleted.' });
      fetchData();
    } catch (error) {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
    }
  };

  const handleRecalcStars = async () => {
    try {
      await supabase.from('star_config').upsert(starConfig);
      const { error } = await supabase.rpc('recalc_star_ratings'); // Assume RPC for batch recalc
      if (error) throw error;
      toast({ title: 'Success', description: 'Stars recalculated.' });
      fetchData();
    } catch (error) {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
    }
  };

  const handleEditCompany = (company) => {
    setEditingCompany(company);
    setIsFormOpen(true);
  };

  const companyColumns = [
    { Header: 'Name', accessor: 'company_name' },
    { Header: 'Star Rating', accessor: 'star_rating' },
    { Header: 'HQ', accessor: 'headquarters_location' },
    { Header: 'Manufacturing', accessor: 'manufacturing_locations' },
    { Header: 'Actions', Cell: ({ row }) => <Button onClick={() => handleEditCompany(row.original)} className="bg-blue-600">Edit</Button> },
  ];

  return (
    <>
      <Helmet>
        <title>Admin Panel - Tabarnam</title>
      </Helmet>
      <div className="p-6 space-y-6" style={{ backgroundColor: 'rgb(177, 221, 227)' }}> {/* Tabarnam blue */}
        <h1 className="text-3xl font-bold">Admin Panel</h1>

        {/* Import Status */}
        <div className="p-4 border" style={{ borderColor: 'rgb(100, 150, 180)' }}> {/* Bolder blue */}
          Last Import Count: {lastImportCount}
        </div>

        {/* User Management */}
        <div className="p-4 border" style={{ borderColor: 'rgb(100, 150, 180)' }}>
          <h2 className="text-xl">User Management</h2>
          <Input value={newAdminEmail} onChange={(e) => setNewAdminEmail(e.target.value)} placeholder="Email" />
          <Button onClick={handleAddAdmin} disabled={!isSuperAdmin}>Add Admin</Button>
          <ReactTable data={users} columns={[{ Header: 'Email', accessor: 'email' }, { Header: 'Role', accessor: 'role' }, { Header: 'Actions', Cell: ({ row }) => <Button onClick={() => handleDeleteUser(row.original.id)} disabled={!isSuperAdmin}>Delete</Button> }]} className="w-full border-collapse table-auto" />
        </div>

        {/* Companies Table */}
        {loading ? <Loader2 className="animate-spin" /> : (
          <div className="p-4 border" style={{ borderColor: 'rgb(100, 150, 180)' }}>
            <h2 className="text-xl">Companies</h2>
            <ReactTable data={companies} columns={companyColumns} className="w-full border-collapse table-auto" />
          </div>
        )}

        {/* Star Rating Dashboard */}
        <div className="p-4 border" style={{ borderColor: 'rgb(100, 150, 180)' }}>
          <h2 className="text-xl">Star Rating Config</h2>
          <Input type="number" value={starConfig.hq_weight} onChange={(e) => setStarConfig({ ...starConfig, hq_weight: parseFloat(e.target.value) })} placeholder="HQ Weight" />
          <Input type="number" value={starConfig.manufacturing_weight} onChange={(e) => setStarConfig({ ...starConfig, manufacturing_weight: parseFloat(e.target.value) })} placeholder="Manufacturing Weight" />
          <Input type="number" value={starConfig.review_threshold} onChange={(e) => setStarConfig({ ...starConfig, review_threshold: parseFloat(e.target.value) })} placeholder="Review Threshold" />
          <Input type="number" value={starConfig.min_reviews} onChange={(e) => setStarConfig({ ...starConfig, min_reviews: parseInt(e.target.value) })} placeholder="Min Reviews" />
          <Button onClick={handleRecalcStars}>Recalculate Stars</Button>
        </div>

        {/* Company Form Modal */}
        {isFormOpen && <CompanyForm isOpen={isFormOpen} onClose={() => setIsFormOpen(false)} company={editingCompany} onSuccess={fetchData} />}

        <Link to="/admin/xai-bulk-import">Bulk Import Tool</Link>
      </div>
    </>
  );
};

export default AdminPanel;