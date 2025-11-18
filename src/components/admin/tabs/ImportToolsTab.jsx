import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ExternalLink } from 'lucide-react';

const ImportToolsTab = () => {
  const [stats, setStats] = useState({ last24h: 0, last7d: 0, lastMonth: 0 });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchImportStats();
  }, []);

  const fetchImportStats = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/import-stats');
      if (res.ok) {
        const data = await res.json();
        setStats(data);
      }
    } catch (error) {
      console.warn('Failed to load import stats:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-slate-600">Last 24 Hours</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-slate-900">{stats.last24h}</p>
            <p className="text-xs text-slate-500 mt-1">Companies imported</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-slate-600">Last 7 Days</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-slate-900">{stats.last7d}</p>
            <p className="text-xs text-slate-500 mt-1">Companies imported</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-slate-600">Last 30 Days</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-slate-900">{stats.lastMonth}</p>
            <p className="text-xs text-slate-500 mt-1">Companies imported</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Bulk Import Tool</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-slate-600">
            Use the dedicated bulk import tool for importing companies from external sources.
          </p>
          <Button
            asChild
            className="bg-[#B1DDE3] text-slate-900 hover:bg-[#A0C8D0]"
          >
            <a href="/admin/xai-bulk-import">
              Open Bulk Import Tool
              <ExternalLink className="ml-2 h-4 w-4" />
            </a>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Duplicate Resolver</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-slate-600">
            Scan for duplicate companies and merge them safely.
          </p>
          <Button variant="outline" className="border-[#B1DDE3] text-slate-900">
            Scan for Duplicates
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};

export default ImportToolsTab;
