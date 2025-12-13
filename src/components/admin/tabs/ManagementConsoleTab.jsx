import React, { useState, useMemo } from 'react';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiFetch } from '@/lib/api';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertTriangle, Play } from 'lucide-react';
import { getAdminUser } from '@/lib/azureAuth';

const ManagementConsoleTab = ({ companies, onUpdate }) => {
  const user = getAdminUser();
  const [selectedField, setSelectedField] = useState('');
  const [newValue, setNewValue] = useState('');
  const [selectedCompanies, setSelectedCompanies] = useState([]);
  const [loading, setLoading] = useState(false);

  const commonFields = [
    'company_name',
    'tagline',
    'website_url',
    'amazon_store_url',
    'star_rating',
    'notes',
  ];

  const selectedCompanyData = useMemo(() => {
    return companies.filter(c => selectedCompanies.includes(c.id));
  }, [companies, selectedCompanies]);

  const handleSelectCompany = (id) => {
    setSelectedCompanies(prev =>
      prev.includes(id) ? prev.filter(cid => cid !== id) : [...prev, id]
    );
  };

  const handleSelectAll = () => {
    if (selectedCompanies.length === companies.length) {
      setSelectedCompanies([]);
    } else {
      setSelectedCompanies(companies.map(c => c.id));
    }
  };

  const handleApplyBatch = async () => {
    if (!selectedField || !newValue) {
      toast.error('Select a field and enter a value');
      return;
    }
    if (selectedCompanies.length === 0) {
      toast.error('Select at least one company');
      return;
    }

    setLoading(true);
    try {
      const res = await apiFetch('xadmin-api-batch-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          field: selectedField,
          value: newValue,
          companyIds: selectedCompanies,
          actor: user?.email,
        }),
      });
      if (!res.ok) throw new Error('Batch update failed');
      const data = await res.json();
      toast.success(`Updated ${data.updated} companies`);
      onUpdate();
      setSelectedCompanies([]);
      setSelectedField('');
      setNewValue('');
    } catch (error) {
      toast.error(error?.message || 'Batch update failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-600" />
            Batch Operations
          </CardTitle>
          <p className="text-sm text-slate-600 mt-2">
            Carefully select companies and set field values. Preview before applying.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-700">Field to Update</label>
              <Select value={selectedField} onValueChange={setSelectedField}>
                <SelectTrigger>
                  <SelectValue placeholder="Select field" />
                </SelectTrigger>
                <SelectContent>
                  {commonFields.map(field => (
                    <SelectItem key={field} value={field}>
                      {field}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-700">New Value</label>
              <Input
                placeholder="Enter value..."
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-700">&nbsp;</label>
              <Button
                onClick={handleApplyBatch}
                disabled={loading || !selectedField || !newValue || selectedCompanies.length === 0}
                className="w-full bg-[#B1DDE3] text-slate-900 hover:bg-[#A0C8D0]"
              >
                <Play className="mr-2 h-4 w-4" />
                Apply to {selectedCompanies.length} Companies
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            Select Companies ({selectedCompanies.length} selected)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={handleSelectAll}
              className="border-[#B1DDE3] text-slate-900"
            >
              {selectedCompanies.length === companies.length ? 'Deselect All' : 'Select All'}
            </Button>
            <Button
              variant="outline"
              onClick={() => setSelectedCompanies([])}
              disabled={selectedCompanies.length === 0}
              className="border-slate-300"
            >
              Clear Selection
            </Button>
          </div>

          <div className="max-h-96 overflow-y-auto border border-slate-200 rounded-lg">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 sticky top-0">
                  <th className="p-3 text-left">
                    <input
                      type="checkbox"
                      checked={selectedCompanies.length === companies.length && companies.length > 0}
                      onChange={handleSelectAll}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                  </th>
                  <th className="text-left p-3 font-semibold text-slate-700">Name</th>
                  <th className="text-left p-3 font-semibold text-slate-700">Tagline</th>
                </tr>
              </thead>
              <tbody>
                {companies.map(company => (
                  <tr
                    key={company.id}
                    className={`border-b border-slate-200 hover:bg-slate-50 ${
                      selectedCompanies.includes(company.id) ? 'bg-blue-50' : ''
                    }`}
                  >
                    <td className="p-3">
                      <input
                        type="checkbox"
                        checked={selectedCompanies.includes(company.id)}
                        onChange={() => handleSelectCompany(company.id)}
                        className="h-4 w-4 rounded border-slate-300"
                      />
                    </td>
                    <td className="p-3 font-medium text-slate-900">{company.company_name || company.name}</td>
                    <td className="p-3 text-slate-600 truncate max-w-xs">{company.tagline || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default ManagementConsoleTab;
