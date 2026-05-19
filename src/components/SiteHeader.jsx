import React from "react";
import { Link, useLocation } from "react-router-dom";

// Slim header with clickable logo (hidden on / if you already place a big logo there)
const SiteHeader = () => {
  const { pathname } = useLocation();
  const hideOnHome = pathname === "/";

  if (hideOnHome) {
    return null;
  }

  return (
    <header className="sticky top-0 z-40 bg-background/70 backdrop-blur border-b border-border">
      <div className="max-w-6xl mx-auto flex items-center justify-between p-3">
        <Link to="/" className="inline-block" aria-label="Tabarnam home">
          <span className="relative inline-block transition-transform duration-150 ease-out hover:scale-[1.04]">
            <img
              src="/tabarnam.png"
              alt="Tabarnam™"
              className="h-10 dark:brightness-110"
            />
            <sup
              aria-hidden="true"
              className="absolute top-1 right-[5%] text-[7px] font-semibold text-primary leading-none select-none"
            >
              TM
            </sup>
          </span>
        </Link>
      </div>
    </header>
  );
};

export default SiteHeader;
