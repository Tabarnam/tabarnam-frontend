import React from 'react';
import { Helmet } from 'react-helmet';
import { Toaster } from '@components/ui/toaster';
import { AuthProvider } from '@contexts/SupabaseAuthContext';
import { UserRoleProvider } from '@contexts/UserRoleContext';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';

import AdminPanel from '@pages/AdminPanel';
import ResultsPage from '@pages/ResultsPage';
import HomePage from '@pages/HomePage';
import XAIBulkImportPage from '@pages/XAIBulkImportPage';
import AdminRoute from '@components/AdminRoute';

function App() {
  return (
    <AuthProvider>
      <UserRoleProvider>
        <Router>
          <div className="min-h-screen">
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/results" element={<ResultsPage />} />
              <Route
                path="/admin"
                element={
                  <AdminRoute>
                    <AdminPanel />
                  </AdminRoute>
                }
              />
              {/* TEMP: Render import page without auth wrapper to debug layout */}
              <Route
                path="/admin/xai-bulk-import"
                element={<XAIBulkImportPage />}
              />
            </Routes>
          </div>
        </Router>
        <Toaster />
      </UserRoleProvider>
    </AuthProvider>
  );
}

export default App;
