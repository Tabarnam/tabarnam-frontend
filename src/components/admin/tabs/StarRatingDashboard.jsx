import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ClipLoader } from 'react-spinners';
import { Save, RotateCcw } from 'lucide-react';
import { getAdminUser } from '@/lib/azureAuth';

const StarRatingDashboard = ({ companies, onUpdate }) => {
  const user = getAdminUser();
  const [loading, setLoading] = useState(false);
  const [starConfig, setStarConfig] = useState({
    hq_weight: 1,
    manufacturing_weight: 1,
    review_threshold: 4,
    min_reviews: 3,
  });

  useEffect(() => {
    fetchStarConfig();
  }, []);

  const fetchStarConfig = async () => {
    try {
      const res = await fetch('/api/admin-star-config');
      if (!res.ok) throw new Error('Failed to load star config');
      const data = await res.json();
      if (data.config) {
        setStarConfig(data.config);
      }
    } catch (error) {
      console.warn('Star config not found, using defaults');
    }
  };

  const handleSaveConfig = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin-star-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: starConfig, actor: user?.email }),
      });
      if (!res.ok) throw new Error('Failed to save configuration');
      toast.success('Star configuration saved');
      onUpdate();
    } catch (error) {
      toast.error(error?.message || 'Failed to save configuration');
    } finally {
      setLoading(false);
    }
  };

  const handleRecalculateStars = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin-recalc-stars', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: user?.email }),
      });
      if (!res.ok) throw new Error('Failed to recalculate stars');
      const data = await res.json();
      toast.success(`Recalculated stars for ${data.updated || 0} companies`);
      onUpdate();
    } catch (error) {
      toast.error(error?.message || 'Failed to recalculate stars');
    } finally {
      setLoading(false);
    }
  };

  const binaryStarsExplanation = `
    Binary star calculation (0-3 stars):
    • 1 star if company has HQ location
    • 1 star if company has manufacturing locations
    • 1 star if company has reviews (min ${starConfig.min_reviews} reviews)
    • 4th & 5th stars must be set manually
  `;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-700">HQ Weight</label>
              <Input
                type="number"
                min="0"
                step="0.1"
                value={starConfig.hq_weight}
                onChange={(e) => setStarConfig({ ...starConfig, hq_weight: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-700">Manufacturing Weight</label>
              <Input
                type="number"
                min="0"
                step="0.1"
                value={starConfig.manufacturing_weight}
                onChange={(e) => setStarConfig({ ...starConfig, manufacturing_weight: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-700">Review Threshold (min reviews)</label>
              <Input
                type="number"
                min="1"
                value={starConfig.min_reviews}
                onChange={(e) => setStarConfig({ ...starConfig, min_reviews: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-700">Review Rating Threshold (min stars)</label>
              <Input
                type="number"
                min="0"
                max="5"
                step="0.1"
                value={starConfig.review_threshold}
                onChange={(e) => setStarConfig({ ...starConfig, review_threshold: Number(e.target.value) })}
              />
            </div>
            <Button
              onClick={handleSaveConfig}
              disabled={loading}
              className="w-full bg-[#B1DDE3] text-slate-900 hover:bg-[#A0C8D0]"
            >
              {loading ? <ClipLoader size={16} /> : <Save className="mr-2 h-4 w-4" />}
              Save Configuration
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Binary Star System</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-slate-600 whitespace-pre-line">{binaryStarsExplanation}</p>
            <Button
              onClick={handleRecalculateStars}
              disabled={loading}
              className="w-full bg-[#B1DDE3] text-slate-900 hover:bg-[#A0C8D0]"
            >
              {loading ? <ClipLoader size={16} /> : <RotateCcw className="mr-2 h-4 w-4" />}
              Recalculate All Stars
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Star Distribution</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[0, 1, 2, 3, 4, 5].map(stars => {
              const count = companies.filter(c => Math.round(c.star_rating || 0) === stars).length;
              const pct = companies.length > 0 ? Math.round((count / companies.length) * 100) : 0;
              return (
                <div key={stars} className="flex items-center gap-4">
                  <div className="w-12 font-medium text-slate-900">{stars} ⭐</div>
                  <div className="flex-1 bg-slate-200 rounded-full h-6 overflow-hidden">
                    <div
                      className="bg-[#B1DDE3] h-full transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="w-16 text-right text-sm text-slate-600">
                    {count} ({pct}%)
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default StarRatingDashboard;
