import { useState } from 'react';
import { useLocation } from 'react-router-dom';

export default function PrivacyBadge() {
  const { pathname } = useLocation();
  const [hovered, setHovered] = useState(false);

  // Only show on homepage
  if (pathname !== '/') return null;

  return (
    <div
      className="fixed bottom-4 left-4 z-50"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Expanded image - appears on hover */}
      <div
        className={`absolute bottom-12 left-0 transition-all duration-300 origin-bottom-left ${
          hovered
            ? 'opacity-100 scale-100'
            : 'opacity-0 scale-0 pointer-events-none'
        }`}
      >
        <img
          src="/not collecting your data II.jpg"
          alt="Not collecting your data"
          style={{ width: '20rem', maxWidth: 'none' }}
          className="rounded-lg shadow-xl border border-border"
        />
      </div>

      {/* Tiny badge icon */}
      <div className="flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1.5 shadow-lg backdrop-blur cursor-default">
        <img
          src="/not collecting your data II.jpg"
          alt="Not collecting your data"
          className="h-5 w-5 rounded-full object-cover"
        />
        <span className="text-[10px] font-medium text-muted-foreground whitespace-nowrap">
          No tracking
        </span>
      </div>
    </div>
  );
}
