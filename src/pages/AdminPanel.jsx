// src/pages/AdminPanel.jsx
import React, { useState, useEffect } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
} from '@tanstack/react-table';
import CompanyForm from '@/components/admin/CompanyForm';
import AdminHeader from '@/components/AdminHeader';
import { getAdminUser } from '@/lib/azureAuth';

const AdminPanel = () => {
  const user = getAdminUser();

  const [companies, setCompanies] = useState([]);
  const [filteredCompanies, setFilteredCompanies] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newAdminEmail, setNewAdminEmail] = useState('');
  const [lastImportCount, setLastImportCount] = useState(0);
  const [starConfig, setStarConfig] = useState({
    hq_weight: 1,
    manufacturing_weight: 1,
    review_threshold: 4,
    min_reviews: 3
  });

  const [editingCompany, setEditingCompany] = useState(null);
  const [isFormOpen, setIsFormOpen] = useState(false);

  const isSuperAdmin = user?.email === 'duh@tabarnam.com' || user?.email === 'admin@tabarnam.com';

  useEffect(() => {
    fetchData();
    const savedImport = localStorage.getItem('lastImportCount');
    if (savedImport) setLastImportCount(parseInt(savedImport));
  }, []);

  useEffect(() => {
    // Filter companies by search query on any field
    const filtered = companies.filter((company) =>
      Object.values(company).some((value) =>
        value && value.toString().toLowerCase().includes(searchQuery.toLowerCase())
      )
    );
    setFilteredCompanies(filtered);
  }, [searchQuery, companies]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const { data: companyData, error: companyError } = await supabase.from('companies').select('*');
      if (companyError) throw companyError;
      setCompanies(companyData || []);
      setFilteredCompanies(companyData || []);

      const { data: userData, error: userError } = await supabase.from('profiles').select('id, email, role');
      if (userError) throw userError;
      setUsers(userData || []);

      const { data: configData, error: configError } = await supabase.from('star_config').select('*').single();
      if (configError) throw configError;
      if (configData) setStarConfig(configData);
    } catch (error) {
      toast.error('Fetch Error', error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleAddAdmin = async () => {
    if (!isSuperAdmin) {
      toast.error('Permission Denied', 'Only jon@tabarnam.com can manage users.');
      return;
    }
    if (!newAdminEmail) {
      toast.error('Invalid Email', 'Enter a valid email.');
      return;
    }
    try {
      const { error } = await supabase.from('profiles').upsert({ email: newAdminEmail, role: 'admin' });
      if (error) throw error;
      toast.success('Success', 'Admin added.');
      setNewAdminEmail('');
      fetchData();
    } catch (error) {
      toast.error('Error', error.message);
    }
  };

  const handleDeleteUser = async (userId) => {
    if (!isSuperAdmin) return;
    try {
      const { error } = await supabase.from('profiles').delete().eq('id', userId);
      if (error) throw error;
      toast.success('Success', 'User deleted.');
      fetchData();
    } catch (error) {
      toast.error('Error', error.message);
    }
  };

  const handleRecalcStars = async () => {
    try {
      await supabase.from('star_config').upsert(starConfig);
      const { error } = await supabase.rpc('recalc_star_ratings');
      if (error) throw error;
      toast.success('Success', 'Stars recalculated.');
      fetchData();
    } catch (error) {
      toast.error('Error', error.message);
    }
  };

  const handleEditCompany = (company) => {
    setEditingCompany(company);
    setIsFormOpen(true);
  };

  const companyColumns = React.useMemo(
    () => [
      {
        accessorKey: 'company_name',
        header: 'Name',
      },
      {
        accessorKey: 'star_rating',
        header: 'Star Rating',
      },
      {
        accessorKey: 'headquarters_location',
        header: 'HQ',
      },
      {
        accessorKey: 'manufacturing_locations',
        header: 'Manufacturing',
      },
      {
        id: 'actions',
        header: 'Actions',
        cell: ({ row }) => (
          <Button onClick={() => handleEditCompany(row.original)} className="bg-blue-600">
            Edit
          </Button>
        ),
      },
    ],
    []
  );

  const userColumns = React.useMemo(
    () => [
      {
        accessorKey: 'email',
        header: 'Email',
      },
      {
        accessorKey: 'role',
        header: 'Role',
      },
      {
        id: 'actions',
        header: 'Actions',
        cell: ({ row }) => (
          <Button onClick={() => handleDeleteUser(row.original.id)} disabled={!isSuperAdmin}>
            Delete
          </Button>
        ),
      },
    ],
    []
  );

  const userTable = useReactTable({
    data: users,
    columns: userColumns,
    getCoreRowModel: getCoreRowModel(),
  });

  const companyTable = useReactTable({
    data: filteredCompanies,
    columns: companyColumns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <>
      <Helmet>
        <title>Admin Panel - Tabarnam</title>
      </Helmet>

      <AdminHeader />

      <div className="p-6 space-y-6" style={{ backgroundColor: 'rgb(177, 221, 227)' }}>
        <h2 className="text-2xl font-bold">Administration</h2>

        <div className="p-4 border" style={{ borderColor: 'rgb(100, 150, 180)' }}>
          Last Import Count: {lastImportCount}
        </div>

        <div className="p-4 border" style={{ borderColor: 'rgb(100, 150, 180)' }}>
          <h2 className="text-xl">User Management</h2>
          <Input value={newAdminEmail} onChange={(e) => setNewAdminEmail(e.target.value)} placeholder="Email" />
          <Button onClick={handleAddAdmin} disabled={!isSuperAdmin}>
            Add Admin
          </Button>
          <table className="w-full border-collapse table-auto">
            <thead>
              {userTable.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th key={header.id} className="p-2 border">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {userTable.getRowModel().rows.map((row) => (
                <tr key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="p-2 border">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {loading ? (
          <Loader2 className="animate-spin" />
        ) : (
          <div className="p-4 border" style={{ borderColor: 'rgb(100, 150, 180)' }}>
            <h2 className="text-xl">Companies</h2>
            <Input placeholder="Search companies by any field..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
            <table className="w-full border-collapse table-auto">
              <thead>
                {companyTable.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <th key={header.id} className="p-2 border">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {companyTable.getRowModel().rows.map((row) => (
                  <tr key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="p-2 border">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="p-4 border" style={{ borderColor: 'rgb(100, 150, 180)' }}>
          <h2 className="text-xl">Star Rating Config</h2>
          <Input
            type="number"
            value={starConfig.hq_weight}
            onChange={(e) => setStarConfig({ ...starConfig, hq_weight: parseFloat(e.target.value) })}
            placeholder="HQ Weight"
          />
          <Input
            type="number"
            value={starConfig.manufacturing_weight}
            onChange={(e) => setStarConfig({ ...starConfig, manufacturing_weight: parseFloat(e.target.value) })}
            placeholder="Manufacturing Weight"
          />
          <Input
            type="number"
            value={starConfig.review_threshold}
            onChange={(e) => setStarConfig({ ...starConfig, review_threshold: parseFloat(e.target.value) })}
            placeholder="Review Threshold"
          />
          <Input
            type="number"
            value={starConfig.min_reviews}
            onChange={(e) => setStarConfig({ ...starConfig, min_reviews: parseInt(e.target.value) })}
            placeholder="Min Reviews"
          />
          <Button onClick={handleRecalcStars}>Recalculate Stars</Button>
        </div>

        {/* Company Form Modal */}
        {isFormOpen && (
          <CompanyForm
            isOpen={isFormOpen}
            onClose={() => setIsFormOpen(false)}
            company={editingCompany}
            onSuccess={fetchData}
          />
        )}

        <Link to="/admin/xai-bulk-import">Bulk Import Tool</Link>
      </div>
    </>
  );
};

export default AdminPanel;
