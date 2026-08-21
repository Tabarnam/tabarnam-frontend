import React, { useEffect, lazy, Suspense } from "react";
import { HelmetProvider } from "@/components/DocumentHead";
import { MotionConfig } from "framer-motion";
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
import { consumePostLoginDest } from "@/lib/postLoginDest";
import { installStaleBuildRecovery } from "@/lib/staleBuildRecovery";

import ResultsPage from "@pages/ResultsPage";
import HomePage from "@pages/HomePage";
import Login from "@pages/Login";
import PrivacyPage from "@pages/PrivacyPage";
import AboutPage from "@pages/AboutPage";
import HelpPage from "@pages/HelpPage";

import SiteHeader from "@/components/SiteHeader";
import Footer from "@/components/Footer";
import AdminRoute from "@/components/AdminRoute";
import AuthKeepAlive from "@/components/AuthKeepAlive";

import ThemeProvider from "@/components/ThemeProvider";
import ThemeToggle from "@/components/ThemeToggle";
import PrivacyBadge from "@/components/PrivacyBadge";
import TourController from "@/components/tour/TourController";
import ScrollToHashOrTop from "@/components/ScrollToHashOrTop";
import { BookmarksProvider } from "@/contexts/BookmarksContext";

// Admin pages are lazy-loaded — they're only reachable at /admin/* and
// shouldn't ship in the main bundle for every public visitor.
const AdminPanel = lazy(() => import("@pages/AdminPanel"));
const CompanyDashboard = lazy(() => import("@pages/CompanyDashboard"));
const AdminImport = lazy(() => import("@pages/AdminImport"));
const AdminLogoReview = lazy(() => import("@pages/AdminLogoReview"));
const AdminImages = lazy(() => import("@pages/AdminImages"));
const AdminSearchEdit = lazy(() => import("@pages/AdminSearchEdit"));
const AdminBackfillScores = lazy(() => import("@pages/AdminBackfillScores"));
const AdminReviewQueue = lazy(() => import("@pages/AdminReviewQueue"));
const AdminBackfillHomepages = lazy(() => import("@pages/AdminBackfillHomepages"));
const AdminBackfillLogos = lazy(() => import("@pages/AdminBackfillLogos"));
const AdminExtractCompanies = lazy(() => import("@pages/AdminExtractCompanies"));
const AdminCompanyHistory = lazy(() => import("@pages/AdminCompanyHistory"));
const AdminAuditLog = lazy(() => import("@pages/AdminAuditLog"));
const BookmarksDrawer = lazy(() => import("@/components/bookmarks/BookmarksDrawer"));
const BookmarksPage = lazy(() => import("@/pages/BookmarksPage"));
// "Made in ___" SEO pages — lazy; they pull the pins index on demand.
const MadeInPage = lazy(() => import("@pages/MadeInPage"));
const MadeInIndexPage = lazy(() => import("@pages/MadeInIndexPage"));
const MadeInStatePage = lazy(() => import("@pages/MadeInStatePage"));
const CompanyPage = lazy(() => import("@pages/CompanyPage"));

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
      {/* BetaBadge removed */}
      {showLayout && <SiteHeader />}
      {/* tabIndex={-1} lets the skip link move focus INTO the landmark (not
          just scroll to it) without adding <main> to the tab order. */}
      <main id="main-content" tabIndex={-1} className="flex-grow outline-none">
        {children}
      </main>
      {/* Contact now lives in the footer (as an inline link), not a floating
          top-right pill. */}
      <ThemeToggle />
      {showLayout && <PrivacyBadge />}
      {showLayout && <Footer />}
    </div>
  );
}

// Track if diagnostics have been run to prevent spam on hot reloads
let diagnosticsRun = false;

