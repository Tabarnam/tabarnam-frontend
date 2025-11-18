import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ClipLoader } from 'react-spinners';
import { RotateCcw, Trash2 } from 'lucide-react';
import { getAdminUser } from '@/lib/azureAuth';

const UndoHistoryTab = () => {
  const user = getAdminUser();
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchHistory();
  }, []);

  const fetchHistory = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin-undo-history');
      if (res.ok) {
        const data = await res.json();
        setHistory(data.history || []);
      }
    } catch (error) {
      toast.error('Failed to load undo history');
    } finally {
      setLoading(false);
    }
  };

  const handleUndo = async (id) => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin-undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, actor: user?.email }),
      });
      if (!res.ok) throw new Error('Failed to undo action');
      toast.success('Action undone');
      fetchHistory();
    } catch (error) {
      toast.error(error?.message || 'Failed to undo action');
    } finally {
      setLoading(false);
    }
  };

  const handleClearOldHistory = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin-undo-history', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: user?.email }),
      });
      if (!res.ok) throw new Error('Failed to clear history');
      toast.success('Old history cleared');
      fetchHistory();
    } catch (error) {
      toast.error(error?.message || 'Failed to clear history');
    } finally {
      setLoading(false);
    }
  };

  if (loading && history.length === 0) {
    return (
      <div className="flex justify-center items-center py-12">
        <ClipLoader color="#B1DDE3" size={40} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Button
          onClick={handleClearOldHistory}
          disabled={loading}
          variant="outline"
          className="border-slate-300"
        >
          <Trash2 className="mr-2 h-4 w-4" />
          Clear Old History (&gt;48h)
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Action History</CardTitle>
          <p className="text-sm text-slate-600 mt-2">Last 48 hours of changes (oldest removed automatically)</p>
        </CardHeader>
        <CardContent>
          <div className="space-y-3 max-h-[600px] overflow-y-auto">
            {history.length === 0 ? (
              <p className="text-slate-500 text-sm">No undo history available.</p>
            ) : (
              history.map(item => (
                <div
                  key={item.id}
                  className="border border-slate-200 rounded-lg p-3 hover:bg-slate-50 transition"
                >
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <p className="font-medium text-slate-900">{item.description}</p>
                      <p className="text-xs text-slate-500 mt-1">
                        {item.actor && `By: ${item.actor} • `}
                        {new Date(item.created_at).toLocaleString()}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => handleUndo(item.id)}
                      disabled={loading || item.is_undone}
                      className="bg-[#B1DDE3] text-slate-900 hover:bg-[#A0C8D0]"
                    >
                      <RotateCcw className="h-4 w-4" />
                    </Button>
                  </div>
                  {item.is_undone && (
                    <p className="text-xs text-slate-500 font-medium">✓ Already undone</p>
                  )}
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default UndoHistoryTab;
