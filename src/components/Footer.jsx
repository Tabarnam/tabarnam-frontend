import React from 'react';
import { Link } from 'react-router-dom';

const Footer = () => {
  return (
    <footer className="bg-muted border-t border-border pt-4 pb-8">
      <div className="max-w-5xl mx-auto text-center">
        <nav className="flex items-center justify-center gap-4 mb-2 text-xs">
          <Link
            to="/about"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            About
          </Link>
          <span className="text-muted-foreground/50" aria-hidden="true">·</span>
          <Link
            to="/privacy"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            Privacy
          </Link>
        </nav>
        <p className="text-xs text-muted-foreground">
          Est 2016. Copyright © {new Date().getFullYear()} Tabarnam. All rights reserved
        </p>
      </div>
    </footer>
  );
};

export default Footer;
