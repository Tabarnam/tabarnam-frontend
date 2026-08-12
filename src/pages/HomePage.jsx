// src/pages/HomePage.jsx
import React from 'react';
import { Helmet } from "@/components/DocumentHead";
import { Link } from 'react-router-dom';
import SearchCard from '@/components/home/SearchCard';

export default function HomePage() {
  return (
    <>
      <Helmet>
        <title>Tabarnam – Discover products with transparent origins</title>
        <meta name="description" content="...but where was it made?" />
        <meta property="og:description" content="...but where was it made?" />
      </Helmet>

      <main className="min-h-[calc(100vh-2rem)] flex flex-col items-center pt-12 pb-16 px-4">
        {/* Upper 1/3 logo */}
        <Link to="/" className="mb-8 inline-block">
          <img
            src="/tabarnam.png"
            alt="Tabarnam"
            className="h-16 sm:h-20 md:h-24 transition-transform duration-150 hover:scale-[1.04] dark:brightness-110"
          />
        </Link>

        {/* Tagline */}
        <p className="mb-8 -mt-4 text-base sm:text-lg text-muted-foreground italic">
          ...but where was it made?
        </p>

        {/* Two-row search bar */}
        <SearchCard autoFocus />

        {/* The /map explore entry is intentionally hidden (2026-08-11): a
            browse-everything map with no search answers no question a
            visitor actually has, and its world-zoom clusters sit at the
            average of their members' coordinates — bubbles in open ocean.
            The route still works if you navigate to it directly. The
            search-scoped maps (results + made-in) are the ones under
            evaluation. */}
      </main>
    </>
  );
}
