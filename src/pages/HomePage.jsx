// src/pages/HomePage.jsx
import React from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router-dom';

export default function HomePage() {
  return (
    <>
      <Helmet>
        <title>Tabarnam – Discover Verified Companies</title>
        <meta name="description" content="Explore verified companies by location, product, and more with Tabarnam." />
      </Helmet>
      <div className="p-6 space-y-6">
        <h1 className="text-4xl font-bold">Welcome to Tabarnam</h1>
        <p className="text-lg">Search and explore thousands of verified companies around the world.</p>
        <Link
          to="/results"
          className="inline-block mt-4 bg-blue-600 text-white px-6 py-2 rounded-md hover:bg-blue-700"
        >
          Get Started
        </Link>
      </div>
    </>
  );
}