import React from "react";
import { Link, useLocation } from "react-router-dom";
import BookmarkHeaderIcon from "@/components/bookmarks/BookmarkHeaderIcon";

const SiteHeader = () => {
  const { pathname } = useLocation();
  const hideOnHome = pathname === "/";

  if (hideOnHome) {
    return (
      <div className="fixed top-2 right-40 z-40">
        <BookmarkHeaderIcon />
      </div>
    );
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
        <div className="mr-28">
          <BookmarkHeaderIcon />
        </div>
      </div>
    </header>
  );
};

export default SiteHeader;
