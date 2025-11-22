import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Download } from 'lucide-react';
import { apiFetch, join, API_BASE } from '@/lib/api';

const AnalyticsViewerTab = () => {
  const [dateRange, setDateRange] = useState({ start: '', end: '' });
  const [metrics, setMetrics] = useState({
    totalSearches: 0,
    uniqueUsers: 0,
    topSearchTerms: [],
    affiliateClicks: 0,
    amazonConversions: 0,
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
    setDateRange({
      start: start.toISOString().split('T')[0],
      end: end.toISOString().split('T')[0],
    });
    fetchMetrics(start, end);
  }, []);

  const fetchMetrics = async (startDate, endDate) => {
    setLoading(true);
    try {
      const url = join(API_BASE, `admin-analytics?start=${startDate.toISOString()}&end=${endDate.toISOString()}`);
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setMetrics(data);
      }
    } catch (error) {
      console.warn('Failed to load analytics:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDateChange = (field, value) => {
    setDateRange(prev => ({ ...prev, [field]: value }));
  };

  const handleRefresh = () => {
    if (dateRange.start && dateRange.end) {
      fetchMetrics(new Date(dateRange.start), new Date(dateRange.end));
    }
  };

  const handleExport = () => {
    const data = [
      ['Metric', 'Value'],
      ['Total Searches', metrics.totalSearches],
      ['Unique Users', metrics.uniqueUsers],
      ['Affiliate Clicks', metrics.affiliateClicks],
      ['Amazon Conversions', metrics.amazonConversions],
      ['', ''],
      ['Top Search Terms', 'Count'],
      ...metrics.topSearchTerms.map(t => [t.term, t.count]),
    ];
    const csv = data.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `analytics_${dateRange.start}_to_${dateRange.end}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Date Range</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col sm:flex-row gap-4 items-end">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-slate-700">From</label>
            <Input
              type="date"
              value={dateRange.start}
              onChange={(e) => handleDateChange('start', e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-medium text-slate-700">To</label>
            <Input
              type="date"
              value={dateRange.end}
              onChange={(e) => handleDateChange('end', e.target.value)}
            />
          </div>
          <Button
            onClick={handleRefresh}
            disabled={loading}
            className="bg-[#B1DDE3] text-slate-900 hover:bg-[#A0C8D0]"
          >
            Refresh
          </Button>
          <Button
            onClick={handleExport}
            variant="outline"
            className="border-[#B1DDE3] text-slate-900"
          >
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-slate-600">Total Searches</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-slate-900">{metrics.totalSearches}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-slate-600">Unique Users</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-slate-900">{metrics.uniqueUsers}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-slate-600">Affiliate Clicks</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-slate-900">{metrics.affiliateClicks}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-slate-600">Amazon Conversions</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-slate-900">{metrics.amazonConversions}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Top Search Terms</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50">
                  <th className="text-left p-3 font-semibold text-slate-700">Term</th>
                  <th className="text-right p-3 font-semibold text-slate-700">Count</th>
                </tr>
              </thead>
              <tbody>
                {metrics.topSearchTerms.slice(0, 10).map((item, i) => (
                  <tr key={i} className="border-b border-slate-200 hover:bg-slate-50">
                    <td className="p-3 text-slate-900">{item.term}</td>
                    <td className="p-3 text-right text-slate-600">{item.count}</td>
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

export default AnalyticsViewerTab;