export default function App() {
  useEffect(() => {
    // A tab open across a deploy asks for chunks that no longer exist. Reload
    // once rather than leaving it stranded on a build the server deleted.
    installStaleBuildRecovery();

    // Honor a post-login destination stashed before the SWA auth round-trip.
    // SWA's own redirect cookie (SameSite=None) is dropped by strict-cookie
    // browsers like Brave, landing admins on "/" instead of the page they asked
    // for. We stash the admin path in localStorage at login time and redirect
    // here on return. One-shot + 5-min TTL, admin paths only (see postLoginDest),
    // so this can't hijack ordinary navigation or loop. Runs before anything
    // else so we don't kick off homepage init we're about to navigate away from.
    try {
      const dest = consumePostLoginDest();
      if (dest && dest !== window.location.pathname + window.location.search) {
        window.location.replace(dest);
        return;
      }
    } catch { /* non-fatal — SWA cookie remains the fallback */ }

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
      {/* reducedMotion="user" — every framer-motion animation site-wide obeys
          the OS "reduce motion" setting (transform/layout animations disabled,
          opacity fades kept). CSS animations are covered by the matching
          prefers-reduced-motion guard in index.css. */}
      <MotionConfig reducedMotion="user">
      <ThemeProvider>
      <ErrorBoundary>
        <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <BookmarksProvider>
          {/* Skip link for keyboard users — visually hidden until focused (see
              .skip-link in index.css). Rendered FIRST in the document so it's
              the first tabbable element on every page; jumps past the header +
              filter chrome straight to <main id="main-content"> in Layout. */}
          <a href="#main-content" className="skip-link">
            Skip to main content
          </a>
          <AuthKeepAlive />
          <ScrollToHashOrTop />
          <TourController />
          <Suspense fallback={null}><BookmarksDrawer /></Suspense>
          <Layout>
            <Suspense fallback={null}>
            <Routes>
              {/* public */}
              <Route path="/" element={<HomePage />} />
              <Route path="/results" element={<ResultsPage />} />
              <Route path="/made-in" element={<MadeInIndexPage />} />
              {/* State route must precede the country route's :slug so
                  /made-in/usa/california doesn't fall through. */}
              <Route path="/made-in/usa/:state" element={<MadeInStatePage />} />
              <Route path="/made-in/:slug" element={<MadeInPage />} />
              {/* Server-rendered by api/company-page; this route is what React
                  mounts once it takes over. Without it the catch-all below
                  would bounce every company URL to "/" a moment after the
                  server-rendered page painted. */}
              <Route path="/company/:slug" element={<CompanyPage />} />
              <Route path="/bookmarks" element={<Suspense fallback={null}><BookmarksPage /></Suspense>} />
              <Route path="/privacy" element={<PrivacyPage />} />
              <Route path="/about" element={<AboutPage />} />
              <Route path="/how-it-works" element={<HelpPage />} />
              {/* legacy redirect — /help shipped before the rename */}
              <Route path="/help" element={<Navigate to="/how-it-works" replace />} />

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
                path="/admin/logos"
                element={
                  <AdminRoute>
                    <AdminLogoReview />
                  </AdminRoute>
                }
              />
              <Route
                path="/admin/images"
                element={
                  <AdminRoute>
                    <AdminImages />
                  </AdminRoute>
                }
              />
              <Route
                path="/admin/search-edit"
                element={
                  <AdminRoute staffOnly>
                    <AdminSearchEdit />
                  </AdminRoute>
                }
              />
              <Route
                path="/admin/backfill-scores"
                element={
                  <AdminRoute staffOnly>
                    <AdminBackfillScores />
                  </AdminRoute>
                }
              />
              <Route
                path="/admin/review-queue"
                element={
                  <AdminRoute staffOnly>
                    <AdminReviewQueue />
                  </AdminRoute>
                }
              />
              <Route
                path="/admin/audit-log"
                element={
                  <AdminRoute staffOnly>
                    <AdminAuditLog />
                  </AdminRoute>
                }
              />
              <Route
                path="/admin/backfill-homepages"
                element={
                  <AdminRoute staffOnly>
                    <AdminBackfillHomepages />
                  </AdminRoute>
                }
              />
              <Route
                path="/admin/backfill-logos"
                element={
                  <AdminRoute staffOnly>
                    <AdminBackfillLogos />
                  </AdminRoute>
                }
              />
              <Route
                path="/admin/extract-companies"
                element={
                  <AdminRoute staffOnly>
                    <AdminExtractCompanies />
                  </AdminRoute>
                }
              />
              <Route
                path="/admin/companies/:companyId/history"
                element={
                  <AdminRoute>
                    <AdminCompanyHistory />
                  </AdminRoute>
                }
              />
              <Route
                path="/admin/diagnostics"
                element={
                  <AdminRoute staffOnly>
                    <AdminPanel />
                  </AdminRoute>
                }
              />

              {/* fallback */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            </Suspense>
          </Layout>
          </BookmarksProvider>
        </Router>
        <Toaster />
      </ErrorBoundary>
      </ThemeProvider>
      </MotionConfig>
    </HelmetProvider>
  );
}
