import React, { useEffect } from "react";
import { HelmetProvider } from "react-helmet-async";
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
  useLocation,
} from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { initializeAzureUser } from "@/lib/azureAuth";
import { logWiringDiagnostics } from "@/lib/diagnostics";

import AdminPanel from "@pages/AdminPanel";
import CompanyDashboard from "@pages/CompanyDashboard";
import AdminImport from "@pages/AdminImport";
import ResultsPage from "@pages/ResultsPage";
import HomePage from "@pages/HomePage";
import Login from "@pages/Login";

import SiteHeader from "@/components/SiteHeader";
import FeedbackWidget from "@/components/FeedbackWidget";
import Footer from "@/components/Footer";
import AdminRoute from "@/components/AdminRoute";
import AuthKeepAlive from "@/components/AuthKeepAlive";
import BetaBadge from "@/components/BetaBadge";
import ThemeProvider from "@/components/ThemeProvider";
import ThemeToggle from "@/components/ThemeToggle";

// Main application component with routing, layout management, and error handling
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
        <div className="min-h-screen flex items-center justify-center bg-background p-4">
          <div className="bg-card rounded-lg shadow-lg p-6 max-w-md">
            <h1 className="text-2xl font-bold text-red-600 dark:text-red-400 mb-2">Something went wrong</h1>
            <p className="text-muted-foreground mb-4">{this.state.error?.message}</p>
            <button
              onClick={() => window.location.reload()}
              className="bg-primary text-primary-foreground px-4 py-2 rounded hover:bg-primary/90"
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
      {showLayout && <BetaBadge />}
      {showLayout && <SiteHeader />}
      <div className="flex-grow">{children}</div>
      {showLayout && <FeedbackWidget />}
      {showLayout && <Footer />}
      <ThemeToggle />
    </div>
  );
}

// Track if diagnostics have been run to prevent spam on hot reloads
let diagnosticsRun = false;

export default function App() {
  useEffect(() => {
    // Initialize Azure Entra ID user on app load
    initializeAzureUser().catch(err => {
      console.error('[App] Failed to initialize Azure user:', err);
    });

    // Log API wiring diagnostics once on app startup (not on every hot reload)
    if (!diagnosticsRun) {
      diagnosticsRun = true;
      logWiringDiagnostics();
    }
  }, []);

  return (
    <HelmetProvider>
      <ThemeProvider>
      <ErrorBoundary>
        <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <AuthKeepAlive />
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
                    <CompanyDashboard />
                  </AdminRoute>
                }
              />
              <Route
                path="/admin/import"
                element={
                  <AdminRoute>
                    <AdminImport />
                  </AdminRoute>
                }
              />
              <Route
                path="/admin/diagnostics"
                element={
                  <AdminRoute>
                    <AdminPanel />
                  </AdminRoute>
                }
              />

              {/* fallback */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Layout>
        </Router>
        <Toaster />
      </ErrorBoundary>
      </ThemeProvider>
    </HelmetProvider>
  );
}
