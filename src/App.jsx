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
import Login from "@pages/Login";

import SiteHeader from "@/components/SiteHeader";
import FeedbackWidget from "@/components/FeedbackWidget";
import Footer from "@/components/Footer";
import AdminRoute from "@/components/AdminRoute";
import AuthKeepAlive from "@/components/AuthKeepAlive";

// Simple error boundary
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-100 p-4">
          <div className="bg-white rounded-lg shadow-lg p-6 max-w-md">
            <h1 className="text-2xl font-bold text-red-600 mb-2">Something went wrong</h1>
            <p className="text-gray-600 mb-4">{this.state.error?.message}</p>
            <button
              onClick={() => window.location.reload()}
              className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Layout that hides header/feedback on /admin/* and /login
function Layout({ children }) {
  const { pathname } = useLocation();
  const isAdmin = pathname.startsWith("/admin");
  const isLogin = pathname === "/login";
  const showLayout = !isAdmin && !isLogin;
  
  return (
    <div className="flex flex-col min-h-screen">
      {showLayout && <SiteHeader />}
      <div className="flex-grow">{children}</div>
      {showLayout && <FeedbackWidget />}
      {showLayout && <Footer />}
    </div>
  );
}

export default function App() {
  return (
    <HelmetProvider>
      <ErrorBoundary>
        <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Layout>
            <Routes>
              {/* public */}
              <Route path="/" element={<HomePage />} />
              <Route path="/results" element={<ResultsPage />} />

              {/* auth */}
              <Route path="/login" element={<Login />} />

              {/* admin - protected */}
              <Route
                path="/admin"
                element={
                  <AdminRoute>
                    <AdminPanel />
                  </AdminRoute>
                }
              />
              <Route
                path="/admin/xai-bulk-import"
                element={
                  <AdminRoute>
                    <XAIBulkImportPage />
                  </AdminRoute>
                }
              />

              {/* convenience alias to the bulk importer */}
              <Route
                path="/bulk-import"
                element={
                  <AdminRoute>
                    <XAIBulkImportPage />
                  </AdminRoute>
                }
              />
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
      </ErrorBoundary>
    </HelmetProvider>
  );
}
