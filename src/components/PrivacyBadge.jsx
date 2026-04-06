import { useLocation, Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';

export default function PrivacyBadge() {
  const { pathname } = useLocation();

  // Only show on homepage
  if (pathname !== '/') return null;

  return (
    <div className="px-4 py-3">
      <Link
        to="/privacy"
        className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-1.5 shadow-lg backdrop-blur transition-colors hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <span className="flex h-6 w-6 items-center justify-center">
          <ShieldCheck size={14} className="text-primary" />
        </span>
        <span className="text-xs font-medium text-muted-foreground whitespace-nowrap pr-1">
          Not Collecting Your Data
        </span>
      </Link>
    </div>
  );
}
