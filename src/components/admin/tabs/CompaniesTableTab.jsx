import React, { useState, useMemo } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ClipLoader } from 'react-spinners';
import { Edit2, Trash2, Plus, Download, Search } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import CompanyForm from '@/components/admin/CompanyForm';
import { getAdminUser } from '@/lib/azureAuth';

const CompaniesTableTab = ({ companies, loading, onUpdate }) => {
  const user = getAdminUser();
  const [searchTerm, setSearchTerm] = useState('');
  const [editingCompany, setEditingCompany] = useState(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [deleteCompanyId, setDeleteCompanyId] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 50;

  const filteredCompanies = useMemo(() => {
    if (!searchTerm) return companies;
    const term = searchTerm.toLowerCase();
    return companies.filter(c =>
      (c.company_name?.toLowerCase().includes(term)) ||
      (c.name?.toLowerCase().includes(term)) ||
      (c.product_keywords?.toLowerCase().includes(term)) ||
      (c.normalized_domain?.toLowerCase().includes(term)) ||
      (c.amazon_url?.toLowerCase().includes(term)) ||
      (c.tagline?.toLowerCase().includes(term)) ||
      (Array.isArray(c.industries) && c.industries.some(i => i.toLowerCase?.().includes(term)))
    );
  }, [companies, searchTerm]);

  const totalPages = Math.ceil(filteredCompanies.length / itemsPerPage);
  const paginatedCompanies = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filteredCompanies.slice(start, start + itemsPerPage);
  }, [filteredCompanies, currentPage]);

  const handleEdit = (company) => {
    setEditingCompany(company);
    setIsFormOpen(true);
  };

  const handleDelete = async (companyId) => {
    const companyToDelete = companies.find(c => c.id === companyId);
    console.log('[Admin] Deleting company', {
      id: companyId,
      company_id: companyToDelete?.company_id,
      company_name: companyToDelete?.company_name || companyToDelete?.name,
    });

    try {
      const deletePayload = { id: companyId, actor: user?.email };
      console.log('[Admin] DELETE payload:', deletePayload);

      const res = await apiFetch('/companies-list', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deletePayload),
      });

      console.log('[Admin] DELETE response:', {
        status: res.status,
        ok: res.ok,
        statusText: res.statusText,
      });

      let responseBody = {};
      try {
        responseBody = await res.json();
        console.log('[Admin] DELETE response body:', responseBody);
      } catch (jsonErr) {
        console.warn('[Admin] Failed to parse DELETE response as JSON:', jsonErr?.message);
      }

      if (!res.ok) {
        throw new Error(responseBody?.error || responseBody?.detail || `Delete failed with status ${res.status}`);
      }

      if (!responseBody.ok) {
        console.warn('[Admin] Response indicated failure:', responseBody);
        throw new Error(responseBody?.error || 'Delete response was not ok');
      }

      console.log('[Admin] Delete confirmed as successful');
      toast.success('Company deleted');
      console.log('[Admin] Calling onUpdate() to refresh companies list...');
      onUpdate();
      setDeleteCompanyId(null);
    } catch (error) {
      console.error('[Admin] Delete error:', error);
      toast.error(error?.message || 'Failed to delete company');
    }
  };

  const handleExportCSV = () => {
    if (filteredCompanies.length === 0) {
      toast.error('No companies to export');
      return;
    }
    const headers = ['ID', 'Name', 'Tagline', 'Website', 'Industries', 'Stars', 'Amazon URL'];
    const rows = filteredCompanies.map(c => [
      c.id,
      c.company_name || c.name || '',
      c.tagline || '',
      c.website_url || '',
      (Array.isArray(c.industries) ? c.industries.join('; ') : ''),
      c.star_rating || '0',
      c.amazon_store_url || c.amazon_url || '',
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `companies_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Exported to CSV');
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <ClipLoader color="#B1DDE3" size={40} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
          <Input
            placeholder="Search by name, tagline, or industry..."
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              setCurrentPage(1);
            }}
            className="pl-9"
          />
        </div>
        <Button
          onClick={() => {
            setEditingCompany(null);
            setIsFormOpen(true);
          }}
          className="bg-[#B1DDE3] text-slate-900 hover:bg-[#A0C8D0]"
        >
          <Plus className="mr-2 h-4 w-4" /> Add Company
        </Button>
        <Button
          variant="outline"
          onClick={handleExportCSV}
          className="border-[#B1DDE3] text-slate-900"
        >
          <Download className="mr-2 h-4 w-4" /> Export CSV
        </Button>
      </div>

      <div className="text-sm text-slate-600">
        Showing {paginatedCompanies.length} of {filteredCompanies.length} companies
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              <th className="text-left p-3 font-semibold text-slate-700">Name</th>
              <th className="text-left p-3 font-semibold text-slate-700">Tagline</th>
              <th className="text-left p-3 font-semibold text-slate-700">Industries</th>
              <th className="text-center p-3 font-semibold text-slate-700">Stars</th>
              <th className="text-center p-3 font-semibold text-slate-700">Flag</th>
              <th className="text-center p-3 font-semibold text-slate-700">Actions</th>
            </tr>
          </thead>
          <tbody>
            {paginatedCompanies.map(company => (
              <tr key={company.id} className="border-b border-slate-200 hover:bg-slate-50 transition">
                <td className="p-3 font-medium text-slate-900">{company.company_name || company.name || 'N/A'}</td>
                <td className="p-3 text-slate-600 truncate max-w-xs">{company.tagline || '-'}</td>
                <td className="p-3 text-slate-600">
                  {Array.isArray(company.industries) && company.industries.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {company.industries.slice(0, 2).map((ind, i) => (
                        <span key={i} className="bg-blue-100 text-blue-700 text-xs px-2 py-0.5 rounded">
                          {ind}
                        </span>
                      ))}
                      {company.industries.length > 2 && (
                        <span className="text-xs text-slate-500">+{company.industries.length - 2}</span>
                      )}
                    </div>
                  ) : (
                    '-'
                  )}
                </td>
                <td className="p-3 text-center">
                  <span className="font-semibold text-slate-900">{company.star_rating || 0}</span>
                </td>
                <td className="p-3 text-center">
                  {company.red_flag ? (
                    <span title={company.red_flag_reason || "Flagged for review"} className="inline-block bg-red-100 text-red-700 px-2 py-1 rounded text-xs font-semibold cursor-help">
                      🚩
                    </span>
                  ) : (
                    <span className="text-slate-400 text-xs">-</span>
                  )}
                </td>
                <td className="p-3 text-center">
                  <div className="flex justify-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleEdit(company)}
                      className="text-blue-600 hover:bg-blue-50"
                      title="Edit company"
                      aria-label={`Edit ${company.company_name || company.name}`}
                    >
                      <Edit2 className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setDeleteCompanyId(company.id)}
                      className="text-red-600 hover:bg-red-50"
                      title="Delete company"
                      aria-label={`Delete ${company.company_name || company.name}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {paginatedCompanies.length === 0 && (
        <div className="text-center py-12">
          <p className="text-slate-500">No companies found. {searchTerm && 'Try a different search.'}</p>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex justify-center gap-2 mt-6">
          <Button
            variant="outline"
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            disabled={currentPage === 1}
          >
            Previous
          </Button>
          <div className="flex items-center gap-2">
            {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
              <Button
                key={page}
                variant={currentPage === page ? 'default' : 'outline'}
                size="sm"
                onClick={() => setCurrentPage(page)}
                className={currentPage === page ? 'bg-[#B1DDE3] text-slate-900' : ''}
              >
                {page}
              </Button>
            ))}
          </div>
          <Button
            variant="outline"
            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages}
          >
            Next
          </Button>
        </div>
      )}

      <CompanyForm
        isOpen={isFormOpen}
        onClose={() => {
          setIsFormOpen(false);
          setEditingCompany(null);
        }}
        company={editingCompany}
        onSuccess={onUpdate}
      />

      <AlertDialog open={!!deleteCompanyId} onOpenChange={() => setDeleteCompanyId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Company</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this company? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteCompanyId && handleDelete(deleteCompanyId)}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default CompaniesTableTab;
