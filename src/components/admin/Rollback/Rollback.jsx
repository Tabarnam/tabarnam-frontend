import React, { useState, useEffect } from 'react';
import RollbackButton from './RollbackButton';
import RollbackStatus from './RollbackStatus';

export default function Rollback() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/vercel/rollback');
      const data = await res.json();
      setStatus(data.message || 'No failed deployment found.');
    } catch (err) {
      setStatus('Error fetching rollback status.');
    }
  };

  const handleRollback = async () => {
    const confirm = window.confirm('Are you sure you want to rollback the last failed deployment?');
    if (!confirm) return;

    setLoading(true);
    try {
      const res = await fetch('/api/vercel/rollback', { method: 'POST' });
      const data = await res.json();
      setStatus(data.message || 'Rollback attempted.');
    } catch (err) {
      setStatus('Rollback failed.');
    } finally {
      setLoading(false);
    }
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
