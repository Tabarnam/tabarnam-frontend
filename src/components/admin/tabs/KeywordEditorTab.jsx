import React, { useState, useEffect } from 'react';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Plus, Trash2, Save } from 'lucide-react';
import { getAdminUser } from '@/lib/azureAuth';
import { apiFetch } from '@/lib/api';

const KeywordEditorTab = () => {
  const user = getAdminUser();
  const [keywords, setKeywords] = useState([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchKeywords();
  }, []);

  const fetchKeywords = async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/keywords-list');
      if (res.ok) {
        const data = await res.json();
        setKeywords(data.keywords || []);
      }
    } catch (error) {
      console.warn('Failed to load keywords:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddKeyword = async () => {
    if (!newKeyword.trim()) return;
    const keyword = newKeyword.trim();
    if (keywords.includes(keyword)) {
      toast.error('Keyword already exists');
      return;
    }
    const updated = [...keywords, keyword];
    await handleSave(updated);
    setNewKeyword('');
  };

  const handleRemoveKeyword = async (keyword) => {
    const updated = keywords.filter(k => k !== keyword);
    await handleSave(updated);
  };

  const handleSave = async (updatedKeywords) => {
    setLoading(true);
    try {
      const res = await apiFetch('/keywords-list', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: updatedKeywords, actor: user?.email }),
      });
      if (!res.ok) throw new Error('Failed to save keywords');
      setKeywords(updatedKeywords);
      toast.success('Keywords updated');
    } catch (error) {
      toast.error(error?.message || 'Failed to save keywords');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Industry Keywords</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="Add new keyword..."
              value={newKeyword}
              onChange={(e) => setNewKeyword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddKeyword()}
            />
            <Button
              onClick={handleAddKeyword}
              disabled={loading || !newKeyword.trim()}
              className="bg-[#B1DDE3] text-slate-900 hover:bg-[#A0C8D0]"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex flex-wrap gap-2">
            {keywords.map(keyword => (
              <div
                key={keyword}
                className="inline-flex items-center gap-2 bg-slate-200 text-slate-900 px-3 py-1 rounded-full"
              >
                <span className="text-sm">{keyword}</span>
                <button
                  onClick={() => handleRemoveKeyword(keyword)}
                  disabled={loading}
                  className="text-slate-600 hover:text-red-600 disabled:opacity-50"
                  aria-label={`Remove ${keyword}`}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>

          {keywords.length === 0 && (
            <p className="text-sm text-slate-500">No keywords added yet.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Bulk Operations</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-slate-600">
            Bulk operations for managing keywords across companies are coming soon.
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

export default KeywordEditorTab;
