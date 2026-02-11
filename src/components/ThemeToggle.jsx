import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { Sun, Moon } from 'lucide-react';

export default function ThemeToggle() {
  const { setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Placeholder with same dimensions to avoid layout shift
  if (!mounted) {
    return (
      <div className="fixed bottom-4 right-4 z-50 h-9 w-[72px] rounded-full bg-muted/50" />
    );
  }

  const isDark = resolvedTheme === 'dark';

  const toggle = () => {
    document.documentElement.classList.add('transitioning');
    setTheme(isDark ? 'light' : 'dark');
    setTimeout(() => {
      document.documentElement.classList.remove('transitioning');
    }, 350);
  };

  return (
    <button
      onClick={toggle}
      className="fixed bottom-4 right-4 z-50 flex items-center gap-1 rounded-full border border-border bg-card px-2 py-1.5 shadow-lg backdrop-blur transition-colors hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring"
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      <span
        className={`flex h-6 w-6 items-center justify-center rounded-full transition-colors ${
          !isDark ? 'bg-amber-400 text-amber-900' : 'text-muted-foreground'
        }`}
      >
        <Sun size={14} />
      </span>
      <span
        className={`flex h-6 w-6 items-center justify-center rounded-full transition-colors ${
          isDark ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
        }`}
      >
        <Moon size={14} />
      </span>
    </button>
  );
}
