// src/App.jsx
import React from "react";
import { HelmetProvider } from "react-helmet-async";
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
  useLocation,
} from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";

import AdminPanel from "@pages/AdminPanel";
import ResultsPage from "@pages/ResultsPage";
import HomePage from "@pages/HomePage";
import XAIBulkImportPage from "@pages/XAIBulkImportPage";

import SiteHeader from "@/components/SiteHeader";
import FeedbackWidget from "@/components/FeedbackWidget";
import { SupabaseAuthProvider } from "@/contexts/SupabaseAuthProvider";
import { UserRoleProvider } from "@/contexts/UserRoleProvider";

// Simple error boundary
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    return this.state.hasError ? (
      <h1>Something went wrong.</h1>
    ) : (
      this.props.children
    );
  }
}

// Layout that hides header/feedback on /admin/*
function Layout({ children }) {
  const { pathname } = useLocation();
  const isAdmin = pathname.startsWith("/admin");
  return (
    <>
      {!isAdmin && <SiteHeader />}
      <div className="min-h-screen">{children}</div>
      {!isAdmin && <FeedbackWidget />}
    </>
  );
}

export default function App() {
  return (
    <HelmetProvider>
      <ErrorBoundary>
        <SupabaseAuthProvider>
          <UserRoleProvider>
            <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
              <Layout>
            <Routes>
              {/* public */}
              <Route path="/" element={<HomePage />} />
              <Route path="/results" element={<ResultsPage />} />

              {/* admin */}
              <Route path="/admin" element={<AdminPanel />} />
              <Route path="/admin/xai-bulk-import" element={<XAIBulkImportPage />} />

              {/* convenience alias to the bulk importer */}
              <Route path="/bulk-import" element={<XAIBulkImportPage />} />
              <Route
                path="/admin/bulk-import"
                element={<Navigate to="/admin/xai-bulk-import" replace />}
              />

              {/* fallback */}
              <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
              </Layout>
            </Router>
            <Toaster />
          </UserRoleProvider>
        </SupabaseAuthProvider>
      </ErrorBoundary>
    </HelmetProvider>
  );
}
