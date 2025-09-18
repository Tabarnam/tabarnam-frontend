import React from "react";
import { Link, useLocation } from "react-router-dom";
import Logo from "@/assets/tabarnam.png";
import FeedbackWidget from "@/components/FeedbackWidget";

// Slim header with clickable logo (hidden on / if you already place a big logo there)
const SiteHeader = () => {
  const { pathname } = useLocation();
  const hideOnHome = pathname === "/";

  if (hideOnHome) {
    return <FeedbackWidget />; // keep feedback widget floating on home
  }

  return (
    <>
      <header className="sticky top-0 z-40 bg-white/70 backdrop-blur border-b border-gray-200">
        <div className="max-w-6xl mx-auto flex items-center justify-between p-3">
          <Link to="/" className="inline-block" aria-label="Tabarnam home">
            <img
              src={Logo}
              alt="Tabarnam"
              className="h-10 transition-transform duration-150 ease-out hover:scale-[1.04]"
            />
          </Link>
        </div>
      </header>
      <FeedbackWidget />
    </>
  );
};

export default SiteHeader;
