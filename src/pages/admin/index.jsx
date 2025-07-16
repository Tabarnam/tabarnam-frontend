// src/pages/admin/index.jsx
import React from 'react';
import { Link } from 'react-router-dom';

export default function AdminDashboard() {
  return (
    <div className="p-6 space-y-6">
      <h1 className="text-3xl font-bold">Admin Panel</h1>
      <ul className="space-y-4">
        <li><Link to="/admin/xai-bulk-import" className="text-blue-600 underline">xAI Bulk Import</Link></li>
        {/* Add more admin tools here */}
      </ul>
    </div>
  );
}
