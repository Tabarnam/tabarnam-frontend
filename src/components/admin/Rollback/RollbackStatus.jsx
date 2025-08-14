// C:\Users\jatlas\OneDrive\Tabarnam Inc\MVP Do It Yourself\tabarnam-frontend\src\components\admin\Rollback\RollbackStatus.jsx
import { useEffect, useState } from 'react';

export default function RollbackStatus() {
  const [status, setStatus] = useState('Vercel rollback disabled. Check Azure deployment status.');
  const [lastRollback, setLastRollback] = useState(null);

  useEffect(() => {
    const saved = localStorage.getItem('lastRollback');
    if (saved) {
      setLastRollback(JSON.parse(saved));
    }
  }, []);

  return (
    <div className="p-4 space-y-2">
      <h3 className="text-sm font-medium text-gray-600">Rollback Status:</h3>
      <p className="text-lg">{status}</p>
      {lastRollback && (
        <p className="text-sm text-gray-500">
          Last rollback by <strong>{lastRollback.user}</strong> at{' '}
          {lastRollback.time}
        </p>
      )}
    </div>
  );
}