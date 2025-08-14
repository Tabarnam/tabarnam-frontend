// C:\Users\jatlas\OneDrive\Tabarnam Inc\MVP Do It Yourself\tabarnam-frontend\src\components\admin\Rollback\Rollback.jsx
import React, { useState, useEffect } from 'react';
import RollbackButton from './RollbackButton';
import RollbackStatus from './RollbackStatus';

export default function Rollback() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchStatus = async () => {
    setStatus('Vercel rollback disabled. Check Azure deployment status.');
  };

  const handleRollback = async () => {
    const confirm = window.confirm('Rollback functionality is disabled. Check Azure deployment instead.');
    if (!confirm) return;
    setLoading(true);
    setStatus('No rollback action taken. Use Azure deployment management.');
    setLoading(false);
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 60000); // auto-refresh every 60s
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="p-4 border rounded shadow my-4">
      <h2 className="text-xl font-bold mb-2">Deployment Rollback</h2>
      <RollbackStatus status={status} loading={loading} />
      <RollbackButton onClick={handleRollback} loading={loading} />
    </div>
  );
}