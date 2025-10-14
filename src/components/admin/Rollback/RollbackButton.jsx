// src/components/admin/Rollback/RollbackButton.jsx
import { useState } from 'react';
import toast from 'react-hot-toast';
import { API_BASE } from '@/lib/api';

export default function RollbackButton() {
  const [loading, setLoading] = useState(false);

  const handleRollback = async () => {
    const confirmed = window.confirm('Are you sure you want to rollback to the last failed deploy?');
    if (!confirmed) return;

    setLoading(true);
    const tId = toast.loading('Attempting rollback...');

    try {
      const res = await fetch(`${API_BASE}/vercel/rollback`);
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data?.error || res.statusText || `HTTP ${res.status}`);
      }

      if (data.message) {
        toast.success(data.message, { id: tId, duration: 4000 });
        localStorage.setItem('lastRollback', JSON.stringify({
          user: 'You',
          time: new Date().toLocaleString()
        }));
      } else {
        toast.success('Rollback completed.', { id: tId, duration: 4000 });
      }
    } catch (e) {
      toast.error(`Rollback failed: ${e?.message || 'Unknown error'}`, { id: tId });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4">
      <button
        onClick={handleRollback}
        disabled={loading}
        className="bg-red-600 text-white px-4 py-2 rounded disabled:opacity-60"
      >
        {loading ? 'Rolling back...' : 'Trigger Rollback'}
      </button>
    </div>
  );
}
