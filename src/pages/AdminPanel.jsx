import React, { useState, useEffect } from 'react';
import { Helmet } from 'react-helmet-async';
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
  const [loading, setLoading] = useState(true);
  const [lastImportCount, setLastImportCount] = useState(0);
  const [starConfig, setStarConfig] = useState({
    hq_weight: 1,
    manufacturing_weight: 1,
    review_threshold: 4,
    min_reviews: 3,
  });

  const [editingCompany, setEditingCompany] = useState(null);
  const [isFormOpen, setIsFormOpen] = useState(false);

  useEffect(() => {
    fetchData();
    const savedImport = localStorage.getItem('lastImportCount');
    if (savedImport) setLastImportCount(parseInt(savedImport));
  }, []);

  useEffect(() => {
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
      console.log('Admin data fetch stub - Supabase removed');
      setCompanies([]);
      setFilteredCompanies([]);
      setStarConfig({
        hq_weight: 1,
        manufacturing_weight: 1,
        review_threshold: 4,
        min_reviews: 3,
      });
    } catch (error) {
      toast.error('Fetch Error', error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRecalcStars = async () => {
    try {
      console.log('Recalc stars stub - Supabase removed');
      toast.success('Success', 'Star recalculation disabled - Supabase removed.');
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

        {loading ? (
          <Loader2 className="animate-spin" />
        ) : (
          <div className="p-4 border" style={{ borderColor: 'rgb(100, 150, 180)' }}>
            <h2 className="text-xl">Companies</h2>
            <Input
              placeholder="Search companies by any field..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
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
            onChange={(e) =>
              setStarConfig({ ...starConfig, manufacturing_weight: parseFloat(e.target.value) })
            }
            placeholder="Manufacturing Weight"
          />
          <Input
            type="number"
            value={starConfig.review_threshold}
            onChange={(e) =>
              setStarConfig({ ...starConfig, review_threshold: parseFloat(e.target.value) })
            }
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

        {isFormOpen && (
          <CompanyForm
            isOpen={isFormOpen}
            onClose={() => setIsFormOpen(false)}
            company={editingCompany}
            onSuccess={fetchData}
          />
        )}
      </div>
    </>
  );
};

export default AdminPanel;
