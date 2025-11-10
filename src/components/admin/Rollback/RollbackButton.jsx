// src/components/admin/Rollback/RollbackButton.jsx
import { useState } from 'react';
import toast from 'react-hot-toast';

export default function RollbackButton() {
  const [loading, setLoading] = useState(false);

  const handleRollback = async () => {
    const confirmed = window.confirm('Rollback via Vercel is disabled. Open Azure Static Web Apps or Azure Front Door to manage deployments. Open portal now?');
    if (!confirmed) return;
    setLoading(true);
    const tId = toast.loading('Opening Azure portal...');
    try {
      window.open('https://portal.azure.com/#view/Microsoft_Azure_StaticWebApps/StaticWebAppMenuBlade/~/overview', '_blank', 'noopener');
      toast.success('Azure portal opened.', { id: tId, duration: 3000 });
      localStorage.setItem('lastRollback', JSON.stringify({
        user: 'You',
        time: new Date().toLocaleString()
      }));
    } catch (e) {
      toast.error(`Could not open Azure portal: ${e?.message || 'Unknown error'}`, { id: tId });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4">
      <button
        onClick={handleRollback}
        disabled={loading}
        className="bg-gray-600 text-white px-4 py-2 rounded disabled:opacity-60"
        title="Vercel rollback removed. Use Azure portal to manage deployments."
      >
        {loading ? 'Opening Azure…' : 'Manage Deployments (Azure)'}
      </button>
    </div>
  );
}
