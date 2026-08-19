import React from "react";
import { Link, useLocation } from "react-router-dom";
import BookmarkHeaderIcon from "@/components/bookmarks/BookmarkHeaderIcon";

const SiteHeader = () => {
  const { pathname } = useLocation();
  const isHome = pathname === "/";
  const isResults = pathname === "/results";

  // Bookmark now sits in the true top-right corner. It used to be offset
  // (right-40) to clear the fixed "Contact Us" pill — that has moved to the
  // footer, so the corner is free.

  // Home drops the banner entirely (searching IS the task there) — just the
  // corner bookmark.
  if (isHome) {
    return (
      <div className="fixed top-2 right-3 z-40">
        <BookmarkHeaderIcon />
      </div>
    );
  }

  // Results also drops the full-width banner so it costs no vertical space
  // above the fold: the logo/home link is pinned to the top-left corner and the
  // bookmark to the top-right. Both get a faint backdrop chip so they stay
  // legible as result cards scroll under them. They sit in the page's side
  // gutters, so they don't overlap the content at normal zoom.
  if (isResults) {
    return (
      <>
        <Link
          to="/"
          aria-label="Tabarnam home"
          className="fixed top-2 left-3 z-40 inline-block rounded-md bg-background/70 backdrop-blur px-1"
        >
          <img
            src="/tabarnam.png"
            alt="Tabarnam"
            className="h-9 transition-transform duration-150 ease-out hover:scale-[1.04] dark:brightness-110"
          />
        </Link>
        <div className="fixed top-2 right-3 z-40 rounded-md bg-background/70 backdrop-blur">
          <BookmarkHeaderIcon />
        </div>
      </>
    );
  }

  return (
    <>
      <header className="sticky top-0 z-40 bg-background/70 backdrop-blur border-b border-border">
        {/* The /map explore link is intentionally hidden (2026-08-11) while
            the search-scoped maps are evaluated — see the note in
            HomePage.jsx. The route itself still resolves. */}
        <div className="max-w-6xl mx-auto flex items-center p-3">
          <Link to="/" className="inline-block" aria-label="Tabarnam home">
            <img
              src="/tabarnam.png"
              alt="Tabarnam"
              className="h-10 transition-transform duration-150 ease-out hover:scale-[1.04] dark:brightness-110"
            />
          </Link>
        </div>
      </header>
      <div className="fixed top-2 right-3 z-40">
        <BookmarkHeaderIcon />
      </div>
    </>
  );
};

export default SiteHeader;
