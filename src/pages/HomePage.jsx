// src/pages/HomePage.jsx
import React from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router-dom';
import Logo from '@/assets/tabarnam.png';
import SearchCard from '@/components/home/SearchCard';

export default function HomePage() {
  return (
    <>
      <Helmet>
        <title>Tabarnam – Discover products with transparent origins</title>
        <meta name="description" content="Where was it made?" />
      </Helmet>

      <main className="min-h-[calc(100vh-2rem)] flex flex-col items-center pt-12 pb-16 px-4">
        {/* Upper 1/3 logo */}
        <Link to="/" className="mb-8 inline-block">
          <img
            src={Logo}
            alt="Tabarnam™"
            className="h-16 sm:h-20 md:h-24 transition-transform duration-150 hover:scale-[1.04]"
          />
        </Link>

        {/* Two-row search bar */}
        <SearchCard />
      </main>
    </>
  );
}
