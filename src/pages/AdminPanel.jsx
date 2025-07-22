import React from 'react';
import { Helmet } from 'react-helmet';
import { Link } from 'react-router-dom';
import Rollback from '@/components/admin/Rollback/Rollback'; // ✅ single import only

export default function AdminPanel() {
  return (
    <>
      <Helmet>
        <title>Admin Panel - Tabarnam</title>
        <meta name="description" content="Admin panel for managing Tabarnam tools and imports." />
      </Helmet>
      <div className="p-6 space-y-6">
        <h1 className="text-3xl font-bold">Admin Panel</h1>

        {/* ✅ Renders entire rollback section (button, status, toasts) */}
        <Rollback />

        <ul className="space-y-4">
          <li>
            <Link to="/admin/xai-bulk-import" className="text-blue-600 underline">
              XAI Bulk Import Tool
            </Link>
          </li>
        </ul>
      </div>
    </>
  );
}
