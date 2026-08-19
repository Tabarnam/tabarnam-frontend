import React from 'react';
import { Link } from 'react-router-dom';
import ContactFormDialog from '@/components/ContactFormDialog';

// Crawlable entry points for the /made-in SEO pages. Static so the footer has
// no data dependency; slugs must match src/lib/madeIn.js registry output.
const MADE_IN_LINKS = [
  ['usa', 'USA'],
  ['canada', 'Canada'],
  ['uk', 'UK'],
  ['france', 'France'],
  ['germany', 'Germany'],
  ['italy', 'Italy'],
  ['japan', 'Japan'],
  ['china', 'China'],
  ['india', 'India'],
  ['mexico', 'Mexico'],
  ['australia', 'Australia'],
  ['south-korea', 'South Korea'],
];

// A few high-volume US states so crawlers reach the state tier directly;
// the full list lives on /made-in/usa.
const MADE_IN_STATE_LINKS = [
  ['california', 'California'],
  ['texas', 'Texas'],
  ['new-york', 'New York'],
  ['florida', 'Florida'],
  ['oregon', 'Oregon'],
  ['colorado', 'Colorado'],
];

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
          <span className="text-muted-foreground/50" aria-hidden="true">·</span>
          {/* Contact moved here from the floating top-right pill. */}
          <ContactFormDialog variant="footer" />
        </nav>
        <nav
          aria-label="Browse by manufacturing country"
          className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 mb-2 text-xs"
        >
          <span className="text-slate-600 dark:text-muted-foreground font-medium">Made in:</span>
          {MADE_IN_LINKS.map(([slug, label]) => (
            <Link
              key={slug}
              to={`/made-in/${slug}`}
              className="text-slate-600 dark:text-muted-foreground hover:text-foreground transition-colors"
            >
              {label}
            </Link>
          ))}
          <Link
            to="/made-in"
            className="text-slate-600 dark:text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
          >
            All countries
          </Link>
        </nav>
        <nav
          aria-label="Browse by US state"
          className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 mb-2 text-xs"
        >
          <span className="text-slate-600 dark:text-muted-foreground font-medium">Made in USA:</span>
          {MADE_IN_STATE_LINKS.map(([slug, label]) => (
            <Link
              key={slug}
              to={`/made-in/usa/${slug}`}
              className="text-slate-600 dark:text-muted-foreground hover:text-foreground transition-colors"
            >
              {label}
            </Link>
          ))}
          <Link
            to="/made-in/usa"
            className="text-slate-600 dark:text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
          >
            All states
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
