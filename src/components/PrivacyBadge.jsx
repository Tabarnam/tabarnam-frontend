import { useLocation, Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';

export default function PrivacyBadge() {
  const { pathname } = useLocation();

  // Only show on homepage
  if (pathname !== '/') return null;

  return (
    <div className="fixed bottom-4 left-4 z-50">
      <Link
        to="/privacy"
        className="flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1.5 shadow-lg backdrop-blur transition-colors hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <ShieldCheck size={14} className="text-primary" />
        <span className="text-[10px] font-medium text-muted-foreground whitespace-nowrap">
          Not Collecting Your Data
        </span>
      </Link>
    </div>
  );
}
