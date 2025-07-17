import React from 'react';
import Head from 'next/head';
import Link from 'next/link';

export default function AdminPanel() {
  return (
    <>
      <Head>
        <title>Admin Panel - Tabarnam</title>
        <meta name="description" content="Admin panel for managing Tabarnam tools and imports." />
      </Head>
      <div className="p-6 space-y-6">
        <h1 className="text-3xl font-bold">Admin Panel</h1>
        <ul className="space-y-4">
          <li>
            <Link href="/admin/xai-bulk-import" className="text-blue-600 underline">
              XAI Bulk Import Tool
            </Link>
          </li>
        </ul>
      </div>
    </>
  );
}
