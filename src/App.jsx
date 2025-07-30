// src/App.jsx
import React from 'react';
import { HelmetProvider } from 'react-helmet-async';
import { Toaster } from '@/components/ui/sonner';
import { SupabaseAuthProvider } from '@/contexts/SupabaseAuthProvider';
import { UserRoleProvider } from '@/contexts/UserRoleProvider';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';

// Error Boundary for robustness
class ErrorBoundary extends React.Component {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return <h1>Something went wrong. Please try again later.</h1>;
    }
    return this.props.children;
  }
}

import AdminPanel from '@pages/AdminPanel';
import ResultsPage from '@pages/ResultsPage';
import HomePage from '@pages/HomePage';
import XAIBulkImportPage from '@pages/XAIBulkImportPage';
import Login from '@pages/Login';
import AdminRoute from '@components/AdminRoute';

function App() {
  return (
    <HelmetProvider>
      <SupabaseAuthProvider>
        <UserRoleProvider>
          <ErrorBoundary>
            <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
              <div className="min-h-screen">
                <Routes>
                  <Route path="/" element={<HomePage />} />
                  <Route path="/results" element={<ResultsPage />} />
                  <Route path="/login" element={<Login />} />
                  <Route path="/admin" element={<AdminRoute><AdminPanel /></AdminRoute>} />
                  <Route path="/admin/xai-bulk-import" element={<XAIBulkImportPage />} />
                </Routes>
              </div>
            </Router>
            <Toaster />
          </ErrorBoundary>
        </UserRoleProvider>
      </SupabaseAuthProvider>
    </HelmetProvider>
  );
}

export default App;