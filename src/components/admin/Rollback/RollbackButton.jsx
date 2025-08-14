import { useState } from 'react';
import toast from 'react-hot-toast';

export default function RollbackButton() {
  const [loading, setLoading] = useState(false);

  const handleRollback = async () => {
    const confirmed = window.confirm('Are you sure you want to rollback to the last failed deploy?');
    if (!confirmed) return;

    setLoading(true);
    const tId = toast.loading('Attempting rollback...');

    try {
      const res = await fetch('/api/vercel/rollback');
      const data = await res.json();

      if (data.message) {
        toast.success(data.message, { id: tId, duration: Infinity });
        localStorage.setItem('lastRollback', JSON.stringify({
          user: 'You',
          time: new Date().toLocaleString()
        }));
      } else {
        toast.error('Rollback completed but no message returned.', { id: tId });
      }
    } catch (e) {
      toast.error('Rollback failed.', { id: tId });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4">
      <button
        onClick={handleRollback}
        disabled={loading}
        className="bg-red-600 text-white px-4 py-2 rounded"
      >
        {loading ? 'Rolling back...' : 'Trigger Rollback'}
      </button>
    </div>
  );
}
