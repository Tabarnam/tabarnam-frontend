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
          <img
            src="/tabarnam.png"
            alt="Tabarnam"
            className="h-10 transition-transform duration-150 ease-out hover:scale-[1.04] dark:brightness-110"
          />
        </Link>
      </div>
    </header>
  );
};

export default SiteHeader;
