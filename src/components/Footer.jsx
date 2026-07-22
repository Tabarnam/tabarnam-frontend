import React from 'react';
import { Link } from 'react-router-dom';

const Footer = () => {
  return (
    <footer className="bg-muted border-t border-border pt-4 pb-8">
      <div className="max-w-5xl mx-auto text-center">
        <nav className="flex items-center justify-center gap-4 mb-2 text-xs">
          <Link
            to="/how-it-works"
            className="text-slate-600 dark:text-muted-foreground hover:text-foreground transition-colors"
          >
            How it works
          </Link>
          <span className="text-muted-foreground/50" aria-hidden="true">·</span>
          <Link
            to="/about"
            className="text-slate-600 dark:text-muted-foreground hover:text-foreground transition-colors"
          >
            About
          </Link>
          <span className="text-muted-foreground/50" aria-hidden="true">·</span>
          <Link
            to="/privacy"
            className="text-slate-600 dark:text-muted-foreground hover:text-foreground transition-colors"
          >
            Privacy
          </Link>
        </nav>
        {/* slate-600 in light mode: muted-foreground (slate-500) is 4.35:1 on
            the bg-muted footer — just under WCAG AA 4.5. Dark mode unchanged. */}
        <p className="text-xs text-slate-600 dark:text-muted-foreground">
          Est 2016. Copyright © {new Date().getFullYear()} Tabarnam. All rights reserved
        </p>
      </div>
    </footer>
  );
};

export default Footer;
